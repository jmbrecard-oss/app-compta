import { un, tous, exec, transaction } from '../db.js';
import { tracer } from '../audit.js';
import { ErreurConformite } from './controles.js';

/**
 * Lettrage : rapprochement des debits et credits d'un meme compte de tiers.
 * Un lot lettre doit etre equilibre, sans quoi le lettrage masquerait un
 * solde non justifie.
 */
function prochaineLettre(compte) {
  const n = un(
    `SELECT COUNT(DISTINCT lettrage) AS n FROM lignes WHERE compte = $c AND lettrage IS NOT NULL`,
    { c: compte },
  ).n;
  let i = n;
  let lettre = '';
  do {
    lettre = String.fromCharCode(65 + (i % 26)) + lettre;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return lettre;
}

export function lettrer(ligneIds, utilisateur) {
  return transaction(() => {
    const lignes = ligneIds.map((id) => {
      const l = un(
        `SELECT l.*, c.lettrable FROM lignes l
         JOIN comptes c ON c.numero = l.compte
         JOIN ecritures e ON e.id = l.ecriture_id
         WHERE l.id = $id AND e.statut <> 'BROUILLON'`,
        { id },
      );
      if (!l) throw new ErreurConformite('LIGNE_INTROUVABLE', `Ligne ${id} introuvable ou non comptabilisee.`);
      if (!l.lettrable) throw new ErreurConformite('COMPTE_NON_LETTRABLE', `Le compte ${l.compte} n est pas lettrable.`);
      if (l.lettrage) throw new ErreurConformite('DEJA_LETTREE', `La ligne ${id} est deja lettree (${l.lettrage}).`);
      return l;
    });

    if (new Set(lignes.map((l) => l.compte)).size !== 1) {
      throw new ErreurConformite('COMPTES_DIFFERENTS', 'Le lettrage ne peut porter que sur un seul compte.');
    }
    const ecart = lignes.reduce((s, l) => s + l.debit - l.credit, 0);
    if (ecart !== 0) {
      throw new ErreurConformite('LETTRAGE_DESEQUILIBRE', `Lot desequilibre de ${ecart} XPF : lettrage refuse.`, { ecart });
    }

    const lettre = prochaineLettre(lignes[0].compte);
    for (const l of lignes) exec('UPDATE lignes SET lettrage = $x WHERE id = $id', { x: lettre, id: l.id });
    tracer(utilisateur.identifiant, 'LETTRAGE', 'compte', lignes[0].compte, `${lettre} sur ${lignes.length} ligne(s)`);
    return { compte: lignes[0].compte, lettrage: lettre, lignes: ligneIds };
  });
}

export function delettrer(compte, lettre, utilisateur) {
  const n = exec('UPDATE lignes SET lettrage = NULL WHERE compte = $c AND lettrage = $x', { c: compte, x: lettre }).changes;
  tracer(utilisateur.identifiant, 'DELETTRAGE', 'compte', compte, `${lettre} - ${n} ligne(s)`);
  return { delettrees: n };
}

export function lignesNonLettrees(compte) {
  return tous(
    `SELECT l.*, e.date_ecriture, e.journal, e.numero, e.piece_ref
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND l.lettrage IS NULL AND e.statut <> 'BROUILLON'
     ORDER BY e.date_ecriture, e.id`,
    { c: compte },
  );
}
