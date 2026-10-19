process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { ouvrirBase, base, un, exec } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider, contrepasser, verifierChaineEcritures } from '../src/domain/ecritures.js';
import { ouvrirDossier, cloreDossier } from '../src/domain/dossiers.js';
import { etatRepresentationFonds, anomalies } from '../src/domain/controles.js';
import { lettrer } from '../src/domain/lettrage.js';
import { genererFEC } from '../src/reports/fec.js';
import { balance } from '../src/reports/etats.js';
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
    journal: 'BQC', date_ecriture: LE('03-01'), libelle: 'Desequilibre',
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

test('un compte client ne peut pas devenir debiteur', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('03-03'), libelle: 'Debours superieur a la provision',
    lignes: [
      { compte: dossier2.compte_client, libelle: 'Debours', debit: 300_000 },
      { compte: '512500', libelle: 'Paiement', credit: 300_000 },
    ],
  }, notaire);
  refuse('SOLDE_CLIENT_DEBITEUR', () => valider(b.id, notaire));

  // La transaction a ete annulee : rien n'est comptabilise.
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
  assert.equal(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: dossier2.id }).solde, 0);
});

test('les fonds clients restent representes par les disponibilites', () => {
  const f = etatRepresentationFonds();
  assert.equal(f.du_aux_clients, 5_000_000);
  assert.equal(f.fonds_detenus_en_depot, 5_000_000);
  assert.ok(f.conforme);
});

test('un prelevement sur les fonds clients au profit de l office est refuse', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-04'), libelle: 'Ponction indue',
    lignes: [
      { compte: '512100', libelle: 'Vers compte office', debit: 1_000_000 },
      { compte: '512500', libelle: 'Depuis fonds clients', credit: 1_000_000 },
    ],
  }, notaire);
  refuse('FONDS_NON_REPRESENTES', () => valider(b.id, notaire));
});

test('une ecriture melant fonds clients et comptes de gestion est refusee', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-05'), libelle: 'Emoluments encaisses directement',
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
    journal: 'OD', date_ecriture: LE('03-07'), libelle: 'Transfert des emoluments encaisses',
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
    journal: 'EMO', date_ecriture: LE('01-15'), libelle: 'Retrodatee',
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
    journal: 'OD', date_ecriture: LE('03-08'), libelle: 'Imputation erronee',
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
    journal: 'OD', date_ecriture: LE('03-10'), libelle: 'Ecriture a extourner',
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
    journal: 'BQC', date_ecriture: LE('03-11'), libelle: 'Restitution du solde DUPONT',
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

test('les anomalies remontent les brouillons restes en attente', () => {
  const liste = anomalies();
  assert.ok(liste.some((a) => a.code === 'BROUILLONS_EN_ATTENTE'));
  assert.ok(!liste.some((a) => a.code === 'SOLDE_CLIENT_DEBITEUR'));
});
