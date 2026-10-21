import { ouvrirBase, un, exec, transaction, fermerBase } from './db.js';
import { PLAN_COMPTABLE, JOURNAUX } from './pcn.js';
import { creerUtilisateur } from './auth.js';
import { ouvrirExercice } from './domain/cloture.js';
import { tracer } from './audit.js';
import { randomBytes } from 'node:crypto';

/**
 * Installation initiale : plan comptable notarial, journaux, exercice courant
 * et compte notaire. Le script est rejouable : il ne recree pas l'existant.
 */
export function initialiser({
  denomination = 'Office notarial',
  notaire = 'Maitre',
  ridet = '',
  adresse = '',
  motDePasse = null,
  annee = new Date().getFullYear(),
} = {}) {
  ouvrirBase();
  const mdp = motDePasse ?? randomBytes(9).toString('base64url');

  return transaction(() => {
    if (!un('SELECT id FROM office WHERE id = 1')) {
      exec(
        `INSERT INTO office (id, denomination, notaire_titulaire, adresse, ridet, cree_le)
         VALUES (1, $d, $n, $a, $r, $c)`,
        { d: denomination, n: notaire, a: adresse, r: ridet, c: new Date().toISOString() },
      );
    }

    for (const c of PLAN_COMPTABLE) {
      if (un('SELECT numero FROM comptes WHERE numero = $n', { n: c.numero })) {
        // Colonne ajoutee apres coup : on aligne le marqueur sur le plan
        // comptable de reference, sans toucher au reste de la fiche.
        exec('UPDATE comptes SET rubrique = $r WHERE numero = $n AND rubrique <> $r',
          { r: c.rubrique, n: c.numero });
        continue;
      }
      exec(
        `INSERT INTO comptes (numero, intitule, classe, type, nature, sens_normal, lettrable, rapprochable, collectif, rubrique)
         VALUES ($numero, $intitule, $classe, $type, $nature, $sens_normal, $lettrable, $rapprochable, $collectif, $rubrique)`,
        c,
      );
    }

    for (const j of JOURNAUX) {
      if (un('SELECT code FROM journaux WHERE code = $c', { c: j.code })) continue;
      exec(
        `INSERT INTO journaux (code, libelle, type, compte_contrepartie, piece_unique)
         VALUES ($code, $libelle, $type, $compte_contrepartie, $piece_unique)`,
        j,
      );
    }

    const systeme = { identifiant: 'systeme', role: 'NOTAIRE' };
    let exercice = un('SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1');
    if (!exercice) {
      exercice = ouvrirExercice(
        { libelle: String(annee), date_debut: `${annee}-01-01`, date_fin: `${annee}-12-31` },
        systeme,
      );
    }

    let compte = null;
    if (!un('SELECT id FROM utilisateurs LIMIT 1')) {
      creerUtilisateur({ identifiant: 'notaire', nom: notaire, role: 'NOTAIRE', motDePasse: mdp });
      compte = { identifiant: 'notaire', motDePasse: mdp };
    }

    tracer('systeme', 'INITIALISATION', 'office', 1, denomination);
    return {
      office: un('SELECT * FROM office WHERE id = 1'),
      comptes: un('SELECT COUNT(*) AS n FROM comptes').n,
      journaux: un('SELECT COUNT(*) AS n FROM journaux').n,
      exercice,
      compte_initial: compte,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (nom, def) => {
    const i = process.argv.indexOf(`--${nom}`);
    return i > -1 ? process.argv[i + 1] : def;
  };
  const r = initialiser({
    denomination: arg('office', 'Office notarial'),
    notaire: arg('notaire', 'Maitre'),
    ridet: arg('ridet', ''),
    adresse: arg('adresse', ''),
    motDePasse: arg('mdp', null),
  });
  console.log(`Office        : ${r.office.denomination}`);
  console.log(`Plan comptable: ${r.comptes} comptes, ${r.journaux} journaux`);
  console.log(`Exercice      : ${r.exercice.libelle} (${r.exercice.date_debut} au ${r.exercice.date_fin})`);
  if (r.compte_initial) {
    console.log('');
    console.log('Compte notaire cree :');
    console.log(`  identifiant  : ${r.compte_initial.identifiant}`);
    console.log(`  mot de passe : ${r.compte_initial.motDePasse}`);
    console.log('  (a changer des la premiere connexion)');
  }
  fermerBase();
}
