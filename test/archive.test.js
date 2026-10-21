process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ouvrirBase, RACINE } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { empreinteEcriture, GENESE } from '../src/hash.js';
import { creerBrouillon, valider, contrepasser } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { genererArchive, serialiserArchive, nomFichierArchive } from '../src/reports/archive.js';
import { verifierArchive, scelleDe, empreinteRacine } from '../src/reports/verification-archive.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '7654321', motDePasse: 'motdepasse-test', annee: ANNEE });

const dossier = ouvrirDossier({ reference: 'A-001', intitule: 'VENTE MARTIN' }, notaire);
const dossier2 = ouvrirDossier({ reference: 'A-002', intitule: 'SUCCESSION PAITA' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

// --- jeu d'ecritures : reception de fonds, emoluments, contre-passation ----

comptabiliser({
  journal: 'BQC', date_ecriture: LE('02-03'), piece_ref: 'V-1', libelle: 'Fonds recus MARTIN',
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: 3_000_000 },
    { compte: dossier.compte_client, libelle: 'Fonds MARTIN', credit: 3_000_000 },
  ],
});

comptabiliser({
  journal: 'BQC', date_ecriture: LE('02-04'), piece_ref: 'V-2', libelle: 'Fonds recus PAITA',
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: 1_200_000 },
    { compte: dossier2.compte_client, libelle: 'Fonds PAITA', credit: 1_200_000 },
  ],
});

comptabiliser({
  journal: 'EMO', date_ecriture: LE('02-05'), piece_ref: 'F-1', libelle: 'Emoluments vente MARTIN',
  lignes: [
    { compte: dossier.compte_client, libelle: 'Emoluments', debit: 222_000 },
    { compte: '706100', libelle: 'Emoluments d acte', credit: 200_000 },
    { compte: '445700', libelle: 'TGC 11 %', credit: 22_000 },
  ],
});

const aExtourner = comptabiliser({
  journal: 'OD', date_ecriture: LE('02-06'), piece_ref: 'P-3303', libelle: 'Imputation erronee',
  lignes: [
    { compte: '606400', libelle: 'Fournitures', debit: 30_000 },
    { compte: '401000', libelle: 'Fournisseur', credit: 30_000 },
  ],
});
contrepasser(aExtourner, { date_ecriture: LE('02-07'), motif: 'Compte de charge errone' }, notaire);

// Un brouillon jamais comptabilise : il ne doit jamais entrer dans l'archive.
const brouillon = creerBrouillon({
  journal: 'OD', date_ecriture: LE('02-08'), piece_ref: 'P-3094', libelle: 'Brouillon abandonne',
  lignes: [
    { compte: '606400', libelle: 'x', debit: 9_999 },
    { compte: '401000', libelle: 'x', credit: 9_999 },
  ],
}, notaire);

// -------------------------------------------------------------- utilitaires

/** Copie profonde, pour falsifier une archive sans toucher a l'originale. */
const copie = (a) => JSON.parse(JSON.stringify(a));

/** Re-scelle une archive falsifiee : simule un faussaire soigneux. */
function resceller(archive) {
  archive.scelle = scelleDe(archive);
  return archive;
}

/**
 * Recalcule toute la chaine d'empreintes d'une archive falsifiee.
 * Simule le faussaire le plus capable : celui qui dispose du code source et
 * refait les empreintes une a une. C'est le scenario contre lequel seule la
 * racine deposee hors de l'archive protege encore.
 */
function rechainer(archive) {
  let precedent = GENESE;
  for (const e of archive.contenu.ecritures) {
    e.hash_precedent = precedent;
    e.hash = empreinteEcriture(e, e.lignes, precedent);
    precedent = e.hash;
  }
  return archive;
}

const codes = (rapport) => rapport.anomalies.map((a) => a.code);

// ---------------------------------------------------------------- les tests

test('l archive scellee se verifie par elle-meme, sans acces a la base', () => {
  const archive = genererArchive({ edite_par: notaire.identifiant });
  const rapport = verifierArchive(serialiserArchive(archive));

  assert.ok(rapport.valide, JSON.stringify(rapport.anomalies));
  assert.equal(rapport.scelle.intact, true);
  assert.equal(rapport.scelle.recalcule, archive.scelle);
  assert.equal(rapport.racine_chaine.length, 64);
  assert.equal(rapport.volumetrie.ecritures, 5);
  assert.equal(rapport.volumetrie.total_debit, rapport.volumetrie.total_credit);
  // Chaque controle annonce son verdict : c'est le rapport remis a l'inspecteur.
  assert.ok(rapport.controles.length >= 8);
  assert.ok(rapport.controles.every((c) => c.verdict === 'OK'));
});

test('le scelle est deterministe et la racine ne depend pas de l heure d edition', () => {
  const a = genererArchive({ edite_par: 'notaire', edite_le: '2026-10-20T00:00:00.000Z' });
  const b = genererArchive({ edite_par: 'notaire', edite_le: '2026-10-20T00:00:00.000Z' });
  assert.equal(a.scelle, b.scelle);
  assert.equal(serialiserArchive(a), serialiserArchive(b));

  // L'heure d'edition entre dans le scelle, jamais dans la racine de la chaine :
  // c'est la racine qui sert d'ancrage d'une edition a l'autre.
  const c = genererArchive({ edite_par: 'notaire', edite_le: '2026-11-01T09:30:00.000Z' });
  assert.notEqual(c.scelle, a.scelle);
  assert.equal(empreinteRacine(c.contenu.ecritures), empreinteRacine(a.contenu.ecritures));
});

test('les brouillons sont exclus de l archive par construction', () => {
  const archive = genererArchive({ edite_par: 'notaire' });
  assert.ok(!JSON.stringify(archive.contenu.ecritures).includes('Brouillon abandonne'));
  assert.ok(!archive.contenu.ecritures.some((e) => e.id === brouillon.id));
  assert.ok(archive.contenu.ecritures.every((e) => e.statut !== 'BROUILLON'));

  // Le journal d'audit, lui, conserve la trace de sa saisie : un brouillon
  // abandonne ne disparait pas de la piste d'audit, il n'entre simplement
  // dans aucun solde.
  assert.ok(archive.contenu.audit.some(
    (e) => e.action === 'CREATION_BROUILLON' && e.details.includes('Brouillon abandonne'),
  ));
});

test('l alteration d un montant dans l archive rompt le scelle', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  faux.contenu.ecritures[0].lignes[0].debit += 1;

  const rapport = verifierArchive(faux);
  assert.equal(rapport.valide, false);
  assert.ok(codes(rapport).includes('SCELLE_ROMPU'));
});

test('un montant falsifie puis re-scelle reste detecte par la chaine d empreintes', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  const cible = faux.contenu.ecritures[2];
  cible.lignes[0].debit += 1000;
  cible.lignes[1].credit += 1000;
  resceller(faux);

  const rapport = verifierArchive(faux);
  assert.equal(rapport.valide, false);
  assert.equal(rapport.scelle.intact, true, 'le faussaire a bien refait le scelle');
  assert.ok(codes(rapport).includes('ECRITURE_ALTEREE'));
  assert.equal(
    rapport.anomalies.find((a) => a.code === 'ECRITURE_ALTEREE').rang_chaine,
    cible.rang_chaine,
  );
});

test('la suppression d une ecriture au milieu de la chaine est detectee', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  faux.contenu.ecritures.splice(2, 1);
  resceller(faux);

  const rapport = verifierArchive(faux);
  assert.equal(rapport.valide, false);
  assert.ok(codes(rapport).includes('RANG_MANQUANT'));
});

test('une ecriture desequilibree glissee dans l archive est refusee', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  faux.contenu.ecritures[1].lignes[0].debit += 500;
  // Le faussaire refait l'empreinte de l'ecriture et toute la chaine suivante.
  resceller(rechainer(faux));

  const rapport = verifierArchive(faux);
  assert.equal(rapport.valide, false);
  assert.ok(codes(rapport).includes('ECRITURE_DESEQUILIBREE'));
  assert.ok(codes(rapport).includes('ARCHIVE_DESEQUILIBREE'));
});

test('une chaine entierement reforgee est demasquee par la racine deposee', () => {
  const authentique = genererArchive({ edite_par: 'notaire' });
  const racineDeposee = empreinteRacine(authentique.contenu.ecritures);

  const faux = copie(authentique);
  faux.contenu.ecritures[3].libelle = 'Libelle reecrit apres coup';
  resceller(rechainer(faux));

  // Le faux est coherent avec lui-meme : scelle, chaine et numerotation tiennent.
  const sansReference = verifierArchive(faux);
  assert.equal(sansReference.scelle.intact, true);
  assert.ok(!codes(sansReference).includes('ECRITURE_ALTEREE'));

  // Mais il ne peut pas reproduire la racine deposee hors de l'archive.
  const rapport = verifierArchive(faux, { racine_attendue: racineDeposee });
  assert.equal(rapport.valide, false);
  assert.ok(codes(rapport).includes('RACINE_DIFFERENTE'));

  // La meme confrontation sur l'archive authentique passe.
  assert.ok(verifierArchive(authentique, { racine_attendue: racineDeposee }).valide);
});

test('l alteration du journal d audit est detectee', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  faux.contenu.audit.find((e) => e.action === 'COMPTABILISATION').utilisateur = 'un autre';
  resceller(faux);

  const rapport = verifierArchive(faux);
  assert.equal(rapport.valide, false);
  assert.ok(codes(rapport).includes('AUDIT_ALTERE'));
});

test('une ecriture referencant un compte absent de l archive est signalee', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  faux.contenu.comptes = faux.contenu.comptes.filter((c) => c.numero !== '512500');
  resceller(faux);

  const rapport = verifierArchive(faux);
  assert.equal(rapport.valide, false);
  assert.ok(codes(rapport).includes('COMPTE_INCONNU'));
});

test('un format ou une version inconnus sont refuses sans etre interpretes', () => {
  const faux = copie(genererArchive({ edite_par: 'notaire' }));
  faux.format = 'AUTRE-CHOSE';
  resceller(faux);
  assert.deepEqual(codes(verifierArchive(faux)), ['FORMAT_INCONNU']);

  assert.ok(codes(verifierArchive('{ ceci n est pas du JSON')).includes('ARCHIVE_ILLISIBLE'));
});

test('le verificateur en ligne de commande s execute sans base de donnees', () => {
  const dossierTemp = mkdtempSync(join(tmpdir(), 'archive-'));
  const archive = genererArchive({ edite_par: 'notaire' });
  const chemin = join(dossierTemp, nomFichierArchive());
  writeFileSync(chemin, serialiserArchive(archive), 'utf8');

  // Base volontairement inaccessible : si le verificateur l'ouvrait, il echouerait.
  const env = { ...process.env, COMPTA_DB: '/proc/impossible/compta.sqlite' };
  const lancer = (args) => execFileSync(
    process.execPath,
    [join(RACINE, 'src', 'verifier-archive.js'), ...args],
    { env, encoding: 'utf8' },
  );

  const sortie = lancer([chemin, '--racine', empreinteRacine(archive.contenu.ecritures)]);
  assert.match(sortie, /ARCHIVE CONFORME/);
  assert.ok(sortie.includes(archive.scelle));

  // Archive falsifiee : code de sortie non nul et motif explicite.
  const faux = copie(archive);
  faux.contenu.ecritures[0].lignes[0].debit += 1;
  const cheminFaux = join(dossierTemp, 'archive-falsifiee.json');
  writeFileSync(cheminFaux, serialiserArchive(faux), 'utf8');

  assert.throws(
    () => lancer([cheminFaux]),
    (e) => {
      assert.equal(e.status, 1);
      assert.match(e.stdout, /ARCHIVE NON CONFORME/);
      assert.match(e.stdout, /SCELLE_ROMPU/);
      return true;
    },
  );
});

test('le nom de fichier porte le RIDET de l office et la date d arrete', () => {
  assert.match(nomFichierArchive(), /^7654321-ARCHIVE-\d{8}\.json$/);
});
