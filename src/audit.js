import { un, tous, exec } from './db.js';
import { empreinteAudit, GENESE } from './hash.js';

/**
 * Journal d'audit en ajout seul, chaine par empreinte.
 * Toute operation significative y laisse une trace nominative et horodatee.
 */
export function tracer(utilisateur, action, objet, objetId = null, details = '') {
  const dernier = un('SELECT hash FROM audit ORDER BY id DESC LIMIT 1');
  const hashPrecedent = dernier?.hash ?? GENESE;
  const evt = {
    horodatage: new Date().toISOString(),
    utilisateur,
    action,
    objet,
    objet_id: objetId === null ? null : String(objetId),
    details: typeof details === 'string' ? details : JSON.stringify(details),
  };
  const hash = empreinteAudit(evt, hashPrecedent);
  exec(
    `INSERT INTO audit (horodatage, utilisateur, action, objet, objet_id, details, hash, hash_precedent)
     VALUES ($horodatage, $utilisateur, $action, $objet, $objet_id, $details, $hash, $hash_precedent)`,
    { ...evt, hash, hash_precedent: hashPrecedent },
  );
  return hash;
}

/** Recalcule la chaine d'audit de bout en bout. */
export function verifierChaineAudit() {
  const lignes = tous('SELECT * FROM audit ORDER BY id');
  let precedent = GENESE;
  for (const l of lignes) {
    if (l.hash_precedent !== precedent) {
      return { valide: false, rupture_id: l.id, motif: 'chainage rompu' };
    }
    if (empreinteAudit(l, precedent) !== l.hash) {
      return { valide: false, rupture_id: l.id, motif: 'contenu altere' };
    }
    precedent = l.hash;
  }
  return { valide: true, evenements: lignes.length, hash_final: precedent };
}

export function journalAudit({ depuis, jusqu, limite = 500 } = {}) {
  return tous(
    `SELECT * FROM audit
     WHERE ($depuis IS NULL OR horodatage >= $depuis)
       AND ($jusqu  IS NULL OR horodatage <= $jusqu)
     ORDER BY id DESC LIMIT $limite`,
    { depuis: depuis ?? null, jusqu: jusqu ?? null, limite },
  );
}
