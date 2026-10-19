import { un, tous, exec, transaction } from '../db.js';
import { tracer } from '../audit.js';
import { ErreurConformite } from './controles.js';
import { PREFIXE_COMPTE_CLIENT } from '../pcn.js';

/**
 * Chaque dossier recoit a son ouverture un compte client individualise.
 * Le compte n'est jamais reutilise, meme apres archivage du dossier :
 * la numerotation est strictement croissante.
 */
function prochainCompteClient() {
  const dernier = un(
    `SELECT numero FROM comptes WHERE numero LIKE $p AND collectif = 0
     ORDER BY numero DESC LIMIT 1`,
    { p: `${PREFIXE_COMPTE_CLIENT}%` },
  );
  const suite = dernier ? Number(dernier.numero.slice(PREFIXE_COMPTE_CLIENT.length)) + 1 : 1;
  return PREFIXE_COMPTE_CLIENT + String(suite).padStart(5, '0');
}

export function ouvrirDossier(saisie, utilisateur) {
  const reference = String(saisie.reference ?? '').trim();
  const intitule = String(saisie.intitule ?? '').trim();
  if (!reference) throw new ErreurConformite('REFERENCE_MANQUANTE', 'La reference du dossier est obligatoire.');
  if (!intitule) throw new ErreurConformite('INTITULE_MANQUANT', 'L intitule du dossier est obligatoire.');
  if (un('SELECT id FROM dossiers WHERE reference = $r', { r: reference })) {
    throw new ErreurConformite('REFERENCE_EXISTANTE', `Le dossier ${reference} existe deja.`);
  }

  return transaction(() => {
    const compte = prochainCompteClient();
    exec(
      `INSERT INTO comptes (numero, intitule, classe, type, nature, sens_normal, lettrable, rapprochable, collectif, actif)
       VALUES ($n, $i, 4, 'BILAN', 'CLIENT', 'CREDIT', 1, 0, 0, 1)`,
      { n: compte, i: `Client - ${reference} ${intitule}`.slice(0, 120) },
    );
    const r = exec(
      `INSERT INTO dossiers (reference, intitule, nature_acte, notaire, collaborateur, compte_client, ouvert_le)
       VALUES ($r, $i, $na, $no, $co, $cc, $d)`,
      {
        r: reference,
        i: intitule,
        na: String(saisie.nature_acte ?? ''),
        no: String(saisie.notaire ?? ''),
        co: String(saisie.collaborateur ?? ''),
        cc: compte,
        d: saisie.ouvert_le ?? new Date().toISOString().slice(0, 10),
      },
    );
    const id = Number(r.lastInsertRowid);
    tracer(utilisateur.identifiant, 'OUVERTURE_DOSSIER', 'dossier', id, `${reference} - compte ${compte}`);
    return lireDossier(id);
  });
}

export function lireDossier(id) {
  const d = un('SELECT * FROM v_soldes_dossiers WHERE id = $id', { id });
  if (!d) return null;
  const fiche = un('SELECT * FROM dossiers WHERE id = $id', { id });
  return {
    ...fiche,
    total_debit: d.total_debit,
    total_credit: d.total_credit,
    solde: d.solde,
    solde_client: -d.solde, // positif = fonds detenus pour le client
    mouvements: tous(
      `SELECT e.date_ecriture, e.journal, e.numero, e.statut, e.piece_ref,
              l.libelle, l.debit, l.credit, l.lettrage, e.id AS ecriture_id
       FROM lignes l
       JOIN ecritures e ON e.id = l.ecriture_id
       WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       ORDER BY e.date_ecriture, e.id, l.ordre`,
      { c: fiche.compte_client },
    ),
  };
}

export function listerDossiers({ statut, recherche } = {}) {
  return tous(
    `SELECT v.*, d.notaire, d.nature_acte, d.ouvert_le
     FROM v_soldes_dossiers v
     JOIN dossiers d ON d.id = v.id
     WHERE ($statut IS NULL OR v.statut = $statut)
       AND ($q IS NULL OR v.reference LIKE $q OR v.intitule LIKE $q)
     ORDER BY v.reference`,
    { statut: statut ?? null, q: recherche ? `%${recherche}%` : null },
  );
}

/**
 * Cloture d'un dossier : refusee tant que le compte client n'est pas solde.
 * Un dossier dont le compte presente un solde ne peut pas etre archive :
 * des fonds appartenant au client resteraient detenus sans affectation.
 */
export function cloreDossier(id, utilisateur) {
  const d = un('SELECT * FROM v_soldes_dossiers WHERE id = $id', { id });
  if (!d) throw new ErreurConformite('INTROUVABLE', `Dossier ${id} introuvable.`);
  if (d.solde !== 0) {
    throw new ErreurConformite(
      'DOSSIER_NON_SOLDE',
      `Dossier ${d.reference} : le compte client presente un solde de ${Math.abs(d.solde)} XPF `
      + `(${d.solde < 0 ? 'fonds dus au client' : 'avance de l office'}). Le dossier ne peut pas etre clos.`,
      { solde: d.solde },
    );
  }
  exec(`UPDATE dossiers SET statut = 'SOLDE', solde_le = $d WHERE id = $id`, { d: new Date().toISOString().slice(0, 10), id });
  tracer(utilisateur.identifiant, 'CLOTURE_DOSSIER', 'dossier', id, d.reference);
  return lireDossier(id);
}
