import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { un, tous } from '../db.js';
import { sha256 } from '../hash.js';
import { ErreurConformite } from './controles.js';

/**
 * Mouvements d'especes.
 *
 * Les especes ne laissent aucune trace bancaire : elles ne sont verifiables
 * que par le registre de caisse et la piece justificative. D'ou quatre
 * exigences, toutes bloquantes a la comptabilisation :
 *
 *   1. la caisse de l'office ne detient jamais de fonds clients, qui ont leur
 *      propre caisse (531500) et entrent dans la representation des fonds ;
 *   2. tout mouvement d'especes porte la reference de sa piece justificative ;
 *   3. un reglement en especes reste sous le plafond, et les reglements
 *      cumules d'un meme dossier aussi - sans quoi le plafond se contournerait
 *      en fractionnant ;
 *   4. une caisse n'est jamais creditrice, a aucune date : on ne decaisse pas
 *      des especes que l'on ne detient pas. Le solde final ne prouve rien,
 *      c'est le solde progressif qui est verifie.
 *
 * Les plafonds ne sont pas dans le code : ils sont lus dans un fichier de
 * parametres, parce qu'ils relevent d'un texte - et que ce texte n'est pas
 * etabli pour la Nouvelle-Caledonie. Tant que le fichier n'est pas valide par
 * la Chambre, l'application le signale en anomalie CRITIQUE.
 */

const FICHIER_DEFAUT = fileURLToPath(new URL('../parametres/especes-nc.json', import.meta.url));

/** Les comptes d'especes sont ceux de la subdivision 53 du plan comptable. */
export const EST_COMPTE_ESPECES = (numero) => String(numero ?? '').startsWith('53');

/**
 * Un mouvement entre comptes de tresorerie de l'office n'est pas un reglement :
 * un versement d'especes en banque ou un retrait au guichet ne paie personne.
 * Les plafonds ne s'y appliquent donc pas.
 */
const NATURES_TRESORERIE = new Set(['BANQUE_OFFICE', 'DEPOT_FONDS_CLIENTS', 'CAISSE']);
const COMPTES_TRANSIT = new Set(['580000', '514000']);

const STATUTS = new Set(['NON_VALIDE', 'VALIDE']);

const entierPositifOuNul = (v) => v === null || (Number.isInteger(v) && v >= 0);

/** Un parametrage n'est jamais applique a moitie : il est accepte en bloc ou refuse. */
export function validerParametresEspeces(p) {
  const refus = (m) => { throw new ErreurConformite('PARAMETRES_ESPECES_INVALIDES', m, { parametres: p?.code ?? null }); };

  if (!p || typeof p !== 'object') refus('Parametres des especes illisibles.');
  if (!String(p.code ?? '').trim()) refus('Le parametrage doit porter un code identifiant.');
  if (!STATUTS.has(p.statut)) {
    refus(`Statut « ${p.statut} » hors nomenclature : attendu NON_VALIDE ou VALIDE.`);
  }
  for (const cle of ['plafond_reglement_xpf', 'plafond_cumul_dossier_xpf', 'encaisse_maximale_xpf']) {
    if (!entierPositifOuNul(p[cle] ?? null)) {
      refus(`${cle} : un montant en XPF est un entier positif, ou null pour desactiver le controle.`);
    }
  }
  if (typeof p.piece_justificative_obligatoire !== 'boolean') {
    refus('piece_justificative_obligatoire doit etre un booleen.');
  }
  if (p.plafond_reglement_xpf !== null && p.plafond_cumul_dossier_xpf !== null
      && p.plafond_cumul_dossier_xpf < p.plafond_reglement_xpf) {
    refus(
      `Plafond cumule par dossier (${p.plafond_cumul_dossier_xpf} XPF) inferieur au plafond unitaire `
      + `(${p.plafond_reglement_xpf} XPF) : le plafond unitaire serait inapplicable.`,
    );
  }
  return p;
}

let cache = null;

/**
 * Parametres en vigueur. COMPTA_ESPECES designe un autre fichier ; un fichier
 * modifie est repris sans redemarrage. L'empreinte du fichier est conservee
 * pour qu'un controle reste verifiable apres remplacement des parametres.
 */
export function parametresEspeces() {
  const chemin = process.env.COMPTA_ESPECES || FICHIER_DEFAUT;
  let signature;
  try {
    signature = `${chemin}:${statSync(chemin).mtimeMs}`;
  } catch {
    throw new ErreurConformite('PARAMETRES_ESPECES_INTROUVABLES', `Fichier de parametres introuvable : ${chemin}.`);
  }
  if (cache?.signature === signature) return cache.parametres;

  const brut = readFileSync(chemin, 'utf8');
  let lu;
  try {
    lu = JSON.parse(brut);
  } catch {
    throw new ErreurConformite('PARAMETRES_ESPECES_INVALIDES', `Fichier de parametres illisible : ${chemin}.`);
  }
  validerParametresEspeces(lu);
  const parametres = Object.freeze({
    ...lu,
    plafond_reglement_xpf: lu.plafond_reglement_xpf ?? null,
    plafond_cumul_dossier_xpf: lu.plafond_cumul_dossier_xpf ?? null,
    encaisse_maximale_xpf: lu.encaisse_maximale_xpf ?? null,
    fichier: chemin,
    empreinte: sha256(brut),
  });
  cache = { signature, parametres };
  return parametres;
}

// --------------------------------------------------------------------------
// Controles bloquants
// --------------------------------------------------------------------------

function qualifier(lignes) {
  return lignes.map((l) => {
    const c = un('SELECT numero, intitule, nature FROM comptes WHERE numero = $n', { n: l.compte });
    return {
      ...l,
      nature: c?.nature ?? 'STANDARD',
      intitule: c?.intitule ?? '',
      especes: EST_COMPTE_ESPECES(l.compte),
    };
  });
}

/**
 * Controles portant sur le contenu de l'ecriture. Renvoie la qualification du
 * mouvement d'especes, ou null si l'ecriture n'en comporte pas.
 */
export function controleEspeces(ecriture, lignes) {
  const details = qualifier(lignes);
  const especes = details.filter((d) => d.especes);
  if (!especes.length) return null;

  // Un a-nouveau reporte un solde, il ne deplace pas d'especes.
  const j = un('SELECT type FROM journaux WHERE code = $c', { c: ecriture.journal });
  if (j?.type === 'ANOUVEAU') return null;

  const parametres = parametresEspeces();

  // 1. Etancheite des caisses : les especes des clients ne passent pas par
  //    la caisse de l'office, sans quoi elles s'y melent a ses fonds propres.
  const caisseOffice = especes.filter((d) => d.nature === 'CAISSE');
  const coteClients = details.filter((d) => d.nature === 'CLIENT' || d.nature === 'DEPOT_FONDS_CLIENTS');
  if (caisseOffice.length && coteClients.length) {
    throw new ErreurConformite(
      'ESPECE_CAISSE_OFFICE_FONDS_CLIENTS',
      `La caisse ${caisseOffice[0].compte} est celle de l office : les especes recues ou remises pour le compte `
      + `d un client passent par la caisse des fonds clients (531500), qui entre dans la representation des fonds.`,
      { caisse: caisseOffice[0].compte, comptes_clients: coteClients.map((d) => d.compte) },
    );
  }

  // 2. Piece justificative : seule trace d'un mouvement sans trace bancaire.
  if (parametres.piece_justificative_obligatoire && !String(ecriture.piece_ref ?? '').trim()) {
    throw new ErreurConformite(
      'ESPECE_SANS_JUSTIFICATION',
      'Un mouvement d especes ne laisse aucune trace bancaire : la reference de la piece justificative '
      + '(recu, bordereau de versement, facture acquittee) est obligatoire.',
      { comptes: especes.map((d) => d.compte) },
    );
  }

  const interne = details.every((d) => NATURES_TRESORERIE.has(d.nature) || COMPTES_TRANSIT.has(d.compte));
  const encaissements = especes.reduce((s, d) => s + d.debit, 0);
  const decaissements = especes.reduce((s, d) => s + d.credit, 0);
  const dossiers = [...new Set(
    [...details.map((d) => d.dossier_id), ecriture.dossier_id ?? null].filter(Boolean),
  )];

  if (!interne) {
    // 3. Plafond du reglement. Le montant retenu est le total des especes
    //    deplacees dans un sens : fractionner un reglement sur plusieurs
    //    lignes ne le fait pas passer sous le plafond.
    const montant = Math.max(encaissements, decaissements);
    const plafond = parametres.plafond_reglement_xpf;
    if (plafond !== null && montant > plafond) {
      throw new ErreurConformite(
        'PLAFOND_ESPECES_DEPASSE',
        `Reglement en especes de ${montant} XPF pour un plafond de ${plafond} XPF `
        + `(parametrage ${parametres.code}).`,
        { montant, plafond, parametrage: parametres.code, statut_parametrage: parametres.statut },
      );
    }

    // 4. Un mouvement d'especes se rattache a une affaire et une seule : le
    //    registre de caisse doit pouvoir imputer chaque remise.
    if (dossiers.length > 1) {
      throw new ErreurConformite(
        'ESPECE_MULTI_DOSSIER',
        'Un reglement en especes ne peut concerner qu un seul dossier : saisir une ecriture par affaire, '
        + 'faute de quoi la remise n est imputable a aucune.',
        { dossiers },
      );
    }
  }

  return { interne, encaissements, decaissements, dossiers };
}

/**
 * Plafond cumule par dossier : barre le fractionnement d'un versement en
 * plusieurs remises inferieures au plafond unitaire. Evalue apres insertion,
 * dans la transaction, sur l'etat reel resultant de l'ecriture.
 */
export function controleCumulEspecesDossier(dossiers) {
  const plafond = parametresEspeces().plafond_cumul_dossier_xpf;
  if (plafond === null) return;
  for (const id of dossiers ?? []) {
    const cumul = cumulEspecesDossier(id);
    if (cumul > plafond) {
      const d = un('SELECT reference FROM dossiers WHERE id = $id', { id });
      throw new ErreurConformite(
        'PLAFOND_ESPECES_CUMUL_DEPASSE',
        `Dossier ${d?.reference ?? id} : ${cumul} XPF recus en especes depuis l ouverture, `
        + `pour un plafond cumule de ${plafond} XPF. Le solde doit etre recu par virement.`,
        { dossier_id: id, cumul, plafond },
      );
    }
  }
}

export function cumulEspecesDossier(dossierId) {
  return un(
    `SELECT IFNULL(SUM(l.debit), 0) AS cumul
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     WHERE substr(l.compte, 1, 2) = '53' AND e.statut = 'VALIDEE'
       AND e.contrepassation_de IS NULL
       AND (e.dossier_id = $d
         OR EXISTS (SELECT 1 FROM lignes x WHERE x.ecriture_id = e.id AND x.dossier_id = $d))`,
    { d: dossierId },
  ).cumul;
}

/**
 * Une caisse n'est jamais creditrice, a aucune date : on ne decaisse pas des
 * especes que l'on ne detient pas. Le controle porte sur le solde progressif,
 * pas sur le solde final - une sortie anterieure a la rentree correspondante
 * laisse un solde final positif et une caisse pourtant a decouvert.
 */
export function controleCaisseNonCreditrice() {
  for (const c of comptesEspeces()) {
    const a = soldeProgressif(mouvementsEspeces(c.numero));
    if (!a.jamais_creditrice) {
      throw new ErreurConformite(
        'CAISSE_CREDITRICE',
        `La caisse ${c.numero} serait creditrice de ${-a.solde_minimum} XPF au ${a.date_minimum} : `
        + `une caisse ne peut pas decaisser des especes qu elle ne detient pas.`,
        { compte: c.numero, solde_minimum: a.solde_minimum, date: a.date_minimum },
      );
    }
  }
}

// --------------------------------------------------------------------------
// Registre des especes
// --------------------------------------------------------------------------

export function comptesEspeces() {
  return tous(
    `SELECT numero, intitule, nature FROM comptes
     WHERE substr(numero, 1, 2) = '53' AND collectif = 0 ORDER BY numero`,
  );
}

export function mouvementsEspeces(compte, { depuis = null, jusqu = null } = {}) {
  return tous(
    `SELECT e.id AS ecriture_id, e.date_ecriture, e.journal, e.numero, e.piece_ref, e.statut,
            l.libelle, l.debit, l.credit, d.reference AS dossier
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     LEFT JOIN dossiers d ON d.id = IFNULL(l.dossier_id, IFNULL(e.dossier_id,
       -- Le dossier est porte par la ligne de compte client, pas par celle de
       -- la caisse : un reglement en especes ne concerne qu une affaire.
       (SELECT x.dossier_id FROM lignes x
         WHERE x.ecriture_id = e.id AND x.dossier_id IS NOT NULL LIMIT 1)))
     WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     ORDER BY e.date_ecriture, e.id, l.ordre`,
    { c: compte, depuis, jusqu },
  );
}

/**
 * Solde progressif et minimum atteint. Le minimum est celui constate apres
 * chaque mouvement ; sans mouvement, c'est le solde d'ouverture.
 */
export function soldeProgressif(mouvements, soldeOuverture = 0) {
  let cumul = soldeOuverture;
  let minimum = null;
  let dateMinimum = null;
  const suivis = mouvements.map((m) => {
    cumul += m.debit - m.credit;
    if (minimum === null || cumul < minimum) {
      minimum = cumul;
      dateMinimum = m.date_ecriture;
    }
    return { ...m, solde_progressif: cumul };
  });
  const soldeMinimum = minimum === null ? soldeOuverture : minimum;
  return {
    mouvements: suivis,
    solde_ouverture: soldeOuverture,
    solde_final: cumul,
    solde_minimum: soldeMinimum,
    date_minimum: dateMinimum,
    jamais_creditrice: soldeMinimum >= 0,
  };
}

function soldeAvant(compte, depuis) {
  if (!depuis) return 0;
  return un(
    `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS solde
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON' AND e.date_ecriture < $depuis`,
    { c: compte, depuis },
  ).solde;
}

/**
 * Registre des especes : piece a presenter au controle. Caisse par caisse,
 * chaque mouvement avec sa piece justificative, son dossier et le solde
 * progressif, puis la ventilation des especes recues par dossier.
 */
export function registreDesEspeces(p = {}) {
  const depuis = p.depuis ?? null;
  const jusqu = p.jusqu ?? null;
  const parametres = parametresEspeces();
  const plafond = parametres.plafond_reglement_xpf;

  const caisses = comptesEspeces().map((c) => {
    const suivi = soldeProgressif(mouvementsEspeces(c.numero, { depuis, jusqu }), soldeAvant(c.numero, depuis));
    const mouvements = suivi.mouvements.map((m) => ({
      ...m,
      compte: c.numero,
      sans_piece: !String(m.piece_ref ?? '').trim(),
      au_dela_du_plafond: plafond !== null && Math.max(m.debit, m.credit) > plafond,
      solde_negatif: m.solde_progressif < 0,
    }));
    return {
      compte: c.numero,
      intitule: c.intitule,
      fonds_clients: c.nature === 'DEPOT_FONDS_CLIENTS',
      ...suivi,
      mouvements,
      encaissements: mouvements.reduce((s, m) => s + m.debit, 0),
      decaissements: mouvements.reduce((s, m) => s + m.credit, 0),
    };
  });

  const cumul_par_dossier = tous(
    `SELECT d.id, d.reference, d.intitule,
            IFNULL(SUM(l.debit), 0)  AS encaissements,
            IFNULL(SUM(l.credit), 0) AS decaissements
     FROM dossiers d
     -- Une remise annulee et son extourne sortent toutes deux du cumul : la
     -- premiere n'est plus comptabilisee, la seconde n'a rendu aucune espece.
     JOIN ecritures e ON e.statut = 'VALIDEE' AND e.contrepassation_de IS NULL
       AND (e.dossier_id = d.id
         OR EXISTS (SELECT 1 FROM lignes x WHERE x.ecriture_id = e.id AND x.dossier_id = d.id))
     JOIN lignes l ON l.ecriture_id = e.id AND substr(l.compte, 1, 2) = '53'
     WHERE ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     GROUP BY d.id
     HAVING encaissements + decaissements > 0
     ORDER BY encaissements DESC`,
    { depuis, jusqu },
  ).map((d) => ({
    ...d,
    au_dela_du_plafond_cumule: parametres.plafond_cumul_dossier_xpf !== null
      && d.encaissements > parametres.plafond_cumul_dossier_xpf,
  }));

  const tous_mouvements = caisses.flatMap((c) => c.mouvements);
  return {
    arrete_le: new Date().toISOString().slice(0, 10),
    periode: { depuis, jusqu },
    parametres: {
      code: parametres.code,
      statut: parametres.statut,
      source: parametres.source ?? null,
      empreinte: parametres.empreinte,
      plafond_reglement_xpf: parametres.plafond_reglement_xpf,
      plafond_cumul_dossier_xpf: parametres.plafond_cumul_dossier_xpf,
      encaisse_maximale_xpf: parametres.encaisse_maximale_xpf,
      avertissement: parametres.statut === 'VALIDE' ? null : parametres.avertissement,
    },
    caisses,
    cumul_par_dossier,
    totaux: {
      encaissements: caisses.reduce((s, c) => s + c.encaissements, 0),
      decaissements: caisses.reduce((s, c) => s + c.decaissements, 0),
      solde_final: caisses.reduce((s, c) => s + c.solde_final, 0),
      mouvements: tous_mouvements.length,
      sans_piece: tous_mouvements.filter((m) => m.sans_piece).length,
      au_dela_du_plafond: tous_mouvements.filter((m) => m.au_dela_du_plafond).length,
    },
  };
}

// --------------------------------------------------------------------------
// Controles signales
// --------------------------------------------------------------------------

export function anomaliesEspeces() {
  const liste = [];
  let parametres;
  try {
    parametres = parametresEspeces();
  } catch (e) {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'PARAMETRES_ESPECES_INVALIDES',
      objet: 'Parametrage des especes',
      message: `${e.message} Aucun controle de plafond n est applique.`,
    });
    return liste;
  }

  if (parametres.statut !== 'VALIDE') {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'PARAMETRES_ESPECES_NON_VALIDES',
      objet: `Parametrage des especes ${parametres.code}`,
      message: 'Les plafonds appliques ne sont adosses a aucun texte : ils sont fictifs et doivent etre '
        + 'valides par la Chambre des notaires avant toute mise en service.',
    });
  }

  for (const c of comptesEspeces()) {
    const suivi = soldeProgressif(mouvementsEspeces(c.numero));
    if (!suivi.jamais_creditrice) {
      liste.push({
        gravite: 'CRITIQUE',
        code: 'CAISSE_CREDITRICE',
        objet: `Caisse ${c.numero}`,
        message: `Caisse creditrice de ${-suivi.solde_minimum} XPF au ${suivi.date_minimum} : `
          + 'des especes ont ete decaissees sans etre detenues.',
      });
    }
    if (parametres.encaisse_maximale_xpf !== null && suivi.solde_final > parametres.encaisse_maximale_xpf) {
      liste.push({
        gravite: 'MAJEURE',
        code: 'ENCAISSE_EXCESSIVE',
        objet: `Caisse ${c.numero}`,
        message: `Encaisse de ${suivi.solde_final} XPF pour un maximum de ${parametres.encaisse_maximale_xpf} XPF : `
          + 'les especes doivent etre versees en banque.',
      });
    }
    const sansPiece = suivi.mouvements.filter((m) => !String(m.piece_ref ?? '').trim()).length;
    if (sansPiece) {
      liste.push({
        gravite: 'MAJEURE',
        code: 'ESPECE_SANS_JUSTIFICATION',
        objet: `Caisse ${c.numero}`,
        message: `${sansPiece} mouvement(s) d especes sans reference de piece justificative.`,
      });
    }
  }

  return liste;
}

/** Obstacles a la cloture tires du registre des especes. */
export function obstaclesEspeces(exercice) {
  const obstacles = [];
  for (const c of comptesEspeces()) {
    const suivi = soldeProgressif(
      mouvementsEspeces(c.numero, { jusqu: exercice.date_fin }),
    );
    if (!suivi.jamais_creditrice) {
      obstacles.push({
        code: 'CAISSE_CREDITRICE',
        message: `Caisse ${c.numero} creditrice de ${-suivi.solde_minimum} XPF au ${suivi.date_minimum}.`,
      });
    }
  }
  return obstacles;
}
