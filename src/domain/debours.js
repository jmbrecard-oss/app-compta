import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { un, tous } from '../db.js';
import { sha256 } from '../hash.js';
import { ErreurConformite, etatRepresentationFonds } from './controles.js';

/**
 * Sommes encaissees pour le compte de tiers : droits d'enregistrement (448600),
 * taxe hypothecaire et salaire du conservateur (448700), autres debours a
 * reverser (448800).
 *
 * Ces sommes ne sont ni des produits de l'office, ni des fonds dont il dispose.
 * Elles transitent par lui : le client les verse, l'office les detient, le
 * Tresor les recoit. Un controle verifie trois choses, et l'etat des sommes
 * dues en apporte la preuve dossier par dossier :
 *
 *   1. toute somme portee a l'un de ces comptes designe le dossier qui l'a
 *      supportee - sans quoi la dette n'est rattachable a aucune affaire et
 *      ne se justifie plus devant un controle ;
 *   2. elle n'est jamais transformee en produit ou en charge de l'office :
 *      un debours non consomme revient au client, il ne s'approprie pas ;
 *   3. elle n'est jamais reversee au-dela de ce qui a ete appele sur le
 *      dossier, et elle reste representee par les disponibilites - au meme
 *      titre que les fonds clients, dont elle n'est que la suite.
 *
 * La liste des comptes et les delais de reversement ne sont pas dans le code :
 * ils relevent d'un texte, et ce texte n'est pas etabli pour la
 * Nouvelle-Caledonie. Ils sont lus dans un fichier de parametres que la
 * Chambre doit valider ; tant qu'il ne l'est pas, l'application le signale en
 * anomalie CRITIQUE.
 */

const FICHIER_DEFAUT = fileURLToPath(new URL('../parametres/debours-nc.json', import.meta.url));

const STATUTS = new Set(['NON_VALIDE', 'VALIDE']);

const EST_NUMERO_COMPTE = /^\d{6}$/;

/** Un parametrage n'est jamais applique a moitie : il est accepte en bloc ou refuse. */
export function validerParametresDebours(p) {
  const refus = (m) => { throw new ErreurConformite('PARAMETRES_DEBOURS_INVALIDES', m, { parametres: p?.code ?? null }); };

  if (!p || typeof p !== 'object') refus('Parametres des debours illisibles.');
  if (!String(p.code ?? '').trim()) refus('Le parametrage doit porter un code identifiant.');
  if (!STATUTS.has(p.statut)) {
    refus(`Statut « ${p.statut} » hors nomenclature : attendu NON_VALIDE ou VALIDE.`);
  }
  if (!Array.isArray(p.comptes) || p.comptes.length === 0) {
    refus('Le parametrage doit enumerer au moins un compte de debours a reverser.');
  }
  const vus = new Set();
  for (const c of p.comptes) {
    if (!EST_NUMERO_COMPTE.test(String(c?.numero ?? ''))) {
      refus(`Numero de compte invalide : « ${c?.numero} ». Six chiffres attendus.`);
    }
    if (vus.has(c.numero)) refus(`Le compte ${c.numero} figure deux fois dans le parametrage.`);
    vus.add(c.numero);
    if (!String(c.beneficiaire ?? '').trim()) {
      refus(`Compte ${c.numero} : le beneficiaire du reversement doit etre designe.`);
    }
    const delai = c.delai_reversement_jours ?? null;
    if (delai !== null && (!Number.isInteger(delai) || delai < 0)) {
      refus(`Compte ${c.numero} : le delai de reversement est un nombre entier de jours, ou null.`);
    }
  }
  return p;
}

let cache = null;

/**
 * Parametres en vigueur. COMPTA_DEBOURS designe un autre fichier ; un fichier
 * modifie est repris sans redemarrage. L'empreinte du fichier est conservee
 * pour qu'un controle reste verifiable apres remplacement des parametres.
 */
export function parametresDebours() {
  const chemin = process.env.COMPTA_DEBOURS || FICHIER_DEFAUT;
  let signature;
  try {
    signature = `${chemin}:${statSync(chemin).mtimeMs}`;
  } catch {
    throw new ErreurConformite('PARAMETRES_DEBOURS_INTROUVABLES', `Fichier de parametres introuvable : ${chemin}.`);
  }
  if (cache?.signature === signature) return cache.parametres;

  const brut = readFileSync(chemin, 'utf8');
  let lu;
  try {
    lu = JSON.parse(brut);
  } catch {
    throw new ErreurConformite('PARAMETRES_DEBOURS_INVALIDES', `Fichier de parametres illisible : ${chemin}.`);
  }
  validerParametresDebours(lu);
  const parametres = Object.freeze({
    ...lu,
    source: lu.source ?? null,
    comptes: Object.freeze(lu.comptes.map((c) => Object.freeze({
      ...c,
      delai_reversement_jours: c.delai_reversement_jours ?? null,
    }))),
    fichier: chemin,
    empreinte: sha256(brut),
  });
  cache = { signature, parametres };
  return parametres;
}

/** Comptes de debours, dans l'ordre du parametrage. */
export const comptesDebours = () => parametresDebours().comptes;

export function estCompteDebours(numero) {
  const n = String(numero ?? '');
  return comptesDebours().some((c) => c.numero === n);
}

const parametrageDuCompte = (numero) => comptesDebours().find((c) => c.numero === numero) ?? null;

const JOUR_MS = 86_400_000;
const joursEntre = (debut, fin) => Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / JOUR_MS);

// --------------------------------------------------------------------------
// Controles bloquants
// --------------------------------------------------------------------------

/**
 * Controles portant sur le contenu de l'ecriture. Renvoie les couples
 * (compte de debours, dossier) mouvementes, ou null si l'ecriture n'en
 * mouvemente aucun.
 */
export function controleDebours(ecriture, lignes) {
  const concernees = lignes.filter((l) => estCompteDebours(l.compte));
  if (!concernees.length) return null;

  // 1. Un debours encaisse pour un tiers n'est ni un produit ni une charge de
  //    l'office. S'il n'est pas consomme, il revient au client par son compte.
  //
  //    Seul le sens compte : l'acte qui appelle des emoluments et des droits en
  //    une seule ecriture CREDITE les uns et les autres par le debit du compte
  //    du client, et reste parfaitement regulier. Ce qui ne l'est pas, c'est de
  //    SOLDER un debours par un compte de gestion - la somme due au tiers
  //    devient alors un produit ou vient effacer une charge de l'office.
  const soldes = concernees.filter((l) => l.debit > 0);
  if (soldes.length) {
    const gestion = lignes
      .filter((l) => l.credit > 0)
      .map((l) => un('SELECT numero, classe FROM comptes WHERE numero = $n', { n: l.compte }))
      .filter((c) => c && (c.classe === 6 || c.classe === 7));
    if (gestion.length) {
      throw new ErreurConformite(
        'DEBOURS_VERS_GESTION',
        `Le compte ${soldes[0].compte} enregistre une somme encaissee pour le compte d un tiers : `
        + `elle ne peut pas etre soldee par le compte de gestion ${gestion[0].numero}. Un debours non `
        + `consomme revient au client par son compte ; une prestation de l office se facture par une `
        + `ecriture distincte.`,
        { debours: soldes.map((l) => l.compte), gestion: gestion.map((c) => c.numero) },
      );
    }
  }

  // 2. Un a-nouveau reporte un solde deja justifie, il n'appelle rien.
  const journal = un('SELECT type FROM journaux WHERE code = $c', { c: ecriture.journal });
  if (journal?.type !== 'ANOUVEAU') {
    const orpheline = concernees.find((l) => !l.dossier_id);
    if (orpheline) {
      throw new ErreurConformite(
        'DEBOURS_SANS_DOSSIER',
        `Compte ${orpheline.compte} : une somme encaissee pour le compte d un tiers designe le dossier `
        + `qui l a supportee. Imputer la ligne sur un dossier, ou rattacher l ecriture a une affaire unique ; `
        + `un reversement global se ventile en une ecriture par dossier.`,
        { compte: orpheline.compte, montant: orpheline.debit + orpheline.credit },
      );
    }
  }

  return {
    couples: concernees.map((l) => ({ compte: l.compte, dossier_id: l.dossier_id ?? null })),
  };
}

/**
 * Un compte de debours ne devient jamais debiteur pour un dossier : on ne
 * reverse pas au Tresor plus que ce que le dossier a supporte. Controle
 * effectue APRES insertion des lignes, dans la transaction, pour porter sur
 * l'etat reel resultant de l'ecriture.
 */
export function controleReversementDebours(couples) {
  const vus = new Set();
  for (const { compte, dossier_id } of couples) {
    const cle = `${compte}/${dossier_id ?? ''}`;
    if (vus.has(cle)) continue;
    vus.add(cle);

    const solde = un(
      `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS solde
       FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
       WHERE l.compte = $c AND l.dossier_id IS $d AND e.statut <> 'BROUILLON'`,
      { c: compte, d: dossier_id },
    ).solde;
    if (solde <= 0) continue;

    const dossier = dossier_id ? un('SELECT reference FROM dossiers WHERE id = $id', { id: dossier_id }) : null;
    throw new ErreurConformite(
      'DEBOURS_DOSSIER_DEBITEUR',
      `Compte ${compte}${dossier ? ` - dossier ${dossier.reference}` : ''} : le reversement excederait de `
      + `${solde} XPF les sommes appelees. L office ne reverse pas au beneficiaire des fonds qu il n a pas recus.`,
      { compte, dossier_id, exces: solde },
    );
  }
}

/**
 * Representation des fonds detenus pour le compte d'autrui.
 *
 * Les fonds clients sont deja controles par `controleRepresentationFonds`.
 * Mais lorsqu'un droit d'enregistrement est appele, la somme quitte le compte
 * du client sans quitter le compte de depot : le seul controle des comptes
 * clients y voit alors un excedent disponible, alors que cet argent est du au
 * Tresor. La representation doit donc couvrir les deux dettes a la fois.
 */
export function etatRepresentationTiers() {
  const fonds = etatRepresentationFonds();
  const duAuxTiers = sommeDueAuxTiers();
  const duTotal = fonds.du_aux_clients + duAuxTiers;
  return {
    representation_totale: fonds.representation_totale,
    fonds_detenus_en_depot: fonds.fonds_detenus_en_depot,
    encaissements_en_cours: fonds.encaissements_en_cours,
    du_aux_clients: fonds.du_aux_clients,
    du_aux_tiers: duAuxTiers,
    du_total: duTotal,
    ecart: fonds.representation_totale - duTotal,
    conforme: fonds.representation_totale - duTotal >= 0,
  };
}

export function controleRepresentationTiers() {
  const etat = etatRepresentationTiers();
  if (!etat.conforme) {
    throw new ErreurConformite(
      'FONDS_TIERS_NON_REPRESENTES',
      `Les fonds detenus pour autrui ne seraient plus representes : ${etat.representation_totale} XPF disponibles `
      + `pour ${etat.du_aux_clients} XPF dus aux clients et ${etat.du_aux_tiers} XPF dus aux tiers `
      + `(deficit de ${-etat.ecart} XPF). Les sommes appelees pour le Tresor restent au depot des fonds clients `
      + `jusqu a leur reversement : elles ne sont pas un excedent disponible.`,
      etat,
    );
  }
  return etat;
}

/** Total des soldes crediteurs des comptes de debours. */
function sommeDueAuxTiers() {
  let total = 0;
  for (const c of comptesDebours()) {
    const solde = un('SELECT solde FROM v_soldes WHERE numero = $n', { n: c.numero })?.solde ?? 0;
    if (solde < 0) total += -solde;
  }
  return total;
}

// --------------------------------------------------------------------------
// Etat de controle des sommes dues
// --------------------------------------------------------------------------

function mouvements({ depuis = null, jusqu = null } = {}) {
  const comptes = comptesDebours().map((c) => c.numero);
  if (!comptes.length) return [];
  const cles = comptes.map((_, i) => `$c${i}`).join(', ');
  const params = { depuis, jusqu };
  comptes.forEach((n, i) => { params[`c${i}`] = n; });

  return tous(
    `SELECT l.compte, l.dossier_id, l.debit, l.credit, l.libelle, l.id AS ligne_id,
            e.date_ecriture, e.journal, e.numero, e.piece_ref, e.statut,
            d.reference, d.intitule
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     LEFT JOIN dossiers d ON d.id = l.dossier_id
     WHERE l.compte IN (${cles}) AND e.statut <> 'BROUILLON'
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     ORDER BY e.date_ecriture, e.id, l.ordre`,
    params,
  );
}

/**
 * Imputation des reversements sur les appels, du plus ancien au plus recent.
 * C'est cette imputation qui donne son anciennete au reliquat : un office qui
 * reverse regulierement ne doit presenter que des sommes recentes.
 */
function imputerFIFO(lignes, aLaDate) {
  const lots = [];
  let appele = 0;
  let reverse = 0;
  let excedent = 0;

  for (const l of lignes) {
    if (l.credit > 0) {
      appele += l.credit;
      lots.push({
        date: l.date_ecriture,
        piece: `${l.journal}-${l.numero}`,
        piece_ref: l.piece_ref,
        libelle: l.libelle,
        montant: l.credit,
        reste: l.credit,
      });
    }
    if (l.debit > 0) {
      reverse += l.debit;
      let aImputer = l.debit;
      for (const lot of lots) {
        if (aImputer === 0) break;
        const pris = Math.min(lot.reste, aImputer);
        lot.reste -= pris;
        aImputer -= pris;
      }
      excedent += aImputer;
    }
  }

  const ouverts = lots
    .filter((lot) => lot.reste > 0)
    .map((lot) => ({ ...lot, anciennete_jours: joursEntre(lot.date, aLaDate) }));

  return {
    appele,
    reverse,
    reste_du: ouverts.reduce((s, lot) => s + lot.reste, 0),
    excedent_reverse: excedent,
    lots: ouverts,
  };
}

/**
 * Etat de controle des sommes dues aux tiers, compte par compte et dossier par
 * dossier, avec l'anciennete de chaque somme restant a reverser.
 *
 * `a_la_date` fixe la date d'appreciation de l'anciennete ; `jusqu` borne les
 * ecritures retenues, pour arreter l'etat a une date passee.
 */
export function etatSommesDues({ a_la_date = null, depuis = null, jusqu = null } = {}) {
  const arrete = a_la_date ?? jusqu ?? new Date().toISOString().slice(0, 10);
  const parametres = parametresDebours();
  const lignes = mouvements({ depuis, jusqu });

  const comptes = [];
  const sansDossier = [];
  const dossiersDebiteurs = [];
  const retards = [];

  for (const c of parametres.comptes) {
    const fiche = un('SELECT intitule FROM comptes WHERE numero = $n', { n: c.numero });
    const duCompte = lignes.filter((l) => l.compte === c.numero);
    const parDossier = new Map();
    for (const l of duCompte) {
      const cle = l.dossier_id ?? 0;
      if (!parDossier.has(cle)) parDossier.set(cle, []);
      parDossier.get(cle).push(l);
    }

    const dossiers = [];
    for (const [cle, mouvementsDuDossier] of parDossier) {
      const imputation = imputerFIFO(mouvementsDuDossier, arrete);
      const delai = c.delai_reversement_jours;
      const plusAncien = imputation.lots[0] ?? null;
      const depasse = delai !== null && plusAncien !== null && plusAncien.anciennete_jours > delai;

      const ligne = {
        dossier_id: cle || null,
        reference: mouvementsDuDossier[0].reference ?? null,
        intitule: mouvementsDuDossier[0].intitule ?? null,
        appele: imputation.appele,
        reverse: imputation.reverse,
        reste_du: imputation.reste_du,
        excedent_reverse: imputation.excedent_reverse,
        plus_ancien_appel: plusAncien?.date ?? null,
        anciennete_jours: plusAncien?.anciennete_jours ?? null,
        delai_depasse: depasse,
        lots: imputation.lots,
      };

      if (ligne.excedent_reverse > 0) {
        dossiersDebiteurs.push({ compte: c.numero, ...ligne });
      }
      if (!ligne.dossier_id && (ligne.appele > 0 || ligne.reverse > 0)) {
        sansDossier.push({ compte: c.numero, intitule: fiche?.intitule ?? '', ...ligne });
        continue;
      }
      if (ligne.reste_du > 0 || ligne.excedent_reverse > 0) {
        if (depasse) retards.push({ compte: c.numero, delai_reversement_jours: delai, ...ligne });
        dossiers.push(ligne);
      }
    }

    dossiers.sort((a, b) => (a.plus_ancien_appel ?? '').localeCompare(b.plus_ancien_appel ?? ''));
    comptes.push({
      numero: c.numero,
      intitule: fiche?.intitule ?? null,
      inscrit_au_plan: Boolean(fiche),
      beneficiaire: c.beneficiaire,
      delai_reversement_jours: c.delai_reversement_jours,
      dossiers,
      total_appele: duCompte.reduce((s, l) => s + l.credit, 0),
      total_reverse: duCompte.reduce((s, l) => s + l.debit, 0),
      total_du: dossiers.reduce((t, d) => t + d.reste_du, 0)
        + sansDossier.filter((d) => d.compte === c.numero).reduce((t, d) => t + d.reste_du, 0),
    });
  }

  return {
    arrete_le: arrete,
    periode: { depuis, jusqu },
    parametrage: {
      code: parametres.code,
      statut: parametres.statut,
      source: parametres.source,
      fichier: parametres.fichier,
      empreinte: parametres.empreinte,
      avertissement: parametres.avertissement,
    },
    comptes,
    total_appele: comptes.reduce((s, c) => s + c.total_appele, 0),
    total_reverse: comptes.reduce((s, c) => s + c.total_reverse, 0),
    total_du: comptes.reduce((s, c) => s + c.total_du, 0),
    retards,
    sans_dossier: sansDossier,
    dossiers_debiteurs: dossiersDebiteurs,
    couverture: etatRepresentationTiers(),
  };
}

// --------------------------------------------------------------------------
// Anomalies et obstacles a la cloture
// --------------------------------------------------------------------------

export function anomaliesDebours({ a_la_date = null } = {}) {
  const liste = [];
  const etat = etatSommesDues({ a_la_date });

  if (etat.parametrage.statut !== 'VALIDE') {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'PARAMETRES_DEBOURS_NON_VALIDES',
      objet: `Parametrage ${etat.parametrage.code}`,
      message: 'Liste des comptes de debours et delais de reversement non valides par la Chambre : '
        + 'les signalements d anciennete sont indicatifs et sans valeur reglementaire.',
    });
  }

  for (const c of etat.comptes.filter((c) => !c.inscrit_au_plan)) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'COMPTE_DEBOURS_ABSENT',
      objet: `Compte ${c.numero}`,
      message: 'Compte de debours parametre mais absent du plan comptable : aucune somme due n y est suivie.',
    });
  }

  if (!etat.couverture.conforme) {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'FONDS_TIERS_NON_REPRESENTES',
      objet: 'Representation des fonds detenus pour autrui',
      message: `Deficit de ${-etat.couverture.ecart} XPF : ${etat.couverture.du_aux_clients} XPF dus aux clients `
        + `et ${etat.couverture.du_aux_tiers} XPF dus aux tiers pour ${etat.couverture.representation_totale} XPF disponibles.`,
    });
  }

  for (const d of etat.dossiers_debiteurs) {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'DEBOURS_DOSSIER_DEBITEUR',
      objet: `Compte ${d.compte}${d.reference ? ` - dossier ${d.reference}` : ''}`,
      message: `Reversements superieurs de ${d.excedent_reverse} XPF aux sommes appelees.`,
    });
  }

  for (const s of etat.sans_dossier) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'DEBOURS_NON_JUSTIFIE',
      objet: `Compte ${s.compte}`,
      message: `${s.reste_du} XPF dus sans dossier d imputation : la somme n est rattachable a aucune affaire.`,
    });
  }

  for (const r of etat.retards) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'DEBOURS_NON_REVERSE',
      objet: `Compte ${r.compte}${r.reference ? ` - dossier ${r.reference}` : ''}`,
      message: `${r.reste_du} XPF dus depuis le ${r.plus_ancien_appel} (${r.anciennete_jours} jours, `
        + `delai parametre ${r.delai_reversement_jours} jours) et non reverses.`,
    });
  }

  return liste;
}

/** Obstacles a la cloture, apprecies a la date de fin de l'exercice. */
export function obstaclesDebours(exercice) {
  const etat = etatSommesDues({ a_la_date: exercice.date_fin, jusqu: exercice.date_fin });
  const obstacles = [];

  for (const d of etat.dossiers_debiteurs) {
    obstacles.push({
      code: 'DEBOURS_DOSSIER_DEBITEUR',
      message: `Compte ${d.compte}${d.reference ? ` - dossier ${d.reference}` : ''} : `
        + `${d.excedent_reverse} XPF reverses au-dela des sommes appelees.`,
    });
  }
  for (const s of etat.sans_dossier) {
    obstacles.push({
      code: 'DEBOURS_NON_JUSTIFIE',
      message: `Compte ${s.compte} : ${s.reste_du} XPF dus sans dossier d imputation.`,
    });
  }
  for (const r of etat.retards) {
    obstacles.push({
      code: 'DEBOURS_NON_REVERSE',
      message: `Compte ${r.compte}${r.reference ? ` - dossier ${r.reference}` : ''} : ${r.reste_du} XPF `
        + `appeles le ${r.plus_ancien_appel} et non reverses au ${exercice.date_fin}.`,
    });
  }
  if (!etat.couverture.conforme) {
    obstacles.push({
      code: 'FONDS_TIERS_NON_REPRESENTES',
      message: `Fonds detenus pour autrui non representes : deficit de ${-etat.couverture.ecart} XPF.`,
    });
  }
  return obstacles;
}

/**
 * Reprise a nouveau des sommes dues, dossier par dossier.
 *
 * Un a-nouveau global sur 448600 perdrait au 1er janvier la justification de
 * la dette : l'etat des sommes dues ne saurait plus a quelle affaire rattacher
 * le solde repris. La reprise conserve donc le detail.
 */
export function repriseDeboursParDossier(exerciceId) {
  const comptes = comptesDebours().map((c) => c.numero);
  if (!comptes.length) return [];
  const cles = comptes.map((_, i) => `$c${i}`).join(', ');
  const params = { ex: exerciceId };
  comptes.forEach((n, i) => { params[`c${i}`] = n; });

  return tous(
    `SELECT l.compte, l.dossier_id, d.reference, SUM(l.debit - l.credit) AS solde
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     LEFT JOIN dossiers d ON d.id = l.dossier_id
     WHERE l.compte IN (${cles}) AND e.statut <> 'BROUILLON' AND e.exercice_id = $ex
     GROUP BY l.compte, l.dossier_id
     HAVING solde <> 0
     ORDER BY l.compte, d.reference`,
    params,
  );
}
