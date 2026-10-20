import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { un, tous } from '../db.js';
import { ErreurConformite } from './controles.js';

/**
 * TGC - taxe generale sur la consommation (Nouvelle-Caledonie).
 *
 * Deux choses distinctes vivent ici :
 *
 *   1. un CONTROLE BLOQUANT : toute taxe portee en comptabilite doit etre
 *      justifiee par une assiette et un taux en vigueur, et toute declaration
 *      doit boucler sur des soldes qui existent reellement ;
 *   2. un ETAT PREPARATOIRE a la declaration, qui ventile la taxe par taux a
 *      partir des seules ecritures comptabilisees et se rapproche du
 *      mouvement des comptes 445600 / 445700.
 *
 * Les taux, la periodicite et la regle d'arrondi ne sont pas ecrits dans le
 * code : ils proviennent d'un fichier de parametres separe, livre avec le
 * statut A_VALIDER. Le chargeur refuse un fichier qui se declarerait conforme
 * sans porter la reference du texte : aucun chiffre ne peut se presenter comme
 * reglementaire sans source.
 */

const ICI = dirname(fileURLToPath(import.meta.url));
export const CHEMIN_PARAMETRES_TGC = join(ICI, '..', 'parametres', 'tgc-nc.json');

const ARRONDIS = new Set(['PROCHE', 'INFERIEUR', 'SUPERIEUR']);
const PERIODICITES = new Set(['MENSUELLE', 'TRIMESTRIELLE']);

const cache = new Map();

const invalide = (chemin, motif) => {
  throw new ErreurConformite(
    'PARAMETRES_TGC_INVALIDES',
    `Parametres de TGC inexploitables (${chemin}) : ${motif}`,
    { chemin },
  );
};

function verifierParametres(p, chemin) {
  if (!p || typeof p !== 'object') invalide(chemin, 'fichier vide ou illisible');
  if (p.statut !== 'A_VALIDER' && p.statut !== 'VALIDE') {
    invalide(chemin, 'statut attendu : A_VALIDER ou VALIDE');
  }
  const taux = Array.isArray(p.taux) ? p.taux : null;
  if (!taux || !taux.length) invalide(chemin, 'aucun taux defini');
  for (const t of taux) {
    if (!t.code || !t.libelle) invalide(chemin, 'un taux sans code ni libelle');
    if (!Number.isInteger(t.taux_millieme) || t.taux_millieme < 0 || t.taux_millieme > 1000) {
      invalide(chemin, `taux ${t.code} : millieme entier attendu entre 0 et 1000`);
    }
  }
  if (!taux.some((t) => t.taux_millieme > 0)) invalide(chemin, 'aucun taux non nul');

  // Un bareme ne peut se dire valide qu'en citant son texte : sans cela, les
  // chiffres restent des hypotheses et doivent le dire.
  if (p.statut === 'VALIDE') {
    if (!String(p.reference ?? '').trim()) {
      invalide(chemin, 'statut VALIDE sans reference du texte applicable');
    }
    const orphelins = taux.filter((t) => t.sourcee !== true).map((t) => t.code);
    if (orphelins.length) {
      invalide(chemin, `statut VALIDE mais taux non sources : ${orphelins.join(', ')}`);
    }
  } else if (String(p.avertissement ?? '').trim().length < 40) {
    invalide(chemin, 'statut A_VALIDER sans avertissement explicite');
  }

  for (const r of ['collectee', 'deductible', 'a_decaisser']) {
    if (!String(p.comptes?.[r] ?? '').trim()) invalide(chemin, `compte de TGC ${r} non renseigne`);
  }
  if (!ARRONDIS.has(p.arrondi)) invalide(chemin, `arrondi inconnu : ${p.arrondi}`);
  if (!Number.isInteger(p.tolerance_arrondi_xpf) || p.tolerance_arrondi_xpf < 0) {
    invalide(chemin, 'tolerance d arrondi : entier positif ou nul attendu');
  }
  if (!PERIODICITES.has(p.declaration?.periodicite)) {
    invalide(chemin, `periodicite inconnue : ${p.declaration?.periodicite}`);
  }
  if (!Number.isInteger(p.declaration?.jours_apres_periode) || p.declaration.jours_apres_periode < 0) {
    invalide(chemin, 'delai de depot : nombre de jours entier positif attendu');
  }
  return p;
}

/** Charge et valide un jeu de parametres. Le resultat est mis en cache. */
export function chargerParametresTgc(chemin = CHEMIN_PARAMETRES_TGC) {
  if (cache.has(chemin)) return cache.get(chemin);
  let brut;
  try {
    brut = JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (e) {
    invalide(chemin, e.message);
  }
  const p = verifierParametres(brut, chemin);
  cache.set(chemin, p);
  return p;
}

export function oublierParametresTgc() {
  cache.clear();
}

// ---------------------------------------------------------------- liquidation

/**
 * Applique un taux exprime en milliemes a une assiette entiere de XPF.
 * Tout est fait en arithmetique entiere : le franc Pacifique n'a pas de
 * subdivision et aucun arrondi ne doit se produire en silence.
 */
export function liquiderTgc(assiette, tauxMillieme, arrondi = 'PROCHE') {
  if (!Number.isInteger(assiette) || !Number.isInteger(tauxMillieme)) {
    throw new ErreurConformite('MONTANT_NON_ENTIER', 'Assiette et taux doivent etre des entiers.');
  }
  if (!ARRONDIS.has(arrondi)) {
    throw new ErreurConformite('PARAMETRES_TGC_INVALIDES', `Arrondi inconnu : ${arrondi}`);
  }
  const signe = assiette < 0 ? -1 : 1;
  const brut = Math.abs(assiette) * tauxMillieme;
  const francs = arrondi === 'INFERIEUR' ? Math.floor(brut / 1000)
    : arrondi === 'SUPERIEUR' ? Math.ceil(brut / 1000)
      : Math.floor((brut + 500) / 1000);
  return signe * francs;
}

/**
 * Retrouve le taux applique a partir du couple (assiette, taxe).
 *
 * La fenetre d'acceptation vaut un franc - l'ecart maximal entre deux regles
 * d'arrondi - elargie de la tolerance parametree. Comparaison en entiers :
 * |taxe x 1000 - assiette x millieme| < (1 + tolerance) x 1000.
 */
export function identifierTauxTgc(assiette, taxe, parametres = chargerParametresTgc()) {
  if (!Number.isInteger(assiette) || !Number.isInteger(taxe)) {
    throw new ErreurConformite('MONTANT_NON_ENTIER', 'Assiette et taxe doivent etre des entiers.');
  }
  if (assiette === 0 || taxe === 0) return null;
  if (Math.sign(assiette) !== Math.sign(taxe)) return null;

  const fenetre = (1 + parametres.tolerance_arrondi_xpf) * 1000;
  let meilleur = null;
  for (const t of parametres.taux) {
    if (t.taux_millieme <= 0) continue;
    const ecart = Math.abs(taxe * 1000 - assiette * t.taux_millieme);
    if (ecart >= fenetre) continue;
    if (!meilleur || ecart < meilleur.ecart
      || (ecart === meilleur.ecart && t.taux_millieme < meilleur.taux_millieme)) {
      meilleur = { code: t.code, libelle: t.libelle, taux_millieme: t.taux_millieme, ecart };
    }
  }
  return meilleur;
}

// ------------------------------------------------------------------ analyse

const classes = new Map();

function classeDuCompte(numero) {
  if (classes.has(numero)) return classes.get(numero);
  const c = un('SELECT classe FROM comptes WHERE numero = $n', { n: numero });
  // Un compte absent n'est pas memorise : les comptes clients naissent en
  // cours d'exploitation, a l'ouverture de chaque dossier.
  if (c) classes.set(numero, c.classe);
  return c ? c.classe : null;
}

/**
 * Decompose une ecriture du point de vue de la TGC.
 *
 * d7 / d6 / d5 : mouvement net (debit - credit) des comptes de TGC collectee,
 * deductible et a decaisser. assiette_produits et assiette_charges : assiette
 * potentielle presente dans la meme ecriture.
 */
function decomposer(lignes, parametres) {
  const { collectee, deductible, a_decaisser } = parametres.comptes;
  const d = { d7: 0, d6: 0, d5: 0, assiette_produits: 0, assiette_charges: 0, touche: false, base: false };
  for (const l of lignes) {
    const net = (l.debit ?? 0) - (l.credit ?? 0);
    if (l.compte === collectee) { d.d7 += net; d.touche = true; continue; }
    if (l.compte === deductible) { d.d6 += net; d.touche = true; continue; }
    if (l.compte === a_decaisser) { d.d5 += net; d.touche = true; continue; }
    const classe = classeDuCompte(l.compte);
    if (classe === 7) { d.assiette_produits -= net; d.base = true; }
    else if (classe === 6 || classe === 2) { d.assiette_charges += net; d.base = true; }
  }
  // Sans aucune ligne d'assiette, l'ecriture solde ou regle la taxe : elle ne
  // la constitue pas. C'est la declaration ou son paiement.
  d.liquidation = d.touche && !d.base;
  return d;
}

const soldeAu = (compte, date, sens) => {
  const r = un(
    `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS solde
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       AND ($d IS NULL OR e.date_ecriture <= $d)`,
    { c: compte, d: date ?? null },
  ).solde;
  // `0` et non `-0` : un solde nul s'affiche et se compare comme un zero.
  return sens === 'CREDIT' && r !== 0 ? -r : r;
};

// -------------------------------------------------------- controle bloquant

/**
 * Controle bloquant de la TGC, execute a la comptabilisation.
 *
 * Ce qui est refuse :
 *   - une taxe collectee ou deductible qui ne correspond a aucun taux en
 *     vigueur applique a l'assiette presente dans l'ecriture ;
 *   - une taxe sans assiette du tout ;
 *   - une declaration dont l'arithmetique ne boucle pas ;
 *   - une declaration ou un reglement qui porterait sur plus de taxe que la
 *     comptabilite n'en a enregistre a cette date.
 *
 * Les a-nouveaux sont hors champ : ils reprennent des soldes, ils ne
 * constituent pas de taxe.
 */
export function controleTgc(lignes, ecriture, parametres = chargerParametresTgc()) {
  const journal = un('SELECT type FROM journaux WHERE code = $c', { c: ecriture.journal });
  if (journal?.type === 'ANOUVEAU') return null;

  const d = decomposer(lignes, parametres);
  if (!d.touche) return null;

  const { collectee, deductible, a_decaisser } = parametres.comptes;
  const date = ecriture.date_ecriture;

  if (d.liquidation) {
    if (d.d7 !== 0 || d.d6 !== 0) {
      const reste = d.d7 + d.d6 + d.d5;
      if (reste !== 0) {
        throw new ErreurConformite(
          'TGC_LIQUIDATION_INCOHERENTE',
          `Declaration de TGC incoherente : ${d.d7} XPF de taxe collectee soldee, `
          + `${-d.d6} XPF de taxe deductible imputee, ${-d.d5} XPF portes a decaisser `
          + `- il reste ${reste} XPF inexpliques.`,
          { collectee_soldee: d.d7, deductible_imputee: -d.d6, a_decaisser: -d.d5, ecart: reste },
        );
      }
    }
    const manque = (compte, demande, sens, quoi) => {
      if (demande <= 0) return;
      const disponible = soldeAu(compte, date, sens);
      if (demande > disponible) {
        throw new ErreurConformite(
          'TGC_SOLDE_INSUFFISANT',
          `${quoi} : ${demande} XPF portes au compte ${compte} alors que la comptabilite `
          + `n en presente que ${disponible} XPF au ${date}.`,
          { compte, demande, disponible, date },
        );
      }
    };
    manque(collectee, d.d7, 'CREDIT', 'Declaration de TGC');
    manque(deductible, -d.d6, 'DEBIT', 'Imputation de TGC deductible');
    manque(a_decaisser, d.d5, 'CREDIT', 'Reglement de TGC au Tresor');
    return { mode: 'LIQUIDATION', ...d };
  }

  const justifier = (taxe, assiette, cote, compte) => {
    if (taxe === 0) return null;
    if (assiette === 0) {
      throw new ErreurConformite(
        'TGC_SANS_ASSIETTE',
        `TGC ${cote} de ${Math.abs(taxe)} XPF portee au compte ${compte} sans aucune assiette `
        + `dans l ecriture : la taxe doit accompagner l operation qui la produit.`,
        { compte, taxe, cote },
      );
    }
    const t = identifierTauxTgc(assiette, taxe, parametres);
    if (!t) {
      const implicite = Math.round((taxe * 1000) / assiette);
      throw new ErreurConformite(
        'TGC_ASSIETTE_INCOHERENTE',
        `TGC ${cote} de ${taxe} XPF pour une assiette de ${assiette} XPF, soit `
        + `${(implicite / 10).toFixed(1)} % : aucun taux en vigueur ne correspond. `
        + `Corriger le montant, ou scinder l ecriture si plusieurs taux s appliquent.`,
        {
          compte, taxe, assiette, taux_implicite_millieme: implicite,
          taux_en_vigueur: parametres.taux.filter((x) => x.taux_millieme > 0).map((x) => x.taux_millieme),
        },
      );
    }
    return t;
  };

  return {
    mode: 'ASSIETTE',
    ...d,
    taux_collectee: justifier(-d.d7, d.assiette_produits, 'collectee', collectee),
    taux_deductible: justifier(d.d6, d.assiette_charges, 'deductible', deductible),
  };
}

// --------------------------------------------------------------- ventilation

const vide = () => ({ taux: new Map(), total: 0, assiette_totale: 0 });

function ajouter(bucket, t, assiette, taxe) {
  const cle = t.code;
  const e = bucket.taux.get(cle) ?? {
    code: t.code, libelle: t.libelle, taux_millieme: t.taux_millieme,
    assiette: 0, taxe: 0, ecritures: 0,
  };
  e.assiette += assiette;
  e.taxe += taxe;
  e.ecritures += 1;
  bucket.taux.set(cle, e);
  bucket.total += taxe;
  bucket.assiette_totale += assiette;
}

const fige = (bucket) => ({
  taux: [...bucket.taux.values()].sort((a, b) => a.taux_millieme - b.taux_millieme),
  total: bucket.total,
  assiette_totale: bucket.assiette_totale,
});

/**
 * Decompose, une fois pour toutes, les ecritures de TGC d'un intervalle.
 * Les a-nouveaux sont exclus : ils reprennent un solde anterieur, ils ne
 * constituent pas de taxe.
 */
function analyserEcritures(depuis, jusqu, parametres) {
  const { collectee, deductible, a_decaisser } = parametres.comptes;
  const ecritures = tous(
    `SELECT DISTINCT e.id, e.journal, e.numero, e.date_ecriture, e.libelle, e.piece_ref
     FROM ecritures e
     JOIN lignes l   ON l.ecriture_id = e.id
     JOIN journaux j ON j.code = e.journal
     WHERE e.statut <> 'BROUILLON' AND j.type <> 'ANOUVEAU'
       AND l.compte IN ($c, $d, $a)
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     ORDER BY e.date_ecriture, e.id`,
    { c: collectee, d: deductible, a: a_decaisser, depuis: depuis ?? null, jusqu: jusqu ?? null },
  );
  return ecritures.map((e) => ({
    ecriture: e,
    ...decomposer(
      tous('SELECT compte, debit, credit FROM lignes WHERE ecriture_id = $id', { id: e.id }),
      parametres,
    ),
  }));
}

/** Agrege par taux un lot d'ecritures deja decomposees. */
function agreger(analyses, parametres) {
  const col = vide();
  const ded = vide();
  const non_ventilees = [];
  let liquide_collectee = 0;
  let impute_deductible = 0;
  let a_decaisser_constate = 0;
  let regle = 0;

  for (const { ecriture: e, ...d } of analyses) {
    if (d.liquidation) {
      if (d.d7 === 0 && d.d6 === 0) { regle += d.d5; continue; }
      liquide_collectee += d.d7;
      impute_deductible += -d.d6;
      a_decaisser_constate += -d.d5;
      continue;
    }

    const taxeC = -d.d7;
    if (taxeC !== 0) {
      const t = identifierTauxTgc(d.assiette_produits, taxeC, parametres);
      if (t) ajouter(col, t, d.assiette_produits, taxeC);
      else non_ventilees.push({ ...e, cote: 'collectee', taxe: taxeC, assiette: d.assiette_produits });
    }
    const taxeD = d.d6;
    if (taxeD !== 0) {
      const t = identifierTauxTgc(d.assiette_charges, taxeD, parametres);
      if (t) ajouter(ded, t, d.assiette_charges, taxeD);
      else non_ventilees.push({ ...e, cote: 'deductible', taxe: taxeD, assiette: d.assiette_charges });
    }
  }

  return {
    collectee: fige(col),
    deductible: fige(ded),
    non_ventilees,
    liquidations: {
      collectee_liquidee: liquide_collectee,
      deductible_imputee: impute_deductible,
      a_decaisser_constate,
      regle_au_tresor: regle,
    },
  };
}

const ventiler = (depuis, jusqu, parametres) =>
  agreger(analyserEcritures(depuis, jusqu, parametres), parametres);

const mouvementNet = (compte, depuis, jusqu, sens) => {
  const r = un(
    `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS net
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     JOIN journaux j  ON j.code = e.journal
     WHERE l.compte = $c AND e.statut <> 'BROUILLON' AND j.type <> 'ANOUVEAU'
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)`,
    { c: compte, depuis: depuis ?? null, jusqu: jusqu ?? null },
  ).net;
  return sens === 'CREDIT' && r !== 0 ? -r : r;
};

// -------------------------------------------------------- etat preparatoire

/**
 * Etat preparatoire a la declaration de TGC.
 *
 * Ce n'est pas une declaration : c'est la justification comptable de ce qui
 * sera declare. La ventilation par taux est confrontee au mouvement reel des
 * comptes 445600 / 445700 ; tout ecart et toute ecriture non rattachable a un
 * taux sont nommes.
 */
export function etatTgc({ depuis = null, jusqu = null, parametres } = {}) {
  const p = parametres ?? chargerParametresTgc();
  const v = ventiler(depuis, jusqu, p);
  const { collectee, deductible, a_decaisser } = p.comptes;

  const mouvement_collectee = mouvementNet(collectee, depuis, jusqu, 'CREDIT');
  const mouvement_deductible = mouvementNet(deductible, depuis, jusqu, 'DEBIT');
  const ecart_collectee = mouvement_collectee
    - (v.collectee.total - v.liquidations.collectee_liquidee);
  const ecart_deductible = mouvement_deductible
    - (v.deductible.total - v.liquidations.deductible_imputee);

  const net = v.collectee.total - v.deductible.total;

  return {
    arrete_le: new Date().toISOString().slice(0, 10),
    periode: { depuis, jusqu },
    parametres: {
      statut: p.statut,
      avertissement: p.avertissement ?? '',
      reference: p.reference ?? '',
      periodicite: p.declaration.periodicite,
      jours_apres_periode: p.declaration.jours_apres_periode,
      arrondi: p.arrondi,
      taux: p.taux,
    },
    comptes: p.comptes,
    collectee: v.collectee,
    deductible: v.deductible,
    net: {
      montant: net,
      a_decaisser: Math.max(net, 0),
      credit_reportable: Math.max(-net, 0),
    },
    liquidations: v.liquidations,
    non_ventilees: v.non_ventilees,
    controle: {
      mouvement_collectee,
      ventile_collectee: v.collectee.total,
      liquide_collectee: v.liquidations.collectee_liquidee,
      ecart_collectee,
      mouvement_deductible,
      ventile_deductible: v.deductible.total,
      impute_deductible: v.liquidations.deductible_imputee,
      ecart_deductible,
      justifie: ecart_collectee === 0 && ecart_deductible === 0 && v.non_ventilees.length === 0,
    },
    soldes: {
      collectee: soldeAu(collectee, jusqu, 'CREDIT'),
      deductible: soldeAu(deductible, jusqu, 'DEBIT'),
      a_decaisser: soldeAu(a_decaisser, jusqu, 'CREDIT'),
    },
  };
}

/**
 * Ecriture de declaration proposee : solde la taxe collectee detenue a la date
 * d'arrete, impute la taxe deductible a due concurrence et porte le reste au
 * Tresor. Un credit de TGC ne genere aucune dette : le reliquat deductible
 * reste au bilan, en report.
 *
 * Le resultat est une saisie a comptabiliser par le circuit normal : elle
 * repasse donc par tous les controles.
 */
export function propositionLiquidationTgc({ depuis = null, jusqu = null, parametres } = {}) {
  const p = parametres ?? chargerParametresTgc();
  const arrete = jusqu ?? new Date().toISOString().slice(0, 10);
  const collectee = soldeAu(p.comptes.collectee, arrete, 'CREDIT');
  if (collectee <= 0) return null;

  const deductible = soldeAu(p.comptes.deductible, arrete, 'DEBIT');
  const imputable = Math.max(0, Math.min(deductible, collectee));
  const du = collectee - imputable;

  const lignes = [
    { compte: p.comptes.collectee, libelle: 'TGC collectee de la periode', debit: collectee, credit: 0 },
  ];
  if (imputable > 0) {
    lignes.push({ compte: p.comptes.deductible, libelle: 'TGC deductible imputee', debit: 0, credit: imputable });
  }
  if (du > 0) {
    lignes.push({ compte: p.comptes.a_decaisser, libelle: 'TGC a decaisser', debit: 0, credit: du });
  }

  return {
    journal: 'OD',
    date_ecriture: arrete,
    piece_ref: `TGC-${arrete}`,
    libelle: depuis
      ? `Declaration de TGC du ${depuis} au ${arrete}`
      : `Declaration de TGC au ${arrete}`,
    lignes,
    recapitulatif: { collectee, deductible, imputable, a_decaisser: du, credit_reporte: deductible - imputable },
  };
}

// ------------------------------------------------------- periodes et relance

const DEUX = (n) => String(n).padStart(2, '0');
const finDeMois = (annee, mois) => new Date(Date.UTC(annee, mois, 0)).toISOString().slice(0, 10);

function bornesPeriode(annee, index, periodicite) {
  if (periodicite === 'TRIMESTRIELLE') {
    const premier = index * 3 + 1;
    return {
      code: `${annee}-T${index + 1}`,
      libelle: `${index + 1}ᵉ trimestre ${annee}`,
      debut: `${annee}-${DEUX(premier)}-01`,
      fin: finDeMois(annee, premier + 2),
    };
  }
  return {
    code: `${annee}-${DEUX(index + 1)}`,
    libelle: `${DEUX(index + 1)}/${annee}`,
    debut: `${annee}-${DEUX(index + 1)}-01`,
    fin: finDeMois(annee, index + 1),
  };
}

const ajouterJours = (iso, jours) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + jours * 86_400_000).toISOString().slice(0, 10);

/**
 * Enumere les periodes de declaration depuis le premier mouvement de TGC.
 *
 * `reste_a_liquider` est le solde crediteur de la taxe collectee a la fin de
 * la periode : s'il n'est pas nul une fois le delai de depot ecoule, la
 * declaration n'a pas ete faite.
 */
export function periodesTgc({ jusqu = null, aujourdhui = null, parametres, limite = 36 } = {}) {
  const p = parametres ?? chargerParametresTgc();
  const { collectee, deductible, a_decaisser } = p.comptes;

  const premier = un(
    `SELECT MIN(e.date_ecriture) AS d
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     JOIN journaux j  ON j.code = e.journal
     WHERE e.statut <> 'BROUILLON' AND j.type <> 'ANOUVEAU'
       AND l.compte IN ($c, $d, $a)`,
    { c: collectee, d: deductible, a: a_decaisser },
  ).d;
  if (!premier) return [];

  const ce_jour = aujourdhui ?? new Date().toISOString().slice(0, 10);
  const borne = jusqu ?? ce_jour;
  const parAn = p.declaration.periodicite === 'TRIMESTRIELLE' ? 4 : 12;
  const rang = (iso) => {
    const annee = Number(iso.slice(0, 4));
    const mois = Number(iso.slice(5, 7));
    return annee * parAn + (parAn === 4 ? Math.floor((mois - 1) / 3) : mois - 1);
  };

  // Une seule lecture des ecritures de taxe, repartie ensuite par periode.
  const analyses = analyserEcritures(premier, borne, p);

  const periodes = [];
  for (let r = rang(premier); r <= rang(borne); r++) {
    const annee = Math.floor(r / parAn);
    const b = bornesPeriode(annee, r - annee * parAn, p.declaration.periodicite);
    const v = agreger(
      analyses.filter((a) => a.ecriture.date_ecriture >= b.debut && a.ecriture.date_ecriture <= b.fin),
      p,
    );
    const reste = soldeAu(collectee, b.fin, 'CREDIT');
    const echeance = ajouterJours(b.fin, p.declaration.jours_apres_periode);
    const echue = ce_jour > echeance;
    periodes.push({
      ...b,
      echeance,
      echue,
      collectee: v.collectee.total,
      deductible: v.deductible.total,
      net: v.collectee.total - v.deductible.total,
      liquidee: reste === 0,
      reste_a_liquider: reste,
      en_retard: echue && reste > 0,
      non_ventilees: v.non_ventilees.length,
    });
  }
  return periodes.slice(-limite);
}

/** Anomalies de TGC, versees au tableau de bord et au dossier d'inspection. */
export function anomaliesTgc(parametres) {
  const p = parametres ?? chargerParametresTgc();
  const liste = [];
  const periodes = periodesTgc({ parametres: p });
  if (!periodes.length) return liste;

  const retard = periodes.find((x) => x.en_retard);
  if (retard) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'TGC_NON_LIQUIDEE',
      objet: `Declaration TGC ${retard.code}`,
      message: `Periode ${retard.code} echue le ${retard.echeance} : ${retard.reste_a_liquider} XPF `
        + `de TGC collectee restent a declarer.`,
    });
  }

  const nonVentilees = ventiler(null, null, p).non_ventilees;
  if (nonVentilees.length) {
    const e = nonVentilees[0];
    liste.push({
      gravite: 'MAJEURE',
      code: 'TGC_NON_VENTILEE',
      objet: 'Justification de la TGC',
      message: `${nonVentilees.length} ecriture(s) de TGC ne correspondent a aucun taux en vigueur, `
        + `dont ${e.journal}-${e.numero} du ${e.date_ecriture} (${e.taxe} XPF sur ${e.assiette} XPF).`,
    });
  }

  const due = soldeAu(p.comptes.a_decaisser, null, 'CREDIT');
  if (due > 0) {
    liste.push({
      gravite: 'INFORMATION',
      code: 'TGC_DUE_NON_REGLEE',
      objet: `Compte ${p.comptes.a_decaisser}`,
      message: `${due} XPF de TGC declaree restent a regler au Tresor.`,
    });
  }

  if (p.statut !== 'VALIDE') {
    liste.push({
      gravite: 'INFORMATION',
      code: 'PARAMETRES_TGC_NON_VALIDES',
      objet: 'Parametres de TGC',
      message: 'Les taux et la periodicite utilises n ont pas ete confrontes au texte en vigueur : '
        + 'l etat preparatoire est un document de travail.',
    });
  }

  return liste;
}

/** Periodes echues et non declarees d'un exercice : obstacle a la cloture. */
export function periodesTgcEnRetard({ date_debut, date_fin }, parametres) {
  return periodesTgc({ jusqu: date_fin, parametres })
    .filter((p) => p.debut >= date_debut && p.fin <= date_fin && p.en_retard);
}
