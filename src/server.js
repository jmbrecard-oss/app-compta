import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

import { ouvrirBase, un, tous, RACINE } from './db.js';
import { initialiser } from './init.js';
import { connecter, deconnecter, utilisateurDuJeton, exigerDroit, listerUtilisateurs, creerUtilisateur } from './auth.js';
import { ErreurConformite, anomalies, etatRepresentationFonds, etatComptesDebiteurs, etatDeboursAReverser } from './domain/controles.js';
import * as Ecritures from './domain/ecritures.js';
import * as Dossiers from './domain/dossiers.js';
import { etatPlacements } from './domain/placements.js';
import * as Rapprochement from './domain/rapprochement.js';
import * as Lettrage from './domain/lettrage.js';
import * as Cloture from './domain/cloture.js';
import * as Tarif from './domain/tarif.js';
import * as Tgc from './domain/tgc.js';
import * as Etats from './reports/etats.js';
import { registreDesEspeces } from './domain/especes.js';
import { genererFEC, nomFichierFEC, versCSV } from './reports/fec.js';
import { genererArchive, serialiserArchive, nomFichierArchive } from './reports/archive.js';
import { verifierArchive } from './reports/verification-archive.js';
import { tracer, verifierChaineAudit, journalAudit } from './audit.js';

const PORT = Number(process.env.PORT ?? 7420);
const HOTE = process.env.HOTE ?? '127.0.0.1';

// --------------------------------------------------------------- utilitaires

const json = (res, code, corps) => {
  const texte = JSON.stringify(corps, (_, v) => (typeof v === 'bigint' ? Number(v) : v));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(texte);
};

const texteBrut = (res, nomFichier, contenu, type = 'text/plain; charset=utf-8') => {
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${nomFichier}"`,
  });
  res.end(contenu);
};

async function corpsJSON(req) {
  const morceaux = [];
  let taille = 0;
  for await (const m of req) {
    taille += m.length;
    if (taille > 2_000_000) throw new ErreurConformite('CORPS_TROP_VOLUMINEUX', 'Requete trop volumineuse.');
    morceaux.push(m);
  }
  if (!morceaux.length) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
  } catch {
    throw new ErreurConformite('JSON_INVALIDE', 'Corps de requete illisible.');
  }
}

const TYPES_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function servirStatique(res, chemin) {
  const relatif = normalize(chemin === '/' ? '/index.html' : chemin).replace(/^(\.\.[/\\])+/, '');
  const fichier = join(RACINE, 'public', relatif);
  if (!fichier.startsWith(join(RACINE, 'public'))) {
    res.writeHead(403).end('Interdit');
    return;
  }
  try {
    const contenu = await readFile(fichier);
    res.writeHead(200, { 'content-type': TYPES_MIME[extname(fichier)] ?? 'application/octet-stream' });
    res.end(contenu);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Page introuvable');
  }
}

// ------------------------------------------------------------------- routage

const routes = [];
const route = (methode, motif, droit, gestionnaire) => {
  const parametres = [];
  const regex = new RegExp(
    '^' + motif.replace(/:([a-z_]+)/g, (_, n) => { parametres.push(n); return '([^/]+)'; }) + '$',
  );
  routes.push({ methode, regex, parametres, droit, gestionnaire });
};

/** Contexte : { utilisateur, params, query, corps } */

route('POST', '/api/connexion', null, async ({ corps }) => connecter(corps.identifiant, corps.motDePasse));

route('POST', '/api/deconnexion', 'lire', async ({ utilisateur, jeton }) => {
  deconnecter(jeton, utilisateur);
  return { deconnecte: true };
});

route('GET', '/api/moi', 'lire', async ({ utilisateur }) => utilisateur);

route('GET', '/api/office', 'lire', async () => ({
  office: un('SELECT * FROM office WHERE id = 1'),
  exercices: tous('SELECT * FROM exercices ORDER BY date_debut DESC'),
}));

route('GET', '/api/tableau-de-bord', 'lire', async () => {
  const exercice = un(`SELECT * FROM exercices WHERE statut = 'OUVERT' ORDER BY date_debut DESC LIMIT 1`);
  const periode = exercice ? { depuis: exercice.date_debut, jusqu: exercice.date_fin } : {};
  const resultat = Etats.compteDeResultat(periode);
  return {
    exercice,
    representation_fonds: etatRepresentationFonds(),
    anomalies: anomalies(),
    resultat: { produits: resultat.total_produits, charges: resultat.total_charges, resultat: resultat.resultat },
    dossiers: {
      ouverts: un(`SELECT COUNT(*) AS n FROM dossiers WHERE statut = 'OUVERT'`).n,
      debiteurs: un('SELECT COUNT(*) AS n FROM v_soldes_dossiers WHERE solde > 0').n,
    },
    tresorerie: tous(
      `SELECT numero, intitule, nature, solde FROM v_soldes
       WHERE nature IN ('BANQUE_OFFICE','DEPOT_FONDS_CLIENTS','CAISSE') ORDER BY numero`,
    ),
    brouillons: un(`SELECT COUNT(*) AS n FROM ecritures WHERE statut = 'BROUILLON'`).n,
    rapprochements: Rapprochement.surveillance(),
    chaine: Ecritures.verifierChaineEcritures(),
  };
});

// ------------------------------------------------------------------ referentiel

route('GET', '/api/comptes', 'lire', async ({ query }) => tous(
  `SELECT c.*, v.solde FROM comptes c LEFT JOIN v_soldes v ON v.numero = c.numero
   WHERE ($q IS NULL OR c.numero LIKE $q OR c.intitule LIKE $q)
     AND ($nature IS NULL OR c.nature = $nature)
   ORDER BY c.numero`,
  { q: query.q ? `%${query.q}%` : null, nature: query.nature ?? null },
));

route('GET', '/api/journaux', 'lire', async () => tous('SELECT * FROM journaux WHERE actif = 1 ORDER BY code'));

route('GET', '/api/utilisateurs', 'administrer', async () => listerUtilisateurs());
route('POST', '/api/utilisateurs', 'administrer', async ({ corps }) => creerUtilisateur(corps));

// --------------------------------------------------------------------- dossiers

route('GET', '/api/dossiers', 'lire', async ({ query }) => Dossiers.listerDossiers(query));
route('POST', '/api/dossiers', 'saisir', async ({ corps, utilisateur }) => Dossiers.ouvrirDossier(corps, utilisateur));
route('GET', '/api/dossiers/:id', 'lire', async ({ params }) => Dossiers.lireDossier(Number(params.id)));
route('POST', '/api/dossiers/:id/clore', 'valider', async ({ params, utilisateur }) =>
  Dossiers.cloreDossier(Number(params.id), utilisateur));

// -------------------------------------------------------------------- ecritures

route('GET', '/api/ecritures', 'lire', async ({ query }) => Ecritures.rechercher({
  ...query,
  dossier_id: query.dossier_id ? Number(query.dossier_id) : undefined,
  limite: query.limite ? Number(query.limite) : undefined,
}));
route('POST', '/api/ecritures', 'saisir', async ({ corps, utilisateur }) => Ecritures.creerBrouillon(corps, utilisateur));
route('GET', '/api/ecritures/:id', 'lire', async ({ params }) => Ecritures.lire(Number(params.id)));
route('PUT', '/api/ecritures/:id', 'saisir', async ({ params, corps, utilisateur }) =>
  Ecritures.modifierBrouillon(Number(params.id), corps, utilisateur));
route('DELETE', '/api/ecritures/:id', 'saisir', async ({ params, utilisateur }) =>
  Ecritures.supprimerBrouillon(Number(params.id), utilisateur));
route('POST', '/api/ecritures/:id/valider', 'valider', async ({ params, utilisateur }) =>
  Ecritures.valider(Number(params.id), utilisateur));
route('POST', '/api/ecritures/:id/contrepasser', 'contrepasser', async ({ params, corps, utilisateur }) =>
  Ecritures.contrepasser(Number(params.id), corps, utilisateur));

// ----------------------------------------------------------- taxe des actes

route('GET', '/api/tarif/bareme', 'lire', async () => {
  const b = Tarif.baremeCourant();
  return {
    ...b.meta,
    arrondi: b.arrondi,
    empreinte: b.empreinte,
    fichier: b.origine,
    fictif: Tarif.baremeFictif(b),
    prestations: b.prestations,
  };
});

route('POST', '/api/tarif/simulation', 'lire', async ({ corps }) => Tarif.simulerTaxe(corps));

route('GET', '/api/taxes', 'lire', async ({ query }) => Tarif.listerTaxes({
  ...query,
  dossier_id: query.dossier_id ? Number(query.dossier_id) : undefined,
}));
route('POST', '/api/taxes', 'saisir', async ({ corps, utilisateur }) => Tarif.creerTaxe(corps, utilisateur));
route('GET', '/api/taxes/:id', 'lire', async ({ params }) => Tarif.lireTaxe(Number(params.id)));
route('DELETE', '/api/taxes/:id', 'saisir', async ({ params, utilisateur }) =>
  Tarif.supprimerTaxe(Number(params.id), utilisateur));
route('POST', '/api/taxes/:id/arreter', 'valider', async ({ params, utilisateur }) =>
  Tarif.arreterTaxe(Number(params.id), utilisateur));
route('POST', '/api/taxes/:id/comptabiliser', 'valider', async ({ params, corps, utilisateur }) =>
  Tarif.comptabiliserTaxe(Number(params.id), utilisateur, corps));

// --------------------------------------------------------------------- lettrage

route('GET', '/api/comptes/:numero/non-lettrees', 'lire', async ({ params }) =>
  Lettrage.lignesNonLettrees(params.numero));
route('POST', '/api/lettrage', 'valider', async ({ corps, utilisateur }) =>
  Lettrage.lettrer(corps.lignes.map(Number), utilisateur));
route('POST', '/api/delettrage', 'valider', async ({ corps, utilisateur }) =>
  Lettrage.delettrer(corps.compte, corps.lettrage, utilisateur));

// --------------------------------------------------------------- rapprochements

route('GET', '/api/rapprochements', 'lire', async () => Rapprochement.listerRapprochements());
route('POST', '/api/rapprochements', 'saisir', async ({ corps, utilisateur }) =>
  Rapprochement.ouvrirRapprochement(corps, utilisateur));
// Les routes nommees precedent la route parametree : le routeur retient la premiere correspondance.
route('GET', '/api/rapprochements/surveillance', 'lire', async ({ query }) => Rapprochement.surveillance(query));
route('GET', '/api/rapprochements/calendrier/:numero', 'lire', async ({ params, query }) =>
  Rapprochement.calendrier(params.numero, {
    ...query,
    periodicite_mois: query.periodicite_mois ? Number(query.periodicite_mois) : undefined,
    delai_jours: query.delai_jours ? Number(query.delai_jours) : undefined,
  }));
route('GET', '/api/rapprochements/:id', 'lire', async ({ params }) =>
  Rapprochement.etatRapprochement(Number(params.id)));
route('POST', '/api/rapprochements/:id/pointer', 'saisir', async ({ params, corps, utilisateur }) =>
  Rapprochement.pointer(Number(params.id), corps.lignes.map(Number), corps.pointe !== false, utilisateur));
route('POST', '/api/rapprochements/:id/clore', 'valider', async ({ params, utilisateur }) =>
  Rapprochement.cloreRapprochement(Number(params.id), utilisateur));

// -------------------------------------------------------------------- exercices

route('POST', '/api/exercices', 'administrer', async ({ corps, utilisateur }) =>
  Cloture.ouvrirExercice(corps, utilisateur));
route('GET', '/api/exercices/:id/pre-cloture', 'lire', async ({ params }) =>
  Cloture.controlePreCloture(Number(params.id)));
route('POST', '/api/exercices/:id/cloturer', 'clore', async ({ params, corps, utilisateur }) =>
  Cloture.cloturerExercice(Number(params.id), utilisateur, { forcer: corps.forcer === true }));

// ------------------------------------------------------------------------ etats

route('GET', '/api/etats/balance', 'lire', async ({ query }) => Etats.balance(query));
route('GET', '/api/etats/grand-livre/:numero', 'lire', async ({ params, query }) =>
  Etats.grandLivre(params.numero, query));
route('GET', '/api/etats/journal', 'lire', async ({ query }) => Etats.journal(query.code ?? null, query));
route('GET', '/api/etats/resultat', 'lire', async ({ query }) => Etats.compteDeResultat(query));
route('GET', '/api/etats/bilan', 'lire', async ({ query }) => Etats.bilan(query));
route('GET', '/api/etats/comptes-clients', 'lire', async () => Etats.etatComptesClients());
route('GET', '/api/etats/representation-fonds', 'lire', async () => etatRepresentationFonds());
route('GET', '/api/etats/comptes-debiteurs', 'lire', async () => etatComptesDebiteurs());
route('GET', '/api/etats/taxes', 'lire', async ({ query }) => Etats.etatTaxes({
  dossier_id: query.dossier_id ? Number(query.dossier_id) : undefined,
}));
route('GET', '/api/etats/compte-definitif/:id', 'lire', async ({ params }) =>
  Etats.compteDefinitif(Number(params.id)));
route('GET', '/api/etats/debours-a-reverser', 'lire', async () => etatDeboursAReverser());
route('GET', '/api/etats/placements', 'lire', async () => etatPlacements());
route('GET', '/api/etats/inspection', 'lire', async ({ query }) => Etats.dossierInspection(query));
route('GET', '/api/etats/registre-especes', 'lire', async ({ query }) => registreDesEspeces(query));

// ------------------------------------------------------------------------ TGC

route('GET', '/api/etats/tgc', 'lire', async ({ query }) => Tgc.etatTgc(query));
route('GET', '/api/etats/tgc/periodes', 'lire', async ({ query }) => ({
  periodes: Tgc.periodesTgc({
    jusqu: query.jusqu ?? null,
    limite: query.limite ? Number(query.limite) : undefined,
  }),
}));
route('GET', '/api/tgc/liquidation', 'lire', async ({ query }) => ({
  proposition: Tgc.propositionLiquidationTgc(query),
}));
route('POST', '/api/tgc/liquidation', 'saisir', async ({ corps, utilisateur }) => {
  const proposition = Tgc.propositionLiquidationTgc(corps);
  if (!proposition) {
    throw new ErreurConformite(
      'TGC_RIEN_A_LIQUIDER',
      'Aucune TGC collectee ne reste a declarer a cette date.',
    );
  }
  return Ecritures.creerBrouillon(proposition, utilisateur);
});

// --------------------------------------------------------- controles et audit

route('GET', '/api/controles/anomalies', 'lire', async () => anomalies());
route('GET', '/api/controles/chaine', 'lire', async () => ({
  ecritures: Ecritures.verifierChaineEcritures(),
  audit: verifierChaineAudit(),
}));
/**
 * Contre-epreuve immediate : l'application edite une archive et la soumet au
 * verificateur independant, celui-la meme qu'un inspecteur lancerait sur le
 * fichier recu. Si les deux divergeaient, l'archive ne vaudrait rien.
 *
 * Le scelle n'est pas rendu ici : il depend de l'instant d'edition et figure
 * dans le fichier exporte. La racine de la chaine, elle, est stable : c'est
 * la valeur a deposer hors de l'archive.
 */
route('GET', '/api/controles/archive', 'lire', async ({ utilisateur }) => {
  const archive = genererArchive({ edite_par: utilisateur.identifiant });
  const r = verifierArchive(archive);
  return {
    nom_fichier: nomFichierArchive(),
    valide: r.valide,
    racine_chaine: r.racine_chaine,
    racine_audit: r.racine_audit,
    volumetrie: r.volumetrie,
    controles: r.controles,
    anomalies: r.anomalies,
  };
});

route('GET', '/api/audit', 'lire', async ({ query }) => journalAudit({
  ...query,
  limite: query.limite ? Number(query.limite) : undefined,
}));

// -------------------------------------------------------------------- exports

route('GET', '/api/export/fec', 'lire', async ({ query, res }) => {
  const exercice = query.exercice_id
    ? un('SELECT * FROM exercices WHERE id = $id', { id: Number(query.exercice_id) })
    : un(`SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1`);
  const contenu = genererFEC({
    exercice_id: exercice?.id ?? null,
    depuis: query.depuis ?? null,
    jusqu: query.jusqu ?? null,
  });
  texteBrut(res, nomFichierFEC(exercice), contenu);
  return null;
});

/**
 * Archive scellee : la chaine complete des ecritures comptabilisees, le plan
 * comptable, les dossiers, les exercices et le journal d'audit, sous un scelle
 * unique. L'edition est elle-meme tracee : le scelle delivre figure ainsi dans
 * la piste d'audit que reprendront les archives suivantes.
 *
 * La trace est posee avant l'envoi, jamais apres : l'archive est deja
 * constituee en memoire, son contenu n'en bouge donc pas, et un echec
 * d'ecriture du journal d'audit doit encore pouvoir etre rendu en erreur HTTP.
 */
route('GET', '/api/export/archive.json', 'lire', async ({ utilisateur, res }) => {
  const archive = genererArchive({ edite_par: utilisateur.identifiant });
  const racine = verifierArchive(archive).racine_chaine;
  tracer(
    utilisateur.identifiant, 'EDITION_ARCHIVE', 'archive', null,
    `scelle=${archive.scelle} racine=${racine} ecritures=${archive.contenu.ecritures.length}`,
  );
  texteBrut(res, nomFichierArchive(), serialiserArchive(archive), 'application/json; charset=utf-8');
  return null;
});

route('GET', '/api/export/balance.csv', 'lire', async ({ query, res }) => {
  const b = Etats.balance(query);
  const contenu = versCSV(b.lignes, [
    { titre: 'Compte', valeur: 'numero' },
    { titre: 'Intitule', valeur: 'intitule' },
    { titre: 'Debit', valeur: 'debit' },
    { titre: 'Credit', valeur: 'credit' },
    { titre: 'Solde debiteur', valeur: 'solde_debiteur' },
    { titre: 'Solde crediteur', valeur: 'solde_crediteur' },
  ]);
  texteBrut(res, 'balance.csv', contenu, 'text/csv; charset=utf-8');
  return null;
});

route('GET', '/api/export/registre-especes.csv', 'lire', async ({ query, res }) => {
  const r = registreDesEspeces(query);
  const lignes = r.caisses.flatMap((c) => c.mouvements.map((m) => ({
    ...m,
    caisse: c.compte,
    signalement: [
      m.sans_piece ? 'sans piece' : '',
      m.au_dela_du_plafond ? 'au-dela du plafond' : '',
      m.solde_negatif ? 'caisse creditrice' : '',
      m.statut === 'CONTREPASSEE' ? 'contre-passee' : '',
    ].filter(Boolean).join(' / '),
  })));
  const contenu = versCSV(lignes, [
    { titre: 'Caisse', valeur: 'caisse' },
    { titre: 'Date', valeur: 'date_ecriture' },
    { titre: 'Journal', valeur: 'journal' },
    { titre: 'Numero', valeur: 'numero' },
    { titre: 'Piece', valeur: 'piece_ref' },
    { titre: 'Libelle', valeur: 'libelle' },
    { titre: 'Dossier', valeur: 'dossier' },
    { titre: 'Encaissement (XPF)', valeur: 'debit' },
    { titre: 'Decaissement (XPF)', valeur: 'credit' },
    { titre: 'Solde (XPF)', valeur: 'solde_progressif' },
    { titre: 'Signalement', valeur: 'signalement' },
  ]);
  texteBrut(res, 'registre-especes.csv', contenu, 'text/csv; charset=utf-8');
route('GET', '/api/export/tgc.csv', 'lire', async ({ query, res }) => {
  const e = Tgc.etatTgc(query);
  const lignes = [
    ...e.collectee.taux.map((t) => ({ sens: 'TGC collectee', ...t })),
    ...e.deductible.taux.map((t) => ({ sens: 'TGC deductible', ...t })),
  ];
  const contenu = versCSV(lignes, [
    { titre: 'Sens', valeur: 'sens' },
    { titre: 'Taux', valeur: 'libelle' },
    { titre: 'Taux (pour mille)', valeur: 'taux_millieme' },
    { titre: 'Assiette (XPF)', valeur: 'assiette' },
    { titre: 'Taxe (XPF)', valeur: 'taxe' },
    { titre: 'Ecritures', valeur: 'ecritures' },
  ]);
  texteBrut(res, 'tgc.csv', contenu, 'text/csv; charset=utf-8');
route('GET', '/api/export/placements.csv', 'lire', async ({ res }) => {
  const e = etatPlacements();
  const contenu = versCSV(e.dossiers, [
    { titre: 'Dossier', valeur: 'reference' },
    { titre: 'Intitule', valeur: 'intitule' },
    { titre: 'Compte client', valeur: 'compte_client' },
    { titre: 'Place en rubrique (XPF)', valeur: 'place' },
    { titre: 'Fonds detenus (XPF)', valeur: 'fonds_dus' },
    { titre: 'Disponible non place (XPF)', valeur: 'disponible_non_place' },
    { titre: 'Produits affectes (XPF)', valeur: 'produits_affectes' },
  ]);
  texteBrut(res, 'placements-rubriques.csv', contenu, 'text/csv; charset=utf-8');
  return null;
});

route('GET', '/api/export/comptes-clients.csv', 'lire', async ({ res }) => {
  const e = Etats.etatComptesClients();
  const contenu = versCSV(e.dossiers, [
    { titre: 'Dossier', valeur: 'reference' },
    { titre: 'Intitule', valeur: 'intitule' },
    { titre: 'Compte client', valeur: 'compte_client' },
    { titre: 'Statut', valeur: 'statut' },
    { titre: 'Fonds detenus (XPF)', valeur: 'fonds_detenus' },
  ]);
  texteBrut(res, 'comptes-clients.csv', contenu, 'text/csv; charset=utf-8');
  return null;
});

route('GET', '/api/export/compte-definitif/:id', 'lire', async ({ params, res }) => {
  const c = Etats.compteDefinitif(Number(params.id));
  if (!c) return null;
  const contenu = versCSV(c.mouvements, [
    { titre: 'Date', valeur: 'date_ecriture' },
    { titre: 'Journal', valeur: 'journal' },
    { titre: 'Piece', valeur: 'piece_ref' },
    { titre: 'Libelle', valeur: 'libelle' },
    { titre: 'Verse par le client (XPF)', valeur: 'credit' },
    { titre: 'Impute au dossier (XPF)', valeur: 'debit' },
  ]);
  texteBrut(res, `compte-definitif-${c.dossier.reference}.csv`, contenu, 'text/csv; charset=utf-8');
  return null;
});

// ------------------------------------------------------------------- serveur

function jetonDeLaRequete(req) {
  const entete = req.headers.authorization;
  if (entete?.startsWith('Bearer ')) return entete.slice(7);
  const cookie = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('jeton='));
  return cookie ? decodeURIComponent(cookie.slice(6)) : null;
}

const serveur = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? HOTE}`);

  if (!url.pathname.startsWith('/api/')) {
    await servirStatique(res, url.pathname);
    return;
  }

  const r = routes.find((x) => x.methode === req.method && x.regex.test(url.pathname));
  if (!r) return json(res, 404, { erreur: 'Route inconnue', code: 'ROUTE_INCONNUE' });

  try {
    const jeton = jetonDeLaRequete(req);
    const utilisateur = utilisateurDuJeton(jeton);
    if (r.droit) {
      if (!utilisateur) return json(res, 401, { erreur: 'Authentification requise', code: 'NON_AUTHENTIFIE' });
      exigerDroit(utilisateur, r.droit);
    }

    const correspondance = url.pathname.match(r.regex);
    const params = Object.fromEntries(r.parametres.map((n, i) => [n, decodeURIComponent(correspondance[i + 1])]));
    const query = Object.fromEntries(url.searchParams);
    const corps = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await corpsJSON(req) : {};

    const resultat = await r.gestionnaire({ utilisateur, jeton, params, query, corps, res });
    if (resultat === null && res.headersSent) return;
    if (resultat === null || resultat === undefined) return json(res, 404, { erreur: 'Introuvable', code: 'INTROUVABLE' });
    return json(res, 200, resultat);
  } catch (e) {
    if (e instanceof ErreurConformite) {
      const code = e.code === 'NON_AUTHENTIFIE' ? 401 : e.code === 'DROIT_INSUFFISANT' ? 403 : 422;
      return json(res, code, { erreur: e.message, code: e.code, details: e.details });
    }
    if (/INALTERABILITE/.test(e.message ?? '')) {
      return json(res, 409, { erreur: e.message, code: 'INALTERABILITE' });
    }
    console.error(e);
    return json(res, 500, { erreur: 'Erreur interne', code: 'ERREUR_INTERNE' });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  ouvrirBase();
  const nouveau = initialiser();
  serveur.listen(PORT, HOTE, () => {
    console.log(`Comptabilite notariale - ${nouveau.office.denomination}`);
    console.log(`Interface : http://${HOTE}:${PORT}`);
    if (nouveau.compte_initial) {
      console.log('');
      console.log(`Premier acces : ${nouveau.compte_initial.identifiant} / ${nouveau.compte_initial.motDePasse}`);
    }
  });
}

export { serveur };
