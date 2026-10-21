/**
 * Jeu de demonstration.
 *
 * Cree un office fictif, cinq dossiers a des stades differents et une
 * cinquantaine d'ecritures, de facon a pouvoir parcourir chaque ecran avec
 * des donnees credibles : etats, rapprochement, dossier d'inspection.
 *
 * DONNEES FICTIVES. Les noms, montants et references sont inventes.
 * A n'utiliser que sur une base jetable, jamais sur la base d'un office.
 *
 *   node src/demo.js                      base par defaut (refuse si non vide)
 *   COMPTA_DB=/tmp/demo.sqlite node src/demo.js
 *   node src/demo.js --mdp motdepasse
 */

import { writeFileSync } from 'node:fs';

import { ouvrirBase, un, exec, transaction, fermerBase } from './db.js';
import { initialiser } from './init.js';
import { ouvrirDossier } from './domain/dossiers.js';
import { creerBrouillon, valider } from './domain/ecritures.js';
import { ouvrirRapprochement, pointer, cloreRapprochement } from './domain/rapprochement.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;

const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(nom);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

// --------------------------------------------------------------- dossiers --

const DOSSIERS = [
  {
    reference: `${ANNEE}-00041`,
    intitule: 'TAUFA / WAMYTAN - vente appartement Nouville',
    nature_acte: 'Vente immobiliere',
    notaire: 'Me Lefevre',
    collaborateur: 'C. Poadja',
  },
  {
    reference: `${ANNEE}-00057`,
    intitule: 'Succession BERNARD Jacqueline',
    nature_acte: 'Succession',
    notaire: 'Me Lefevre',
    collaborateur: 'M. Gope',
  },
  {
    reference: `${ANNEE}-00063`,
    intitule: 'SCI LES BANIANS - acquisition terrain Dumbea',
    nature_acte: 'Vente immobiliere',
    notaire: 'Me Lefevre',
    collaborateur: 'C. Poadja',
  },
  {
    reference: `${ANNEE}-00071`,
    intitule: 'KASOVIMOIN / Donation-partage',
    nature_acte: 'Donation-partage',
    notaire: 'Me Lefevre',
    collaborateur: 'M. Gope',
  },
  {
    reference: `${ANNEE}-00078`,
    intitule: 'MARTIN Olivier - pret hypothecaire BCI',
    nature_acte: 'Pret',
    notaire: 'Me Lefevre',
    collaborateur: 'C. Poadja',
  },
];

/**
 * Ecritures du jeu de demonstration.
 *
 * `cc(n)` designe le compte client du n-ieme dossier : il n'est connu
 * qu'apres creation, d'ou la fonction.
 */
function ecritures(cc) {
  return [
    // -------------------------------------------------- vie de l'office --
    { journal: 'BQO', date: LE('01-05'), libelle: 'Apport initial de l exploitant', piece: 'AP-001',
      lignes: [{ compte: '512100', debit: 4_000_000 }, { compte: '108000', credit: 4_000_000 }] },
    { journal: 'ACH', date: LE('01-10'), libelle: 'Loyer des locaux - janvier', piece: 'F-2026-0012',
      lignes: [{ compte: '613000', debit: 185_000 }, { compte: '401000', credit: 185_000 }] },
    { journal: 'BQO', date: LE('01-15'), libelle: 'Reglement loyer janvier', piece: 'VIR-0041',
      lignes: [{ compte: '401000', debit: 185_000 }, { compte: '512100', credit: 185_000 }] },
    { journal: 'ACH', date: LE('01-20'), libelle: 'Abonnement telephonie et internet', piece: 'F-2026-0031',
      lignes: [{ compte: '626000', debit: 42_500 }, { compte: '401000', credit: 42_500 }] },
    { journal: 'ACH', date: LE('02-02'), libelle: 'Cotisation Chambre des notaires', piece: 'F-CH-004',
      lignes: [{ compte: '622600', debit: 320_000 }, { compte: '401000', credit: 320_000 }] },
    { journal: 'BQO', date: LE('02-05'), libelle: 'Reglement cotisation Chambre', piece: 'VIR-0058',
      lignes: [{ compte: '401000', debit: 320_000 }, { compte: '512100', credit: 320_000 }] },
    { journal: 'ACH', date: LE('02-10'), libelle: 'Loyer des locaux - fevrier', piece: 'F-2026-0067',
      lignes: [{ compte: '613000', debit: 185_000 }, { compte: '401000', credit: 185_000 }] },
    { journal: 'BQO', date: LE('02-14'), libelle: 'Reglement loyer fevrier', piece: 'VIR-0072',
      lignes: [{ compte: '401000', debit: 185_000 }, { compte: '512100', credit: 185_000 }] },

    // ------------------------- dossier 1 : vente, cycle complet et solde --
    { journal: 'BQC', date: LE('01-12'), libelle: 'Provision sur vente Nouville', piece: 'VIR-C-0101',
      dossier: 0, lignes: [{ compte: '512500', debit: 2_400_000 }, { compte: cc(0), credit: 2_400_000 }] },
    { journal: 'BQC', date: LE('01-28'), libelle: 'Droits d enregistrement - vente Nouville', piece: 'DEB-0101',
      dossier: 0, lignes: [{ compte: cc(0), debit: 1_320_000 }, { compte: '448600', credit: 1_320_000 }] },
    { journal: 'BQC', date: LE('01-28'), libelle: 'Taxe hypothecaire - vente Nouville', piece: 'DEB-0102',
      dossier: 0, lignes: [{ compte: cc(0), debit: 184_000 }, { compte: '448700', credit: 184_000 }] },
    { journal: 'EMO', date: LE('02-03'), libelle: 'Emoluments d acte - vente Nouville', piece: 'TAX-0041',
      dossier: 0, lignes: [{ compte: cc(0), debit: 561_000 }, { compte: '706100', credit: 506_000 }, { compte: '445700', credit: 55_000 }] },
    { journal: 'BQC', date: LE('02-06'), libelle: 'Virement des emoluments vers le compte office', piece: 'VIR-I-0012',
      dossier: 0, lignes: [{ compte: '473000', debit: 561_000 }, { compte: '512500', credit: 561_000 }] },
    { journal: 'BQO', date: LE('02-06'), libelle: 'Encaissement des emoluments - vente Nouville', piece: 'VIR-I-0012',
      dossier: 0, lignes: [{ compte: '512100', debit: 561_000 }, { compte: '473000', credit: 561_000 }] },
    { journal: 'BQC', date: LE('02-20'), libelle: 'Reversement des droits au Tresor - dossier 00041', piece: 'VIR-T-0007',
      dossier: 0, lignes: [{ compte: '448600', debit: 1_320_000 }, { compte: '448700', debit: 184_000 }, { compte: '512500', credit: 1_504_000 }] },
    { journal: 'BQC', date: LE('02-24'), libelle: 'Restitution du solde au client - vente Nouville', piece: 'VIR-C-0188',
      dossier: 0, lignes: [{ compte: cc(0), debit: 335_000 }, { compte: '512500', credit: 335_000 }] },

    // --------------------- dossier 2 : succession en cours, fonds detenus --
    { journal: 'BQC', date: LE('01-22'), libelle: 'Fonds de succession recus de la BCI', piece: 'VIR-C-0112',
      dossier: 1, lignes: [{ compte: '512500', debit: 8_750_000 }, { compte: cc(1), credit: 8_750_000 }] },
    { journal: 'BQC', date: LE('02-08'), libelle: 'Frais de publication - succession BERNARD', piece: 'DEB-0117',
      dossier: 1, lignes: [{ compte: cc(1), debit: 96_000 }, { compte: '448800', credit: 96_000 }] },
    { journal: 'BQC', date: LE('02-18'), libelle: 'Acompte versement heritier BERNARD P.', piece: 'VIR-C-0164',
      dossier: 1, lignes: [{ compte: cc(1), debit: 2_000_000 }, { compte: '512500', credit: 2_000_000 }] },
    { journal: 'EMO', date: LE('03-02'), libelle: 'Emoluments de formalites - succession', piece: 'TAX-0057',
      dossier: 1, lignes: [{ compte: cc(1), debit: 266_400 }, { compte: '706200', credit: 240_000 }, { compte: '445700', credit: 26_400 }] },

    // ---------------------- dossier 3 : acquisition, provision importante --
    { journal: 'BQC', date: LE('02-11'), libelle: 'Provision SCI LES BANIANS', piece: 'VIR-C-0141',
      dossier: 2, lignes: [{ compte: '512500', debit: 15_000_000 }, { compte: cc(2), credit: 15_000_000 }] },
    { journal: 'BQC', date: LE('02-27'), libelle: 'Droits d enregistrement - terrain Dumbea', piece: 'DEB-0133',
      dossier: 2, lignes: [{ compte: cc(2), debit: 4_400_000 }, { compte: '448600', credit: 4_400_000 }] },
    { journal: 'EMO', date: LE('03-05'), libelle: 'Emoluments d acte - terrain Dumbea', piece: 'TAX-0063',
      dossier: 2, lignes: [{ compte: cc(2), debit: 998_400 }, { compte: '706100', credit: 900_000 }, { compte: '445700', credit: 98_400 }] },

    // -------------------------- dossier 4 : donation-partage, petit solde --
    { journal: 'BQC', date: LE('02-19'), libelle: 'Provision donation-partage KASOVIMOIN', piece: 'VIR-C-0159',
      dossier: 3, lignes: [{ compte: '512500', debit: 850_000 }, { compte: cc(3), credit: 850_000 }] },
    { journal: 'BQC', date: LE('03-04'), libelle: 'Frais de publicite fonciere - donation', piece: 'DEB-0148',
      dossier: 3, lignes: [{ compte: cc(3), debit: 72_000 }, { compte: '448800', credit: 72_000 }] },

    // ------------------------------- dossier 5 : pret, ouvert sans mouvement
    { journal: 'BQC', date: LE('03-09'), libelle: 'Provision pret hypothecaire MARTIN', piece: 'VIR-C-0177',
      dossier: 4, lignes: [{ compte: '512500', debit: 420_000 }, { compte: cc(4), credit: 420_000 }] },

    // ------------------------------------------- frais de mars et salaires --
    { journal: 'ACH', date: LE('03-10'), libelle: 'Loyer des locaux - mars', piece: 'F-2026-0104',
      lignes: [{ compte: '613000', debit: 185_000 }, { compte: '401000', credit: 185_000 }] },
    { journal: 'BQO', date: LE('03-12'), libelle: 'Salaires de fevrier', piece: 'PAIE-02',
      lignes: [{ compte: '641000', debit: 780_000 }, { compte: '512100', credit: 780_000 }] },
    { journal: 'CAI', date: LE('03-13'), libelle: 'Alimentation de la caisse', piece: 'CAI-004',
      lignes: [{ compte: '531000', debit: 50_000 }, { compte: '512100', credit: 50_000 }] },
    { journal: 'CAI', date: LE('03-16'), libelle: 'Achat de fournitures de bureau', piece: 'CAI-005',
      lignes: [{ compte: '606400', debit: 18_500 }, { compte: '531000', credit: 18_500 }] },
  ];
}

// ------------------------------------------------------------------ main --

function construire() {
  const base = process.env.COMPTA_DB ?? '(base par defaut)';
  ouvrirBase();

  if (un('SELECT id FROM ecritures LIMIT 1')) {
    console.error(
      `\nRefus : la base ${base} contient deja des ecritures.\n` +
      `Le jeu de demonstration ne s installe que sur une base vierge, pour ne jamais\n` +
      `risquer de polluer la comptabilite d un office.\n\n` +
      `  COMPTA_DB=/tmp/demo.sqlite node src/demo.js\n`,
    );
    process.exitCode = 1;
    return null;
  }

  const mdp = arg('--mdp');
  const init = initialiser({
    denomination: 'SCP LEFEVRE & POADJA, notaires associes',
    notaire: 'Me Catherine Lefevre',
    adresse: '12 rue de l Alma, 98800 Noumea',
    ridet: '0000000.001',
    motDePasse: mdp,
  });

  const utilisateur = { identifiant: 'notaire', role: 'NOTAIRE' };
  const dossiers = DOSSIERS.map((d) => ouvrirDossier({ ...d, ouvert_le: LE('01-08') }, utilisateur));
  const cc = (i) => dossiers[i].compte_client;

  let comptabilisees = 0;
  let brouillons = 0;

  // Les ecritures doivent etre comptabilisees dans l'ordre des dates : chaque
  // journal exige une chronologie continue.
  const aPoster = ecritures(cc).sort((a, b) => a.date.localeCompare(b.date));

  for (const e of aPoster) {
    const saisie = {
      journal: e.journal,
      date_ecriture: e.date,
      piece_ref: e.piece,
      libelle: e.libelle,
      dossier_id: e.dossier === undefined ? null : dossiers[e.dossier].id,
      lignes: e.lignes.map((l, i) => ({
        ordre: i + 1,
        compte: l.compte,
        libelle: e.libelle,
        debit: l.debit ?? 0,
        credit: l.credit ?? 0,
      })),
    };
    const brouillon = creerBrouillon(saisie, utilisateur);
    valider(brouillon.id, utilisateur);
    comptabilisees++;
  }

  // Un brouillon laisse en attente : le dossier d'inspection doit le signaler.
  creerBrouillon(
    {
      journal: 'ACH', date_ecriture: LE('03-18'), piece_ref: 'F-2026-0131',
      libelle: 'Entretien du systeme informatique - a verifier',
      lignes: [
        { ordre: 1, compte: '615000', libelle: 'Entretien informatique', debit: 134_000, credit: 0 },
        { ordre: 2, compte: '401000', libelle: 'Entretien informatique', debit: 0, credit: 134_000 },
      ],
    },
    utilisateur,
  );
  brouillons++;

  // Un rapprochement bancaire clos sur le compte office, pour que l'ecran ne
  // soit pas vide et que la pre-cloture ait de quoi se prononcer. Le releve
  // est cale sur la comptabilite a la date d'arrete : tout se pointe, l'ecart
  // est nul, le rapprochement se clot.
  const arrete = LE('02-28');
  const soldeAuArrete = un(
    `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS s
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = '512100' AND e.statut <> 'BROUILLON' AND e.date_ecriture <= $d`,
    { d: arrete },
  ).s;

  const rappro = ouvrirRapprochement(
    { compte: '512100', date_arrete: arrete, solde_releve: soldeAuArrete },
    utilisateur,
  );
  pointer(rappro.id, rappro.en_suspens.map((m) => m.id), true, utilisateur);
  cloreRapprochement(rappro.id, utilisateur);

  const mdpFinal = init.compte_initial?.motDePasse ?? '(compte deja existant, mot de passe inchange)';

  // Les accès sont ecrits sur disque : la commande qui installe la demo et
  // celle qui la lance sont distinctes, et le mot de passe ne doit pas se
  // perdre entre les deux.
  const fichierAcces = new URL('../data/demo-acces.txt', import.meta.url).pathname;
  writeFileSync(
    fichierAcces,
    `Jeu de demonstration - DONNEES FICTIVES\n`
    + `Installe le ${new Date().toISOString().slice(0, 16).replace('T', ' a ')}\n\n`
    + `  Adresse      http://127.0.0.1:7420\n`
    + `  Identifiant  notaire\n`
    + `  Mot de passe ${mdpFinal}\n\n`
    + `Base jetable : data/demo.sqlite. Supprimez-la et relancez "npm run demo"\n`
    + `pour repartir a zero.\n`,
    'utf8',
  );

  return { dossiers, comptabilisees, brouillons, mdp: mdpFinal, fichierAcces };
}

const r = construire();
if (r) {
  console.log(`
Jeu de demonstration installe. DONNEES FICTIVES.

  Office      SCP LEFEVRE & POADJA, notaires associes (Noumea)
  Dossiers    ${r.dossiers.length}
  Ecritures   ${r.comptabilisees} comptabilisees, ${r.brouillons} brouillon en attente

  Connexion   notaire — mot de passe note dans data/demo-acces.txt

Lancer l interface :  npm run demo:start
`);
}
fermerBase();
