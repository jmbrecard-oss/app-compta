import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { RACINE } from '../db.js';
import { sha256 } from '../hash.js';
import { ErreurConformite } from '../erreurs.js';
import { TAUX_TGC } from '../pcn.js';

/**
 * Moteur de baremes : liquidation du tarif notarial.
 *
 * L'article 2 de l'arrete du 27 janvier 2006 soumet a l'examen de conformite
 * "la taxe des actes" et "tous les modules des lors qu'ils generent des
 * ecritures comptables". Le calcul des emoluments entre donc dans le perimetre
 * d'un logiciel de comptabilite notariale.
 *
 * EN NOUVELLE-CALEDONIE LE TARIF RELEVE DU DECRET N 78-321/CG DU 26 SEPTEMBRE
 * 1978, dont le texte n'a pas ete consulte. Ce module ne contient donc AUCUN
 * chiffre : taux, tranches, minimums, comptes d'imputation et regle d'arrondi
 * proviennent tous d'un fichier de donnees externe (src/baremes/bareme-nc.json
 * par defaut, ou le fichier designe par la variable d'environnement
 * COMPTA_BAREME). Le bareme livre se declare FICTIF ; tant qu'il l'est,
 * l'application remonte une anomalie critique.
 *
 * Discipline de calcul :
 *   - les taux sont des entiers en parties par million (ppm) : 4 % = 40 000 ;
 *   - toute la liquidation se fait en BigInt sur des numerateurs entiers ;
 *   - l'arrondi n'intervient qu'UNE fois, sur le total de la prestation, selon
 *     le mode inscrit dans le fichier de bareme. Aucun arrondi intermediaire,
 *     aucun flottant.
 */

const PPM = 1_000_000n;      // les taux sont exprimes en parties par million
const MILLIEME = 1_000n;     // les taux de TGC sont exprimes en milliemes

export const CHEMIN_BAREME_DEFAUT = join(RACINE, 'src', 'baremes', 'bareme-nc.json');

const MODES = new Set(['TRANCHES', 'PROPORTIONNEL', 'FIXE', 'LIBRE']);
const CATEGORIES = new Set(['EMOLUMENT', 'DEBOURS', 'TAXE']);
const ARRONDIS = new Set(['SUPERIEUR', 'INFERIEUR', 'MATHEMATIQUE']);
const ARRONDI_LIBELLE = {
  SUPERIEUR: 'au franc superieur',
  INFERIEUR: 'au franc inferieur',
  MATHEMATIQUE: 'au franc le plus proche',
};

const invalide = (message, details = {}) => {
  throw new ErreurConformite('BAREME_INVALIDE', `Bareme inexploitable : ${message}`, details);
};

/**
 * Entier positif REPRESENTABLE exactement. Number.isInteger accepte 1e300,
 * qui n'est plus un entier pour SQLite ni pour personne : laisse passer, il
 * finirait en flottant dans une colonne INTEGER, ou ferait echouer le pilote
 * avec une erreur brute au lieu d'un refus lisible.
 */
const entierPositif = (v) => Number.isSafeInteger(v) && v >= 0;

// --------------------------------------------------------------- arrondi --

/**
 * Arrondi d'un quotient entier, sans jamais passer par un flottant.
 * Le mode vient du bareme : la direction de l'arrondi est une question de
 * tarif, pas d'implementation.
 */
export function arrondir(numerateur, denominateur, mode) {
  const n = BigInt(numerateur);
  const d = BigInt(denominateur);
  const quotient = n / d;
  const reste = n % d;
  if (reste === 0n) return Number(quotient);
  switch (mode) {
    case 'INFERIEUR': return Number(quotient);
    case 'SUPERIEUR': return Number(quotient + 1n);
    case 'MATHEMATIQUE': return Number(reste * 2n >= d ? quotient + 1n : quotient);
    default: return invalide(`mode d arrondi inconnu (${mode})`);
  }
}

// ------------------------------------------------------ lecture du bareme --

/** Controle de structure. Un bareme mal forme n'est jamais utilise a moitie. */
export function validerBareme(brut, origine = '') {
  if (!brut || typeof brut !== 'object') invalide('fichier illisible', { origine });
  const meta = brut.bareme;
  if (!meta || typeof meta !== 'object') invalide('section "bareme" absente', { origine });
  for (const champ of ['code', 'libelle', 'statut', 'avertissement', 'texte_reference', 'a_valider_par']) {
    if (!String(meta[champ] ?? '').trim()) invalide(`champ bareme.${champ} absent`, { origine });
  }
  if (!['FICTIF', 'VALIDE'].includes(meta.statut)) {
    invalide(`bareme.statut doit valoir FICTIF ou VALIDE (lu : ${meta.statut})`, { origine });
  }
  if (!ARRONDIS.has(brut.arrondi)) {
    invalide(`regle d arrondi absente ou inconnue (${brut.arrondi})`, { origine });
  }
  if (!Array.isArray(brut.prestations) || brut.prestations.length === 0) {
    invalide('aucune prestation declaree', { origine });
  }

  const index = new Map();
  for (const p of brut.prestations) {
    const code = String(p.code ?? '').trim();
    if (!code) invalide('prestation sans code', { origine });
    if (index.has(code)) invalide(`code de prestation en double (${code})`, { origine });
    if (!String(p.libelle ?? '').trim()) invalide(`prestation ${code} sans libelle`, { origine });
    if (!CATEGORIES.has(p.categorie)) invalide(`prestation ${code} : categorie inconnue (${p.categorie})`, { origine });
    if (!MODES.has(p.mode)) invalide(`prestation ${code} : mode inconnu (${p.mode})`, { origine });
    if (!/^\d{6}$/.test(String(p.compte ?? ''))) invalide(`prestation ${code} : compte d imputation absent ou mal forme`, { origine });
    if (p.minimum !== undefined && !entierPositif(p.minimum)) {
      invalide(`prestation ${code} : minimum non entier`, { origine });
    }
    if (p.tgc !== undefined && !TAUX_TGC.some((t) => t.code === p.tgc)) {
      invalide(`prestation ${code} : taux de TGC inconnu (${p.tgc})`, { origine });
    }

    if (p.mode === 'TRANCHES') {
      if (!Array.isArray(p.tranches) || p.tranches.length === 0) {
        invalide(`prestation ${code} : aucune tranche`, { origine });
      }
      let borneeInferieure = 0;
      p.tranches.forEach((t, i) => {
        if (!entierPositif(t.taux_ppm)) invalide(`prestation ${code}, tranche ${i + 1} : taux non entier en ppm`, { origine });
        const derniere = i === p.tranches.length - 1;
        if (derniere) {
          if (t.jusqu_a !== null && t.jusqu_a !== undefined) {
            invalide(`prestation ${code} : la derniere tranche doit etre ouverte (jusqu_a: null)`, { origine });
          }
          return;
        }
        if (!entierPositif(t.jusqu_a)) invalide(`prestation ${code}, tranche ${i + 1} : borne non entiere`, { origine });
        if (t.jusqu_a <= borneeInferieure) {
          invalide(`prestation ${code}, tranche ${i + 1} : les bornes doivent etre strictement croissantes`, { origine });
        }
        borneeInferieure = t.jusqu_a;
      });
    }
    if (p.mode === 'PROPORTIONNEL' && !entierPositif(p.taux_ppm)) {
      invalide(`prestation ${code} : taux non entier en ppm`, { origine });
    }
    if (p.mode === 'FIXE' && !entierPositif(p.montant)) {
      invalide(`prestation ${code} : montant fixe non entier`, { origine });
    }

    index.set(code, { ...p, code, tgc: p.tgc ?? 'TGC0', minimum: p.minimum ?? 0 });
  }

  return {
    meta,
    arrondi: brut.arrondi,
    prestations: [...index.values()],
    index,
    origine,
    empreinte: sha256(JSON.stringify(brut)),
  };
}

const cache = new Map();

/**
 * Charge et valide un fichier de bareme.
 * Le resultat est mis en cache, mais la cle integre la date de modification
 * du fichier : un bareme remplace sur le disque est repris sans redemarrage,
 * et jamais liquide a partir d'une version perimee.
 */
export function chargerBareme(chemin = CHEMIN_BAREME_DEFAUT) {
  let contenu;
  let version;
  try {
    contenu = readFileSync(chemin, 'utf8');
    version = statSync(chemin).mtimeMs;
  } catch (e) {
    return invalide(`fichier ${chemin} illisible (${e.message})`, { chemin });
  }
  const cle = `${chemin}@${version}`;
  if (cache.has(cle)) return cache.get(cle);

  let brut;
  try {
    brut = JSON.parse(contenu);
  } catch (e) {
    return invalide(`fichier ${chemin} : JSON invalide (${e.message})`, { chemin });
  }
  const bareme = validerBareme(brut, chemin);
  // L'empreinte identifie le fichier tel qu'il est sur le disque : c'est elle
  // qui est conservee dans chaque taxe liquidee.
  bareme.empreinte = sha256(contenu);
  cache.set(cle, bareme);
  return bareme;
}

/** Bareme en service. COMPTA_BAREME permet a un office de designer le sien. */
export function baremeCourant() {
  return chargerBareme(process.env.COMPTA_BAREME || CHEMIN_BAREME_DEFAUT);
}

export const baremeFictif = (bareme = baremeCourant()) => bareme.meta.statut !== 'VALIDE';

// ----------------------------------------------------------- liquidation --

/** Taux en ppm restitue en pourcentage lisible : 12 000 ppm -> "1,2". */
const formaterPpm = (ppm) => (ppm / 10_000).toFixed(4)
  .replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
const grouper = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Numerateur exact (en ppm-XPF) de la liquidation par tranches. */
function liquiderTranches(prestation, assiette) {
  let numerateur = 0n;
  let plancher = 0n;
  const etapes = [];
  const base = BigInt(assiette);
  for (const t of prestation.tranches) {
    const plafond = t.jusqu_a === null || t.jusqu_a === undefined ? base : BigInt(t.jusqu_a);
    const haut = base < plafond ? base : plafond;
    if (haut <= plancher) break;
    const part = haut - plancher;
    numerateur += part * BigInt(t.taux_ppm);
    etapes.push(`${grouper(part)} a ${formaterPpm(t.taux_ppm)} %`);
    plancher = haut;
    if (base <= plafond) break;
  }
  return { numerateur, detail: etapes.join(' + ') };
}

/**
 * Liquide une prestation du bareme.
 * Renvoie la ligne de taxe et la justification lisible du calcul : c'est elle
 * qu'un inspecteur confronte au bareme.
 */
export function calculerPrestation(saisie, bareme = baremeCourant()) {
  const code = String(saisie?.code ?? '').trim();
  const prestation = bareme.index.get(code);
  if (!prestation) {
    throw new ErreurConformite('PRESTATION_INCONNUE', `Prestation ${code || '(vide)'} absente du bareme ${bareme.meta.code}.`, { code });
  }

  const assiette = saisie.assiette ?? 0;
  const quantite = saisie.quantite ?? 1;
  if (!entierPositif(assiette)) {
    throw new ErreurConformite(
      'ASSIETTE_INVALIDE',
      `Assiette invalide pour ${code} : le franc Pacifique ne comporte pas de decimale et une assiette ne peut etre negative.`,
      { code, assiette },
    );
  }
  if (!entierPositif(quantite) || quantite < 1) {
    throw new ErreurConformite('QUANTITE_INVALIDE', `Quantite invalide pour ${code}.`, { code, quantite });
  }

  // Une assiette nulle n'est pas une assiette : liquider un emolument
  // proportionnel sur rien reviendrait a facturer le minimum du bareme sur un
  // champ laisse vide.
  if ((prestation.mode === 'TRANCHES' || prestation.mode === 'PROPORTIONNEL') && assiette === 0) {
    throw new ErreurConformite(
      'ASSIETTE_INVALIDE',
      `Prestation ${code} : une assiette est requise pour liquider un emolument proportionnel.`,
      { code },
    );
  }

  let numerateur = 0n;
  let denominateur = 1n;
  let detail = '';
  // Montant libre tel qu'il a ete saisi, avant application de la quantite :
  // c'est l'ENTREE de la liquidation, celle dont le recalcul doit repartir.
  let montantSaisi = 0;

  switch (prestation.mode) {
    case 'TRANCHES': {
      const r = liquiderTranches(prestation, assiette);
      numerateur = r.numerateur * BigInt(quantite);
      denominateur = PPM;
      detail = r.detail;
      break;
    }
    case 'PROPORTIONNEL':
      numerateur = BigInt(assiette) * BigInt(prestation.taux_ppm) * BigInt(quantite);
      denominateur = PPM;
      detail = `${grouper(assiette)} a ${formaterPpm(prestation.taux_ppm)} %`;
      break;
    case 'FIXE':
      numerateur = BigInt(prestation.montant) * BigInt(quantite);
      detail = quantite > 1 ? `${quantite} x ${grouper(prestation.montant)} XPF` : `forfait ${grouper(prestation.montant)} XPF`;
      break;
    case 'LIBRE': {
      montantSaisi = saisie.montant ?? 0;
      const montant = montantSaisi;
      if (!entierPositif(montant)) {
        throw new ErreurConformite(
          'MONTANT_INVALIDE',
          `Prestation ${code} : montant libre attendu, entier et positif, en XPF.`,
          { code, montant: saisie.montant },
        );
      }
      numerateur = BigInt(montant) * BigInt(quantite);
      detail = 'montant libre';
      break;
    }
    default:
      return invalide(`mode ${prestation.mode} non liquidable`);
  }

  // Unique arrondi de la liquidation.
  let montant = arrondir(numerateur, denominateur, bareme.arrondi);
  if (denominateur !== 1n && numerateur % denominateur !== 0n) {
    // Liquidation exacte avant arrondi, affichee au centieme sans flottant.
    const entier = numerateur / denominateur;
    const centiemes = ((numerateur % denominateur) * 100n) / denominateur;
    detail += ` = ${grouper(entier)},${String(centiemes).padStart(2, '0')} arrondi ${ARRONDI_LIBELLE[bareme.arrondi]}`;
  }
  detail += ` = ${grouper(montant)} XPF`;
  if (prestation.minimum && montant < prestation.minimum) {
    montant = prestation.minimum;
    detail += `, porte au minimum du bareme : ${grouper(montant)} XPF`;
  }

  const tgc = TAUX_TGC.find((t) => t.code === prestation.tgc);
  const tgcMontant = tgc.taux_millieme === 0
    ? 0
    : arrondir(BigInt(montant) * BigInt(tgc.taux_millieme), MILLIEME, bareme.arrondi);

  if (!Number.isSafeInteger(montant) || !Number.isSafeInteger(tgcMontant)) {
    throw new ErreurConformite('MONTANT_HORS_LIMITES', `Prestation ${code} : montant hors des limites representables.`, { code });
  }

  return {
    code: prestation.code,
    libelle: String(saisie.libelle ?? prestation.libelle),
    categorie: prestation.categorie,
    compte: prestation.compte,
    mode: prestation.mode,
    assiette,
    quantite,
    montant_saisi: montantSaisi,
    montant,
    tgc_code: prestation.tgc,
    tgc_montant: tgcMontant,
    detail,
  };
}

export const totaliser = (lignes) => {
  const emoluments = lignes.filter((l) => l.categorie === 'EMOLUMENT').reduce((s, l) => s + l.montant, 0);
  const debours = lignes.filter((l) => l.categorie !== 'EMOLUMENT').reduce((s, l) => s + l.montant, 0);
  const tgc = lignes.reduce((s, l) => s + l.tgc_montant, 0);
  return {
    total_emoluments: emoluments,
    total_debours: debours,
    total_tgc: tgc,
    total_du: emoluments + debours + tgc,
  };
};

/** Liquidation complete d'un acte, sans rien enregistrer. */
export function simulerTaxe(saisie, bareme = baremeCourant()) {
  const demandees = Array.isArray(saisie?.prestations) ? saisie.prestations : [];
  if (!demandees.length) {
    throw new ErreurConformite('TAXE_VIDE', 'Une taxe comporte au moins une prestation.');
  }
  const lignes = demandees.map((p, i) => ({ ordre: i + 1, ...calculerPrestation(p, bareme) }));
  return {
    acte: String(saisie.acte ?? '').trim(),
    date_acte: saisie.date_acte ?? null,
    dossier_id: saisie.dossier_id ?? null,
    bareme: { code: bareme.meta.code, statut: bareme.meta.statut, empreinte: bareme.empreinte },
    lignes,
    ...totaliser(lignes),
  };
}

