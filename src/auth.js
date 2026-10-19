import { un, exec, tous } from './db.js';
import { hacherMotDePasse, verifierMotDePasse, jetonAleatoire } from './hash.js';
import { tracer } from './audit.js';
import { ErreurConformite } from './domain/controles.js';

const DUREE_SESSION_H = 12;

/**
 * Droits par role. L'inspecteur dispose d'un acces en lecture integral :
 * il doit pouvoir tout consulter sans jamais pouvoir modifier quoi que ce soit.
 */
export const DROITS = {
  NOTAIRE: ['lire', 'saisir', 'valider', 'contrepasser', 'clore', 'administrer'],
  COMPTABLE: ['lire', 'saisir', 'valider', 'contrepasser', 'clore'],
  CLERC: ['lire', 'saisir'],
  INSPECTEUR: ['lire'],
};

export const peut = (utilisateur, droit) => DROITS[utilisateur?.role]?.includes(droit) ?? false;

export function exigerDroit(utilisateur, droit) {
  if (!peut(utilisateur, droit)) {
    throw new ErreurConformite(
      'DROIT_INSUFFISANT',
      `Le role ${utilisateur?.role ?? 'anonyme'} ne permet pas d effectuer cette operation (${droit}).`,
    );
  }
}

export function creerUtilisateur({ identifiant, nom, role, motDePasse }) {
  if (!DROITS[role]) throw new ErreurConformite('ROLE_INVALIDE', `Role ${role} inconnu.`);
  if (String(motDePasse ?? '').length < 10) {
    throw new ErreurConformite('MDP_FAIBLE', 'Le mot de passe doit comporter au moins 10 caracteres.');
  }
  const { hash, sel } = hacherMotDePasse(motDePasse);
  const r = exec(
    `INSERT INTO utilisateurs (identifiant, nom, role, mdp_hash, mdp_sel, cree_le)
     VALUES ($i, $n, $r, $h, $s, $d)`,
    { i: identifiant, n: nom, r: role, h: hash, s: sel, d: new Date().toISOString() },
  );
  tracer('systeme', 'CREATION_UTILISATEUR', 'utilisateur', r.lastInsertRowid, `${identifiant} (${role})`);
  return un('SELECT id, identifiant, nom, role FROM utilisateurs WHERE id = $id', { id: r.lastInsertRowid });
}

export function connecter(identifiant, motDePasse) {
  const u = un('SELECT * FROM utilisateurs WHERE identifiant = $i AND actif = 1', { i: identifiant });
  if (!u || !verifierMotDePasse(motDePasse, u.mdp_sel, u.mdp_hash)) {
    tracer(identifiant || 'inconnu', 'ECHEC_CONNEXION', 'session', null, '');
    throw new ErreurConformite('IDENTIFIANTS_INVALIDES', 'Identifiant ou mot de passe incorrect.');
  }
  const jeton = jetonAleatoire();
  const expire = new Date(Date.now() + DUREE_SESSION_H * 3600_000).toISOString();
  exec(
    'INSERT INTO sessions (jeton, utilisateur_id, ouvert_le, expire_le) VALUES ($j, $u, $o, $e)',
    { j: jeton, u: u.id, o: new Date().toISOString(), e: expire },
  );
  tracer(u.identifiant, 'CONNEXION', 'session', u.id, '');
  return { jeton, expire_le: expire, utilisateur: { id: u.id, identifiant: u.identifiant, nom: u.nom, role: u.role } };
}

export function utilisateurDuJeton(jeton) {
  if (!jeton) return null;
  const s = un(
    `SELECT u.id, u.identifiant, u.nom, u.role FROM sessions s
     JOIN utilisateurs u ON u.id = s.utilisateur_id
     WHERE s.jeton = $j AND s.expire_le > $now AND u.actif = 1`,
    { j: jeton, now: new Date().toISOString() },
  );
  return s ?? null;
}

export function deconnecter(jeton, utilisateur) {
  exec('DELETE FROM sessions WHERE jeton = $j', { j: jeton });
  if (utilisateur) tracer(utilisateur.identifiant, 'DECONNEXION', 'session', utilisateur.id, '');
}

export const listerUtilisateurs = () =>
  tous('SELECT id, identifiant, nom, role, actif, cree_le FROM utilisateurs ORDER BY identifiant');
