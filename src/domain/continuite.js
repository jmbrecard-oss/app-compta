import { un, tous } from '../db.js';
import { ErreurConformite } from './controles.js';

/**
 * Continuite et concordance des livres comptables.
 *
 * Le chainage cryptographique prouve qu'une ecriture n'a pas ete *alteree*.
 * Il ne prouve pas qu'elle est toujours *la* : une ecriture ramenee a l'etat
 * de brouillon quitte la balance, le grand livre, le journal et le FEC en
 * laissant son numero inoccupe, sans rompre la chaine d'empreintes — qui ne
 * porte pas sur le statut. La disparition est de surcroit equilibree, donc
 * muette : la balance reste equilibree, a un total plus faible.
 *
 * Deux remparts repondent a ce risque :
 *   - des declencheurs de base interdisent la decomptabilisation, le
 *     decrochage de la chaine et l'ajout d'une ligne a une ecriture
 *     comptabilisee (voir `schema.sql`) ;
 *   - l'etat ci-dessous *prouve*, chiffres a l'appui, que les livres sont
 *     complets : c'est la piece que l'inspection attend, et le controle que
 *     les declencheurs ne peuvent pas rendre : une base deja corrompue, ou
 *     manipulee avant la pose des verrous, reste a detecter.
 *
 * Trois totaux doivent coincider :
 *   livre-journal  (toutes les lignes des ecritures comptabilisees)
 *   grand livre    (les memes, rattachees a un compte du plan comptable)
 *   balance        (les memes, hors comptes collectifs)
 * Tout ecart designe des mouvements invisibles dans l'un des etats.
 */

const COMPTABILISEE = `e.statut <> 'BROUILLON'`;

const ecart = (code, objet, message, details = {}) =>
  ({ gravite: 'CRITIQUE', code, objet, message, details });

/**
 * Sequence des numeros d'ecriture, journal par journal et exercice par
 * exercice. Le numero est attribue a la comptabilisation : la serie doit
 * courir de 1 au dernier numero attribue, sans trou.
 */
export function sequencesJournaux() {
  const series = tous(
    `SELECT e.exercice_id, x.libelle AS exercice, e.journal,
            COUNT(*) AS comptabilisees, MIN(e.numero) AS premier, MAX(e.numero) AS dernier
     FROM ecritures e JOIN exercices x ON x.id = e.exercice_id
     WHERE ${COMPTABILISEE}
     GROUP BY e.exercice_id, e.journal
     ORDER BY x.date_debut, e.journal`,
  );

  for (const s of series) {
    const attribues = new Set(tous(
      `SELECT numero FROM ecritures
       WHERE exercice_id = $ex AND journal = $j AND statut <> 'BROUILLON'`,
      { ex: s.exercice_id, j: s.journal },
    ).map((r) => r.numero));
    // Un premier numero superieur a 1 se traduit de lui-meme en numeros
    // manquants : la serie est verifiee depuis 1, pas depuis son minimum.
    s.manquants = [];
    for (let n = 1; n <= s.dernier; n++) if (!attribues.has(n)) s.manquants.push(n);
    s.continue = s.manquants.length === 0;
  }
  return series;
}

/**
 * Trous de numerotation d'un journal, sans parcourir toute la base.
 * Appele a chaque comptabilisation : le numero attribue doit etre le
 * (n+1)-ieme d'une serie qui en compte deja n.
 */
export function controleSequenceJournal(journal, exerciceId, numeroAttribue) {
  const r = un(
    `SELECT COUNT(*) AS comptabilisees, IFNULL(MAX(numero), 0) AS dernier
     FROM ecritures WHERE exercice_id = $ex AND journal = $j AND statut <> 'BROUILLON'`,
    { ex: exerciceId, j: journal },
  );
  if (r.dernier !== r.comptabilisees) {
    throw new ErreurConformite(
      'SEQUENCE_INTERROMPUE',
      `Le journal ${journal} compte ${r.comptabilisees} ecriture(s) comptabilisee(s) pour un dernier `
      + `numero ${r.dernier} : la serie presente un trou. Comptabiliser l ecriture ${numeroAttribue} `
      + `figerait cette discontinuite. Faire verifier l integrite de la base avant toute nouvelle saisie.`,
      { journal, comptabilisees: r.comptabilisees, dernier: r.dernier },
    );
  }
}

/** Concordance livre-journal / grand livre / balance. */
export function concordanceLivres() {
  const journal = un(
    `SELECT IFNULL(SUM(l.debit), 0) AS debit, IFNULL(SUM(l.credit), 0) AS credit, COUNT(*) AS lignes
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id WHERE ${COMPTABILISEE}`,
  );
  const grandLivre = un(
    `SELECT IFNULL(SUM(l.debit), 0) AS debit, IFNULL(SUM(l.credit), 0) AS credit, COUNT(*) AS lignes
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     JOIN comptes c ON c.numero = l.compte WHERE ${COMPTABILISEE}`,
  );
  const balance = un(
    `SELECT IFNULL(SUM(l.debit), 0) AS debit, IFNULL(SUM(l.credit), 0) AS credit, COUNT(*) AS lignes
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     JOIN comptes c ON c.numero = l.compte WHERE ${COMPTABILISEE} AND c.collectif = 0`,
  );
  return {
    livre_journal: journal,
    grand_livre: grandLivre,
    balance,
    concordant: journal.debit === grandLivre.debit && grandLivre.debit === balance.debit
      && journal.credit === grandLivre.credit && grandLivre.credit === balance.credit,
    equilibre: journal.debit === journal.credit,
  };
}

/**
 * Etat de continuite des livres : la piece de preuve.
 * `conforme` a faux signifie qu'au moins une ecriture comptabilisee ne se
 * retrouve pas integralement dans les etats produits.
 */
export function etatContinuiteLivres() {
  const ecarts = [];
  const sequences = sequencesJournaux();

  for (const s of sequences) {
    if (s.manquants.length) {
      ecarts.push(ecart(
        'NUMERO_MANQUANT',
        `Journal ${s.journal} — ${s.exercice}`,
        `Numero(s) ${s.manquants.join(', ')} absent(s) de la serie : `
        + `${s.comptabilisees} ecriture(s) comptabilisee(s) pour un dernier numero ${s.dernier}.`,
        { journal: s.journal, exercice: s.exercice, manquants: s.manquants },
      ));
    }
  }

  // Signature d'une decomptabilisation : un brouillon qui porte un numero
  // definitif. La saisie n'en attribue jamais (numero provisoire negatif).
  for (const e of tous(
    `SELECT id, journal, numero, date_ecriture, libelle FROM ecritures
     WHERE statut = 'BROUILLON' AND numero > 0 ORDER BY journal, numero`,
  )) {
    ecarts.push(ecart(
      'BROUILLON_NUMEROTE',
      `Ecriture ${e.journal}-${e.numero}`,
      `L ecriture ${e.journal}-${e.numero} du ${e.date_ecriture} porte un numero definitif `
      + `mais figure en brouillon : le numero n est attribue qu a la comptabilisation, l ecriture `
      + `a donc ete retiree des livres apres coup. Elle n apparait plus ni en balance, ni au grand `
      + `livre, ni au FEC, et son numero reste inoccupe.`,
      { ecriture_id: e.id, journal: e.journal, numero: e.numero, libelle: e.libelle },
    ));
  }

  // Une ecriture comptabilisee est toujours scellee dans la chaine.
  for (const e of tous(
    `SELECT id, journal, numero FROM ecritures
     WHERE statut <> 'BROUILLON' AND (rang_chaine IS NULL OR hash IS NULL) ORDER BY id`,
  )) {
    ecarts.push(ecart(
      'ECRITURE_HORS_CHAINE',
      `Ecriture ${e.journal}-${e.numero}`,
      `Ecriture comptabilisee absente de la chaine d empreintes : son contenu n est plus scelle, `
      + `et la verification de la chaine ne la couvre pas.`,
      { ecriture_id: e.id },
    ));
  }

  // Partie double : verifiee a la comptabilisation, reverifiee sur l'etat reel.
  for (const e of tous(
    `SELECT e.id, e.journal, e.numero, COUNT(l.id) AS lignes,
            IFNULL(SUM(l.debit), 0) AS debit, IFNULL(SUM(l.credit), 0) AS credit
     FROM ecritures e LEFT JOIN lignes l ON l.ecriture_id = e.id
     WHERE ${COMPTABILISEE}
     GROUP BY e.id
     -- Agregats repetes a dessein : en clause HAVING, SQLite resout un nom
     -- d'abord sur les colonnes de la table, pas sur l'alias de la projection.
     HAVING IFNULL(SUM(l.debit), 0) <> IFNULL(SUM(l.credit), 0) OR COUNT(l.id) < 2`,
  )) {
    ecarts.push(ecart(
      e.lignes < 2 ? 'ECRITURE_SANS_LIGNES' : 'ECRITURE_DESEQUILIBREE',
      `Ecriture ${e.journal}-${e.numero}`,
      e.lignes < 2
        ? `Ecriture comptabilisee reduite a ${e.lignes} ligne(s) : des lignes ont ete retirees de la base.`
        : `Ecriture comptabilisee desequilibree : ${e.debit} XPF au debit contre ${e.credit} XPF au credit.`,
      { ecriture_id: e.id, lignes: e.lignes, debit: e.debit, credit: e.credit },
    ));
  }

  const concordance = concordanceLivres();
  if (!concordance.concordant) {
    for (const c of tous(
      `SELECT l.compte, c.intitule, c.collectif, COUNT(*) AS lignes,
              IFNULL(SUM(l.debit), 0) AS debit, IFNULL(SUM(l.credit), 0) AS credit
       FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
       LEFT JOIN comptes c ON c.numero = l.compte
       WHERE ${COMPTABILISEE} AND (c.numero IS NULL OR c.collectif = 1)
       GROUP BY l.compte ORDER BY l.compte`,
    )) {
      ecarts.push(ecart(
        c.collectif ? 'LIGNE_SUR_COMPTE_COLLECTIF' : 'LIGNE_SANS_COMPTE',
        `Compte ${c.compte}`,
        c.collectif
          ? `${c.lignes} ligne(s) imputee(s) sur le compte collectif ${c.compte} `
            + `(${c.debit} XPF au debit, ${c.credit} XPF au credit) : la balance exclut les comptes `
            + `collectifs, ces mouvements n y figurent donc pas.`
          : `${c.lignes} ligne(s) imputee(s) sur le compte ${c.compte}, absent du plan comptable.`,
        { compte: c.compte, lignes: c.lignes, debit: c.debit, credit: c.credit },
      ));
    }
    if (!concordance.equilibre) {
      ecarts.push(ecart(
        'LIVRE_JOURNAL_DESEQUILIBRE',
        'Livre-journal',
        `Le livre-journal totalise ${concordance.livre_journal.debit} XPF au debit contre `
        + `${concordance.livre_journal.credit} XPF au credit.`,
        concordance.livre_journal,
      ));
    }
  }

  return {
    arrete_le: new Date().toISOString(),
    sequences,
    concordance,
    ecarts,
    conforme: ecarts.length === 0,
  };
}

/** Refus bloquant : les livres ne sont pas en etat d'etre presentes. */
export function controleContinuiteLivres() {
  const etat = etatContinuiteLivres();
  if (!etat.conforme) {
    throw new ErreurConformite(
      'LIVRES_DISCONTINUS',
      etat.ecarts.map((e) => `${e.objet} : ${e.message}`).join(' '),
      { ecarts: etat.ecarts },
    );
  }
  return etat;
}
