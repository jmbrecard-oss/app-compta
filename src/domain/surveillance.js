import { un, tous } from '../db.js';

/**
 * Surveillance de la periodicite des rapprochements bancaires.
 *
 * Le rapprochement du compte de depot des fonds clients est la verification
 * centrale du controle de comptabilite : il etablit que les sommes inscrites
 * en comptabilite correspondent aux avoirs reellement detenus par
 * l'etablissement teneur du compte. Un rapprochement isole ne prouve rien :
 * seule une serie continue, periode apres periode, etablit que les fonds ont
 * ete representes sans interruption. Entre deux arretes rapproches, aucune
 * verification externe ne couvre la comptabilite.
 *
 * Ce module construit, pour chaque compte rapprochable, le calendrier des
 * periodes depuis le premier mouvement comptabilise, et qualifie chacune :
 *
 *   COUVERTE   un rapprochement clos est arrete au dernier jour de la periode
 *   EN_COURS   un rapprochement est ouvert pour cette periode, pas encore clos,
 *              et son echeance n'est pas depassee
 *   ATTENDUE   periode revolue, dans le delai de production du releve
 *   MANQUANTE  periode revolue, echeance depassee, aucun rapprochement clos
 *
 * Un rapprochement arrete en cours de periode (le 15 du mois, par exemple) est
 * licite mais ne couvre aucune periode : il laisse la fin de mois non verifiee.
 *
 * PARAMETRES A CONFIRMER PAR LA CHAMBRE DES NOTAIRES DE NOUVELLE-CALEDONIE :
 * la periodicite mensuelle et le delai de quinze jours retenus ci-dessous sont
 * ceux de la pratique professionnelle courante ; aucun texte caledonien
 * consulte ne les fixe. Ils sont parametrables a l'appel.
 */

/** Periodicite par defaut, en mois. 1 = rapprochement mensuel. */
export const PERIODICITE_MOIS = 1;

/**
 * Delai, en jours, entre la fin d'une periode et l'exigibilite du
 * rapprochement : le temps de reception du releve de l'etablissement teneur.
 */
export const DELAI_PRODUCTION_JOURS = 15;

const JOUR_MS = 86_400_000;

const iso = (a, m, j) => `${a}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
const joursDansLeMois = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
const finDeMois = (a, m) => iso(a, m, joursDansLeMois(a, m));
const moisDe = (date) => [Number(date.slice(0, 4)), Number(date.slice(5, 7))];

const ajouterMois = (a, m, n) => {
  const t = a * 12 + (m - 1) + n;
  return [Math.floor(t / 12), (t % 12) + 1];
};

const ajouterJours = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * JOUR_MS)
  .toISOString().slice(0, 10);

const ecartJours = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / JOUR_MS);

const aujourdhuiISO = () => new Date().toISOString().slice(0, 10);

/** Les options venant d'une requete HTTP sont du texte : on les ramene au type attendu. */
const dateOption = (v, defaut) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : defaut);
const entierOption = (v, defaut, mini) => {
  if (v === null || v === undefined || v === '') return defaut;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(n, mini) : defaut;
};

/**
 * Gravite d'un defaut de rapprochement.
 *
 * Un compte de depot des fonds clients non rapproche est plus grave qu'un
 * compte de l'office : ce sont les fonds d'autrui qui ne sont plus controles.
 */
export function graviteRetard(nature, periodesManquantes) {
  if (periodesManquantes <= 0) return null;
  if (nature === 'DEPOT_FONDS_CLIENTS') return periodesManquantes >= 2 ? 'CRITIQUE' : 'MAJEURE';
  return periodesManquantes >= 2 ? 'MAJEURE' : 'MINEURE';
}

/**
 * Calendrier des periodes de rapprochement d'un compte.
 *
 * Options :
 *   aujourdhui        date de reference (defaut : ce jour)
 *   jusqu             derniere date couverte par le calendrier (defaut : aujourdhui)
 *   depuis            plancher : aucune periode anterieure n'est generee
 *   periodicite_mois  longueur d'une periode, en mois
 *   delai_jours       delai de production du releve
 */
export function calendrierRapprochements(compte, options = {}) {
  const c = un('SELECT numero, intitule, nature, rapprochable, actif FROM comptes WHERE numero = $n', { n: compte });
  if (!c) return null;

  const periodicite = entierOption(options.periodicite_mois, PERIODICITE_MOIS, 1);
  const delai = entierOption(options.delai_jours, DELAI_PRODUCTION_JOURS, 0);
  const arreteLe = dateOption(options.aujourdhui, aujourdhuiISO());
  const limite = dateOption(options.jusqu, arreteLe);

  const premier = un(
    `SELECT MIN(e.date_ecriture) AS d FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON'`,
    { c: compte },
  ).d ?? null;

  const rapprochements = tous(
    'SELECT id, date_arrete, statut, cree_le, clos_le FROM rapprochements WHERE compte = $c ORDER BY date_arrete',
    { c: compte },
  );
  const derniereCouverture = rapprochements
    .filter((r) => r.statut === 'CLOS').map((r) => r.date_arrete).sort().at(-1) ?? null;

  const etat = {
    compte: c.numero,
    intitule: c.intitule,
    nature: c.nature,
    rapprochable: Boolean(c.rapprochable),
    periodicite_mois: periodicite,
    delai_jours: delai,
    arrete_le: arreteLe,
    premier_mouvement: premier,
    derniere_couverture: derniereCouverture,
    periodes: [],
    periodes_manquantes: [],
    nb_periodes_manquantes: 0,
    plus_ancienne_periode: null,
    retard_jours: 0,
    prochaine_echeance: null,
    gravite: null,
    conforme: true,
  };

  // Sans mouvement comptabilise, le compte n'appelle aucun rapprochement.
  if (!premier) return etat;

  const plancher = dateOption(options.depuis, null);
  const debutCalendrier = plancher && plancher > premier ? plancher : premier;
  let [annee, mois] = moisDe(debutCalendrier);

  // Garde-fou : un siecle de periodes mensuelles au maximum.
  for (let i = 0; i < 1200; i++) {
    const [af, mf] = ajouterMois(annee, mois, periodicite - 1);
    const fin = finDeMois(af, mf);
    if (fin > limite) {
      etat.prochaine_echeance = ajouterJours(fin, delai);
      break;
    }
    const debut = iso(annee, mois, 1);
    const echeance = ajouterJours(fin, delai);
    const clos = rapprochements.find((r) => r.date_arrete === fin && r.statut === 'CLOS');
    const ouvert = rapprochements.find((r) => r.date_arrete === fin && r.statut === 'EN_COURS');

    let statut;
    let retard = 0;
    if (clos) statut = 'COUVERTE';
    else if (arreteLe < echeance) statut = ouvert ? 'EN_COURS' : 'ATTENDUE';
    else {
      statut = 'MANQUANTE';
      retard = ecartJours(arreteLe, echeance);
    }

    etat.periodes.push({
      libelle: `${annee}-${String(mois).padStart(2, '0')}`,
      debut,
      fin,
      echeance,
      statut,
      retard_jours: retard,
      inacheve: statut === 'MANQUANTE' && Boolean(ouvert),
      rapprochement_id: clos?.id ?? ouvert?.id ?? null,
    });

    [annee, mois] = ajouterMois(annee, mois, periodicite);
  }

  etat.periodes_manquantes = etat.periodes.filter((p) => p.statut === 'MANQUANTE');
  etat.nb_periodes_manquantes = etat.periodes_manquantes.length;
  etat.plus_ancienne_periode = etat.periodes_manquantes[0]?.libelle ?? null;
  etat.retard_jours = etat.periodes_manquantes[0]?.retard_jours ?? 0;
  etat.gravite = graviteRetard(c.nature, etat.nb_periodes_manquantes);
  etat.conforme = etat.nb_periodes_manquantes === 0;
  return etat;
}

const ORDRE_GRAVITE = { CRITIQUE: 0, MAJEURE: 1, MINEURE: 2 };

/**
 * Relances : pour chaque compte rapprochable, les periodes dont le
 * rapprochement est exigible et n'a pas ete produit. C'est l'etat que le
 * tableau de bord affiche et que le dossier d'inspection reprend.
 */
export function relancesRapprochements(options = {}) {
  const comptes = tous('SELECT numero FROM comptes WHERE rapprochable = 1 AND actif = 1 ORDER BY numero');
  const calendriers = comptes.map((c) => calendrierRapprochements(c.numero, options));

  const relances = calendriers.filter((c) => !c.conforme).map((c) => ({
    compte: c.compte,
    intitule: c.intitule,
    nature: c.nature,
    gravite: c.gravite,
    nb_periodes_manquantes: c.nb_periodes_manquantes,
    plus_ancienne_periode: c.plus_ancienne_periode,
    derniere_couverture: c.derniere_couverture,
    retard_jours: c.retard_jours,
    periodes: c.periodes_manquantes.map((p) => p.libelle),
    message: message(c),
  })).sort((a, b) => (ORDRE_GRAVITE[a.gravite] - ORDRE_GRAVITE[b.gravite])
    || (b.retard_jours - a.retard_jours)
    || a.compte.localeCompare(b.compte));

  return {
    arrete_le: calendriers[0]?.arrete_le ?? dateOption(options.aujourdhui, aujourdhuiISO()),
    periodicite_mois: calendriers[0]?.periodicite_mois ?? PERIODICITE_MOIS,
    delai_jours: calendriers[0]?.delai_jours ?? DELAI_PRODUCTION_JOURS,
    calendriers,
    relances,
    conforme: relances.length === 0,
  };
}

function message(c) {
  const inacheves = c.periodes_manquantes.filter((p) => p.inacheve).length;
  return `Compte ${c.compte} : ${c.nb_periodes_manquantes} periode(s) sans rapprochement bancaire clos `
    + `(${c.periodes_manquantes.map((p) => p.libelle).join(', ')}). `
    + (c.derniere_couverture
      ? `Derniere periode couverte : arrete au ${c.derniere_couverture}. `
      : 'Aucun rapprochement clos depuis le premier mouvement du compte. ')
    + (inacheves ? `${inacheves} rapprochement(s) ouvert(s) et jamais clos. ` : '')
    + `Retard de ${c.retard_jours} jour(s) sur la periode la plus ancienne.`;
}

/**
 * Periodes anterieures a une date d'arrete qui ne sont pas couvertes.
 *
 * Sert de controle bloquant a la cloture d'un rapprochement : l'arrete d'une
 * periode suppose que la precedente a ete justifiee, faute de quoi le solde
 * de depart n'a jamais ete verifie.
 */
export function periodesAnterieuresNonCouvertes(compte, dateArrete, options = {}) {
  const veille = ajouterJours(dateArrete, -1);
  const c = calendrierRapprochements(compte, {
    ...options,
    aujourdhui: dateArrete,
    jusqu: veille,
    delai_jours: 0,
  });
  return c ? c.periodes.filter((p) => p.statut === 'MANQUANTE') : [];
}
