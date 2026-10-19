process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { ouvrirBase, un, tous } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { etatRepresentationFonds, anomalies } from '../src/domain/controles.js';
import {
  validerParametresDebours,
  parametresDebours,
  estCompteDebours,
  etatSommesDues,
  etatRepresentationTiers,
  anomaliesDebours,
} from '../src/domain/debours.js';
import { ouvrirExercice, controlePreCloture, cloturerExercice } from '../src/domain/cloture.js';
import { dossierInspection } from '../src/reports/etats.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const ARRETE = LE('09-30');
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const dossierA = ouvrirDossier({ reference: 'D-100', intitule: 'VENTE MARTIN' }, notaire);
const dossierB = ouvrirDossier({ reference: 'D-200', intitule: 'SUCCESSION KAMI' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

/** Provisions des deux dossiers : les fonds sont au depot clients. */
comptabiliser({
  journal: 'BQC', date_ecriture: LE('02-01'), piece_ref: 'V-100', libelle: 'Provision vente MARTIN',
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: 10_000_000 },
    { compte: dossierA.compte_client, libelle: 'Provision MARTIN', credit: 10_000_000 },
  ],
});
comptabiliser({
  journal: 'BQC', date_ecriture: LE('02-02'), piece_ref: 'V-200', libelle: 'Provision succession KAMI',
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: 2_000_000 },
    { compte: dossierB.compte_client, libelle: 'Provision KAMI', credit: 2_000_000 },
  ],
});

// --------------------------------------------------------------- parametrage

test('le parametrage des debours livre avec l application est marque non valide', () => {
  const p = parametresDebours();
  assert.equal(p.statut, 'NON_VALIDE');
  assert.equal(p.source, null);
  assert.match(p.avertissement, /FICTIFS/);
  assert.equal(p.empreinte.length, 64);
  assert.deepEqual(p.comptes.map((c) => c.numero), ['448600', '448700', '448800']);
  assert.ok(estCompteDebours('448600') && estCompteDebours('448700') && estCompteDebours('448800'));
  assert.ok(!estCompteDebours('445700'), 'la TGC collectee est une dette propre de l office, pas un debours client');

  const liste = anomaliesDebours({ a_la_date: ARRETE });
  assert.ok(liste.some((a) => a.code === 'PARAMETRES_DEBOURS_NON_VALIDES' && a.gravite === 'CRITIQUE'));
});

test('un parametrage de debours incoherent est refuse en bloc', () => {
  const base = JSON.parse(JSON.stringify(parametresDebours()));
  const sans = (modif) => ({ ...base, ...modif });

  refuse('PARAMETRES_DEBOURS_INVALIDES', () => validerParametresDebours(sans({ statut: 'HOMOLOGUE' })));
  refuse('PARAMETRES_DEBOURS_INVALIDES', () => validerParametresDebours(sans({ comptes: [] })));
  refuse('PARAMETRES_DEBOURS_INVALIDES', () => validerParametresDebours(
    sans({ comptes: [{ numero: '44', beneficiaire: 'x', delai_reversement_jours: 30 }] }),
  ));
  refuse('PARAMETRES_DEBOURS_INVALIDES', () => validerParametresDebours(
    sans({ comptes: [{ numero: '448600', beneficiaire: 'x', delai_reversement_jours: -1 }] }),
  ));
  refuse('PARAMETRES_DEBOURS_INVALIDES', () => validerParametresDebours(
    sans({ comptes: [{ numero: '448600', beneficiaire: '', delai_reversement_jours: 30 }] }),
  ));
});

// ------------------------------------------------- justification par dossier

test('une somme due au Tresor doit designer le dossier qui l a supportee', () => {
  const b = creerBrouillon({
    journal: 'BQO', date_ecriture: LE('03-01'), piece_ref: 'T-1',
    libelle: 'Reversement global des droits d enregistrement',
    lignes: [
      { compte: '448600', libelle: 'Droits reverses', debit: 500_000 },
      { compte: '512100', libelle: 'Compte office', credit: 500_000 },
    ],
  }, notaire);
  refuse('DEBOURS_SANS_DOSSIER', () => valider(b.id, notaire));
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id: b.id }).statut, 'BROUILLON');
});

test('un debours imputable a deux dossiers a la fois est refuse', () => {
  const b = creerBrouillon({
    journal: 'EMO', date_ecriture: LE('03-01'), libelle: 'Droits de deux affaires en une ecriture',
    lignes: [
      { compte: dossierA.compte_client, libelle: 'Droits MARTIN', debit: 100_000 },
      { compte: dossierB.compte_client, libelle: 'Droits KAMI', debit: 100_000 },
      { compte: '448600', libelle: 'Droits d enregistrement', credit: 200_000 },
    ],
  }, notaire);
  refuse('DEBOURS_SANS_DOSSIER', () => valider(b.id, notaire));
});

test('l appel de droits sur un dossier unique rattache le debours a ce dossier', () => {
  const id = comptabiliser({
    journal: 'EMO', date_ecriture: LE('03-02'), piece_ref: 'A-100',
    libelle: 'Droits d enregistrement vente MARTIN',
    lignes: [
      { compte: dossierA.compte_client, libelle: 'Droits appeles', debit: 400_000 },
      { compte: '448600', libelle: 'Droits d enregistrement a reverser', credit: 400_000 },
    ],
  });
  const ligne = un(
    `SELECT dossier_id FROM lignes WHERE ecriture_id = $id AND compte = '448600'`, { id },
  );
  assert.equal(ligne.dossier_id, dossierA.id, 'le debours herite du dossier de l ecriture');
});

test('un debours encaisse pour un tiers ne peut pas devenir un produit de l office', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-03'), libelle: 'Droits non consommes passes en produit',
    dossier_id: dossierA.id,
    lignes: [
      { compte: '448600', libelle: 'Reprise des droits', debit: 100_000 },
      { compte: '706400', libelle: 'Honoraires', credit: 100_000 },
    ],
  }, notaire);
  refuse('DEBOURS_VERS_GESTION', () => valider(b.id, notaire));
});

test('on ne reverse pas au Tresor plus que ce qui a ete appele sur le dossier', () => {
  const b = creerBrouillon({
    journal: 'BQC', date_ecriture: LE('03-04'), piece_ref: 'T-2',
    libelle: 'Reversement superieur aux droits appeles',
    dossier_id: dossierA.id,
    lignes: [
      { compte: '448600', libelle: 'Droits reverses', debit: 500_000 },
      { compte: '512500', libelle: 'Depuis le depot clients', credit: 500_000 },
    ],
  }, notaire);
  refuse('DEBOURS_DOSSIER_DEBITEUR', () => valider(b.id, notaire));
  assert.equal(un(`SELECT solde FROM v_soldes WHERE numero = '448600'`).solde, -400_000);
});

// ------------------------------------- representation des sommes dues aux tiers

test('les sommes dues aux tiers ne peuvent pas etre virees au compte de l office', () => {
  // Le controle de representation des fonds CLIENTS, lui, voit une marge :
  // les droits appeles ont quitte le compte du client sans quitter le depot.
  const fondsClients = etatRepresentationFonds();
  assert.ok(fondsClients.conforme);
  assert.equal(fondsClients.ecart, 400_000);

  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-05'), libelle: 'Virement de l excedent apparent vers l office',
    lignes: [
      { compte: '512100', libelle: 'Compte office', debit: 400_000 },
      { compte: '512500', libelle: 'Depot clients', credit: 400_000 },
    ],
  }, notaire);
  refuse('FONDS_TIERS_NON_REPRESENTES', () => valider(b.id, notaire));

  const tiers = etatRepresentationTiers();
  assert.equal(tiers.du_aux_clients, 11_600_000);
  assert.equal(tiers.du_aux_tiers, 400_000);
  assert.equal(tiers.du_total, 12_000_000);
  assert.equal(tiers.representation_totale, 12_000_000);
  assert.equal(tiers.ecart, 0);
  assert.ok(tiers.conforme);
});

// ------------------------------------------------- etat de controle et anciennete

test('le reversement s impute sur les appels les plus anciens', () => {
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('04-01'), piece_ref: 'A-200',
    libelle: 'Taxe hypothecaire succession KAMI',
    lignes: [
      { compte: dossierB.compte_client, libelle: 'Taxe appelee', debit: 150_000 },
      { compte: '448700', libelle: 'Taxe hypothecaire a reverser', credit: 150_000 },
    ],
  });
  comptabiliser({
    journal: 'EMO', date_ecriture: LE('09-20'), piece_ref: 'A-201',
    libelle: 'Complement de taxe hypothecaire KAMI',
    lignes: [
      { compte: dossierB.compte_client, libelle: 'Taxe appelee', debit: 250_000 },
      { compte: '448700', libelle: 'Taxe hypothecaire a reverser', credit: 250_000 },
    ],
  });
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('09-25'), piece_ref: 'T-3',
    libelle: 'Reversement partiel de la taxe hypothecaire',
    dossier_id: dossierB.id,
    lignes: [
      { compte: '448700', libelle: 'Taxe reversee', debit: 200_000 },
      { compte: '512500', libelle: 'Depuis le depot clients', credit: 200_000 },
    ],
  });

  const etat = etatSommesDues({ a_la_date: ARRETE });
  const compte = etat.comptes.find((c) => c.numero === '448700');
  const b = compte.dossiers.find((d) => d.reference === 'D-200');

  assert.equal(b.appele, 400_000);
  assert.equal(b.reverse, 200_000);
  assert.equal(b.reste_du, 200_000);
  // Les 200 000 reverses soldent l appel du 1er avril et entament celui du
  // 20 septembre : le reliquat a l anciennete du second, pas du premier.
  assert.equal(b.plus_ancien_appel, LE('09-20'));
  assert.equal(b.anciennete_jours, 10);
  assert.equal(b.delai_depasse, false);
  assert.deepEqual(b.lots.map((l) => [l.date, l.reste]), [[LE('09-20'), 200_000]]);
});

test('l etat des sommes dues chiffre compte par compte et dossier par dossier', () => {
  const etat = etatSommesDues({ a_la_date: ARRETE });

  assert.equal(etat.arrete_le, ARRETE);
  assert.equal(etat.total_du, 600_000);
  assert.deepEqual(
    etat.comptes.map((c) => [c.numero, c.total_du]),
    [['448600', 400_000], ['448700', 200_000], ['448800', 0]],
  );

  const a = etat.comptes.find((c) => c.numero === '448600').dossiers.find((d) => d.reference === 'D-100');
  assert.equal(a.reste_du, 400_000);
  assert.equal(a.plus_ancien_appel, LE('03-02'));
  assert.equal(a.anciennete_jours, 212);
  assert.equal(a.delai_depasse, true);

  // Le total de l'etat est la dette reelle : il doit coller au plan comptable.
  const soldeComptable = -tous(`SELECT solde FROM v_soldes WHERE numero IN ('448600','448700','448800')`)
    .reduce((s, c) => s + c.solde, 0);
  assert.equal(etat.total_du, soldeComptable);

  assert.equal(etat.couverture.du_aux_tiers, 600_000);
  assert.ok(etat.couverture.conforme);
  assert.equal(etat.sans_dossier.length, 0);
  assert.equal(etat.dossiers_debiteurs.length, 0);
});

test('une somme due au-dela du delai de reversement est signalee', () => {
  const liste = anomaliesDebours({ a_la_date: ARRETE });
  const retard = liste.filter((a) => a.code === 'DEBOURS_NON_REVERSE');
  assert.equal(retard.length, 1, 'seul le dossier D-100 depasse le delai au 30 septembre');
  assert.match(retard[0].objet, /448600.*D-100/);
  assert.match(retard[0].message, /400000 XPF dus depuis le /);
  assert.equal(retard[0].gravite, 'MAJEURE');

  // Les anomalies du module sont bien reprises dans le tableau de bord general.
  assert.ok(anomalies().some((a) => a.code === 'PARAMETRES_DEBOURS_NON_VALIDES'));
});

test('une somme due non reversee fait obstacle a la cloture de l exercice', () => {
  const ex = un('SELECT * FROM exercices WHERE statut = $s ORDER BY date_debut LIMIT 1', { s: 'OUVERT' });
  const diag = controlePreCloture(ex.id);
  const obstacles = diag.obstacles.filter((o) => o.code === 'DEBOURS_NON_REVERSE');
  assert.ok(obstacles.length >= 1);
  assert.match(obstacles[0].message, /448600|448700/);
  assert.equal(diag.pret, false);
});

test('l etat des sommes dues figure au dossier d inspection', () => {
  const d = dossierInspection();
  assert.equal(d.sommes_dues_tiers.total_du, 600_000);
  assert.equal(d.sommes_dues_tiers.parametrage.statut, 'NON_VALIDE');
});

test('le reversement effectif eteint la somme due', () => {
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('09-26'), piece_ref: 'T-4',
    libelle: 'Reversement des droits d enregistrement MARTIN',
    dossier_id: dossierA.id,
    lignes: [
      { compte: '448600', libelle: 'Droits reverses au Tresor', debit: 400_000 },
      { compte: '512500', libelle: 'Depuis le depot clients', credit: 400_000 },
    ],
  });

  const etat = etatSommesDues({ a_la_date: ARRETE });
  assert.equal(etat.total_du, 200_000);
  assert.equal(etat.comptes.find((c) => c.numero === '448600').dossiers.length, 0);
  assert.equal(anomaliesDebours({ a_la_date: ARRETE }).filter((a) => a.code === 'DEBOURS_NON_REVERSE').length, 0);
});

// ------------------------------------------------- continuite d un exercice a l autre

test('la reprise a nouveau conserve le detail par dossier des sommes dues', () => {
  const ex = un('SELECT * FROM exercices WHERE statut = $s ORDER BY date_debut LIMIT 1', { s: 'OUVERT' });
  ouvrirExercice(
    { libelle: String(ANNEE + 1), date_debut: `${ANNEE + 1}-01-01`, date_fin: `${ANNEE + 1}-12-31` },
    notaire,
  );
  const r = cloturerExercice(ex.id, notaire, { forcer: true });

  const lignes = tous(
    `SELECT l.compte, l.dossier_id, l.debit, l.credit FROM lignes l
     WHERE l.ecriture_id = $id AND l.compte IN ('448600','448700','448800')`,
    { id: r.a_nouveau.id },
  );
  assert.equal(lignes.length, 1, 'un a-nouveau par dossier restant du, pas un solde global');
  assert.equal(lignes[0].compte, '448700');
  assert.equal(lignes[0].dossier_id, dossierB.id);
  assert.equal(lignes[0].credit, 200_000);
  assert.equal(lignes[0].debit, 0);
});

test('l appel d emoluments et de droits dans une meme ecriture reste regulier', () => {
  // Le controle ne vise qu un sens : solder un debours par un compte de
  // gestion. La taxe d un acte, elle, credite emoluments, TGC et droits
  // ensemble par le debit du compte du client - c est l ecriture ordinaire.
  const dossierC = ouvrirDossier({ reference: 'D-300', intitule: 'VENTE WAMYTAN' }, notaire);
  comptabiliser({
    journal: 'BQC', date_ecriture: `${ANNEE + 1}-02-01`, piece_ref: 'V-300', libelle: 'Provision WAMYTAN',
    lignes: [
      { compte: '512500', libelle: 'Virement recu', debit: 1_000_000 },
      { compte: dossierC.compte_client, libelle: 'Provision', credit: 1_000_000 },
    ],
  });
  const id = comptabiliser({
    journal: 'EMO', date_ecriture: `${ANNEE + 1}-02-02`, piece_ref: 'A-300', libelle: 'Taxe de l acte WAMYTAN',
    lignes: [
      { compte: dossierC.compte_client, libelle: 'Taxe de l acte', debit: 250_000 },
      { compte: '706100', libelle: 'Emoluments d acte', credit: 180_000 },
      { compte: '445700', libelle: 'TGC 11 %', credit: 20_000 },
      { compte: '448600', libelle: 'Droits d enregistrement', credit: 50_000 },
    ],
  });
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id }).statut, 'VALIDEE');
  assert.equal(
    un(`SELECT dossier_id FROM lignes WHERE ecriture_id = $id AND compte = '448600'`, { id }).dossier_id,
    dossierC.id,
  );
});
