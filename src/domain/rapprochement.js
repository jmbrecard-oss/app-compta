import { un, tous, exec, transaction } from '../db.js';
import { tracer } from '../audit.js';
import { ErreurConformite } from './controles.js';
import { calendrierRapprochements, periodesAnterieuresNonCouvertes, relancesRapprochements } from './surveillance.js';

/**
 * Rapprochement bancaire.
 *
 * Le rapprochement mensuel du compte de depot des fonds clients est la
 * verification centrale du controle de comptabilite : il etablit que les
 * sommes inscrites en comptabilite correspondent aux avoirs reellement
 * detenus par l'etablissement teneur du compte.
 *
 * Le rapprochement n'a de valeur que repete : la continuite des periodes est
 * surveillee par src/domain/surveillance.js, et la cloture d'un rapprochement
 * est refusee tant qu'une periode anterieure n'est pas justifiee.
 */

export function ouvrirRapprochement({ compte, date_arrete, solde_releve }, utilisateur) {
  const c = un('SELECT * FROM comptes WHERE numero = $n AND rapprochable = 1', { n: compte });
  if (!c) throw new ErreurConformite('COMPTE_NON_RAPPROCHABLE', `Le compte ${compte} n est pas rapprochable.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date_arrete ?? ''))) {
    throw new ErreurConformite('DATE_INVALIDE', 'Date d arrete attendue au format AAAA-MM-JJ.', { date_arrete });
  }
  const solde = solde_releve === '' || solde_releve === null || solde_releve === undefined
    ? NaN : Number(solde_releve);
  if (!Number.isInteger(solde)) {
    throw new ErreurConformite(
      'MONTANT_NON_ENTIER',
      `Solde du releve invalide : le franc Pacifique ne comporte pas de decimale (recu "${solde_releve}").`,
      { solde_releve },
    );
  }
  if (un('SELECT id FROM rapprochements WHERE compte = $c AND date_arrete = $d', { c: compte, d: date_arrete })) {
    throw new ErreurConformite('RAPPROCHEMENT_EXISTANT', `Un rapprochement du ${date_arrete} existe deja pour ce compte.`);
  }
  const r = exec(
    `INSERT INTO rapprochements (compte, date_arrete, solde_releve, cree_le, cree_par)
     VALUES ($c, $d, $s, $now, $u)`,
    { c: compte, d: date_arrete, s: solde, now: new Date().toISOString(), u: utilisateur.identifiant },
  );
  const id = Number(r.lastInsertRowid);
  tracer(utilisateur.identifiant, 'OUVERTURE_RAPPROCHEMENT', 'rapprochement', id, `${compte} au ${date_arrete}`);
  return etatRapprochement(id);
}

export function pointer(rapprochementId, ligneIds, pointe, utilisateur) {
  const r = un('SELECT * FROM rapprochements WHERE id = $id', { id: rapprochementId });
  if (!r) throw new ErreurConformite('INTROUVABLE', 'Rapprochement introuvable.');
  if (r.statut === 'CLOS') throw new ErreurConformite('RAPPROCHEMENT_CLOS', 'Rapprochement clos : pointage figé.');

  return transaction(() => {
    for (const id of ligneIds) {
      const l = un(
        `SELECT l.id FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
         WHERE l.id = $id AND l.compte = $c AND e.statut <> 'BROUILLON'
           AND e.date_ecriture <= $d`,
        { id, c: r.compte, d: r.date_arrete },
      );
      if (!l) throw new ErreurConformite('LIGNE_HORS_PERIMETRE', `La ligne ${id} n appartient pas a ce rapprochement.`);
      exec('UPDATE lignes SET rapprochement_id = $r WHERE id = $id', { r: pointe ? rapprochementId : null, id });
    }
    tracer(utilisateur.identifiant, pointe ? 'POINTAGE' : 'DEPOINTAGE', 'rapprochement', rapprochementId, `${ligneIds.length} ligne(s)`);
    return etatRapprochement(rapprochementId);
  });
}

export function etatRapprochement(id) {
  const r = un('SELECT * FROM rapprochements WHERE id = $id', { id });
  if (!r) return null;

  const mouvements = tous(
    `SELECT l.id, l.libelle, l.debit, l.credit, l.rapprochement_id,
            e.date_ecriture, e.journal, e.numero, e.piece_ref
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON' AND e.date_ecriture <= $d
       AND (l.rapprochement_id IS NULL OR l.rapprochement_id = $id)
     ORDER BY e.date_ecriture, e.id`,
    { c: r.compte, d: r.date_arrete, id },
  );

  const pointes = mouvements.filter((m) => m.rapprochement_id === id);
  const enSuspens = mouvements.filter((m) => m.rapprochement_id === null);

  const soldeComptable = un(
    `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS s
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON' AND e.date_ecriture <= $d`,
    { c: r.compte, d: r.date_arrete },
  ).s;

  const suspens = enSuspens.reduce((s, m) => s + m.debit - m.credit, 0);
  const soldeRapproche = soldeComptable - suspens;

  return {
    ...r,
    solde_comptable: soldeComptable,
    total_suspens: suspens,
    solde_rapproche: soldeRapproche,
    ecart: soldeRapproche - r.solde_releve,
    justifie: soldeRapproche === r.solde_releve,
    pointes,
    en_suspens: enSuspens,
  };
}

export function cloreRapprochement(id, utilisateur) {
  const etat = etatRapprochement(id);
  if (!etat) throw new ErreurConformite('INTROUVABLE', 'Rapprochement introuvable.');
  if (etat.statut === 'CLOS') throw new ErreurConformite('RAPPROCHEMENT_CLOS', 'Rapprochement deja clos.');

  // Continuite : le solde d'ouverture de la periode n'est etabli que si la
  // periode precedente a elle-meme ete rapprochee et close.
  const anterieures = periodesAnterieuresNonCouvertes(etat.compte, etat.date_arrete);
  if (anterieures.length) {
    throw new ErreurConformite(
      'RAPPROCHEMENT_ANTERIEUR_MANQUANT',
      `Compte ${etat.compte} : ${anterieures.length} periode(s) anterieure(s) sans rapprochement clos `
      + `(${anterieures.map((p) => p.libelle).join(', ')}). `
      + 'Un arrete ne peut pas etre justifie tant que le precedent ne l est pas.',
      { periodes: anterieures },
    );
  }

  if (!etat.justifie) {
    throw new ErreurConformite(
      'RAPPROCHEMENT_NON_JUSTIFIE',
      `Ecart non justifie de ${etat.ecart} XPF entre le releve et la comptabilite. `
      + 'Le rapprochement ne peut pas etre clos en l etat.',
      { ecart: etat.ecart },
    );
  }
  exec(`UPDATE rapprochements SET statut = 'CLOS', clos_le = $d WHERE id = $id`, { d: new Date().toISOString(), id });
  tracer(utilisateur.identifiant, 'CLOTURE_RAPPROCHEMENT', 'rapprochement', id, `${etat.compte} au ${etat.date_arrete}`);
  return etatRapprochement(id);
}

export function listerRapprochements() {
  return tous(
    `SELECT r.*, c.intitule, c.nature FROM rapprochements r
     JOIN comptes c ON c.numero = r.compte ORDER BY r.date_arrete DESC`,
  );
}

/** Etat de surveillance : periodes exigibles non rapprochees, tous comptes. */
export function surveillance(options = {}) {
  return relancesRapprochements(options);
}

/** Calendrier des periodes d'un compte rapprochable. */
export function calendrier(compte, options = {}) {
  return calendrierRapprochements(compte, options);
}
