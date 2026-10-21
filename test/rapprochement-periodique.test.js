process.env.COMPTA_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { ouvrirBase, un, exec } from '../src/db.js';
import { initialiser } from '../src/init.js';
import { creerBrouillon, valider } from '../src/domain/ecritures.js';
import { ouvrirDossier } from '../src/domain/dossiers.js';
import { anomalies } from '../src/domain/controles.js';
import { ouvrirRapprochement, pointer, cloreRapprochement } from '../src/domain/rapprochement.js';
import { calendrierRapprochements, relancesRapprochements } from '../src/domain/surveillance.js';
import { controlePreCloture } from '../src/domain/cloture.js';

const ANNEE = new Date().getFullYear();
const LE = (mmjj) => `${ANNEE}-${mmjj}`;
const notaire = { identifiant: 'notaire', role: 'NOTAIRE' };

ouvrirBase();
initialiser({ denomination: 'Office de test', ridet: '1234567', motDePasse: 'motdepasse-test', annee: ANNEE });

const dossier = ouvrirDossier({ reference: 'D-100', intitule: 'VENTE MARTIN' }, notaire);

const comptabiliser = (saisie) => valider(creerBrouillon(saisie, notaire).id, notaire).id;

const refuse = (code, fn) => {
  try {
    fn();
    assert.fail(`attendu un refus ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `code attendu ${code}, obtenu ${e.code} (${e.message})`);
  }
};

/** Solde comptable d'un compte a une date, tel que le rapprochement le calcule. */
const soldeAu = (compte, date) => un(
  `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS s
   FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
   WHERE l.compte = $c AND e.statut <> 'BROUILLON' AND e.date_ecriture <= $d`,
  { c: compte, d: date },
).s;

/** Rapprochement complet : ouverture au solde comptable, pointage integral, cloture. */
const rapprocherAu = (compte, date) => {
  const r = ouvrirRapprochement({ compte, date_arrete: date, solde_releve: soldeAu(compte, date) }, notaire);
  const lignes = r.en_suspens.map((m) => m.id);
  if (lignes.length) pointer(r.id, lignes, true, notaire);
  return cloreRapprochement(r.id, notaire);
};

// Fonds clients recus en janvier, puis mouvements de fevrier et de mars.
comptabiliser({
  journal: 'BQC', date_ecriture: LE('01-15'), piece_ref: 'V-1', libelle: 'Fonds recus MARTIN',
  lignes: [
    { compte: '512500', libelle: 'Virement recu', debit: 8_000_000 },
    { compte: dossier.compte_client, libelle: 'Fonds recus', dossier_id: dossier.id, credit: 8_000_000 },
  ],
});
comptabiliser({
  journal: 'BQC', date_ecriture: LE('02-10'), piece_ref: 'D-1', libelle: 'Droits d enregistrement MARTIN',
  lignes: [
    { compte: dossier.compte_client, libelle: 'Droits verses', dossier_id: dossier.id, debit: 1_200_000 },
    { compte: '512500', libelle: 'Virement Tresor', credit: 1_200_000 },
  ],
});
comptabiliser({
  journal: 'BQO', date_ecriture: LE('02-12'), piece_ref: 'F-1', libelle: 'Fournitures',
  lignes: [
    { compte: '606400', libelle: 'Fournitures', debit: 45_000 },
    { compte: '512100', libelle: 'Reglement', credit: 45_000 },
  ],
});

test('le calendrier part du premier mouvement comptabilise et ne retient que les periodes revolues', () => {
  const c = calendrierRapprochements('512500', { aujourdhui: LE('06-20') });
  assert.equal(c.premier_mouvement, LE('01-15'));
  assert.deepEqual(c.periodes.map((p) => p.libelle), [
    `${ANNEE}-01`, `${ANNEE}-02`, `${ANNEE}-03`, `${ANNEE}-04`, `${ANNEE}-05`,
  ]);
  assert.equal(c.periodes[0].debut, LE('01-01'));
  assert.equal(c.periodes[0].fin, LE('01-31'));
  // Dernier jour de fevrier, annee bissextile comprise.
  assert.equal(c.periodes[1].fin, `${ANNEE}-02-${new Date(Date.UTC(ANNEE, 2, 0)).getUTCDate()}`);
});

test('un compte rapprochable jamais mouvemente n appelle aucune relance', () => {
  const c = calendrierRapprochements('512600', { aujourdhui: LE('06-20') });
  assert.equal(c.premier_mouvement, null);
  assert.deepEqual(c.periodes, []);
  assert.equal(c.conforme, true);
  assert.equal(c.gravite, null);
});

test('une periode n est exigible qu au terme du delai de production du releve', () => {
  // Au 10 fevrier, le releve de janvier n est pas encore exigible : rien a relancer.
  const avant = calendrierRapprochements('512500', { aujourdhui: LE('02-10'), delai_jours: 15 });
  assert.equal(avant.periodes.at(-1).libelle, `${ANNEE}-01`);
  assert.equal(avant.periodes.at(-1).statut, 'ATTENDUE');
  assert.equal(avant.conforme, true);

  // Au 20 fevrier, l echeance (31/01 + 15 jours) est depassee : la periode manque.
  const apres = calendrierRapprochements('512500', { aujourdhui: LE('02-20'), delai_jours: 15 });
  const janvier = apres.periodes.find((p) => p.libelle === `${ANNEE}-01`);
  assert.equal(janvier.statut, 'MANQUANTE');
  assert.equal(janvier.echeance, LE('02-15'));
  assert.equal(janvier.retard_jours, 5);
  assert.equal(apres.conforme, false);
});

test('un rapprochement ouvert mais jamais clos ne couvre pas la periode', () => {
  const r = ouvrirRapprochement(
    { compte: '512500', date_arrete: LE('01-31'), solde_releve: soldeAu('512500', LE('01-31')) },
    notaire,
  );
  const c = calendrierRapprochements('512500', { aujourdhui: LE('02-20'), delai_jours: 15 });
  const janvier = c.periodes.find((p) => p.libelle === `${ANNEE}-01`);
  assert.equal(janvier.statut, 'MANQUANTE');
  assert.equal(janvier.inacheve, true);
  assert.equal(janvier.rapprochement_id, r.id);

  // Avant l echeance, le rapprochement en cours est signale comme tel, sans relance.
  const enCours = calendrierRapprochements('512500', { aujourdhui: LE('02-05'), delai_jours: 15 });
  assert.equal(enCours.periodes.at(-1).statut, 'EN_COURS');
  assert.equal(enCours.conforme, true);

  // Il est clos pour la suite des tests.
  pointer(r.id, r.en_suspens.map((m) => m.id), true, notaire);
  cloreRapprochement(r.id, notaire);
  const apres = calendrierRapprochements('512500', { aujourdhui: LE('02-20'), delai_jours: 15 });
  assert.equal(apres.periodes.find((p) => p.libelle === `${ANNEE}-01`).statut, 'COUVERTE');
  assert.equal(apres.derniere_couverture, LE('01-31'));
});

test('un rapprochement arrete en cours de mois ne couvre pas la periode', () => {
  rapprocherAu('512500', LE('02-15'));
  const c = calendrierRapprochements('512500', { aujourdhui: LE('04-20'), delai_jours: 15 });
  assert.equal(c.periodes.find((p) => p.libelle === `${ANNEE}-02`).statut, 'MANQUANTE');
});

test('clore un rapprochement est refuse tant qu une periode anterieure ne l est pas', () => {
  const fevrier = calendrierRapprochements('512500', { aujourdhui: LE('03-31'), delai_jours: 0 })
    .periodes.find((p) => p.libelle === `${ANNEE}-02`);
  assert.equal(fevrier.statut, 'MANQUANTE');

  // Le rapprochement de mars peut etre prepare et pointe...
  const mars = ouvrirRapprochement(
    { compte: '512500', date_arrete: LE('03-31'), solde_releve: soldeAu('512500', LE('03-31')) },
    notaire,
  );
  if (mars.en_suspens.length) pointer(mars.id, mars.en_suspens.map((m) => m.id), true, notaire);

  // ... mais non clos tant que la periode de fevrier ne l est pas.
  refuse('RAPPROCHEMENT_ANTERIEUR_MANQUANT', () => cloreRapprochement(mars.id, notaire));

  rapprocherAu('512500', fevrier.fin);
  assert.equal(cloreRapprochement(mars.id, notaire).statut, 'CLOS');
  assert.equal(
    calendrierRapprochements('512500', { aujourdhui: LE('04-20'), delai_jours: 15 })
      .periodes.filter((p) => p.statut === 'MANQUANTE').length,
    0,
  );
});

test('la gravite des relances distingue les fonds clients des comptes de l office', () => {
  // 512500 (fonds clients) est a jour jusqu a mars ; 512100 (office) n a jamais ete rapproche.
  const r = relancesRapprochements({ aujourdhui: LE('04-20'), delai_jours: 15 });
  assert.equal(r.conforme, false);
  const office = r.relances.find((x) => x.compte === '512100');
  assert.equal(office.nature, 'BANQUE_OFFICE');
  assert.equal(office.nb_periodes_manquantes, 2); // fevrier et mars
  assert.equal(office.gravite, 'MAJEURE');
  assert.equal(office.plus_ancienne_periode, `${ANNEE}-02`);
  assert.ok(!r.relances.some((x) => x.compte === '512500'));

  // Deux periodes de fonds clients non rapprochees : le defaut devient critique.
  const tardif = relancesRapprochements({ aujourdhui: LE('06-20'), delai_jours: 15 });
  const clients = tardif.relances.find((x) => x.compte === '512500');
  assert.equal(clients.nb_periodes_manquantes, 2); // avril et mai
  assert.equal(clients.gravite, 'CRITIQUE');
  assert.equal(tardif.relances[0].compte, '512500'); // les relances les plus graves en tete
});

test('la periodicite du rapprochement est parametrable', () => {
  const trimestriel = calendrierRapprochements('512100', {
    aujourdhui: LE('10-20'), periodicite_mois: 3, delai_jours: 15,
  });
  assert.deepEqual(trimestriel.periodes.map((p) => p.libelle), [`${ANNEE}-02`, `${ANNEE}-05`]);
  assert.equal(trimestriel.periodes[0].debut, LE('02-01'));
  assert.equal(trimestriel.periodes[0].fin, LE('04-30'));
  assert.equal(trimestriel.periodes[1].fin, LE('07-31'));
});

test('les anomalies signalent les rapprochements periodiques non effectues', () => {
  const liste = anomalies({ aujourdhui: LE('06-20') });
  const relance = liste.find((a) => a.code === 'RAPPROCHEMENT_EN_RETARD' && a.objet.includes('512500'));
  assert.ok(relance, 'une relance est attendue sur le compte de depot des fonds clients');
  assert.equal(relance.gravite, 'CRITIQUE');
  assert.match(relance.message, /2 periode/);
});

test('la pre-cloture refuse un exercice dont les periodes intermediaires ne sont pas rapprochees', () => {
  const exercice = un('SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1');

  // Simulation d une reprise : seul le rapprochement du 31 decembre est clos en base.
  // Le controle d anteriorite interdit de l obtenir par l application ; la pre-cloture
  // doit neanmoins refuser un exercice dont les mois intermediaires manquent.
  exec(
    `INSERT INTO rapprochements (compte, date_arrete, solde_releve, statut, cree_le, cree_par, clos_le)
     VALUES ('512100', $d, $s, 'CLOS', $now, 'reprise', $now)`,
    { d: LE('12-31'), s: soldeAu('512100', LE('12-31')), now: new Date().toISOString() },
  );

  const diag = controlePreCloture(exercice.id);
  const obstacle = diag.obstacles.find((o) => o.code === 'RAPPROCHEMENT_MANQUANT' && o.message.includes('512100'));
  assert.ok(obstacle, 'la pre-cloture doit relever les periodes non rapprochees');
  assert.match(obstacle.message, new RegExp(`${ANNEE}-02`));
  assert.match(obstacle.message, new RegExp(`${ANNEE}-11`));
  assert.equal(diag.pret, false);
});

test('un rapprochement exige une date d arrete et un solde de releve exploitables', () => {
  // Une date non normalisee rendrait le calendrier des periodes incalculable.
  refuse('DATE_INVALIDE', () => ouvrirRapprochement(
    { compte: '512600', date_arrete: '31/01/2026', solde_releve: 0 }, notaire,
  ));
  // Le franc Pacifique n a pas de subdivision : pas de troncature silencieuse du releve.
  refuse('MONTANT_NON_ENTIER', () => ouvrirRapprochement(
    { compte: '512600', date_arrete: LE('01-31'), solde_releve: 1_250_000.5 }, notaire,
  ));
  refuse('MONTANT_NON_ENTIER', () => ouvrirRapprochement(
    { compte: '512600', date_arrete: LE('01-31'), solde_releve: '' }, notaire,
  ));
  assert.equal(un('SELECT COUNT(*) AS n FROM rapprochements WHERE compte = $c', { c: '512600' }).n, 0);
});
