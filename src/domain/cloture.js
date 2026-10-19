import { un, tous, exec, transaction } from '../db.js';
import { tracer } from '../audit.js';
import { ErreurConformite, etatRepresentationFonds } from './controles.js';
import { verifierChaineEcritures, creerBrouillon, valider } from './ecritures.js';
import { sha256 } from '../hash.js';

/**
 * Cloture de l'exercice.
 *
 * La cloture est irreversible : elle scelle l'exercice par une empreinte,
 * interdit toute ecriture ulterieure a cette periode et genere les a-nouveaux
 * de l'exercice suivant. Elle n'est acceptee que si l'exercice est en etat
 * d'etre presente a un controle.
 */

export function ouvrirExercice({ libelle, date_debut, date_fin }, utilisateur) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_debut) || !/^\d{4}-\d{2}-\d{2}$/.test(date_fin)) {
    throw new ErreurConformite('DATE_INVALIDE', 'Dates attendues au format AAAA-MM-JJ.');
  }
  const chevauche = un(
    `SELECT libelle FROM exercices
     WHERE NOT (date_fin < $debut OR date_debut > $fin)`,
    { debut: date_debut, fin: date_fin },
  );
  if (chevauche) {
    throw new ErreurConformite('EXERCICES_CHEVAUCHANTS', `La periode chevauche l exercice ${chevauche.libelle}.`);
  }
  const r = exec(
    'INSERT INTO exercices (libelle, date_debut, date_fin) VALUES ($l, $d, $f)',
    { l: libelle, d: date_debut, f: date_fin },
  );
  tracer(utilisateur.identifiant, 'OUVERTURE_EXERCICE', 'exercice', r.lastInsertRowid, libelle);
  return un('SELECT * FROM exercices WHERE id = $id', { id: r.lastInsertRowid });
}

/** Diagnostic prealable : ce qui empeche encore la cloture. */
export function controlePreCloture(exerciceId) {
  const ex = un('SELECT * FROM exercices WHERE id = $id', { id: exerciceId });
  if (!ex) throw new ErreurConformite('INTROUVABLE', 'Exercice introuvable.');

  const obstacles = [];

  const brouillons = un(
    `SELECT COUNT(*) AS n FROM ecritures WHERE exercice_id = $id AND statut = 'BROUILLON'`,
    { id: exerciceId },
  ).n;
  if (brouillons) obstacles.push({ code: 'BROUILLONS', message: `${brouillons} ecriture(s) en brouillon a comptabiliser ou supprimer.` });

  const attente = tous(`SELECT * FROM v_soldes WHERE nature = 'ATTENTE' AND solde <> 0`);
  for (const c of attente) {
    obstacles.push({ code: 'COMPTE_ATTENTE', message: `Compte d attente ${c.numero} non solde (${c.solde} XPF).` });
  }

  const debiteurs = tous('SELECT * FROM v_soldes_dossiers WHERE solde > 0');
  for (const d of debiteurs) {
    obstacles.push({ code: 'CLIENT_DEBITEUR', message: `Dossier ${d.reference} debiteur de ${d.solde} XPF.` });
  }

  const fonds = etatRepresentationFonds();
  if (!fonds.conforme) {
    obstacles.push({ code: 'FONDS_NON_REPRESENTES', message: `Fonds clients non representes : deficit de ${-fonds.ecart} XPF.` });
  }

  const chaine = verifierChaineEcritures();
  if (!chaine.valide) {
    obstacles.push({ code: 'CHAINE_ALTEREE', message: `Chaine d inalterabilite rompue (ecriture ${chaine.ecriture_id} : ${chaine.motif}).` });
  }

  const comptesRapprochables = tous(`SELECT numero, intitule FROM comptes WHERE rapprochable = 1 AND actif = 1`);
  for (const c of comptesRapprochables) {
    const dernier = un(
      `SELECT date_arrete FROM rapprochements
       WHERE compte = $c AND statut = 'CLOS' AND date_arrete <= $fin
       ORDER BY date_arrete DESC LIMIT 1`,
      { c: c.numero, fin: ex.date_fin },
    );
    if (!dernier || dernier.date_arrete < ex.date_fin) {
      obstacles.push({
        code: 'RAPPROCHEMENT_MANQUANT',
        message: `Compte ${c.numero} : aucun rapprochement bancaire clos au ${ex.date_fin}.`,
      });
    }
  }

  return { exercice: ex, obstacles, pret: obstacles.length === 0 };
}

/**
 * Clot l'exercice et genere les a-nouveaux sur l'exercice suivant.
 * Les comptes de gestion (classes 6 et 7) sont soldes par le resultat ;
 * les comptes de bilan sont repris pour leur solde.
 */
export function cloturerExercice(exerciceId, utilisateur, { forcer = false } = {}) {
  return transaction(() => {
    const diag = controlePreCloture(exerciceId);
    if (!diag.pret && !forcer) {
      throw new ErreurConformite('CLOTURE_IMPOSSIBLE', 'L exercice ne remplit pas les conditions de cloture.', { obstacles: diag.obstacles });
    }
    const ex = diag.exercice;
    if (ex.statut === 'CLOS') throw new ErreurConformite('DEJA_CLOS', `L exercice ${ex.libelle} est deja clos.`);

    const soldes = tous(
      `SELECT c.numero, c.classe,
              IFNULL(SUM(l.debit - l.credit), 0) AS solde
       FROM comptes c
       JOIN lignes    l ON l.compte = c.numero
       JOIN ecritures e ON e.id = l.ecriture_id
       WHERE e.statut <> 'BROUILLON' AND e.exercice_id = $ex
       GROUP BY c.numero HAVING solde <> 0`,
      { ex: exerciceId },
    );

    const resultat = -soldes.filter((s) => s.classe >= 6).reduce((t, s) => t + s.solde, 0);
    const reprises = soldes.filter((s) => s.classe <= 5);

    const suivant = un(
      `SELECT * FROM exercices WHERE date_debut > $fin AND statut = 'OUVERT' ORDER BY date_debut LIMIT 1`,
      { fin: ex.date_fin },
    );

    let aNouveau = null;
    if (suivant && reprises.length) {
      const lignes = reprises.map((s) => ({
        compte: s.numero,
        libelle: `A nouveau ${ex.libelle}`,
        debit: s.solde > 0 ? s.solde : 0,
        credit: s.solde < 0 ? -s.solde : 0,
      }));
      if (resultat !== 0) {
        lignes.push({
          compte: resultat >= 0 ? '120000' : '129000',
          libelle: `Resultat de l exercice ${ex.libelle}`,
          debit: resultat >= 0 ? 0 : -resultat,
          credit: resultat >= 0 ? resultat : 0,
        });
      }
      aNouveau = genererANouveau(suivant, lignes, utilisateur);
    }

    const empreinte = sha256(JSON.stringify({
      exercice: ex.libelle,
      soldes: soldes.map((s) => [s.numero, s.solde]),
      resultat,
      chaine: verifierChaineEcritures().hash_final,
    }));

    exec(
      `UPDATE exercices SET statut = 'CLOS', cloture_le = $d, cloture_par = $u, cloture_hash = $h WHERE id = $id`,
      { d: new Date().toISOString(), u: utilisateur.identifiant, h: empreinte, id: exerciceId },
    );
    tracer(utilisateur.identifiant, 'CLOTURE_EXERCICE', 'exercice', exerciceId, `${ex.libelle} resultat=${resultat} hash=${empreinte.slice(0, 16)}`);

    return {
      exercice: un('SELECT * FROM exercices WHERE id = $id', { id: exerciceId }),
      resultat,
      a_nouveau: aNouveau,
      obstacles_ignores: forcer ? diag.obstacles : [],
    };
  });
}

function genererANouveau(exercice, lignes, utilisateur) {
  const brouillon = creerBrouillon(
    {
      journal: 'AN',
      date_ecriture: exercice.date_debut,
      libelle: `A nouveaux au ${exercice.date_debut}`,
      piece_ref: 'AN',
      lignes,
    },
    utilisateur,
  );
  return valider(brouillon.id, utilisateur);
}
