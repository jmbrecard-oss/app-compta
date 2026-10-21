process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ouvrirBase, un } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider, contrepasser } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { controlePreCloture } from '../src/domain/cloture.js';
import { anomalies } from '../src/domain/controles.js';
import {
  chargerParametresTgc,
  liquiderTgc,
  identifierTauxTgc,
  etatTgc,
  periodesTgc,
  propositionLiquidationTgc,
  anomaliesTgc,
} from '../src/domain/tgc.js';

const ICI = join(fileURLToPath(import.meta.url), '..');

// L'exercice de test porte sur l'annee precedente : toutes ses periodes de
// declaration sont echues, quelle que soit la date d'execution des tests.
const ANNEE = new Date().getFullYear() - 1;
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', motDePasse: 'motdepasse-test', annee: ANNEE });
const exercice = un('SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1');

const dossier = ouvrirDossier({ reference: 'T-001', intitule: 'VENTE MARTIN' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

const solde = (compte) => un('SELECT solde FROM v_soldes WHERE numero = $n', { n: compte }).solde;

// ---------------------------------------------------------------------------
// 1. Les parametres de taxe ne peuvent pas se presenter comme reglementaires
//    sans source.
// ---------------------------------------------------------------------------

test('les parametres de TGC livres sont marques a valider et portent un avertissement', () => {
  const p = chargerParametresTgc();
  assert.equal(p.statut, 'A_VALIDER');
  assert.ok(p.avertissement.length > 40, 'un avertissement explicite est obligatoire');
  assert.ok(p.taux.every((t) => t.sourcee === false), 'aucun taux livre ne se declare source');
});

test('un jeu de parametres qui se declare VALIDE sans reference est refuse', () => {
  refuse('PARAMETRES_TGC_INVALIDES', () => chargerParametresTgc(join(ICI, 'tgc-sans-reference.json')));
});

test('la liquidation applique le taux en milliemes, en entiers de XPF', () => {
  assert.equal(liquiderTgc(400_000, 110), 44_000);
  assert.equal(liquiderTgc(12_345, 110), 1_358);          // 1 357,95 arrondi au plus proche
  assert.equal(liquiderTgc(12_345, 110, 'INFERIEUR'), 1_357);
  assert.equal(liquiderTgc(12_345, 110, 'SUPERIEUR'), 1_358);
  assert.equal(liquiderTgc(-400_000, 110), -44_000);      // extourne : symetrie exacte
  assert.ok(Number.isInteger(liquiderTgc(999_999, 30)));
});

test('le taux est identifie a partir de l assiette et de la taxe', () => {
  assert.equal(identifierTauxTgc(400_000, 44_000).taux_millieme, 110);
  assert.equal(identifierTauxTgc(12_345, 1_357).taux_millieme, 110);   // arrondi inferieur admis
  assert.equal(identifierTauxTgc(400_000, 40_000), null);              // 10 % n existe pas
  assert.equal(identifierTauxTgc(0, 44_000), null);
});

// ---------------------------------------------------------------------------
// 2. Controle bloquant : toute TGC comptabilisee est justifiee par une assiette
// ---------------------------------------------------------------------------

test('une facture d emoluments dont la TGC correspond a l assiette est comptabilisee', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('01-05'), piece_ref: 'V-1', libelle: 'Fonds recus MARTIN',
    lignes: [
      { compte: '512500', libelle: 'Virement recu', debit: 5_000_000 },
      { compte: dossier.compte_client, libelle: 'Fonds MARTIN', credit: 5_000_000 },
    ],
  });
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('01-10'), piece_ref: 'F-1', libelle: 'Emoluments vente MARTIN',
    lignes: [
      { compte: dossier.compte_client, libelle: 'Emoluments TTC', debit: 444_000 },
      { compte: '706100', libelle: 'Emoluments d acte', credit: 400_000 },
      { compte: '445700', libelle: 'TGC collectee', credit: 44_000 },
    ],
  });
  assert.equal(solde('445700'), -44_000);
});

test('une TGC collectee qui ne correspond a aucun taux en vigueur est refusee', () => {
  const b = creerBrouillon({
    journal: 'EMO', date_ecriture: LE('01-11'), piece_ref: 'P-5015', libelle: 'Emoluments taxes a 10 %',
    lignes: [
      { compte: dossier.compte_client, libelle: 'Emoluments TTC', debit: 440_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 400_000 },
      { compte: '445700', libelle: 'TGC', credit: 40_000 },
    ],
  }, notaire);
  refuse('TGC_ASSIETTE_INCOHERENTE', () => valider(b.id, notaire));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
});

test('une TGC collectee sans assiette est refusee', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('01-11'), piece_ref: 'P-4725', libelle: 'TGC sans produit',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 44_000 },
      { compte: '445700', libelle: 'TGC de nulle part', credit: 44_000 },
    ],
  }, notaire);
  refuse('TGC_SANS_ASSIETTE', () => valider(b.id, notaire));
});

test('l arrondi au franc le plus proche ou au franc inferieur est admis', () => {
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('01-12'), piece_ref: 'F-2', libelle: 'Emoluments arrondi superieur',
    lignes: [
      { compte: dossier.compte_client, libelle: 'TTC', debit: 13_703 },
      { compte: '706200', libelle: 'Emoluments de formalites', credit: 12_345 },
      { compte: '445700', libelle: 'TGC 11 %', credit: 1_358 },
    ],
  });
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('01-12'), piece_ref: 'F-3', libelle: 'Emoluments arrondi inferieur',
    lignes: [
      { compte: dossier.compte_client, libelle: 'TTC', debit: 13_702 },
      { compte: '706200', libelle: 'Emoluments de formalites', credit: 12_345 },
      { compte: '445700', libelle: 'TGC 11 %', credit: 1_357 },
    ],
  });
  assert.equal(solde('445700'), -(44_000 + 1_358 + 1_357));
});

test('un ecart superieur au franc d arrondi est refuse', () => {
  const b = creerBrouillon({
    journal: 'EMO', date_ecriture: LE('01-13'), piece_ref: 'P-0662', libelle: 'TGC minoree de deux francs',
    lignes: [
      { compte: dossier.compte_client, libelle: 'TTC', debit: 13_701 },
      { compte: '706200', libelle: 'Emoluments', credit: 12_345 },
      { compte: '445700', libelle: 'TGC', credit: 1_356 },
    ],
  }, notaire);
  refuse('TGC_ASSIETTE_INCOHERENTE', () => valider(b.id, notaire));
});

test('la TGC deductible est controlee sur l assiette des achats', () => {
  comptabiliser({
    journal: 'ACH', date_ecriture: LE('01-15'), piece_ref: 'A-1', libelle: 'Fournitures administratives',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 100_000 },
      { compte: '445600', libelle: 'TGC deductible', debit: 11_000 },
      { compte: '401000', libelle: 'Fournisseur', credit: 111_000 },
    ],
  });
  assert.equal(solde('445600'), 11_000);

  const b = creerBrouillon({
    journal: 'ACH', date_ecriture: LE('01-16'), piece_ref: 'P-1879', libelle: 'TGC deductible gonflee',
    lignes: [
      { compte: '606400', libelle: 'Fournitures', debit: 100_000 },
      { compte: '445600', libelle: 'TGC deductible', debit: 25_000 },
      { compte: '401000', libelle: 'Fournisseur', credit: 125_000 },
    ],
  }, notaire);
  refuse('TGC_ASSIETTE_INCOHERENTE', () => valider(b.id, notaire));
});

test('les a-nouveaux ne sont pas soumis au controle d assiette', () => {
  // Le journal des a-nouveaux reprend des soldes : il ne constitue pas de TGC.
  const b = creerBrouillon({
    journal: 'AN', date_ecriture: LE('01-01'), piece_ref: 'P-7719', libelle: 'Reprise de solde de TGC',
    lignes: [
      { compte: '445700', libelle: 'A nouveau TGC collectee', debit: 7_000 },
      { compte: '445600', libelle: 'A nouveau TGC deductible', credit: 7_000 },
    ],
  }, notaire);
  const id = valider(b.id, notaire).id;
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id }).statut, 'VALIDEE');
  // Remis a zero pour ne pas fausser les etats qui suivent.
  contrepasser(id, { date_ecriture: LE('01-01'), motif: 'Reprise de test' }, notaire);
  assert.equal(solde('445600'), 11_000);
});

// ---------------------------------------------------------------------------
// 3. Etat preparatoire a la declaration
// ---------------------------------------------------------------------------

test('l etat preparatoire ventile la TGC collectee par taux et par assiette', () => {
  const e = etatTgc({ depuis: LE('01-01'), jusqu: LE('01-31') });
  const g = e.collectee.taux.find((t) => t.taux_millieme === 110);
  assert.equal(g.assiette, 400_000 + 12_345 + 12_345);
  assert.equal(g.taxe, 44_000 + 1_358 + 1_357);
  assert.equal(g.ecritures, 3);
  assert.equal(e.collectee.total, 46_715);
  assert.equal(e.deductible.total, 11_000);
  assert.equal(e.deductible.assiette_totale, 100_000);
});

test('l etat preparatoire rapproche la ventilation du mouvement comptable', () => {
  const e = etatTgc({ depuis: LE('01-01'), jusqu: LE('01-31') });
  assert.equal(e.controle.ecart_collectee, 0);
  assert.equal(e.controle.ecart_deductible, 0);
  assert.equal(e.non_ventilees.length, 0);
  assert.ok(e.controle.justifie);
});

test('l etat preparatoire calcule la TGC nette due au Tresor', () => {
  const e = etatTgc({ depuis: LE('01-01'), jusqu: LE('01-31') });
  assert.equal(e.net.montant, 46_715 - 11_000);
  assert.equal(e.net.a_decaisser, 35_715);
  assert.equal(e.net.credit_reportable, 0);
});

test('l etat preparatoire ignore les brouillons', () => {
  creerBrouillon({
    journal: 'EMO', date_ecriture: LE('01-20'), piece_ref: 'P-5437', libelle: 'Brouillon non comptabilise',
    lignes: [
      { compte: dossier.compte_client, libelle: 'TTC', debit: 111_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 100_000 },
      { compte: '445700', libelle: 'TGC', credit: 11_000 },
    ],
  }, notaire);
  const e = etatTgc({ depuis: LE('01-01'), jusqu: LE('01-31') });
  assert.equal(e.collectee.total, 46_715);
});

test('l etat preparatoire porte l avertissement sur les parametres non valides', () => {
  const e = etatTgc({ depuis: LE('01-01'), jusqu: LE('01-31') });
  assert.equal(e.parametres.statut, 'A_VALIDER');
  assert.ok(e.parametres.avertissement.length > 40);
});

// ---------------------------------------------------------------------------
// 4. Ecriture de liquidation
// ---------------------------------------------------------------------------

test('l ecriture de liquidation proposee est equilibree et passe les controles', () => {
  const p = propositionLiquidationTgc({ depuis: LE('01-01'), jusqu: LE('01-31') });
  const debit = p.lignes.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credit = p.lignes.reduce((s, l) => s + (l.credit ?? 0), 0);
  assert.equal(debit, credit);
  assert.equal(p.lignes.find((l) => l.compte === '445700').debit, 46_715);
  assert.equal(p.lignes.find((l) => l.compte === '445600').credit, 11_000);
  assert.equal(p.lignes.find((l) => l.compte === '445500').credit, 35_715);

  comptabiliser(p);
  assert.equal(solde('445700'), 0);
  assert.equal(solde('445600'), 0);
  assert.equal(solde('445500'), -35_715);
});

test('la TGC declaree et non encore reglee est signalee', () => {
  const due = anomaliesTgc().find((x) => x.code === 'TGC_DUE_NON_REGLEE');
  assert.ok(due, 'le solde crediteur de 445500 doit etre signale');
  assert.match(due.message, /35\u202f?715|35 715|35715/);
});

test('une declaration qui liquide plus de TGC que la comptabilite n en porte est refusee', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('02-01'), piece_ref: 'P-1744', libelle: 'Declaration gonflee',
    lignes: [
      { compte: '445700', libelle: 'TGC collectee', debit: 50_000 },
      { compte: '445500', libelle: 'TGC a decaisser', credit: 50_000 },
    ],
  }, notaire);
  refuse('TGC_SOLDE_INSUFFISANT', () => valider(b.id, notaire));
});

test('une declaration dont l arithmetique ne boucle pas est refusee', () => {
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('02-10'), piece_ref: 'F-4', libelle: 'Emoluments fevrier',
    lignes: [
      { compte: dossier.compte_client, libelle: 'TTC', debit: 222_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 200_000 },
      { compte: '445700', libelle: 'TGC 11 %', credit: 22_000 },
    ],
  });
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('02-28'), piece_ref: 'P-8261', libelle: 'Declaration incoherente',
    lignes: [
      { compte: '445700', libelle: 'TGC collectee', debit: 22_000 },
      { compte: '445500', libelle: 'TGC a decaisser', credit: 19_000 },
      { compte: '471000', libelle: 'Difference inexpliquee', credit: 3_000 },
    ],
  }, notaire);
  refuse('TGC_LIQUIDATION_INCOHERENTE', () => valider(b.id, notaire));
});

test('un reglement au Tresor superieur a la TGC declaree est refuse', () => {
  const b = creerBrouillon({
    journal: 'BQO', date_ecriture: LE('02-05'), piece_ref: 'P-0363', libelle: 'Reglement TGC excessif',
    lignes: [
      { compte: '445500', libelle: 'TGC a decaisser', debit: 50_000 },
      { compte: '512100', libelle: 'Compte office', credit: 50_000 },
    ],
  }, notaire);
  refuse('TGC_SOLDE_INSUFFISANT', () => valider(b.id, notaire));
});

test('le reglement de la TGC declaree solde le compte du Tresor', () => {
  comptabiliser({
    journal: 'BQO', date_ecriture: LE('02-06'), piece_ref: 'TGC-01', libelle: 'Reglement TGC janvier',
    lignes: [
      { compte: '445500', libelle: 'TGC a decaisser', debit: 35_715 },
      { compte: '512100', libelle: 'Compte office', credit: 35_715 },
    ],
  });
  assert.equal(solde('445500'), 0);
});

test('le reglement solde le compte du Tresor et leve le signalement', () => {
  assert.equal(solde('445500'), 0);
  assert.ok(!anomaliesTgc().some((x) => x.code === 'TGC_DUE_NON_REGLEE'));
});

test('la contre-passation d une ecriture de TGC reste acceptee', () => {
  const id = un(
    `SELECT id FROM ecritures WHERE piece_ref = 'F-4' AND statut = 'VALIDEE'`,
  ).id;
  const r = contrepasser(id, { date_ecriture: LE('02-20'), motif: 'Acte annule' }, notaire);
  assert.equal(r.origine.statut, 'CONTREPASSEE');
  assert.equal(solde('445700'), 0);
  const e = etatTgc({ depuis: LE('02-01'), jusqu: LE('02-28') });
  assert.equal(e.collectee.total, 0);
  assert.equal(e.non_ventilees.length, 0);
});

test('un credit de TGC ne genere pas de TGC a decaisser', () => {
  comptabiliser({
    journal: 'ACH', date_ecriture: LE('03-05'), piece_ref: 'A-2', libelle: 'Achat de materiel',
    lignes: [
      { compte: '218300', libelle: 'Materiel informatique', debit: 500_000 },
      { compte: '445600', libelle: 'TGC deductible', debit: 55_000 },
      { compte: '401000', libelle: 'Fournisseur', credit: 555_000 },
    ],
  });
  const e = etatTgc({ depuis: LE('03-01'), jusqu: LE('03-31') });
  assert.equal(e.deductible.total, 55_000);
  assert.equal(e.net.a_decaisser, 0);
  assert.equal(e.net.credit_reportable, 55_000);
  assert.equal(propositionLiquidationTgc({ depuis: LE('03-01'), jusqu: LE('03-31') }), null);
});

// ---------------------------------------------------------------------------
// 5. Relance des periodes echues et pre-cloture
// ---------------------------------------------------------------------------

test('une periode echue dont la TGC collectee n est pas liquidee est signalee', () => {
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('04-10'), piece_ref: 'F-5', libelle: 'Emoluments avril',
    lignes: [
      { compte: dossier.compte_client, libelle: 'TTC', debit: 111_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 100_000 },
      { compte: '445700', libelle: 'TGC 11 %', credit: 11_000 },
    ],
  });

  const periodes = periodesTgc({ jusqu: LE('12-31') });
  const avril = periodes.find((p) => p.code === `${ANNEE}-04`);
  assert.ok(avril, 'la periode d avril doit etre enumeree');
  assert.equal(avril.collectee, 11_000);
  assert.equal(avril.reste_a_liquider, 11_000);
  assert.ok(avril.echue);
  assert.ok(avril.en_retard, 'periode echue et non liquidee');

  const janvier = periodes.find((p) => p.code === `${ANNEE}-01`);
  assert.equal(janvier.reste_a_liquider, 0);
  assert.equal(janvier.en_retard, false);

  const a = anomaliesTgc();
  assert.ok(a.some((x) => x.code === 'TGC_NON_LIQUIDEE'));
  assert.ok(anomalies().some((x) => x.code === 'TGC_NON_LIQUIDEE'));
});

test('la periode non encore echue ne declenche pas de relance', () => {
  const periodes = periodesTgc({ jusqu: LE('12-31'), aujourdhui: `${ANNEE}-05-02` });
  const avril = periodes.find((p) => p.code === `${ANNEE}-04`);
  assert.equal(avril.echue, false);
  assert.equal(avril.en_retard, false);
});

test('la pre-cloture refuse un exercice dont la TGC echue n est pas liquidee', () => {
  const d = controlePreCloture(exercice.id);
  const o = d.obstacles.find((x) => x.code === 'TGC_NON_LIQUIDEE');
  assert.ok(o, 'la TGC non liquidee doit faire obstacle a la cloture');
  assert.match(o.message, new RegExp(`${ANNEE}-04`));
});

test('la liquidation de la periode en retard leve l obstacle', () => {
  const p = propositionLiquidationTgc({ depuis: LE('04-01'), jusqu: LE('04-30') });
  assert.equal(p.lignes.find((l) => l.compte === '445700').debit, 11_000);
  comptabiliser(p);
  assert.equal(solde('445700'), 0);

  assert.ok(!periodesTgc({ jusqu: LE('12-31') }).some((x) => x.en_retard));
  assert.ok(!anomaliesTgc().some((x) => x.code === 'TGC_NON_LIQUIDEE'));
  assert.ok(!controlePreCloture(exercice.id).obstacles.some((x) => x.code === 'TGC_NON_LIQUIDEE'));
});

// ---------------------------------------------------------------------------
// 6. Parametrage
// ---------------------------------------------------------------------------

test('la periodicite et la tolerance d arrondi sont parametrables', () => {
  const p = chargerParametresTgc(join(ICI, 'tgc-tolerance.json'));
  assert.equal(p.declaration.periodicite, 'TRIMESTRIELLE');
  assert.equal(p.tolerance_arrondi_xpf, 5);

  const periodes = periodesTgc({ jusqu: LE('12-31'), parametres: p });
  assert.ok(periodes.some((x) => x.code === `${ANNEE}-T1`));
  assert.ok(!periodes.some((x) => x.code === `${ANNEE}-01`));

  // La tolerance elargit la fenetre d acceptation du controle d assiette.
  assert.equal(identifierTauxTgc(12_345, 1_352, p).taux_millieme, 110);
  assert.equal(identifierTauxTgc(12_345, 1_352), null);
});
