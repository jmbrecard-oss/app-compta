import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

export const GENESE = '0'.repeat(64);

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Empreinte canonique d'une ecriture validee.
 * L'ordre des champs est fige : le modifier invaliderait toute la chaine
 * des exercices anterieurs.
 */
export function empreinteEcriture(ecriture, lignes, hashPrecedent) {
  const corps = [
    ecriture.exercice_id,
    ecriture.journal,
    ecriture.numero,
    ecriture.date_ecriture,
    ecriture.piece_ref ?? '',
    ecriture.libelle,
    ecriture.dossier_id ?? '',
    ecriture.valide_le,
    ecriture.valide_par,
    ...lignes
      .slice()
      .sort((a, b) => a.ordre - b.ordre)
      .map((l) => [l.ordre, l.compte, l.dossier_id ?? '', l.libelle, l.debit, l.credit].join('|')),
  ].join('~');
  return sha256(hashPrecedent + corps);
}

export function empreinteAudit(evt, hashPrecedent) {
  const corps = [evt.horodatage, evt.utilisateur, evt.action, evt.objet, evt.objet_id ?? '', evt.details].join('~');
  return sha256(hashPrecedent + corps);
}

// --------------------------------------------------------- mots de passe --

export function hacherMotDePasse(motDePasse, sel = randomBytes(16).toString('hex')) {
  const hash = pbkdf2Sync(motDePasse, sel, 210000, 32, 'sha512').toString('hex');
  return { hash, sel };
}

export function verifierMotDePasse(motDePasse, sel, hashAttendu) {
  const { hash } = hacherMotDePasse(motDePasse, sel);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashAttendu, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const jetonAleatoire = () => randomBytes(32).toString('hex');
