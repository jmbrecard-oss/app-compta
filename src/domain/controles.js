import { un, tous } from '../db.js';

/**
 * Controles de conformite de la comptabilite notariale.
 *
 * Les controles BLOQUANTS refusent la comptabilisation : ils traduisent des
 * regles auxquelles l'office ne peut pas deroger. Les controles SIGNALES
 * alimentent le tableau de bord et le dossier d'inspection.
 */

export class ErreurConformite extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ErreurConformite';
    this.code = code;
    this.details = details;
  }
}

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
export function controleSoldeClients(comptesClients) {
  const fautifs = [];
  for (const compte of new Set(comptesClients)) {
    const r = un('SELECT solde, reference, intitule FROM v_soldes_dossiers WHERE compte_client = $c', { c: compte });
    if (r && r.solde > 0) fautifs.push({ compte, ...r });
  }
  if (fautifs.length) {
    const d = fautifs[0];
    throw new ErreurConformite(
      'SOLDE_CLIENT_DEBITEUR',
      `Dossier ${d.reference} : le compte client deviendrait debiteur de ${d.solde} XPF. `
      + `L office ne peut pas avancer de fonds pour le compte d un client.`,
      { dossiers: fautifs },
    );
  }
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

// --------------------------------------------------------------------------
// Controles signales : tableau de bord et dossier d'inspection
// --------------------------------------------------------------------------

export function anomalies() {
  const liste = [];

  for (const d of tous('SELECT * FROM v_soldes_dossiers WHERE solde > 0')) {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'SOLDE_CLIENT_DEBITEUR',
      objet: `Dossier ${d.reference}`,
      message: `Compte client debiteur de ${d.solde} XPF : avance de fonds par l office.`,
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

  const brouillons = un(`SELECT COUNT(*) AS n FROM ecritures WHERE statut = 'BROUILLON'`).n;
  if (brouillons > 0) {
    liste.push({
      gravite: 'MINEURE',
      code: 'BROUILLONS_EN_ATTENTE',
      objet: 'Saisie',
      message: `${brouillons} ecriture(s) en brouillon, non comptabilisee(s).`,
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

  return liste;
}
