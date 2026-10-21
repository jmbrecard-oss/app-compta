import { un, tous } from '../db.js';
import { ErreurConformite } from '../erreurs.js';
import { COMPTES_EMOLUMENTS, COMPTES_DEBOURS_TIERS } from '../pcn.js';
import { baremeCourant, baremeFictif } from './bareme.js';
import { anomaliesEspeces } from './especes.js';
// Cycle assume : tgc.js n'utilise ErreurConformite qu'a l'interieur de ses
// fonctions, et controles.js n'appelle anomaliesTgc qu'a l'execution.
import { anomaliesTgc } from './tgc.js';
import { anomaliesPlacements } from './placements.js';
import { relancesRapprochements } from './surveillance.js';

/**
 * Controles de conformite de la comptabilite notariale.
 *
 * Les controles BLOQUANTS refusent la comptabilisation : ils traduisent des
 * regles auxquelles l'office ne peut pas deroger. Les controles SIGNALES
 * alimentent le tableau de bord et le dossier d'inspection.
 */

// Reexportee : tout le domaine l'importe historiquement depuis ce module.
export { ErreurConformite };

// --------------------------------------------------------------------------
// Controles bloquants, appliques a la validation d'une ecriture
// --------------------------------------------------------------------------

/** Partie double : total des debits = total des credits. */
export function controleEquilibre(lignes) {
  const debit = lignes.reduce((s, l) => s + l.debit, 0);
  const credit = lignes.reduce((s, l) => s + l.credit, 0);
  if (debit !== credit) {
    throw new ErreurConformite(
      'DESEQUILIBRE',
      `Ecriture desequilibree : ${debit} XPF au debit contre ${credit} XPF au credit.`,
      { debit, credit, ecart: debit - credit },
    );
  }
  if (debit === 0) {
    throw new ErreurConformite('MONTANT_NUL', 'Une ecriture de montant nul ne peut pas etre comptabilisee.');
  }
  return { debit, credit };
}

/** Les montants sont des entiers de XPF : la devise n'a pas de subdivision. */
export function controleMontantsEntiers(lignes) {
  for (const l of lignes) {
    if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit)) {
      throw new ErreurConformite(
        'MONTANT_NON_ENTIER',
        `Le franc Pacifique ne comporte pas de decimale : montant invalide sur le compte ${l.compte}.`,
        { compte: l.compte },
      );
    }
    if (l.debit < 0 || l.credit < 0) {
      throw new ErreurConformite(
        'MONTANT_NEGATIF',
        `Montant negatif interdit sur le compte ${l.compte} : utiliser le sens inverse.`,
        { compte: l.compte },
      );
    }
  }
}

/** Tous les comptes mouvementes existent, sont actifs et ne sont pas collectifs. */
export function controleComptes(lignes) {
  for (const l of lignes) {
    const c = un('SELECT * FROM comptes WHERE numero = $n', { n: l.compte });
    if (!c) throw new ErreurConformite('COMPTE_INCONNU', `Compte ${l.compte} inexistant au plan comptable.`, { compte: l.compte });
    if (!c.actif) throw new ErreurConformite('COMPTE_INACTIF', `Compte ${l.compte} cloture.`, { compte: l.compte });
    if (c.collectif) {
      throw new ErreurConformite(
        'COMPTE_COLLECTIF',
        `Le compte ${l.compte} est un compte collectif : imputer sur le compte client individualise du dossier.`,
        { compte: l.compte },
      );
    }
    if (c.nature === 'CLIENT') {
      const d = un('SELECT id FROM dossiers WHERE compte_client = $n', { n: l.compte });
      if (!d) {
        throw new ErreurConformite('CLIENT_SANS_DOSSIER', `Le compte client ${l.compte} n est rattache a aucun dossier.`, { compte: l.compte });
      }
      if (l.dossier_id && l.dossier_id !== d.id) {
        throw new ErreurConformite(
          'DOSSIER_INCOHERENT',
          `Le compte ${l.compte} appartient a un autre dossier que celui impute.`,
          { compte: l.compte },
        );
      }
    }
  }
}

/** L'ecriture tombe dans un exercice ouvert. */
export function controleExercice(dateEcriture) {
  const ex = un(
    `SELECT * FROM exercices WHERE $d BETWEEN date_debut AND date_fin`,
    { d: dateEcriture },
  );
  if (!ex) {
    throw new ErreurConformite('HORS_EXERCICE', `Aucun exercice comptable ne couvre la date ${dateEcriture}.`, { date: dateEcriture });
  }
  if (ex.statut === 'CLOS') {
    throw new ErreurConformite(
      'EXERCICE_CLOS',
      `L exercice ${ex.libelle} est clos : aucune ecriture ne peut plus y etre portee.`,
      { exercice: ex.libelle },
    );
  }
  return ex;
}

/**
 * Chronologie : une ecriture ne peut pas etre anterieure a la derniere
 * ecriture deja comptabilisee dans le meme journal.
 */
export function controleChronologie(journal, exerciceId, dateEcriture) {
  const derniere = un(
    `SELECT date_ecriture, numero FROM ecritures
     WHERE journal = $j AND exercice_id = $e AND statut <> 'BROUILLON'
     ORDER BY date_ecriture DESC, numero DESC LIMIT 1`,
    { j: journal, e: exerciceId },
  );
  if (derniere && dateEcriture < derniere.date_ecriture) {
    throw new ErreurConformite(
      'RUPTURE_CHRONOLOGIE',
      `Le journal ${journal} est deja comptabilise jusqu au ${derniere.date_ecriture} : `
      + `une ecriture au ${dateEcriture} romprait l ordre chronologique.`,
      { journal, derniere_date: derniere.date_ecriture },
    );
  }
}

/**
 * Interdiction du solde debiteur sur un compte client.
 *
 * Regle cardinale de la comptabilite notariale : l'office ne peut jamais
 * avancer de fonds pour le compte d'un client. Un compte client doit
 * presenter un solde crediteur ou nul a tout instant.
 *
 * Le controle est effectue APRES insertion des lignes, dans la transaction,
 * de sorte que l'etat teste soit l'etat reel resultant de l'ecriture.
 */
export function alerteSoldeClients(comptesClients) {
  const debiteurs = [];
  for (const compte of new Set(comptesClients)) {
    const r = un('SELECT solde, reference, intitule FROM v_soldes_dossiers WHERE compte_client = $c', { c: compte });
    if (r && r.solde > 0) debiteurs.push({ compte, ...r });
  }
  return debiteurs.map((d) => ({
    gravite: 'MAJEURE',
    code: 'SOLDE_CLIENT_DEBITEUR',
    compte: d.compte,
    reference: d.reference,
    solde: d.solde,
    message: `Dossier ${d.reference} : compte client debiteur de ${d.solde} XPF. `
      + `L office avance des fonds pour le compte du client ; a regulariser avant la cloture.`,
  }));
}

/**
 * Etat des comptes clients debiteurs.
 *
 * Donne, pour chaque dossier debiteur, le montant avance par l'office et la
 * date a laquelle le compte a bascule : c'est l'anciennete qui rend l'anomalie
 * grave, pas le fait ponctuel d'un debours regle avant l'arrivee de la
 * provision.
 */
export function etatComptesDebiteurs() {
  const dossiers = tous('SELECT * FROM v_soldes_dossiers WHERE solde > 0 ORDER BY solde DESC');
  const aujourdhui = new Date().toISOString().slice(0, 10);

  const lignes = dossiers.map((d) => {
    // Solde progressif du compte : la bascule est la premiere ecriture apres
    // laquelle le cumul ne repasse plus jamais a zero ou en dessous.
    const mouvements = tous(
      `SELECT e.date_ecriture,
              SUM(l.debit - l.credit) OVER (ORDER BY e.date_ecriture, e.id
                                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumul
       FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
       WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       ORDER BY e.date_ecriture, e.id`,
      { c: d.compte_client },
    );
    let bascule = null;
    for (const m of mouvements) bascule = m.cumul > 0 ? (bascule ?? m.date_ecriture) : null;

    const jours = bascule
      ? Math.round((Date.parse(aujourdhui) - Date.parse(bascule)) / 86_400_000)
      : 0;

    return {
      dossier_id: d.id,
      reference: d.reference,
      intitule: d.intitule,
      compte_client: d.compte_client,
      avance: d.solde,
      debiteur_depuis: bascule,
      anciennete_jours: jours,
      // Un debours regle la veille de la provision n'a pas la meme portee
      // qu'une avance vieille de plusieurs mois.
      gravite: jours >= 30 ? 'CRITIQUE' : 'MAJEURE',
    };
  });

  return {
    arrete_au: aujourdhui,
    nombre: lignes.length,
    total_avance: lignes.reduce((t, l) => t + l.avance, 0),
    a_relancer: lignes.filter((l) => l.anciennete_jours >= 30).length,
    lignes,
  };
}

/**
 * Representation des fonds clients.
 *
 * A tout instant, les disponibilites detenues sur les comptes de depot des
 * fonds clients doivent couvrir le total des soldes crediteurs des dossiers.
 * Un deficit signifie que des fonds clients ont servi a autre chose.
 */
export function etatRepresentationFonds() {
  const depots = un(
    `SELECT IFNULL(SUM(solde), 0) AS total FROM v_soldes WHERE nature = 'DEPOT_FONDS_CLIENTS'`,
  ).total;
  const du = un(
    `SELECT IFNULL(SUM(-solde), 0) AS total FROM v_soldes_dossiers WHERE solde < 0`,
  ).total;
  const enRoute = un(
    `SELECT IFNULL(SUM(solde), 0) AS total FROM v_soldes WHERE numero IN ('514000')`,
  ).total;
  const representation = depots + enRoute;
  return {
    fonds_detenus_en_depot: depots,
    encaissements_en_cours: enRoute,
    representation_totale: representation,
    du_aux_clients: du,
    ecart: representation - du,
    conforme: representation - du >= 0,
  };
}

export function controleRepresentationFonds() {
  const etat = etatRepresentationFonds();
  if (!etat.conforme) {
    throw new ErreurConformite(
      'FONDS_NON_REPRESENTES',
      `Les fonds clients ne seraient plus representes : ${etat.representation_totale} XPF disponibles `
      + `pour ${etat.du_aux_clients} XPF dus aux clients (deficit de ${-etat.ecart} XPF).`,
      etat,
    );
  }
  return etat;
}

/**
 * Etancheite office / clients : un mouvement ne peut pas, dans la meme
 * ecriture, debiter un compte de depot de fonds clients et crediter un
 * produit de l'office sans transiter par un compte client. On interdit donc
 * toute ecriture melant un compte de depot clients et un compte de gestion.
 */
export function controleEtancheite(lignes) {
  const natures = new Set();
  let gestion = false;
  for (const l of lignes) {
    const c = un('SELECT nature, classe FROM comptes WHERE numero = $n', { n: l.compte });
    if (!c) continue;
    natures.add(c.nature);
    if (c.classe === 6 || c.classe === 7) gestion = true;
  }
  if (natures.has('DEPOT_FONDS_CLIENTS') && gestion) {
    throw new ErreurConformite(
      'ETANCHEITE_ROMPUE',
      'Une meme ecriture ne peut pas mouvementer un compte de depot des fonds clients '
      + 'et un compte de charges ou de produits : les emoluments doivent transiter par le compte client du dossier.',
    );
  }
}

/**
 * Rattachement de la taxe de l'acte a un dossier.
 *
 * L'article 2 de l'arrete du 27 janvier 2006 soumet a l'examen de conformite
 * la taxe des actes et tous les modules generant des ecritures. Cela suppose
 * de pouvoir remonter de chaque emolument et de chaque debours a l'acte qui
 * l'a produit : un produit d'emolument ou une somme encaissee pour le compte
 * du Tresor ne peut donc pas etre comptabilise sans dossier.
 *
 * Seuls les a-nouveaux echappent a la regle : ils reprennent des soldes de
 * comptes, pas des actes.
 */
export function controleRattachementActe(lignes, ecriture = {}) {
  if (ecriture.journal === 'AN') return;

  // Une contre-passation n'ajoute aucun produit : elle annule l'existant, et
  // reprend tel quel le rattachement de l'ecriture d'origine. L'y soumettre
  // rendrait definitivement incorrigible toute ecriture comptabilisee avant
  // l'entree en vigueur de ce controle - la contre-passation etant le seul
  // moyen de corriger, et la base interdisant de retoucher une ligne validee.
  if (ecriture.contrepassation_de) return;

  // Le controle porte sur CHAQUE ligne concernee, et non sur l'ecriture prise
  // globalement : une ligne de compte client presente ailleurs dans l'ecriture
  // ne rattache pas a l'acte le produit d'emolument qui l'accompagne.
  for (const l of lignes) {
    if (l.dossier_id) continue;
    if (COMPTES_EMOLUMENTS.includes(l.compte)) {
      throw new ErreurConformite(
        'EMOLUMENT_HORS_DOSSIER',
        `Le compte d emoluments ${l.compte} est mouvemente sans dossier : la taxe d un acte se `
        + `rattache au dossier qui l a genere. Designez-le sur la ligne lorsque l ecriture en concerne plusieurs.`,
        { compte: l.compte, ordre: l.ordre },
      );
    }
    if (COMPTES_DEBOURS_TIERS.includes(l.compte)) {
      throw new ErreurConformite(
        'DEBOURS_HORS_DOSSIER',
        `Le compte ${l.compte} porte des sommes encaissees pour le compte d autrui : la ligne doit `
        + `designer le dossier au titre duquel elles sont dues.`,
        { compte: l.compte, ordre: l.ordre },
      );
    }
  }
}

/**
 * Justification des comptes de tiers a reverser (448600, 448700, 448800).
 * Etat de controle des sommes dues au Tresor et aux tiers, dossier par
 * dossier : un solde debiteur signifie que l'office a reverse plus qu'il n a
 * encaisse pour le compte du client.
 */
export function etatDeboursAReverser() {
  // Liste de numeros de comptes figee dans le plan comptable, jamais saisie :
  // SQLite ne sait pas lier une liste a un parametre nomme.
  const LISTE = COMPTES_DEBOURS_TIERS.map((c) => `'${c}'`).join(',');

  const comptes = tous(
    `SELECT numero, intitule, solde FROM v_soldes WHERE numero IN (${LISTE})`,
  ).map((c) => ({ ...c, du_au_tiers: -c.solde }));

  const parDossier = tous(
    `SELECT l.compte, d.id AS dossier_id, d.reference, d.intitule,
            IFNULL(SUM(l.credit - l.debit), 0) AS du_au_tiers
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id AND e.statut <> 'BROUILLON'
     JOIN dossiers d  ON d.id = l.dossier_id
     WHERE l.compte IN (${LISTE})
     GROUP BY l.compte, d.id
     HAVING du_au_tiers <> 0
     ORDER BY l.compte, d.reference`,
  );

  return {
    arrete_le: new Date().toISOString().slice(0, 10),
    comptes,
    total_du_au_tiers: comptes.reduce((s, c) => s + c.du_au_tiers, 0),
    par_dossier: parDossier,
    avances_par_l_office: parDossier.filter((d) => d.du_au_tiers < 0),
  };
}

// --------------------------------------------------------------------------
// Controles signales : tableau de bord et dossier d'inspection
// --------------------------------------------------------------------------

const GRAVITES = ['CRITIQUE', 'MAJEURE', 'MINEURE', 'INFORMATION'];

export function anomalies(options = {}) {
  const liste = [];

  for (const d of etatComptesDebiteurs().lignes) {
    liste.push({
      gravite: d.gravite,
      code: 'SOLDE_CLIENT_DEBITEUR',
      objet: `Dossier ${d.reference}`,
      message: `Compte client debiteur de ${d.avance} XPF depuis le ${d.debiteur_depuis} `
        + `(${d.anciennete_jours} jour(s)) : avance de fonds par l office, a regulariser.`,
    });
  }

  const fonds = etatRepresentationFonds();
  if (!fonds.conforme) {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'FONDS_NON_REPRESENTES',
      objet: 'Representation des fonds clients',
      message: `Deficit de representation de ${-fonds.ecart} XPF.`,
    });
  }

  for (const c of tous(`SELECT * FROM v_soldes WHERE nature = 'ATTENTE' AND solde <> 0`)) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'COMPTE_ATTENTE_NON_SOLDE',
      objet: `Compte ${c.numero}`,
      message: `Compte d attente non solde : ${c.solde} XPF. A imputer avant la cloture.`,
    });
  }

  if (baremeFictif()) {
    const b = baremeCourant();
    liste.push({
      gravite: 'CRITIQUE',
      code: 'BAREME_NON_VALIDE',
      objet: `Bareme ${b.meta.code}`,
      message: `Le bareme en service est declare ${b.meta.statut} : ses taux et tranches ne sont issus d aucun texte. `
        + `Toute taxe liquidee a partir de ce bareme est sans valeur. Remplacer le fichier par le tarif en vigueur `
        + `(${b.meta.texte_reference}) et le faire valider par : ${b.meta.a_valider_par}.`,
    });
  }

  for (const d of etatDeboursAReverser().avances_par_l_office) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'DEBOURS_AVANCES',
      objet: `Dossier ${d.reference}`,
      message: `Compte ${d.compte} : ${-d.du_au_tiers} XPF reverses au-dela de ce qui a ete encaisse pour le dossier.`,
    });
  }

  const brouillons = un(`SELECT COUNT(*) AS n FROM ecritures WHERE statut = 'BROUILLON'`).n;
  if (brouillons > 0) {
    liste.push({
      gravite: 'MINEURE',
      code: 'BROUILLONS_EN_ATTENTE',
      objet: 'Saisie',
      message: `${brouillons} ecriture(s) en brouillon, non comptabilisee(s).`,
    });
  }

  // Especes : plafonds, encaisse, caisse creditrice a une date quelconque.
  liste.push(...anomaliesEspeces());
  // Rapprochements periodiques non effectues : entre deux arretes rapproches,
  // aucune verification externe ne couvre les fonds detenus.
  for (const r of relancesRapprochements(options).relances) {
    liste.push({
      gravite: r.gravite,
      code: 'RAPPROCHEMENT_EN_RETARD',
      objet: `Compte ${r.compte}`,
      message: r.message,
    });
  }

  const caisse = un(`SELECT IFNULL(SUM(solde), 0) AS s FROM v_soldes WHERE nature = 'CAISSE'`).s;
  if (caisse < 0) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'CAISSE_NEGATIVE',
      objet: 'Caisse',
      message: `Caisse creditrice de ${-caisse} XPF : impossible physiquement.`,
    });
  }

  const dossiersSoldes = tous(
    `SELECT * FROM v_soldes_dossiers WHERE statut = 'OUVERT' AND solde = 0
       AND id IN (SELECT DISTINCT dossier_id FROM lignes WHERE dossier_id IS NOT NULL)`,
  );
  for (const d of dossiersSoldes) {
    liste.push({
      gravite: 'INFORMATION',
      code: 'DOSSIER_A_CLORE',
      objet: `Dossier ${d.reference}`,
      message: 'Compte client solde : le dossier peut etre clos.',
    });
  }

  liste.push(...anomaliesTgc());
  liste.push(...anomaliesPlacements());

  // Le plus grave en tete : c'est dans cet ordre que le tableau de bord et le
  // dossier d'inspection les presentent.
  return liste.sort((a, b) => GRAVITES.indexOf(a.gravite) - GRAVITES.indexOf(b.gravite));
}
