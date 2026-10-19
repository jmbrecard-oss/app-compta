process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ouvrirBase, un, exec } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider, contrepasser } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { anomalies, etatRepresentationFonds } from '../src/domain/controles.js';
import { controlePreCloture } from '../src/domain/cloture.js';
import {
  parametresEspeces,
  validerParametresEspeces,
  soldeProgressif,
  registreDesEspeces,
  cumulEspecesDossier,
  EST_COMPTE_ESPECES,
} from '../src/domain/especes.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const dossier = ouvrirDossier({ reference: 'E-001', intitule: 'VENTE MARTIN' }, notaire);
const dossier2 = ouvrirDossier({ reference: 'E-002', intitule: 'SUCCESSION PAITA' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire);

const refuse = (code, saisie) => {
  const b = creerBrouillon(saisie, notaire);
  try {
    valider(b.id, notaire);
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
  // Un refus annule toute l'ecriture : elle reste en brouillon.
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
  return b;
};

const soldeDe = (compte) => un('SELECT solde FROM v_soldes WHERE numero = $n', { n: compte }).solde;

// Mise en place : l'office dispose de fonds propres en banque, puis alimente sa caisse.
comptabiliser({
  journal: 'OD', date_ecriture: LE('01-05'), piece_ref: 'AP-1', libelle: 'Apport initial',
  lignes: [
    { compte: '512100', libelle: 'Apport', debit: 10_000_000 },
    { compte: '101000', libelle: 'Capital', credit: 10_000_000 },
  ],
});
comptabiliser({
  journal: 'CAI', date_ecriture: LE('01-06'), piece_ref: 'CAI-1', libelle: 'Alimentation de la caisse',
  lignes: [
    { compte: '531000', libelle: 'Retrait d especes', debit: 2_000_000 },
    { compte: '512100', libelle: 'Retrait au guichet', credit: 2_000_000 },
  ],
});

// --------------------------------------------------------------- parametres

test('le plafond des especes est lu dans un fichier de parametres, marque non valide', () => {
  const p = parametresEspeces();
  assert.equal(p.statut, 'NON_VALIDE');
  assert.equal(p.source, null);
  assert.match(p.avertissement, /FICTIVES/);
  assert.ok(Number.isInteger(p.plafond_reglement_xpf));
  assert.ok(Number.isInteger(p.plafond_cumul_dossier_xpf));
  // L'empreinte du fichier est conservee : un controle reste verifiable apres
  // remplacement des parametres.
  assert.match(p.empreinte, /^[0-9a-f]{64}$/);
});

test('des parametres mal formes sont refuses en bloc', () => {
  const base = {
    code: 'X', statut: 'NON_VALIDE', source: null, avertissement: '',
    plafond_reglement_xpf: 100000, plafond_cumul_dossier_xpf: 200000,
    encaisse_maximale_xpf: 50000, piece_justificative_obligatoire: true,
  };
  assert.doesNotThrow(() => validerParametresEspeces(base));

  const invalide = (modif) => {
    try {
      validerParametresEspeces({ ...base, ...modif });
      assert.fail(`attendu un refus pour ${JSON.stringify(modif)}`);
    } catch (e) {
      assert.equal(e.code, 'PARAMETRES_ESPECES_INVALIDES');
    }
  };
  invalide({ statut: 'AGREE' });                        // statut hors nomenclature
  invalide({ plafond_reglement_xpf: 100000.5 });        // le XPF n a pas de decimale
  invalide({ plafond_reglement_xpf: -1 });
  invalide({ piece_justificative_obligatoire: 'oui' }); // doit etre un booleen
  // Un cumul inferieur au plafond unitaire rendrait le plafond unitaire inapplicable.
  invalide({ plafond_cumul_dossier_xpf: 50000 });
});

// ------------------------------------------- les deux caisses sont distinctes

test('les especes detenues pour les clients ont leur propre caisse, qui represente les fonds', () => {
  const c = un('SELECT * FROM comptes WHERE numero = $n', { n: '531500' });
  assert.ok(c, 'le compte 531500 doit figurer au plan comptable');
  assert.equal(c.nature, 'DEPOT_FONDS_CLIENTS');
  assert.ok(EST_COMPTE_ESPECES('531500') && EST_COMPTE_ESPECES('531000'));
  assert.ok(!EST_COMPTE_ESPECES('512500'));
});

test('la caisse de l office ne peut pas recevoir les fonds d un client', () => {
  refuse('ESPECE_CAISSE_OFFICE_FONDS_CLIENTS', {
    journal: 'CAI', date_ecriture: LE('01-07'), piece_ref: 'R-0', libelle: 'Especes recues de MARTIN',
    lignes: [
      { compte: '531000', libelle: 'Especes recues', debit: 100_000 },
      { compte: dossier.compte_client, libelle: 'Provision MARTIN', credit: 100_000 },
    ],
  });
});

// ------------------------------------------------- justification et plafonds

test('un mouvement d especes sans piece justificative est refuse', () => {
  refuse('ESPECE_SANS_JUSTIFICATION', {
    journal: 'CAI', date_ecriture: LE('01-07'), piece_ref: '', libelle: 'Fournitures reglees en especes',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 20_000 },
      { compte: '531000', libelle: 'Especes', credit: 20_000 },
    ],
  });
});

test('un reglement en especes au-dela du plafond est refuse', () => {
  refuse('PLAFOND_ESPECES_DEPASSE', {
    journal: 'CAI', date_ecriture: LE('01-07'), piece_ref: 'F-9', libelle: 'Fournisseur regle en especes',
    lignes: [
      { compte: '401000', libelle: 'Fournisseur', debit: 1_200_000 },
      { compte: '531000', libelle: 'Especes', credit: 1_200_000 },
    ],
  });
});

test('un reglement fractionne sur plusieurs lignes ne passe pas sous le plafond', () => {
  refuse('PLAFOND_ESPECES_DEPASSE', {
    journal: 'CAI', date_ecriture: LE('01-07'), piece_ref: 'F-10', libelle: 'Fournisseur regle en deux remises',
    lignes: [
      { compte: '401000', libelle: 'Fournisseur', debit: 1_200_000 },
      { compte: '531000', libelle: 'Premiere remise', credit: 600_000 },
      { compte: '531000', libelle: 'Seconde remise', credit: 600_000 },
    ],
  });
});

test('le versement des especes en banque n est pas un reglement : le plafond ne s y applique pas', () => {
  comptabiliser({
    journal: 'CAI', date_ecriture: LE('01-08'), piece_ref: 'DEP-1', libelle: 'Versement d especes en banque',
    lignes: [
      { compte: '512100', libelle: 'Bordereau de versement', debit: 1_500_000 },
      { compte: '531000', libelle: 'Sortie de caisse', credit: 1_500_000 },
    ],
  });
  assert.equal(soldeDe('531000'), 500_000);
});

// --------------------------------------------------- rattachement au dossier

test('un reglement en especes ne peut pas concerner deux dossiers', () => {
  refuse('ESPECE_MULTI_DOSSIER', {
    journal: 'CAI', date_ecriture: LE('01-09'), piece_ref: 'R-1', libelle: 'Especes recues pour deux affaires',
    lignes: [
      { compte: '531500', libelle: 'Especes recues', debit: 300_000 },
      { compte: dossier.compte_client, libelle: 'Provision MARTIN', credit: 200_000 },
      { compte: dossier2.compte_client, libelle: 'Provision PAITA', credit: 100_000 },
    ],
  });
});

test('les especes recues pour un client representent ses fonds', () => {
  const avant = etatRepresentationFonds();
  comptabiliser({
    journal: 'CAI', date_ecriture: LE('01-10'), piece_ref: 'R-2', libelle: 'Especes recues de MARTIN',
    lignes: [
      { compte: '531500', libelle: 'Especes recues', debit: 900_000 },
      { compte: dossier.compte_client, libelle: 'Provision MARTIN', credit: 900_000 },
    ],
  });
  const apres = etatRepresentationFonds();
  assert.equal(apres.du_aux_clients, avant.du_aux_clients + 900_000);
  assert.equal(apres.representation_totale, avant.representation_totale + 900_000);
  assert.ok(apres.conforme);
});

test('le cumul des especes recues sur un dossier est plafonne', () => {
  // Deuxieme remise : chacune reste sous le plafond unitaire, le cumul passe.
  comptabiliser({
    journal: 'CAI', date_ecriture: LE('01-11'), piece_ref: 'R-3', libelle: 'Deuxieme remise MARTIN',
    lignes: [
      { compte: '531500', libelle: 'Especes recues', debit: 900_000 },
      { compte: dossier.compte_client, libelle: 'Provision MARTIN', credit: 900_000 },
    ],
  });
  // Troisieme remise : 2 300 000 cumules pour un plafond de 2 000 000.
  refuse('PLAFOND_ESPECES_CUMUL_DEPASSE', {
    journal: 'CAI', date_ecriture: LE('01-12'), piece_ref: 'R-4', libelle: 'Troisieme remise MARTIN',
    lignes: [
      { compte: '531500', libelle: 'Especes recues', debit: 500_000 },
      { compte: dossier.compte_client, libelle: 'Provision MARTIN', credit: 500_000 },
    ],
  });
  assert.equal(soldeDe('531500'), 1_800_000);
  // Le plafond est propre a chaque dossier : un autre dossier reste servi.
  comptabiliser({
    journal: 'CAI', date_ecriture: LE('01-12'), piece_ref: 'R-5', libelle: 'Remise PAITA',
    lignes: [
      { compte: '531500', libelle: 'Especes recues', debit: 500_000 },
      { compte: dossier2.compte_client, libelle: 'Provision PAITA', credit: 500_000 },
    ],
  });
});

// -------------------------------------------------- une caisse jamais negative

test('la caisse ne peut pas devenir creditrice', () => {
  refuse('CAISSE_CREDITRICE', {
    journal: 'CAI', date_ecriture: LE('01-13'), piece_ref: 'F-11', libelle: 'Reglement superieur a l encaisse',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 700_000 },
      { compte: '531000', libelle: 'Especes', credit: 700_000 },
    ],
  });
  assert.equal(soldeDe('531000'), 500_000);
});

test('la caisse ne peut pas non plus etre creditrice a une date intermediaire', () => {
  // 400 000 sortis le 03 janvier, avant que la caisse ne soit alimentee le 06 :
  // le solde final resterait positif (100 000), mais la caisse aurait ete
  // creditrice pendant trois jours. Un solde final ne prouve rien.
  refuse('CAISSE_CREDITRICE', {
    journal: 'ACH', date_ecriture: LE('01-03'), piece_ref: 'F-12', libelle: 'Achat regle en especes',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 400_000 },
      { compte: '531000', libelle: 'Especes', credit: 400_000 },
    ],
  });
  assert.equal(soldeDe('531000'), 500_000);
});

test('le solde progressif retient le minimum atteint et sa date', () => {
  const r = soldeProgressif([
    { date_ecriture: '2026-01-02', debit: 100, credit: 0 },
    { date_ecriture: '2026-01-05', debit: 0, credit: 150 },
    { date_ecriture: '2026-01-09', debit: 300, credit: 0 },
  ]);
  assert.equal(r.solde_final, 250);
  assert.equal(r.solde_minimum, -50);
  assert.equal(r.date_minimum, '2026-01-05');
  assert.equal(r.jamais_creditrice, false);
  assert.deepEqual(r.mouvements.map((m) => m.solde_progressif), [100, -50, 250]);

  const sain = soldeProgressif([{ date_ecriture: '2026-01-02', debit: 10, credit: 0 }]);
  assert.equal(sain.jamais_creditrice, true);
  assert.equal(sain.solde_minimum, 10);
});

// ------------------------------------------------------------------ registre

test('le registre des especes retrace chaque mouvement, caisse par caisse', () => {
  const r = registreDesEspeces();
  const office = r.caisses.find((c) => c.compte === '531000');
  const clients = r.caisses.find((c) => c.compte === '531500');

  assert.equal(office.solde_final, 500_000);
  assert.equal(office.encaissements, 2_000_000);
  assert.equal(office.decaissements, 1_500_000);
  assert.ok(office.jamais_creditrice);

  assert.equal(clients.solde_final, 2_300_000);
  assert.equal(clients.mouvements.length, 3);
  // Aucun brouillon refuse ne figure au registre.
  assert.ok(!clients.mouvements.some((m) => m.piece_ref === 'R-4'));

  // Les especes recues sont ventilees par dossier : c est ce que verifie un controle.
  const parDossier = Object.fromEntries(r.cumul_par_dossier.map((d) => [d.reference, d.encaissements]));
  assert.equal(parDossier['E-001'], 1_800_000);
  assert.equal(parDossier['E-002'], 500_000);

  // Le dossier est porte par la ligne de compte client, pas par celle de la
  // caisse : le registre doit malgre tout l'imputer, sans quoi la colonne
  // « dossier » reste vide la ou elle importe le plus.
  assert.deepEqual(clients.mouvements.map((m) => m.dossier), ['E-001', 'E-001', 'E-002']);

  assert.equal(r.parametres.statut, 'NON_VALIDE');
  assert.equal(r.totaux.solde_final, 2_800_000);
});

test('le registre se borne a la periode demandee', () => {
  const r = registreDesEspeces({ depuis: LE('01-08'), jusqu: LE('01-08') });
  const office = r.caisses.find((c) => c.compte === '531000');
  assert.equal(office.solde_ouverture, 2_000_000);
  assert.equal(office.mouvements.length, 1);
  assert.equal(office.solde_final, 500_000);
});

test('une remise en especes contre-passee sort du cumul du dossier', () => {
  const remise = un(
    `SELECT id FROM ecritures WHERE piece_ref = 'R-5' AND statut = 'VALIDEE'`,
  );
  const r = contrepasser(remise.id, { date_ecriture: LE('01-13'), motif: 'Remise annulee' }, notaire);
  assert.equal(r.origine.statut, 'CONTREPASSEE');

  // La contre-passation est le seul moyen de corriger : elle ne doit buter ni
  // sur le plafond, ni sur la piece justificative, ni sur la caisse.
  assert.equal(soldeDe('531500'), 1_800_000);
  assert.equal(cumulEspecesDossier(dossier2.id), 0);
  // Et le dossier redevient financable en especes a hauteur du plafond entier.
  comptabiliser({
    journal: 'CAI', date_ecriture: LE('01-13'), piece_ref: 'R-6', libelle: 'Nouvelle remise PAITA',
    lignes: [
      { compte: '531500', libelle: 'Especes recues', debit: 500_000 },
      { compte: dossier2.compte_client, libelle: 'Provision PAITA', credit: 500_000 },
    ],
  });
  assert.equal(cumulEspecesDossier(dossier2.id), 500_000);

  // Ni la remise annulee ni son extourne ne doivent apparaitre au registre
  // comme des especes rendues au client : rien n'est sorti de la caisse.
  const ventilation = registreDesEspeces().cumul_par_dossier.find((d) => d.reference === 'E-002');
  assert.equal(ventilation.encaissements, 500_000);
  assert.equal(ventilation.decaissements, 0);
});

// ------------------------------------------------------- parametres externes

test('COMPTA_ESPECES designe un autre fichier de parametres', () => {
  const dossierTmp = mkdtempSync(join(tmpdir(), 'especes-'));
  const fichier = join(dossierTmp, 'especes.json');
  writeFileSync(fichier, JSON.stringify({
    code: 'ESPECES-TEST', statut: 'NON_VALIDE', source: null, avertissement: 'test',
    plafond_reglement_xpf: 50_000, plafond_cumul_dossier_xpf: 50_000,
    encaisse_maximale_xpf: null, piece_justificative_obligatoire: true,
  }));
  const precedent = process.env.COMPTA_ESPECES;
  process.env.COMPTA_ESPECES = fichier;
  try {
    assert.equal(parametresEspeces().plafond_reglement_xpf, 50_000);
    refuse('PLAFOND_ESPECES_DEPASSE', {
      journal: 'CAI', date_ecriture: LE('01-14'), piece_ref: 'F-13', libelle: 'Achat regle en especes',
      lignes: [
        { compte: '606400', libelle: 'Fournitures', debit: 60_000 },
        { compte: '531000', libelle: 'Especes', credit: 60_000 },
      ],
    });
  } finally {
    if (precedent === undefined) delete process.env.COMPTA_ESPECES;
    else process.env.COMPTA_ESPECES = precedent;
  }
  assert.equal(parametresEspeces().code, 'ESPECES-NC-DEMO');
});

// ------------------------------------------------------------------ anomalies

test('les parametres non valides et l encaisse excessive remontent en anomalie', () => {
  const liste = anomalies();
  const params = liste.find((a) => a.code === 'PARAMETRES_ESPECES_NON_VALIDES');
  assert.ok(params, 'un bareme non valide doit etre signale');
  assert.equal(params.gravite, 'CRITIQUE');

  const encaisse = liste.find((a) => a.code === 'ENCAISSE_EXCESSIVE');
  assert.ok(encaisse, '500 000 XPF en caisse pour un maximum de 300 000 doit etre signale');
  assert.ok(!liste.some((a) => a.code === 'CAISSE_CREDITRICE'));
});

// Donnees anterieures au controle : une ecriture inseree directement en base,
// comme peut l'etre une reprise d'antériorité ou une ecriture d'un logiciel
// precedent. Les controles ne l'ont jamais vue ; la detection doit la trouver.
// Ce test doit rester le dernier : il rend la caisse creditrice.
test('une caisse creditrice heritee est detectee et bloque la cloture', () => {
  const ex = un(`SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1`);
  const r = exec(
    `INSERT INTO ecritures (exercice_id, journal, numero, date_ecriture, date_piece, piece_ref,
       libelle, statut, cree_le, cree_par)
     VALUES ($ex, 'OD', 9999, $d, $d, 'REPRISE', 'Reprise d anteriorite', 'VALIDEE', $now, 'reprise')`,
    { ex: ex.id, d: LE('01-15'), now: new Date().toISOString() },
  );
  const id = Number(r.lastInsertRowid);
  exec(`INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
        VALUES ($e, 1, '606400', 'Charge reprise', 2000000, 0)`, { e: id });
  exec(`INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
        VALUES ($e, 2, '531000', 'Especes reprises', 0, 2000000)`, { e: id });

  assert.equal(soldeDe('531000'), -1_500_000);

  const alerte = anomalies().find((a) => a.code === 'CAISSE_CREDITRICE');
  assert.ok(alerte, 'une caisse creditrice doit remonter en anomalie');
  assert.equal(alerte.gravite, 'CRITIQUE');
  assert.match(alerte.message, new RegExp(LE('01-15')));

  const diag = controlePreCloture(ex.id);
  assert.ok(diag.obstacles.some((o) => o.code === 'CAISSE_CREDITRICE'));
  assert.equal(diag.pret, false);
});
