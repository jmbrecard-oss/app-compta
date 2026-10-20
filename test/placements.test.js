process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { ouvrirBase, un } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider } from '../src/domain/ecritures.js';
import { ouvrirDossier, cloreDossier } from '../src/domain/dossiers.js';
import { anomalies } from '../src/domain/controles.js';
import { etatPlacements } from '../src/domain/placements.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const d1 = ouvrirDossier({ reference: 'R-001', intitule: 'SUCCESSION BERGER' }, notaire);
const d2 = ouvrirDossier({ reference: 'R-002', intitule: 'SEQUESTRE TAVERA' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

/** Lit la situation d'un dossier dans l'etat des placements. */
const placementDe = (dossier) => etatPlacements().dossiers.find((x) => x.dossier_id === dossier.id);

// --------------------------------------------------------------------------

test('le compte de placement rubrique est identifie comme tel au plan comptable', () => {
  const c = un('SELECT nature, rubrique FROM comptes WHERE numero = $n', { n: '512600' });
  assert.equal(c.nature, 'DEPOT_FONDS_CLIENTS');
  assert.equal(c.rubrique, 1);
  // Le compte de depot courant, lui, n'est pas rubrique : il porte les fonds
  // de tous les dossiers sans affectation nominative.
  assert.equal(un('SELECT rubrique FROM comptes WHERE numero = $n', { n: '512500' }).rubrique, 0);
});

test('reception des fonds du client sur le compte de depot', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('04-01'), piece_ref: 'V-10', libelle: 'Fonds recus BERGER',
    lignes: [
      { compte: '512500', libelle: 'Virement recu', debit: 10_000_000 },
      { compte: d1.compte_client, libelle: 'Fonds BERGER', credit: 10_000_000 },
    ],
  });
  assert.equal(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: d1.id }).solde, -10_000_000);
});

test('un mouvement sur un compte rubrique sans dossier designe est refuse', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('04-02'), libelle: 'Placement sans affectation',
    lignes: [
      { compte: '512600', libelle: 'Placement', debit: 3_000_000 },
      { compte: '512500', libelle: 'Transfert', credit: 3_000_000 },
    ],
  }, notaire);
  refuse('RUBRIQUE_SANS_DOSSIER', () => valider(b.id, notaire));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
});

test('le placement rubrique au nom du dossier est accepte dans la limite de ses fonds', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('04-03'), piece_ref: 'PL-1', libelle: 'Placement rubrique BERGER',
    lignes: [
      { compte: '512600', dossier_id: d1.id, libelle: 'Placement BERGER', debit: 3_000_000 },
      { compte: '512500', libelle: 'Transfert vers placement', credit: 3_000_000 },
    ],
  });
  const p = placementDe(d1);
  assert.equal(p.place, 3_000_000);
  assert.equal(p.fonds_dus, 10_000_000);
  assert.equal(p.disponible_non_place, 7_000_000);
  assert.equal(p.produits_affectes, 0);
});

test('placer plus que les fonds detenus pour le dossier est refuse', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('04-04'), libelle: 'Placement excedant la provision',
    lignes: [
      { compte: '512600', dossier_id: d1.id, libelle: 'Placement BERGER', debit: 8_000_000 },
      { compte: '512500', libelle: 'Transfert vers placement', credit: 8_000_000 },
    ],
  }, notaire);
  refuse('PLACEMENT_SANS_PROVISION', () => valider(b.id, notaire));
  assert.equal(placementDe(d1).place, 3_000_000);
});

test('retirer plus que le placement du dossier est refuse', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('04-05'), libelle: 'Retrait superieur au placement',
    lignes: [
      { compte: '512500', libelle: 'Retour de placement', debit: 5_000_000 },
      { compte: '512600', dossier_id: d1.id, libelle: 'Denouement BERGER', credit: 5_000_000 },
    ],
  }, notaire);
  refuse('RUBRIQUE_DEBITRICE', () => valider(b.id, notaire));
});

test('le placement d un dossier ne peut pas alimenter le compte client d un autre', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('04-06'), libelle: 'Transfert entre dossiers',
    lignes: [
      { compte: '512600', dossier_id: d1.id, libelle: 'Produits du placement', debit: 1_000_000 },
      { compte: d2.compte_client, libelle: 'Au profit de TAVERA', credit: 1_000_000 },
    ],
  }, notaire);
  refuse('COMPENSATION_RUBRIQUES', () => valider(b.id, notaire));
  assert.equal(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: d2.id }).solde, 0);
});

test('les produits financiers du placement sont affectes au dossier qui les a produits', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('04-07'), piece_ref: 'INT-1', libelle: 'Interets du placement BERGER',
    lignes: [
      { compte: '512600', dossier_id: d1.id, libelle: 'Interets crediteurs', debit: 50_000 },
      { compte: d1.compte_client, libelle: 'Produits du placement', credit: 50_000 },
    ],
  });
  const p = placementDe(d1);
  assert.equal(p.produits_affectes, 50_000);
  assert.equal(p.place, 3_050_000);
  assert.equal(p.fonds_dus, 10_050_000);
});

test('l appropriation des produits du placement par l office est refusee', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('04-08'), libelle: 'Interets conserves par l office',
    lignes: [
      { compte: '512600', dossier_id: d1.id, libelle: 'Interets crediteurs', debit: 20_000 },
      { compte: '768000', libelle: 'Produits financiers', credit: 20_000 },
    ],
  }, notaire);
  refuse('ETANCHEITE_ROMPUE', () => valider(b.id, notaire));
});

test('les rubriques des dossiers ventilent exactement le solde du compte de placement', () => {
  const e = etatPlacements();
  assert.equal(e.solde_comptes, 3_050_000);
  assert.equal(e.total_ventile, 3_050_000);
  assert.equal(e.ecart_ventilation, 0);
  assert.ok(e.ventilation_conforme);
  assert.equal(e.total_produits_affectes, 50_000);
});

test('restituer la totalite des fonds en laissant un placement ouvert est refuse', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('04-09'), libelle: 'Restitution du solde BERGER',
    lignes: [
      { compte: d1.compte_client, libelle: 'Restitution', debit: 10_050_000 },
      { compte: '512500', libelle: 'Virement au client', credit: 10_050_000 },
    ],
  }, notaire);
  refuse('PLACEMENT_SANS_PROVISION', () => valider(b.id, notaire));
  assert.equal(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: d1.id }).solde, -10_050_000);
});

test('un produit financier inscrit a l office alors que des fonds sont places est signale', () => {
  comptabiliser({
    journal: 'OD', date_ecriture: LE('04-10'), piece_ref: 'INT-OFF', libelle: 'Interets percus par l office',
    lignes: [
      { compte: '512100', libelle: 'Interets', debit: 40_000 },
      { compte: '768000', libelle: 'Produits financiers', credit: 40_000 },
    ],
  });
  const a = anomalies().find((x) => x.code === 'PRODUITS_FINANCIERS_OFFICE');
  assert.ok(a, 'anomalie PRODUITS_FINANCIERS_OFFICE attendue');
  assert.equal(a.gravite, 'MAJEURE');
  assert.match(a.message, /40 ?000|40000/);
});

test('un dossier dont les fonds sont encore places ne peut pas etre clos', () => {
  refuse('DOSSIER_RUBRIQUE_NON_DENOUEE', () => cloreDossier(d1.id, notaire));
});

test('le denouement du placement puis la restitution permettent la cloture', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('04-11'), piece_ref: 'PL-2', libelle: 'Denouement du placement BERGER',
    lignes: [
      { compte: '512500', libelle: 'Retour de placement', debit: 3_050_000 },
      { compte: '512600', dossier_id: d1.id, libelle: 'Denouement BERGER', credit: 3_050_000 },
    ],
  });
  assert.equal(placementDe(d1).place, 0);

  comptabiliser({
    journal: 'BQC', date_ecriture: LE('04-12'), piece_ref: 'R-1', libelle: 'Restitution du solde BERGER',
    lignes: [
      { compte: d1.compte_client, libelle: 'Restitution', debit: 10_050_000 },
      { compte: '512500', libelle: 'Virement au client', credit: 10_050_000 },
    ],
  });

  const clos = cloreDossier(d1.id, notaire);
  assert.equal(clos.statut, 'SOLDE');
});
