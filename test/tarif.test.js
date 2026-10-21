process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ouvrirBase, un, exec } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider, contrepasser } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { anomalies, etatComptesDebiteurs } from '../src/domain/controles.js';
import { verifierChaineEcritures } from '../src/domain/ecritures.js';
import { verifierChaineAudit } from '../src/audit.js';
import {
  validerBareme,
  chargerBareme,
  baremeCourant,
  calculerPrestation,
  simulerTaxe,
  creerTaxe,
  arreterTaxe,
  comptabiliserTaxe,
  lireTaxe,
  listerTaxes,
  supprimerTaxe,
} from '../src/domain/tarif.js';
import { compteDefinitif, etatTaxes } from '../src/reports/etats.js';

const ICI = dirname(fileURLToPath(import.meta.url));
const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const provisionne = ouvrirDossier({ reference: 'T-001', intitule: 'VENTE MARTIN' }, notaire);
const demuni = ouvrirDossier({ reference: 'T-002', intitule: 'VENTE SANS PROVISION' }, notaire);
// Dossier de travail pour les essais de liquidation, afin que les etats des
// deux dossiers ci-dessus restent lisibles.
const atelier = ouvrirDossier({ reference: 'T-003', intitule: 'ESSAIS DE LIQUIDATION' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

/** Provision recue du client : prealable a toute taxe. */
comptabiliser({
  journal: 'BQC', date_ecriture: LE('02-01'), piece_ref: 'P-1', libelle: 'Provision MARTIN',
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: 5_000_000 },
    { compte: provisionne.compte_client, libelle: 'Provision', credit: 5_000_000 },
  ],
});

// ===========================================================  le barème lui-même

test('le bareme livre se declare fictif et designe le texte qui doit le remplacer', () => {
  const b = baremeCourant();
  assert.equal(b.meta.statut, 'FICTIF');
  assert.match(b.meta.texte_reference, /78-321\/CG/);
  assert.match(b.meta.a_valider_par, /Chambre des notaires/);
  assert.ok(b.meta.avertissement.length > 100, 'l avertissement doit etre explicite');
  assert.equal(b.empreinte.length, 64, 'le bareme porte une empreinte SHA-256');
});

test('un bareme dont les tranches ne sont pas croissantes est refuse', () => {
  refuse('BAREME_INVALIDE', () => validerBareme({
    bareme: { code: 'X', libelle: 'x', statut: 'FICTIF', avertissement: 'x', texte_reference: 'x', a_valider_par: 'x' },
    arrondi: 'SUPERIEUR',
    prestations: [{
      code: 'A', libelle: 'a', categorie: 'EMOLUMENT', compte: '706100', mode: 'TRANCHES',
      tranches: [{ jusqu_a: 3_000_000, taux_ppm: 10 }, { jusqu_a: 1_000_000, taux_ppm: 20 }, { jusqu_a: null, taux_ppm: 5 }],
    }],
  }));
});

test('un bareme dont la derniere tranche est bornee est refuse', () => {
  refuse('BAREME_INVALIDE', () => validerBareme({
    bareme: { code: 'X', libelle: 'x', statut: 'FICTIF', avertissement: 'x', texte_reference: 'x', a_valider_par: 'x' },
    arrondi: 'SUPERIEUR',
    prestations: [{
      code: 'A', libelle: 'a', categorie: 'EMOLUMENT', compte: '706100', mode: 'TRANCHES',
      tranches: [{ jusqu_a: 1_000_000, taux_ppm: 10 }],
    }],
  }));
});

test('un taux non entier est refuse : aucun flottant n entre dans le bareme', () => {
  refuse('BAREME_INVALIDE', () => validerBareme({
    bareme: { code: 'X', libelle: 'x', statut: 'FICTIF', avertissement: 'x', texte_reference: 'x', a_valider_par: 'x' },
    arrondi: 'SUPERIEUR',
    prestations: [{
      code: 'A', libelle: 'a', categorie: 'EMOLUMENT', compte: '706100', mode: 'PROPORTIONNEL', taux_ppm: 40.5,
    }],
  }));
});

// =============================================================  le calcul

test('l emolument proportionnel est liquide tranche par tranche', () => {
  // 1 000 000 a 4 % + 2 000 000 a 2 % + 7 000 000 a 1,2 % + 15 000 000 a 0,8 %
  const l = calculerPrestation({ code: 'EMO-VENTE', assiette: 25_000_000 });
  assert.equal(l.montant, 284_000);
  assert.match(l.detail, /1 000 000/);
  assert.equal(l.compte, '706100');
});

test('le mode d arrondi vient du fichier de bareme, pas du code', () => {
  // 1 000 000 a 4 % = 40 000 pile ; 234 567 a 2 % = 4 691,34 -> total 44 691,34.
  const haut = calculerPrestation({ code: 'EMO-VENTE', assiette: 1_234_567 });
  assert.equal(haut.montant, 44_692, 'arrondi SUPERIEUR du bareme livre');

  const autre = chargerBareme(join(ICI, 'bareme-arrondi-inferieur.json'));
  assert.equal(autre.arrondi, 'INFERIEUR');
  const bas = calculerPrestation({ code: 'EMO-VENTE', assiette: 1_234_567 }, autre);
  assert.equal(bas.montant, 44_691);
});

test('l arrondi n intervient qu une fois, sur le total de la prestation', () => {
  // Deux tranches fractionnaires a la fois - seul cas qui distingue les deux
  // facons de faire. 1 000 a 1,03 % = 10,30 ; 1 000 a 2,03 % = 20,30.
  //   arrondi unique sur le total : 30,60 -> 31
  //   arrondi tranche par tranche  :  11 + 21 -> 32
  const b = chargerBareme(join(ICI, 'bareme-tranches-fractionnaires.json'));
  const l = calculerPrestation({ code: 'DEUX-FRACTIONS', assiette: 2000 }, b);
  assert.equal(l.montant, 31, 'un arrondi par tranche donnerait 32');
  assert.match(l.detail, /30,60 arrondi/, 'le total exact precede l arrondi');
});

test('la justification de la liquidation est exacte au centieme, sans flottant', () => {
  const l = calculerPrestation({ code: 'EMO-VENTE', assiette: 1_234_567 });
  assert.match(l.detail, /44 691,34 arrondi/, 'la liquidation exacte precede l arrondi');
  assert.match(l.detail, /= 44 692 XPF$/);
});

test('le minimum du bareme s applique quand la liquidation lui est inferieure', () => {
  // 100 000 a 4 % = 4 000, en dessous du minimum de 20 000.
  const l = calculerPrestation({ code: 'EMO-VENTE', assiette: 100_000 });
  assert.equal(l.montant, 20_000);
  assert.match(l.detail, /minimum/i);
});

test('une assiette non entiere, negative ou nulle est refusee', () => {
  refuse('ASSIETTE_INVALIDE', () => calculerPrestation({ code: 'EMO-VENTE', assiette: 1_000_000.5 }));
  refuse('ASSIETTE_INVALIDE', () => calculerPrestation({ code: 'EMO-VENTE', assiette: -1 }));
  // Sans assiette, le minimum du bareme serait facture sur un champ vide.
  refuse('ASSIETTE_INVALIDE', () => calculerPrestation({ code: 'EMO-VENTE', assiette: 0 }));
});

test('une assiette hors des limites representables est refusee proprement', () => {
  // Number.isInteger(1e300) vaut true : sans garde-fou, un flottant finirait
  // dans une colonne INTEGER, et 2**53 ferait remonter une erreur brute du
  // pilote SQLite au lieu d un refus de conformite.
  refuse('ASSIETTE_INVALIDE', () => calculerPrestation({ code: 'EMO-FORMALITE', assiette: 1e300 }));
  refuse('ASSIETTE_INVALIDE', () => calculerPrestation({ code: 'EMO-VENTE', assiette: 2 ** 53 }));
  refuse('QUANTITE_INVALIDE', () => calculerPrestation({ code: 'EMO-FORMALITE', quantite: 2 ** 53 }));
  refuse('MONTANT_INVALIDE', () => calculerPrestation({ code: 'DEBOURS', montant: 1e300 }));
});

test('une prestation absente du bareme est refusee', () => {
  refuse('PRESTATION_INCONNUE', () => calculerPrestation({ code: 'EMO-INVENTE', assiette: 1000 }));
});

test('la TGC est liquidee prestation par prestation, au taux inscrit au bareme', () => {
  // Le code n'impose aucun taux : il applique celui que la prestation declare.
  // Que les debours en soient exoneres est une propriete du FICHIER, a valider
  // avec la Chambre, pas une regle ecrite en dur.
  const emolument = calculerPrestation({ code: 'EMO-VENTE', assiette: 25_000_000 });
  assert.equal(emolument.tgc_code, 'TGC11');
  assert.equal(emolument.tgc_montant, 31_240); // 284 000 x 11 %, exact

  const droits = calculerPrestation({ code: 'DROIT-ENREGISTREMENT', assiette: 25_000_000 });
  assert.equal(droits.montant, 1_000_000);
  assert.equal(droits.tgc_code, 'TGC0');
  assert.equal(droits.tgc_montant, 0);
  assert.equal(droits.compte, '448600');
});

test('la TGC s arrondit comme le reste, selon le mode du bareme', () => {
  // 44 692 x 11 % = 4 916,12 : le chemin d'arrondi de la TGC, distinct de
  // celui de la prestation, doit etre exerce lui aussi.
  const l = calculerPrestation({ code: 'EMO-VENTE', assiette: 1_234_567 });
  assert.equal(l.montant, 44_692);
  assert.equal(l.tgc_montant, 4_917);

  const inf = chargerBareme(join(ICI, 'bareme-arrondi-inferieur.json'));
  const bas = calculerPrestation({ code: 'EMO-VENTE', assiette: 1_234_567 }, inf);
  assert.equal(bas.montant, 44_691);
  assert.equal(bas.tgc_montant, 4_916); // 44 691 x 11 % = 4 916,01 arrondi a l inferieur
});

// ================================================  la taxe de l'acte, piece a piece

const PRESTATIONS_VENTE = [
  { code: 'EMO-VENTE', assiette: 25_000_000 },
  { code: 'EMO-FORMALITE', quantite: 3 },
  { code: 'DROIT-ENREGISTREMENT', assiette: 25_000_000 },
  { code: 'TAXE-HYPOTHECAIRE', assiette: 25_000_000 },
];

test('la taxe totalise emoluments, TGC et debours separement', () => {
  const t = simulerTaxe({ acte: 'Vente MARTIN', date_acte: LE('03-01'), prestations: PRESTATIONS_VENTE });
  assert.equal(t.total_emoluments, 320_000);   // 284 000 + 3 x 12 000
  assert.equal(t.total_tgc, 35_200);           // 31 240 + 3 960
  assert.equal(t.total_debours, 1_150_000);    // 1 000 000 + 150 000
  assert.equal(t.total_du, 1_505_200);
  assert.equal(t.total_du, t.total_emoluments + t.total_tgc + t.total_debours);
});

let taxe;

test('une taxe arretee porte l empreinte du bareme qui l a produite', () => {
  taxe = creerTaxe(
    { dossier_id: provisionne.id, acte: 'Vente MARTIN', date_acte: LE('03-01'), prestations: PRESTATIONS_VENTE },
    notaire,
  );
  assert.equal(taxe.statut, 'PROJET');
  assert.equal(taxe.total_du, 1_505_200);

  const arretee = arreterTaxe(taxe.id, notaire);
  assert.equal(arretee.statut, 'ARRETEE');
  assert.equal(arretee.bareme_empreinte, baremeCourant().empreinte);
  assert.equal(arretee.bareme_statut, 'FICTIF');
});

test('une taxe dont une ligne a ete retouchee ne peut pas etre arretee', () => {
  const t = creerTaxe(
    { dossier_id: demuni.id, acte: 'Vente retouchee', date_acte: LE('03-02'), prestations: PRESTATIONS_VENTE },
    notaire,
  );
  // Un projet est modifiable : on minore l emolument a la main.
  exec(`UPDATE taxes_lignes SET montant = 1000 WHERE taxe_id = $t AND prestation_code = 'EMO-VENTE'`, { t: t.id });
  refuse('TAXE_NON_CONFORME_BAREME', () => arreterTaxe(t.id, notaire));
  assert.equal(lireTaxe(t.id).statut, 'PROJET');
});

test('une prestation a montant libre repetee se recalcule a l identique', () => {
  // La quantite ne doit etre appliquee qu'une fois : le recalcul de l arrete
  // repart du montant saisi, pas du produit deja multiplie.
  const t = creerTaxe(
    { dossier_id: atelier.id, acte: 'Honoraires repetes', date_acte: LE('03-02'),
      prestations: [{ code: 'HONO-LIBRE', montant: 50_000, quantite: 2 }] },
    notaire,
  );
  assert.equal(t.total_emoluments, 100_000);
  assert.equal(t.lignes[0].montant_saisi, 50_000, 'l entree de la liquidation est conservee');
  const arretee = arreterTaxe(t.id, notaire);
  assert.equal(arretee.statut, 'ARRETEE');
  assert.equal(arretee.total_emoluments, 100_000);
});

test('le recalcul de l arrete repart des entrees, pas du resultat enregistre', () => {
  const t = creerTaxe(
    { dossier_id: atelier.id, acte: 'Honoraire retouche', date_acte: LE('03-02'),
      prestations: [{ code: 'HONO-LIBRE', montant: 40_000 }] },
    notaire,
  );
  // On majore le resultat sans toucher a l entree : la divergence doit sortir.
  exec('UPDATE taxes_lignes SET montant = 900000 WHERE taxe_id = $t', { t: t.id });
  refuse('TAXE_NON_CONFORME_BAREME', () => arreterTaxe(t.id, notaire));
});

test('la comptabilisation de la taxe produit l ecriture detaillee de l acte', () => {
  const { ecriture } = comptabiliserTaxe(taxe.id, notaire);
  const parCompte = Object.fromEntries(ecriture.lignes.map((l) => [l.compte, l]));

  assert.equal(ecriture.journal, 'EMO');
  assert.equal(parCompte[provisionne.compte_client].debit, 1_505_200);
  assert.equal(parCompte['706100'].credit, 284_000);
  assert.equal(parCompte['706200'].credit, 36_000);
  assert.equal(parCompte['445700'].credit, 35_200);
  assert.equal(parCompte['448600'].credit, 1_000_000);
  assert.equal(parCompte['448700'].credit, 150_000);
  assert.equal(ecriture.total_debit, ecriture.total_credit);
  // Chaque ligne reste rattachee au dossier : la taxe est tracable a l acte.
  for (const l of ecriture.lignes) assert.equal(l.dossier_id, provisionne.id);

  assert.equal(lireTaxe(taxe.id).statut, 'COMPTABILISEE');
});

test('une taxe deja comptabilisee ne peut pas l etre deux fois', () => {
  refuse('TAXE_DEJA_COMPTABILISEE', () => comptabiliserTaxe(taxe.id, notaire));
});

test('une taxe comptabilisee est verrouillee dans la base, par tous les chemins', () => {
  const id = taxe.id;
  const bloque = (sql, params = {}) => assert.throws(() => exec(sql, { id, ...params }), /INALTERABILITE/);

  // Modification directe des totaux, de l entete, des lignes.
  bloque('UPDATE taxes SET total_du = 1 WHERE id = $id');
  bloque('UPDATE taxes SET acte = $a WHERE id = $id', { a: 'autre acte' });
  bloque('UPDATE taxes SET bareme_empreinte = $e WHERE id = $id', { e: 'x'.repeat(64) });
  bloque('UPDATE taxes_lignes SET montant = 0 WHERE taxe_id = $id');
  bloque('DELETE FROM taxes_lignes WHERE taxe_id = $id');
  bloque('DELETE FROM taxes WHERE id = $id');

  // Ajout d une ligne apres coup : ni UPDATE ni DELETE, mais tout aussi
  // alterant - la taxe ne correspondrait plus a l ecriture passee.
  bloque(
    `INSERT INTO taxes_lignes (taxe_id, ordre, prestation_code, libelle, categorie, compte, montant)
     VALUES ($id, 99, 'DEBOURS', 'Ligne ajoutee', 'DEBOURS', '448800', 999999)`,
  );

  // Retour en arriere du statut : rouvrirait tout ce qui precede.
  bloque(`UPDATE taxes SET statut = 'PROJET' WHERE id = $id`);
  bloque(`UPDATE taxes SET statut = 'ARRETEE' WHERE id = $id`);
  // Detachement ou remplacement de l ecriture rattachee.
  bloque('UPDATE taxes SET ecriture_id = NULL WHERE id = $id');
  bloque('UPDATE taxes SET ecriture_id = 1 WHERE id = $id');
  // Falsification de la trace de l arrete.
  bloque('UPDATE taxes SET arrete_par = $u WHERE id = $id', { u: 'quelqu un d autre' });
  bloque('UPDATE taxes SET arrete_le = $d WHERE id = $id', { d: '2000-01-01T00:00:00.000Z' });

  // Et rien n a bouge.
  const apres = lireTaxe(id);
  assert.equal(apres.statut, 'COMPTABILISEE');
  assert.equal(apres.total_du, 1_505_200);
  assert.equal(apres.lignes.length, 4);
});

test('une taxe arretee non comptabilisee est deja figee', () => {
  const t = creerTaxe(
    { dossier_id: atelier.id, acte: 'Taxe a figer', date_acte: LE('03-02'),
      prestations: [{ code: 'DEBOURS', montant: 7_000 }] },
    notaire,
  );
  arreterTaxe(t.id, notaire);
  assert.throws(() => exec('UPDATE taxes SET total_du = 1 WHERE id = $id', { id: t.id }), /INALTERABILITE/);
  assert.throws(() => exec(`UPDATE taxes SET statut = 'PROJET' WHERE id = $id`, { id: t.id }), /INALTERABILITE/);
  assert.throws(() => exec('DELETE FROM taxes WHERE id = $id', { id: t.id }), /INALTERABILITE/);
  assert.throws(
    () => exec(
      `INSERT INTO taxes_lignes (taxe_id, ordre, prestation_code, libelle, categorie, compte, montant)
       VALUES ($id, 9, 'DEBOURS', 'x', 'DEBOURS', '448800', 1)`,
      { id: t.id },
    ),
    /INALTERABILITE/,
  );

  // Ni par ajout direct, ni en y deplacant la ligne d un autre projet.
  const projet = creerTaxe(
    { dossier_id: atelier.id, acte: 'Projet donneur', date_acte: LE('03-02'),
      prestations: [{ code: 'DEBOURS', montant: 777_777 }] },
    notaire,
  );
  assert.throws(
    () => exec('UPDATE taxes_lignes SET taxe_id = $cible WHERE taxe_id = $source',
      { cible: t.id, source: projet.id }),
    /INALTERABILITE/,
  );
  assert.equal(lireTaxe(t.id).lignes.length, 1);
});

test('une taxe de montant nul ne peut pas etre comptabilisee', () => {
  const t = creerTaxe(
    { dossier_id: demuni.id, acte: 'Acte sans cout', date_acte: LE('03-03'),
      prestations: [{ code: 'DEBOURS', montant: 0 }] },
    notaire,
  );
  arreterTaxe(t.id, notaire);
  refuse('TAXE_SANS_MONTANT', () => comptabiliserTaxe(t.id, notaire));
});

test('la taxe d un dossier sans provision passe, mais rend le dossier debiteur et alerte', () => {
  // Politique retenue par l'etude : le solde client debiteur alerte, il ne
  // bloque pas. Taxer avant d'avoir recu la provision reste donc possible ;
  // l'avance faite par l'office est signalee et suivie, et sa regularisation
  // est exigee avant la cloture de l'exercice.
  const t = creerTaxe(
    { dossier_id: demuni.id, acte: 'Vente sans provision', date_acte: LE('03-03'), prestations: PRESTATIONS_VENTE },
    notaire,
  );
  arreterTaxe(t.id, notaire);
  const { ecriture } = comptabiliserTaxe(t.id, notaire);

  assert.equal(lireTaxe(t.id).statut, 'COMPTABILISEE');
  const solde = un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: demuni.id }).solde;
  assert.ok(solde > 0, 'le dossier non provisionne devient debiteur');

  // L'alerte accompagne l'ecriture de taxe.
  assert.ok(ecriture.alertes?.some((a) => a.code === 'SOLDE_CLIENT_DEBITEUR'),
    'la comptabilisation doit remonter l alerte de solde debiteur');

  // Et le dossier figure a l'etat des comptes debiteurs.
  const etat = etatComptesDebiteurs();
  assert.ok(etat.lignes.some((l) => l.dossier_id === demuni.id));
});

// ==============================  le nouveau controle sur les ecritures manuelles

test('un emolument comptabilise hors dossier est refuse', () => {
  const b = creerBrouillon({
    journal: 'EMO', date_ecriture: LE('03-04'), piece_ref: 'P-9974', libelle: 'Emolument encaisse hors dossier',
    lignes: [
      { compte: '512100', libelle: 'Compte office', debit: 100_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 100_000 },
    ],
  }, notaire);
  refuse('EMOLUMENT_HORS_DOSSIER', () => valider(b.id, notaire));
});

test('un debours a reverser au Tresor comptabilise hors dossier est refuse', () => {
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('03-05'), piece_ref: 'P-9016', libelle: 'Droits d enregistrement sans dossier',
    lignes: [
      { compte: '471000', libelle: 'Attente', debit: 200_000 },
      { compte: '448600', libelle: 'Droits a reverser', credit: 200_000 },
    ],
  }, notaire);
  refuse('DEBOURS_HORS_DOSSIER', () => valider(b.id, notaire));
});

test('un emolument herite du dossier quand l ecriture n en concerne qu un', () => {
  const id = comptabiliser({
    journal: 'EMO', date_ecriture: LE('03-04'), piece_ref: 'P-8118', libelle: 'Emolument complementaire MARTIN',
    lignes: [
      { compte: provisionne.compte_client, libelle: 'Emolument', debit: 22_200 },
      { compte: '706400', libelle: 'Honoraire libre', credit: 20_000 },
      { compte: '445700', libelle: 'TGC', credit: 2_200 },
    ],
  });
  const ligne = un(
    `SELECT dossier_id FROM lignes WHERE ecriture_id = $id AND compte = '706400'`, { id },
  );
  assert.equal(ligne.dossier_id, provisionne.id, 'le produit remonte a l acte sans saisie manuelle');
});

test('un emolument ne peut pas s abriter derriere le dossier d une autre ligne', () => {
  // Deux dossiers dans la meme ecriture : le rattachement du produit devient
  // ambigu, et une ligne de compte client ne vaut pas rattachement de l acte.
  const b = creerBrouillon({
    journal: 'EMO', date_ecriture: LE('03-05'), piece_ref: 'P-1179', libelle: 'Emolument entre deux dossiers',
    lignes: [
      { compte: provisionne.compte_client, libelle: 'Imputation', debit: 100_000 },
      { compte: atelier.compte_client, libelle: 'Contrepartie', credit: 60_000 },
      { compte: '706100', libelle: 'Emoluments', credit: 40_000 },
    ],
  }, notaire);
  refuse('EMOLUMENT_HORS_DOSSIER', () => valider(b.id, notaire));
});

test('le reversement des droits au Tresor reste possible, rattache au dossier', () => {
  const id = comptabiliser({
    journal: 'BQC', date_ecriture: LE('03-06'), piece_ref: 'P-7323', libelle: 'Reversement des droits MARTIN',
    lignes: [
      { compte: '448600', dossier_id: provisionne.id, libelle: 'Droits reverses', debit: 1_000_000 },
      { compte: '512500', libelle: 'Depuis le compte de depot', credit: 1_000_000 },
    ],
  });
  assert.equal(un('SELECT statut FROM ecritures WHERE id = $id', { id }).statut, 'VALIDEE');
});

test('une ecriture anterieure au controle reste contre-passable', () => {
  // Une ecriture comptabilisee avant l'entree en vigueur du rattachement :
  // emolument sans dossier, impossible a saisir aujourd hui. La base interdit
  // de retoucher une ligne validee ; si la contre-passation lui etait fermee,
  // l'ecriture serait definitivement incorrigible.
  const r = exec(
    `INSERT INTO ecritures (exercice_id, journal, numero, date_ecriture, piece_ref, libelle,
                            statut, cree_le, cree_par, valide_le, valide_par)
     VALUES (1, 'OD', 9001, $d, 'ANCIEN', 'Honoraire ancien sans dossier',
             'VALIDEE', $now, 'ancien', $now, 'ancien')`,
    { d: LE('01-05'), now: new Date().toISOString() },
  );
  const ancienne = Number(r.lastInsertRowid);
  exec(
    `INSERT INTO lignes (ecriture_id, ordre, compte, libelle, debit, credit)
     VALUES ($e, 1, '512100', 'Encaissement', 80000, 0), ($e, 2, '706400', 'Honoraire', 0, 80000)`,
    { e: ancienne },
  );

  const c = contrepasser(ancienne, { date_ecriture: LE('06-01'), motif: 'Imputation sans dossier' }, notaire);
  assert.equal(c.origine.statut, 'CONTREPASSEE');
  assert.equal(c.contrepassation.lignes.find((l) => l.compte === '706400').debit, 80_000);

  // Mais la meme ecriture ne peut toujours pas etre saisie a neuf.
  const b = creerBrouillon({
    journal: 'OD', date_ecriture: LE('06-02'), piece_ref: 'P-2296', libelle: 'Honoraire sans dossier',
    lignes: [
      { compte: '512100', libelle: 'Encaissement', debit: 80_000 },
      { compte: '706400', libelle: 'Honoraire', credit: 80_000 },
    ],
  }, notaire);
  refuse('EMOLUMENT_HORS_DOSSIER', () => valider(b.id, notaire));
});

// ======================================================  restitution et alerte

test('le compte definitif du dossier recapitule provisions, emoluments et debours', () => {
  const c = compteDefinitif(provisionne.id);
  assert.equal(c.recu, 5_000_000);
  assert.equal(c.detail.emoluments, 320_000);
  assert.equal(c.detail.tgc, 35_200);
  assert.equal(c.detail.debours, 1_150_000);
  assert.equal(c.total_taxe, 1_505_200);
  assert.equal(c.taxes.length, 1);

  // Le total imputé au dossier depasse le total taxe : l emolument
  // complementaire saisi a la main (22 200 XPF) y figure aussi. Le compte
  // definitif distingue les deux - sans quoi le solde ne se justifierait pas.
  assert.equal(c.impute, 1_527_400);
  assert.equal(c.solde_detenu, c.recu - c.impute);
  assert.equal(c.solde_detenu, 3_472_600);
  assert.ok(c.bareme_fictif, 'le compte definitif porte la mention du bareme non valide');
});

test('une taxe contre-passee sort du compte definitif et des produits', () => {
  // Dossier dedie : on taxe, on comptabilise, puis on extourne l ecriture.
  const d = ouvrirDossier({ reference: 'T-004', intitule: 'ACTE ANNULE' }, notaire);
  comptabiliser({
    journal: 'BQC', date_ecriture: LE('06-03'), piece_ref: 'P-7398', libelle: 'Provision acte annule',
    lignes: [
      { compte: '512500', libelle: 'Virement', debit: 2_000_000 },
      { compte: d.compte_client, libelle: 'Provision', credit: 2_000_000 },
    ],
  });
  const t = creerTaxe(
    { dossier_id: d.id, acte: 'Acte finalement annule', date_acte: LE('06-04'),
      prestations: [{ code: 'EMO-VENTE', assiette: 25_000_000 }] },
    notaire,
  );
  arreterTaxe(t.id, notaire);
  const { ecriture } = comptabiliserTaxe(t.id, notaire);

  const avant = compteDefinitif(d.id);
  assert.equal(avant.total_taxe, 315_240);          // 284 000 + 31 240 de TGC
  assert.equal(avant.solde_detenu, 1_684_760);

  contrepasser(ecriture.id, { date_ecriture: LE('06-05'), motif: 'Acte non signe' }, notaire);

  const apres = compteDefinitif(d.id);
  // Le produit a ete extourne : le compte remis au client ne peut pas
  // continuer a annoncer une taxe que la comptabilite ne porte plus.
  assert.equal(apres.total_taxe, 0);
  assert.equal(apres.detail.emoluments, 0);
  assert.equal(apres.solde_detenu, 2_000_000);
  assert.equal(apres.solde_detenu, apres.recu - apres.impute);
  assert.equal(apres.taxes_annulees.length, 1);

  // La taxe elle-meme reste en base, inalteree : c'est l ecriture qui porte
  // l annulation.
  assert.equal(lireTaxe(t.id).statut, 'COMPTABILISEE');
  assert.ok(etatTaxes({ dossier_id: d.id }).annulees.some((x) => x.id === t.id));
  assert.equal(etatTaxes({ dossier_id: d.id }).totaux.du, 0);
});

test('l etat des taxes separe celles qui restent a comptabiliser', () => {
  const e = etatTaxes();
  // La taxe sans montant reste arretee : rien a comptabiliser.
  assert.ok(e.a_comptabiliser.length >= 1, 'la taxe sans montant doit rester en attente');
  // Les deux taxes chiffrees sont passees, y compris celle du dossier non
  // provisionne, qui a seulement rendu le compte client debiteur.
  assert.equal(e.comptabilisees.length, 2);
});

test('tant que le bareme est fictif, une anomalie critique remonte', () => {
  const a = anomalies().find((x) => x.code === 'BAREME_NON_VALIDE');
  assert.ok(a, 'le tableau de bord doit porter l alerte');
  assert.equal(a.gravite, 'CRITIQUE');
});

test('deux taxes ne portent jamais la meme reference', () => {
  const projet = (acte) => creerTaxe(
    { dossier_id: atelier.id, acte, date_acte: LE('03-07'),
      prestations: [{ code: 'DEBOURS', montant: 1000 }] },
    notaire,
  );
  const a = projet('Projet A');
  const b = projet('Projet B');
  assert.notEqual(a.reference, b.reference);

  // Supprimer un projet qui n'est pas le dernier laisse un trou : sans portee
  // comptable - la continuite exigee porte sur les numeros d'ECRITURES, que la
  // comptabilisation attribue a part - mais la reference n'est jamais reprise
  // par une autre taxe.
  supprimerTaxe(a.id, notaire);
  const c = projet('Projet C');
  assert.notEqual(c.reference, b.reference);
  assert.equal(
    un('SELECT COUNT(*) AS n FROM taxes').n,
    un('SELECT COUNT(DISTINCT reference) AS n FROM taxes').n,
  );

  // Une fois arretee, la taxe n'est plus supprimable : sa reference est figee.
  arreterTaxe(c.id, notaire);
  refuse('TAXE_NON_SUPPRIMABLE', () => supprimerTaxe(c.id, notaire));
  supprimerTaxe(b.id, notaire);
});

test('une comptabilisation refusee ne laisse ni ecriture ni trou dans les chaines', () => {
  // Les taxes refusees plus haut ont cree puis annule brouillons et traces
  // d'audit dans leur transaction : les deux chaines doivent rester intactes.
  const ecritures = verifierChaineEcritures();
  assert.ok(ecritures.valide, ecritures.motif);
  assert.ok(verifierChaineAudit().valide);
  // La comptabilisation d'une taxe est atomique : son refus ne doit laisser
  // aucun brouillon derriere lui, contrairement a une saisie manuelle refusee,
  // qui reste en brouillon avec son motif.
  assert.equal(un(`SELECT COUNT(*) AS n FROM ecritures WHERE statut = 'BROUILLON' AND piece_ref LIKE 'TX-%'`).n, 0);
  assert.equal(un(`SELECT COUNT(*) AS n FROM taxes WHERE statut = 'COMPTABILISEE' AND ecriture_id IS NULL`).n, 0);
});

test('les taxes figurent au dossier d inspection avec leur bareme', () => {
  const liste = listerTaxes({ dossier_id: provisionne.id });
  assert.equal(liste.length, 1);
  assert.equal(liste[0].bareme_code, 'NC-DEMO-1');
});
