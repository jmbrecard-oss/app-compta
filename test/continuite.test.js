process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { ouvrirBase, appliquerSchema, base, un, tous, exec } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider, verifierChaineEcritures } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { etatContinuiteLivres } from '../src/domain/continuite.js';
import { controlePreCloture } from '../src/domain/cloture.js';
import { balance } from '../src/reports/etats.js';
import { genererFEC } from '../src/reports/fec.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const dossier = ouvrirDossier({ reference: 'D-001', intitule: 'VENTE DUPONT' }, notaire);

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

/** Refus leve par le moteur de base lui-meme, pas par le code applicatif. */
const refuseBase = (fragment, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus de la base contenant « ${fragment} »`);
  } catch (e) {
    assert.match(e.message, new RegExp(fragment, 'i'));
  }
};

/** Reception de fonds : deux lignes equilibrees, comptabilisees. */
const encaisser = (mmjj, montant) => valider(creerBrouillon({
  journal: 'BQC', date_ecriture: LE(mmjj), piece_ref: `V-${mmjj}`, libelle: `Fonds recus ${mmjj}`,
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: montant },
    { compte: dossier.compte_client, libelle: 'Fonds DUPONT', credit: montant },
  ],
}, notaire).id, notaire).id;

const ECRITURES = [encaisser('03-01', 5_000_000), encaisser('03-02', 1_200_000), encaisser('03-03', 800_000)];

/**
 * Simule une base manipulee par un outil tiers : les verrous d'inalterabilite
 * sont retires le temps de l'alteration, puis retablis. C'est la seule facon
 * de verifier que le controle applicatif detecte une corruption que les
 * declencheurs empechent desormais de produire.
 */
const VERROUS = [
  'trg_ecriture_statut_fige',
  'trg_ecriture_chainage_fige',
  'trg_ecriture_maj_interdite',
  'trg_ligne_ajout_interdit',
  'trg_ligne_maj_interdite',
  'trg_ligne_suppr_interdite',
];

function sansVerrous(fn) {
  for (const t of VERROUS) base().exec(`DROP TRIGGER IF EXISTS ${t}`);
  try {
    return fn();
  } finally {
    appliquerSchema();
  }
}

/** Decomptabilise l'ecriture, execute le scenario, puis remet la base d'aplomb. */
function avecEcritureDecomptabilisee(id, fn) {
  sansVerrous(() => exec(`UPDATE ecritures SET statut = 'BROUILLON' WHERE id = $id`, { id }));
  try {
    return fn();
  } finally {
    sansVerrous(() => exec(`UPDATE ecritures SET statut = 'VALIDEE' WHERE id = $id`, { id }));
  }
}

// --------------------------------------------------------------------------
// Les verrous : la base refuse elle-meme la disparition d'une ecriture
// --------------------------------------------------------------------------

test('une ecriture comptabilisee ne peut pas revenir a l etat de brouillon', () => {
  refuseBase('brouillon', () => exec(
    `UPDATE ecritures SET statut = 'BROUILLON' WHERE id = $id`, { id: ECRITURES[1] },
  ));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: ECRITURES[1] }).statut, 'VALIDEE');
});

test('une ligne ne peut pas etre ajoutee a une ecriture comptabilisee', () => {
  refuseBase("ajout d'une ligne", () => exec(
    `INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
     VALUES ($e, 9, '606400', 'ligne injectee', 77777, 0)`,
    { e: ECRITURES[0] },
  ));
  assert.equal(un('SELECT COUNT(*) AS n FROM lignes WHERE ecriture_id = $e', { e: ECRITURES[0] }).n, 2);
});

test('le chainage d une ecriture comptabilisee est fige', () => {
  refuseBase('chainage', () => exec(
    'UPDATE ecritures SET rang_chaine = NULL WHERE id = $id', { id: ECRITURES[2] },
  ));
  refuseBase('chainage', () => exec(
    `UPDATE ecritures SET valide_par = 'quelqu un d autre' WHERE id = $id`, { id: ECRITURES[2] },
  ));
  assert.equal(verifierChaineEcritures().valide, true);
});

test('la contre-passation reste possible : seul le retour en arriere est verrouille', () => {
  // VALIDEE -> CONTREPASSEE est la transition legitime de correction.
  exec(`UPDATE ecritures SET statut = 'CONTREPASSEE' WHERE id = $id`, { id: ECRITURES[2] });
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: ECRITURES[2] }).statut, 'CONTREPASSEE');
  refuseBase('brouillon', () => exec(
    `UPDATE ecritures SET statut = 'VALIDEE' WHERE id = $id`, { id: ECRITURES[2] },
  ));
  sansVerrous(() => exec(`UPDATE ecritures SET statut = 'VALIDEE' WHERE id = $id`, { id: ECRITURES[2] }));
});

// --------------------------------------------------------------------------
// L'etat de continuite : la preuve a presenter au controle
// --------------------------------------------------------------------------

test('les livres d une comptabilite saine sont continus et concordants', () => {
  const etat = etatContinuiteLivres();
  assert.equal(etat.conforme, true, JSON.stringify(etat.ecarts));
  assert.deepEqual(etat.ecarts, []);

  const bqc = etat.sequences.find((s) => s.journal === 'BQC');
  assert.equal(bqc.premier, 1);
  assert.equal(bqc.dernier, 3);
  assert.equal(bqc.comptabilisees, 3);
  assert.deepEqual(bqc.manquants, []);

  const c = etat.concordance;
  assert.equal(c.concordant, true);
  assert.equal(c.livre_journal.debit, c.balance.debit);
  assert.equal(c.livre_journal.credit, c.balance.credit);
  assert.equal(c.balance.debit, balance().totaux.debit);
});

test('une ecriture decomptabilisee par acces direct est detectee', () => {
  avecEcritureDecomptabilisee(ECRITURES[1], () => {
    // Ce que l'alteration produit : l'ecriture quitte tous les etats.
    assert.equal(balance().totaux.debit, 5_800_000);
    assert.equal(balance().equilibree, true, 'la disparition est equilibree, donc muette');
    assert.equal(genererFEC().trim().split('\n').length - 1, 4);

    // Et ce que la chaine d'empreintes, a elle seule, n'y voit pas.
    assert.equal(verifierChaineEcritures().valide, true,
      'le chainage ne porte pas sur le statut : il ne peut pas detecter la disparition');

    const etat = etatContinuiteLivres();
    assert.equal(etat.conforme, false);
    const codes = etat.ecarts.map((e) => e.code);
    assert.ok(codes.includes('BROUILLON_NUMEROTE'), `codes releves : ${codes}`);
    assert.ok(codes.includes('NUMERO_MANQUANT'), `codes releves : ${codes}`);
    assert.ok(etat.ecarts.every((e) => e.gravite === 'CRITIQUE'));

    const bqc = etat.sequences.find((s) => s.journal === 'BQC');
    assert.deepEqual(bqc.manquants, [2]);
    assert.equal(bqc.comptabilisees, 2);
  });

  assert.equal(etatContinuiteLivres().conforme, true, 'la base est rendue saine apres le scenario');
});

test('une ecriture comptabilisee hors chaine est detectee', () => {
  sansVerrous(() => exec('UPDATE ecritures SET rang_chaine = NULL, hash = NULL WHERE id = $id', { id: ECRITURES[0] }));
  try {
    const codes = etatContinuiteLivres().ecarts.map((e) => e.code);
    assert.ok(codes.includes('ECRITURE_HORS_CHAINE'), `codes releves : ${codes}`);
  } finally {
    sansVerrous(() => exec(
      'UPDATE ecritures SET rang_chaine = 1, hash = $h WHERE id = $id',
      { id: ECRITURES[0], h: un('SELECT hash_precedent FROM ecritures WHERE rang_chaine = 2').hash_precedent },
    ));
  }
  assert.equal(etatContinuiteLivres().conforme, true);
});

test('une ligne imputee sur un compte collectif echappe a la balance et est signalee', () => {
  // Le compte collectif 411000 est exclu de la balance par construction :
  // deux lignes qui s'y equilibrent disparaissent de l'etat sans le desequilibrer.
  const avant = balance().totaux.debit;
  sansVerrous(() => {
    exec(`INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
          VALUES ($e, 8, '411000', 'imputation collective', 450000, 0)`, { e: ECRITURES[0] });
    exec(`INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
          VALUES ($e, 9, '411000', 'imputation collective', 0, 450000)`, { e: ECRITURES[0] });
  });
  try {
    assert.equal(balance().totaux.debit, avant, 'la balance ignore le compte collectif');
    assert.equal(balance().equilibree, true);

    const etat = etatContinuiteLivres();
    assert.equal(etat.conforme, false);
    assert.equal(etat.concordance.concordant, false);
    assert.equal(etat.concordance.livre_journal.debit - etat.concordance.balance.debit, 450000);
    assert.ok(etat.ecarts.some((e) => e.code === 'LIGNE_SUR_COMPTE_COLLECTIF'),
      `codes releves : ${etat.ecarts.map((e) => e.code)}`);
  } finally {
    sansVerrous(() => exec('DELETE FROM lignes WHERE ecriture_id = $e AND ordre IN (8, 9)', { e: ECRITURES[0] }));
  }
  assert.equal(etatContinuiteLivres().conforme, true);
});

test('une ecriture comptabilisee desequilibree est detectee', () => {
  sansVerrous(() => exec(
    `INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
     VALUES ($e, 7, '606400', 'ligne injectee', 77777, 0)`, { e: ECRITURES[0] },
  ));
  try {
    const ecarts = etatContinuiteLivres().ecarts;
    assert.ok(ecarts.some((e) => e.code === 'ECRITURE_DESEQUILIBREE'),
      `codes releves : ${ecarts.map((e) => e.code)}`);
  } finally {
    sansVerrous(() => exec('DELETE FROM lignes WHERE ecriture_id = $e AND ordre = 7', { e: ECRITURES[0] }));
  }
  assert.equal(etatContinuiteLivres().conforme, true);
});

// --------------------------------------------------------------------------
// Les consequences : plus aucune ecriture ni aucune cloture sur des livres troues
// --------------------------------------------------------------------------

test('la comptabilisation est refusee sur un journal dont la sequence est interrompue', () => {
  avecEcritureDecomptabilisee(ECRITURES[1], () => {
    const b = creerBrouillon({
      journal: 'BQC', date_ecriture: LE('03-04'), libelle: 'Fonds recus apres le trou',
      lignes: [
        { compte: '512500', libelle: 'Virement recu', debit: 300_000 },
        { compte: dossier.compte_client, libelle: 'Fonds DUPONT', credit: 300_000 },
      ],
    }, notaire);
    refuse('SEQUENCE_INTERROMPUE', () => valider(b.id, notaire));
    assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
    exec('DELETE FROM lignes WHERE ecriture_id = $id', { id: b.id });
    exec('DELETE FROM ecritures WHERE id = $id', { id: b.id });
  });
});

test('un journal indemne reste utilisable quand un autre est interrompu', () => {
  avecEcritureDecomptabilisee(ECRITURES[1], () => {
    const id = valider(creerBrouillon({
      journal: 'OD', date_ecriture: LE('03-04'), libelle: 'Operation diverse',
      lignes: [
        { compte: '471000', libelle: 'En attente', debit: 10_000 },
        { compte: '467000', libelle: 'A imputer', credit: 10_000 },
      ],
    }, notaire).id, notaire).id;
    assert.equal(un('SELECT numero FROM ecritures WHERE id = $id', { id }).numero, 1);
  });
});

test('la cloture est refusee tant que les livres ne sont pas continus', () => {
  const exercice = un(`SELECT id FROM exercices ORDER BY date_debut LIMIT 1`).id;
  assert.ok(!controlePreCloture(exercice).obstacles.some((o) => o.code === 'LIVRES_DISCONTINUS'));

  avecEcritureDecomptabilisee(ECRITURES[1], () => {
    const obstacles = controlePreCloture(exercice).obstacles;
    const bloquant = obstacles.find((o) => o.code === 'LIVRES_DISCONTINUS');
    assert.ok(bloquant, `obstacles releves : ${obstacles.map((o) => o.code)}`);
    assert.match(bloquant.message, /BQC/);
  });
});

test('l etat de continuite couvre tous les journaux mouvementes', () => {
  const journaux = new Set(tous(
    `SELECT DISTINCT journal FROM ecritures WHERE statut <> 'BROUILLON'`,
  ).map((r) => r.journal));
  const couverts = new Set(etatContinuiteLivres().sequences.map((s) => s.journal));
  assert.deepEqual([...journaux].sort(), [...couverts].sort());
});

test('un exercice clos scelle ses livres : plus aucune ecriture n y entre', () => {
  const exercice = un('SELECT id FROM exercices ORDER BY date_debut LIMIT 1').id;
  exec(`UPDATE exercices SET statut = 'CLOS' WHERE id = $id`, { id: exercice });
  try {
    refuse('EXERCICE_CLOS', () => creerBrouillon({
      journal: 'OD', date_ecriture: LE('03-09'), libelle: 'Apres cloture',
      lignes: [
        { compte: '471000', libelle: 'En attente', debit: 1000 },
        { compte: '467000', libelle: 'A imputer', credit: 1000 },
      ],
    }, notaire));
  } finally {
    exec(`UPDATE exercices SET statut = 'OUVERT' WHERE id = $id`, { id: exercice });
  }
});
