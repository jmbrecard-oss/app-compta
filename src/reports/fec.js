import { un, tous } from '../db.js';

/**
 * Fichier des ecritures comptables (FEC).
 *
 * Format normalise a 18 colonnes, separateur tabulation, encodage UTF-8,
 * dates AAAAMMJJ. C'est le format attendu par l'administration fiscale et
 * repris par les inspections de comptabilite : il permet de rejouer
 * l'integralite des ecritures comptabilisees.
 *
 * Seules les ecritures comptabilisees figurent au fichier ; les brouillons
 * en sont exclus par construction.
 */

const COLONNES = [
  'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate',
  'CompteNum', 'CompteLib', 'CompAuxNum', 'CompAuxLib',
  'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit',
  'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise',
];

const jour = (iso) => (iso ? String(iso).slice(0, 10).replaceAll('-', '') : '');
const nettoyer = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** XPF : devise sans subdivision, les montants restent entiers. */
const montant = (n) => String(n ?? 0);

export function genererFEC({ exercice_id, depuis, jusqu } = {}) {
  const lignes = tous(
    `SELECT e.journal, j.libelle AS journal_lib, e.numero, e.date_ecriture,
            e.piece_ref, e.date_piece, e.libelle AS ecriture_lib, e.valide_le,
            l.compte, c.intitule AS compte_lib, c.nature,
            l.libelle AS ligne_lib, l.debit, l.credit, l.lettrage,
            d.reference AS dossier_ref, d.intitule AS dossier_lib
     FROM ecritures e
     JOIN journaux j ON j.code = e.journal
     JOIN lignes   l ON l.ecriture_id = e.id
     JOIN comptes  c ON c.numero = l.compte
     LEFT JOIN dossiers d ON d.id = l.dossier_id
     WHERE e.statut <> 'BROUILLON'
       AND ($ex     IS NULL OR e.exercice_id   = $ex)
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     ORDER BY e.date_ecriture, e.journal, e.numero, l.ordre`,
    { ex: exercice_id ?? null, depuis: depuis ?? null, jusqu: jusqu ?? null },
  );

  const devise = un('SELECT devise FROM office WHERE id = 1')?.devise ?? 'XPF';

  const corps = lignes.map((l) => [
    nettoyer(l.journal),
    nettoyer(l.journal_lib),
    `${l.journal}${String(l.numero).padStart(6, '0')}`,
    jour(l.date_ecriture),
    nettoyer(l.compte),
    nettoyer(l.compte_lib),
    // Comptes auxiliaires : le dossier tient lieu de compte auxiliaire client.
    l.nature === 'CLIENT' ? nettoyer(l.dossier_ref) : '',
    l.nature === 'CLIENT' ? nettoyer(l.dossier_lib) : '',
    nettoyer(l.piece_ref),
    jour(l.date_piece ?? l.date_ecriture),
    nettoyer(l.ligne_lib || l.ecriture_lib),
    montant(l.debit),
    montant(l.credit),
    nettoyer(l.lettrage),
    '',
    jour(l.valide_le),
    '',
    devise,
  ].join('\t'));

  return [COLONNES.join('\t'), ...corps].join('\r\n') + '\r\n';
}

/** Nom normalise : <RIDET>FEC<AAAAMMJJ de cloture>.txt */
export function nomFichierFEC(exercice) {
  const ridet = (un('SELECT ridet FROM office WHERE id = 1')?.ridet || 'OFFICE').replace(/\W/g, '');
  return `${ridet}FEC${jour(exercice?.date_fin ?? new Date().toISOString())}.txt`;
}

/** Export CSV generique (point-virgule, compatible tableur francophone). */
export function versCSV(lignes, colonnes) {
  const echappe = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [
    colonnes.map((c) => echappe(c.titre)).join(';'),
    ...lignes.map((l) => colonnes.map((c) => echappe(typeof c.valeur === 'function' ? c.valeur(l) : l[c.valeur])).join(';')),
  ].join('\r\n') + '\r\n';
}
