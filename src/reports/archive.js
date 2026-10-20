import { un, tous } from '../db.js';
import { scelleDe, FORMAT, VERSION } from './verification-archive.js';

/**
 * Archive scellee de la chaine d'ecritures.
 *
 * L'archive est un document autoportant : elle contient l'integralite de la
 * chaine d'ecritures comptabilisees - jamais un extrait - avec le plan
 * comptable, les dossiers, les exercices et le journal d'audit necessaires
 * pour la relire sans l'application. Elle est scellee par une empreinte qui
 * couvre tout le document.
 *
 * Pourquoi la chaine entiere et non une periode : une empreinte chainee ne se
 * verifie que depuis son origine. Un extrait par exercice ne se verifierait
 * pas ; c'est le role de l'export FEC, qui lui est periodique.
 *
 * La verification n'est pas ici : elle vit dans verification-archive.js, qui
 * n'accede pas a la base. Ce module-ci ne fait que produire.
 */

/**
 * Colonnes retenues, explicitement. Ne jamais remplacer par SELECT * :
 * l'ajout d'une colonne au schema changerait alors le scelle de toutes les
 * archives deja editees, sans qu'aucune ecriture ait bouge.
 */
const COLONNES_ECRITURE = [
  'id', 'exercice_id', 'journal', 'numero', 'date_ecriture', 'date_piece', 'piece_ref',
  'libelle', 'dossier_id', 'statut', 'cree_le', 'cree_par', 'valide_le', 'valide_par',
  'contrepassee_par', 'contrepassation_de', 'rang_chaine', 'hash', 'hash_precedent',
];

const COLONNES_LIGNE = ['ordre', 'compte', 'dossier_id', 'libelle', 'debit', 'credit', 'lettrage'];

/** Les valeurs de l'archive sont des scalaires JSON : ni undefined, ni BigInt. */
const scalaire = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  return v;
};

const retenir = (ligne, colonnes) =>
  Object.fromEntries(colonnes.map((c) => [c, scalaire(ligne?.[c])]));

/**
 * Edite l'archive complete et la scelle.
 * `edite_le` est parametrable pour que deux editions comparables produisent
 * le meme document - c'est ce qui rend le scelle reproductible.
 */
export function genererArchive({ edite_par = 'systeme', edite_le = new Date().toISOString() } = {}) {
  const office = un(
    `SELECT denomination, notaire_titulaire, adresse, ridet, chambre, devise, decimales
     FROM office WHERE id = 1`,
  );

  const ecritures = tous(
    `SELECT ${COLONNES_ECRITURE.join(', ')} FROM ecritures
     WHERE statut <> 'BROUILLON' AND rang_chaine IS NOT NULL
     ORDER BY rang_chaine`,
  ).map((e) => ({
    ...retenir(e, COLONNES_ECRITURE),
    lignes: tous(
      `SELECT ${COLONNES_LIGNE.join(', ')} FROM lignes WHERE ecriture_id = $id ORDER BY ordre`,
      { id: e.id },
    ).map((l) => retenir(l, COLONNES_LIGNE)),
  }));

  const contenu = {
    edition: {
      edite_le,
      edite_par,
      perimetre: 'chaine complete des ecritures comptabilisees',
      empreinte: 'SHA-256',
    },
    office: office
      ? retenir(office, ['denomination', 'notaire_titulaire', 'adresse', 'ridet', 'chambre', 'devise', 'decimales'])
      : null,
    exercices: tous(
      `SELECT id, libelle, date_debut, date_fin, statut, cloture_le, cloture_par, cloture_hash
       FROM exercices ORDER BY date_debut`,
    ).map((x) => retenir(x, ['id', 'libelle', 'date_debut', 'date_fin', 'statut', 'cloture_le', 'cloture_par', 'cloture_hash'])),
    journaux: tous('SELECT code, libelle, type FROM journaux ORDER BY code')
      .map((j) => retenir(j, ['code', 'libelle', 'type'])),
    comptes: tous(
      `SELECT numero, intitule, classe, type, nature, sens_normal, collectif, actif
       FROM comptes ORDER BY numero`,
    ).map((c) => retenir(c, ['numero', 'intitule', 'classe', 'type', 'nature', 'sens_normal', 'collectif', 'actif'])),
    dossiers: tous(
      `SELECT id, reference, intitule, nature_acte, notaire, compte_client, statut, ouvert_le, solde_le
       FROM dossiers ORDER BY id`,
    ).map((d) => retenir(d, ['id', 'reference', 'intitule', 'nature_acte', 'notaire', 'compte_client', 'statut', 'ouvert_le', 'solde_le'])),
    ecritures,
    audit: tous(
      `SELECT id, horodatage, utilisateur, action, objet, objet_id, details, hash, hash_precedent
       FROM audit ORDER BY id`,
    ).map((a) => retenir(a, ['id', 'horodatage', 'utilisateur', 'action', 'objet', 'objet_id', 'details', 'hash', 'hash_precedent'])),
  };

  const archive = { format: FORMAT, version: VERSION, contenu };
  archive.scelle = scelleDe(archive);
  return archive;
}

/**
 * Serialisation lisible. Le scelle porte sur la forme canonique du contenu,
 * pas sur la mise en page : l'archive peut donc etre indentee, relue et
 * commentee par un humain sans cesser d'etre verifiable.
 */
export function serialiserArchive(archive) {
  return `${JSON.stringify(archive, null, 2)}\n`;
}

/** Nom normalise : <RIDET>-ARCHIVE-<AAAAMMJJ>.json */
export function nomFichierArchive(date = new Date()) {
  const ridet = (un('SELECT ridet FROM office WHERE id = 1')?.ridet || 'OFFICE').replace(/\W/g, '');
  const jour = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `${ridet}-ARCHIVE-${jour}.json`;
}
