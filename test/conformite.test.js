process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { ouvrirBase, base, un, exec } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider, contrepasser, verifierChaineEcritures } from '../src/domain/ecritures.js';
import { ouvrirDossier, cloreDossier } from '../src/domain/dossiers.js';
import { etatRepresentationFonds, etatComptesDebiteurs, anomalies,
  etatJustificationPieces } from '../src/domain/controles.js';
import { controlePreCloture } from '../src/domain/cloture.js';
import { lettrer } from '../src/domain/lettrage.js';
import { genererFEC } from '../src/reports/fec.js';
import { balance, dossierInspection } from '../src/reports/etats.js';
import { verifierChaineAudit } from '../src/audit.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const dossier = ouvrirDossier({ reference: 'D-001', intitule: 'VENTE DUPONT' }, notaire);
const dossier2 = ouvrirDossier({ reference: 'D-002', intitule: 'SUCCESSION LOUIS' }, notaire);

/** Raccourci : saisit puis comptabilise. */
const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

test('un compte client individualise est cree a l ouverture du dossier', () => {
  assert.match(dossier.compte_client, /^411\d{5}$/);
  assert.notEqual(dossier.compte_client, dossier2.compte_client);
  assert.equal(un('SELECT nature FROM comptes WHERE numero = $n', { n: dossier.compte_client }).nature, 'CLIENT');
});

test('une ecriture desequilibree est refusee', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('03-01'), piece_ref: 'REL-03', libelle: 'Desequilibre',
    lignes: [
      { compte: '512500', debit: 100000 },
      { compte: dossier.compte_client, credit: 90000 },
    ],
  }, notaire);
  refuse('DESEQUILIBRE', () => valider(b.id, notaire));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
});

test('reception de fonds : le compte client devient crediteur', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('03-02'), piece_ref: 'V-1', libelle: 'Fonds recus DUPONT',
    lignes: [
      { compte: '512500', libelle: 'Virement recu', debit: 5_000_000 },
      { compte: dossier.compte_client, libelle: 'Fonds DUPONT', credit: 5_000_000 },
    ],
  });
  const d = un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: dossier.id });
  assert.equal(d.solde, -5_000_000);
});

test('un compte client devenu debiteur alerte sans bloquer la comptabilisation', () => {
  // L'office regle un debours avant d'avoir recu la provision : cas courant.
  // Les fonds sortent du compte de l'office, pas du depot des fonds clients,
  // de sorte que l'argent des autres clients n'est pas touche.
  const b = creerBrouillon({
    journal: 'BQO', date_ecriture: LE('03-03'), piece_ref: 'AVANCE-03',
    libelle: 'Debours avance par l office',
    lignes: [
      { compte: dossier2.compte_client, libelle: 'Debours avance', debit: 300_000 },
      { compte: '512100', libelle: 'Paiement depuis le compte office', credit: 300_000 },
    ],
  }, notaire);

  const e = valider(b.id, notaire);

  // L'ecriture est bien comptabilisee...
  assert.equal(e.statut, 'VALIDEE');
  assert.equal(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: dossier2.id }).solde, 300_000);

  // ...mais elle remonte une alerte nominative.
  assert.equal(e.alertes.length, 1);
  assert.equal(e.alertes[0].code, 'SOLDE_CLIENT_DEBITEUR');
  assert.equal(e.alertes[0].solde, 300_000);

  // L'alerte est tracee dans la piste d'audit.
  const trace = un(
    `SELECT details FROM audit WHERE action = 'ALERTE_SOLDE_DEBITEUR' ORDER BY id DESC LIMIT 1`,
  );
  assert.match(trace.details, /debiteur de 300000 XPF/);
});

test('l etat des comptes debiteurs date la bascule et chiffre l avance', () => {
  const etat = etatComptesDebiteurs();
  assert.equal(etat.nombre, 1);
  assert.equal(etat.total_avance, 300_000);

  const l = etat.lignes[0];
  assert.equal(l.reference, dossier2.reference);
  assert.equal(l.avance, 300_000);
  assert.equal(l.debiteur_depuis, LE('03-03'));
  assert.ok(l.anciennete_jours >= 0);
});

test('un dossier debiteur interdit la cloture de l exercice', () => {
  const ex = un("SELECT id FROM exercices WHERE statut = 'OUVERT' LIMIT 1");
  const diagnostic = controlePreCloture(ex.id);
  assert.ok(diagnostic.obstacles.some((o) => o.code === 'CLIENT_DEBITEUR'),
    'la regularisation doit rester exigee avant la cloture');
});

test('les fonds clients restent representes par les disponibilites', () => {
  const f = etatRepresentationFonds();
  assert.equal(f.du_aux_clients, 5_000_000);
  assert.equal(f.fonds_detenus_en_depot, 5_000_000);
  assert.ok(f.conforme);
});

test('un prelevement sur les fonds clients au profit de l office est refuse', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-04'), piece_ref: 'OD-1', libelle: 'Ponction indue',
    lignes: [
      { compte: '512100', libelle: 'Vers compte office', debit: 1_000_000 },
      { compte: '512500', libelle: 'Depuis fonds clients', credit: 1_000_000 },
    ],
  }, notaire);
  refuse('FONDS_NON_REPRESENTES', () => valider(b.id, notaire));
});

test('une ecriture melant fonds clients et comptes de gestion est refusee', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-05'), piece_ref: 'OD-2', libelle: 'Emoluments encaisses directement',
    lignes: [
      { compte: '512500', libelle: 'Encaissement', debit: 200_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 200_000 },
    ],
  }, notaire);
  refuse('ETANCHEITE_ROMPUE', () => valider(b.id, notaire));
});

test('facturation des emoluments puis virement vers le compte office', () => {
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('03-06'), piece_ref: 'F-1', libelle: 'Emoluments vente DUPONT',
    lignes: [
      { compte: dossier.compte_client, libelle: 'Emoluments', debit: 444_000 },
      { compte: '706100', libelle: 'Emoluments d acte', credit: 400_000 },
      { compte: '445700', libelle: 'TGC 11 %', credit: 44_000 },
    ],
  });
  comptabiliser({
    journal: 'OD', date_ecriture: LE('03-07'), piece_ref: 'OD-3', libelle: 'Transfert des emoluments encaisses',
    lignes: [
      { compte: '512100', libelle: 'Compte office', debit: 444_000 },
      { compte: '512500', libelle: 'Fonds clients', credit: 444_000 },
    ],
  });
  assert.equal(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: dossier.id }).solde, -4_556_000);
  assert.ok(etatRepresentationFonds().conforme);
});

test('la numerotation des journaux est continue', () => {
  const numeros = base().prepare(
    `SELECT numero FROM ecritures WHERE journal = 'BQC' AND statut <> 'BROUILLON' ORDER BY numero`,
  ).all().map((r) => r.numero);
  assert.deepEqual(numeros, numeros.map((_, i) => i + 1));
});

test('une ecriture anterieure a la derniere comptabilisee est refusee', () => {
  const b = creerBrouillon({
    journal: 'EMO', date_ecriture: LE('01-15'), piece_ref: 'F-2', libelle: 'Retrodatee',
    lignes: [
      { compte: dossier.compte_client, debit: 1000, libelle: 'x' },
      { compte: '706100', credit: 1000, libelle: 'x' },
    ],
  }, notaire);
  refuse('RUPTURE_CHRONOLOGIE', () => valider(b.id, notaire));
});

test('une ecriture comptabilisee ne peut etre ni modifiee ni supprimee', () => {
  const id = un(`SELECT id FROM ecritures WHERE statut = 'VALIDEE' LIMIT 1`).id;
  assert.throws(
    () => exec('UPDATE ecritures SET libelle = $l WHERE id = $id', { l: 'falsifie', id }),
    /INALTERABILITE/,
  );
  assert.throws(() => exec('DELETE FROM ecritures WHERE id = $id', { id }), /INALTERABILITE/);
  assert.throws(
    () => exec('UPDATE lignes SET debit = 1 WHERE ecriture_id = $id', { id }),
    /INALTERABILITE/,
  );
});

test('la correction passe par une contre-passation tracee', () => {
  const id = comptabiliser({
    journal: 'OD', date_ecriture: LE('03-08'), piece_ref: 'OD-4', libelle: 'Imputation erronee',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 50_000 },
      { compte: '401000', libelle: 'Fournisseur', credit: 50_000 },
    ],
  });
  const r = contrepasser(id, { date_ecriture: LE('03-09'), motif: 'Compte de charge errone' }, notaire);
  assert.equal(r.origine.statut, 'CONTREPASSEE');
  assert.equal(r.contrepassation.lignes[0].debit, 0);
  assert.equal(r.contrepassation.lignes[0].credit, 50_000);
  assert.equal(un(`SELECT solde FROM v_soldes WHERE numero = '606400'`).solde, 0);
});

test('la contre-passation exige un motif', () => {
  const id = comptabiliser({
    journal: 'OD', date_ecriture: LE('03-10'), piece_ref: 'OD-5', libelle: 'Ecriture a extourner',
    lignes: [
      { compte: '606400', libelle: 'x', debit: 1000 },
      { compte: '401000', libelle: 'x', credit: 1000 },
    ],
  });
  refuse('MOTIF_MANQUANT', () => contrepasser(id, { motif: '  ' }, notaire));
});

test('la chaine d inalterabilite se verifie de bout en bout', () => {
  const c = verifierChaineEcritures();
  assert.ok(c.valide, c.motif);
  assert.equal(c.hash_final.length, 64);
  assert.ok(verifierChaineAudit().valide);
});

test('une alteration directe en base est detectee par la chaine', () => {
  const id = un(`SELECT id FROM ecritures WHERE statut = 'VALIDEE' ORDER BY id LIMIT 1`).id;
  // On contourne les declencheurs pour simuler une falsification.
  base().exec('DROP TRIGGER trg_ligne_maj_interdite');
  exec('UPDATE lignes SET debit = debit + 1 WHERE ecriture_id = $id AND debit > 0', { id });
  const c = verifierChaineEcritures();
  assert.equal(c.valide, false);
  assert.equal(c.motif, 'contenu altere depuis la comptabilisation');
  // Retablissement pour les tests suivants.
  exec('UPDATE lignes SET debit = debit - 1 WHERE ecriture_id = $id AND debit > 0', { id });
  assert.ok(verifierChaineEcritures().valide);
});

test('un dossier non solde ne peut pas etre clos', () => {
  refuse('DOSSIER_NON_SOLDE', () => cloreDossier(dossier.id, notaire));
});

test('un dossier solde peut etre clos', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('03-11'), piece_ref: 'REL-03', libelle: 'Restitution du solde DUPONT',
    lignes: [
      { compte: dossier.compte_client, libelle: 'Solde restitue', debit: 4_556_000 },
      { compte: '512500', libelle: 'Virement sortant', credit: 4_556_000 },
    ],
  });
  const d = cloreDossier(dossier.id, notaire);
  assert.equal(d.statut, 'SOLDE');
  assert.equal(d.solde, 0);
});

test('le lettrage refuse un lot desequilibre', () => {
  const ligne = un(
    `SELECT l.id FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = '401000' AND e.statut <> 'BROUILLON' LIMIT 1`,
  );
  refuse('LETTRAGE_DESEQUILIBRE', () => lettrer([ligne.id], notaire));
});

test('la balance generale est equilibree', () => {
  const b = balance();
  assert.ok(b.equilibree, `debit ${b.totaux.debit} / credit ${b.totaux.credit}`);
});

test('le FEC comporte les 18 colonnes normalisees et aucun brouillon', () => {
  const fec = genererFEC();
  const lignes = fec.trim().split('\r\n');
  assert.equal(lignes[0].split('\t').length, 18);
  assert.equal(lignes[0].split('\t')[0], 'JournalCode');
  for (const l of lignes.slice(1)) assert.equal(l.split('\t').length, 18);

  const brouillons = un(`SELECT libelle FROM ecritures WHERE statut = 'BROUILLON' LIMIT 1`);
  if (brouillons) assert.ok(!fec.includes(brouillons.libelle));

  // Le dossier tient lieu de compte auxiliaire pour les comptes clients.
  assert.ok(fec.includes('D-001'));
});

test('les anomalies remontent les brouillons et les comptes debiteurs', () => {
  const liste = anomalies();
  assert.ok(liste.some((a) => a.code === 'BROUILLONS_EN_ATTENTE'));

  // Le compte devenu debiteur plus haut n'a pas bloque la saisie, mais il
  // figure au dossier d'inspection, date et chiffre.
  const debiteur = liste.find((a) => a.code === 'SOLDE_CLIENT_DEBITEUR');
  assert.ok(debiteur, 'le compte debiteur doit figurer parmi les anomalies');
  assert.match(debiteur.message, /300000 XPF depuis le/);
});

// ---------------------------------------------------------------------------
// Justification des ecritures par une piece
// ---------------------------------------------------------------------------

const achat = (saisie) => ({
  journal: 'ACH',
  lignes: [
    { compte: '606400', piece_ref: 'P-1235', libelle: 'Fournitures', debit: 12_000 },
    { compte: '401000', libelle: 'Fournisseur', credit: 12_000 },
  ],
  ...saisie,
});

test('une ecriture sans reference de piece ne peut pas etre comptabilisee', () => {
  const b = creerBrouillon(achat({ date_ecriture: LE('04-01'), libelle: 'Achat sans facture' }), notaire);
  refuse('PIECE_NON_REFERENCEE', () => valider(b.id, notaire));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');

  // Une reference reduite a des espaces ne justifie rien.
  const vide = creerBrouillon(
    achat({ date_ecriture: LE('04-01'), piece_ref: '   ', libelle: 'Achat sans facture' }),
    notaire,
  );
  refuse('PIECE_NON_REFERENCEE', () => valider(vide.id, notaire));
});

test('une piece datee posterieurement a l ecriture est refusee', () => {
  const b = creerBrouillon(
    achat({ date_ecriture: LE('04-02'), date_piece: LE('04-20'), piece_ref: 'FA-100', libelle: 'Facture a venir' }),
    notaire,
  );
  refuse('PIECE_POSTERIEURE', () => valider(b.id, notaire));
});

test('une date de piece hors format est refusee', () => {
  const b = creerBrouillon(
    achat({ date_ecriture: LE('04-02'), date_piece: '02/04/2026', piece_ref: 'FA-100', libelle: 'Facture mal datee' }),
    notaire,
  );
  refuse('DATE_PIECE_INVALIDE', () => valider(b.id, notaire));
});

test('la meme facture ne peut pas etre comptabilisee deux fois dans un journal de facturation', () => {
  comptabiliser(achat({
    date_ecriture: LE('04-03'), date_piece: LE('04-01'), piece_ref: 'FA-101', libelle: 'Facture fournisseur',
  }));
  // Meme reference, casse differente : c'est la meme piece.
  const b = creerBrouillon(achat({
    date_ecriture: LE('04-04'), date_piece: LE('04-01'), piece_ref: 'fa-101', libelle: 'Facture ressaisie',
  }), notaire);
  refuse('PIECE_DEJA_COMPTABILISEE', () => valider(b.id, notaire));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
});

test('une meme reference de releve justifie plusieurs ecritures de banque', () => {
  const frais = (jour, montant) => comptabiliser({
    journal: 'BQO', date_ecriture: LE(jour), piece_ref: 'REL-04', libelle: 'Frais bancaires',
    lignes: [
      { compte: '627000', libelle: 'Commission', debit: montant },
      { compte: '512100', libelle: 'Releve avril', credit: montant },
    ],
  });
  frais('04-05', 1500);
  frais('04-05', 800);
  assert.equal(
    un(`SELECT COUNT(*) AS n FROM ecritures
        WHERE journal = 'BQO' AND piece_ref = 'REL-04' AND statut = 'VALIDEE'`).n,
    2,
  );
});

test('la contre-passation reprend la piece d origine sans etre tenue pour un doublon', () => {
  const id = comptabiliser({
    journal: 'ACH', date_ecriture: LE('04-06'), date_piece: LE('04-06'),
    piece_ref: 'FA-102', libelle: 'Facture mal imputee',
    lignes: [
      { compte: '606300', libelle: 'Petit equipement', debit: 20_000 },
      { compte: '401000', libelle: 'Fournisseur', credit: 20_000 },
    ],
  });
  const r = contrepasser(id, { date_ecriture: LE('04-07'), motif: 'Compte de charge errone' }, notaire);
  assert.equal(r.contrepassation.piece_ref, 'FA-102');
  assert.equal(r.contrepassation.contrepassation_de, id);
  assert.equal(r.origine.statut, 'CONTREPASSEE');

  // La facture extournee peut etre reimputee sous sa reference d origine.
  const reimpute = comptabiliser({
    journal: 'ACH', date_ecriture: LE('04-08'), date_piece: LE('04-06'),
    piece_ref: 'FA-102', libelle: 'Facture reimputee',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 20_000 },
      { compte: '401000', libelle: 'Fournisseur', credit: 20_000 },
    ],
  });
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: reimpute }).statut, 'VALIDEE');
});

test('l etat de justification des pieces recense les ecritures non justifiees', () => {
  const avant = etatJustificationPieces();
  assert.equal(avant.sans_piece.length, 0);
  assert.equal(avant.doublons.length, 0);
  assert.equal(avant.piece_posterieure.length, 0);
  assert.equal(avant.justifiees, avant.ecritures_comptabilisees);
  assert.ok(avant.conforme);
  // Les brouillons non justifies sont signales sans bloquer : ils ne sont pas
  // encore comptabilises.
  assert.ok(avant.brouillons_sans_piece.length >= 1);
  assert.ok(dossierInspection().justification_pieces.conforme);

  // Simulation d'une base heritee : la reference de piece d'une ecriture deja
  // comptabilisee est effacee en contournant le verrou de la base.
  const id = un(`SELECT id FROM ecritures WHERE statut = 'VALIDEE' ORDER BY id LIMIT 1`).id;
  base().exec('DROP TRIGGER trg_ecriture_maj_interdite');
  exec(`UPDATE ecritures SET piece_ref = '' WHERE id = $id`, { id });

  const apres = etatJustificationPieces();
  assert.equal(apres.conforme, false);
  assert.deepEqual(apres.sans_piece.map((e) => e.id), [id]);
  assert.equal(apres.justifiees, apres.ecritures_comptabilisees - 1);
  assert.ok(anomalies().some((a) => a.code === 'ECRITURE_NON_JUSTIFIEE'));
  // La reference de piece entre dans l'empreinte : l'effacement est detecte.
  assert.equal(verifierChaineEcritures().valide, false);
});
