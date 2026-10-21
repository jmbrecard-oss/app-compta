import { un, tous } from '../db.js';
import { ErreurConformite } from './controles.js';

/**
 * Comptes rubriques : placement des fonds clients et affectation des produits.
 *
 * Les fonds qu'un office detient durablement pour un dossier (sequestre,
 * succession, prix de vente en attente de formalites) peuvent etre places sur
 * un compte de depot ouvert par sous-comptes nominatifs - un compte
 * "rubrique". Trois consequences comptables, qui sont les regles mises en
 * oeuvre ici :
 *
 *   1. la rubrique est nominative : tout mouvement designe le dossier auquel
 *      les fonds places appartiennent, faute de quoi la somme placee n'est
 *      plus rattachable a un client ;
 *   2. on ne place que ce que l'on detient pour ce dossier, et on ne retire
 *      que ce qui a ete place : la rubrique d'un dossier n'excede jamais les
 *      fonds qui lui sont dus et ne devient jamais debitrice ;
 *   3. les produits financiers du placement appartiennent au dossier qui les
 *      a produits. Leur appropriation par l'office est deja refusee par
 *      controleEtancheite (un compte de depot clients ne peut pas cotoyer un
 *      compte de gestion) ; il reste a garantir qu'ils soient affectes au bon
 *      dossier, et non a un autre - c'est controleNonCompensationRubriques.
 */

/** Comptes de depot ouverts par sous-comptes nominatifs. */
export function comptesRubriques() {
  return tous('SELECT numero, intitule FROM comptes WHERE rubrique = 1 ORDER BY numero');
}

const reference = (dossierId) =>
  un('SELECT reference FROM dossiers WHERE id = $id', { id: dossierId })?.reference ?? dossierId;

const estRubrique = (numero) =>
  un('SELECT rubrique FROM comptes WHERE numero = $n', { n: numero })?.rubrique === 1;

/**
 * Dossier porte par une ligne : celui qu'elle designe, ou a defaut celui dont
 * elle mouvemente le compte client. Un compte client appartient a un dossier
 * et a un seul (controleComptes le verifie), l'equivalence est donc sure.
 */
const dossierDeLaLigne = (l) =>
  l.dossier_id ?? un('SELECT id FROM dossiers WHERE compte_client = $c', { c: l.compte })?.id ?? null;

/** Fonds places pour un dossier, tous comptes rubriques confondus. */
export function rubriqueDuDossier(dossierId) {
  return un('SELECT IFNULL(SUM(solde), 0) AS solde FROM v_rubriques WHERE dossier_id = $id', { id: dossierId }).solde;
}

/** Fonds dus au dossier : solde crediteur de son compte client. */
function fondsDus(dossierId) {
  return -(un('SELECT solde FROM v_soldes_dossiers WHERE id = $id', { id: dossierId })?.solde ?? 0);
}

// --------------------------------------------------------------------------
// Controles bloquants
// --------------------------------------------------------------------------

/**
 * Rubrication nominative : une ligne portee sur un compte rubrique designe le
 * dossier proprietaire des fonds places.
 */
export function controleRubrication(lignes) {
  for (const l of lignes) {
    if (!estRubrique(l.compte)) continue;
    if (!l.dossier_id) {
      throw new ErreurConformite(
        'RUBRIQUE_SANS_DOSSIER',
        `Le compte ${l.compte} est un compte de depot rubrique : chaque mouvement doit designer `
        + `le dossier auquel les fonds places appartiennent.`,
        { compte: l.compte },
      );
    }
    const d = un('SELECT id FROM dossiers WHERE id = $id', { id: l.dossier_id });
    if (!d) {
      throw new ErreurConformite(
        'RUBRIQUE_SANS_DOSSIER',
        `Dossier ${l.dossier_id} inexistant : la rubrique du compte ${l.compte} ne peut pas lui etre affectee.`,
        { compte: l.compte },
      );
    }
  }
}

/**
 * Pas de compensation entre dossiers par le detour d'une rubrique.
 *
 * Une ecriture qui mouvemente la rubrique d'un dossier ne peut pas, dans le
 * meme mouvement, mouvementer le compte client d'un autre dossier. C'est ce
 * qui garantit que les produits financiers d'un placement reviennent au
 * dossier qui les a produits, et qu'un placement ne glisse pas d'un client
 * vers un autre.
 */
export function controleNonCompensationRubriques(lignes) {
  const dossiersRubriques = new Set();
  for (const l of lignes) {
    if (estRubrique(l.compte) && l.dossier_id) dossiersRubriques.add(l.dossier_id);
  }
  if (!dossiersRubriques.size) return;

  for (const l of lignes) {
    if (estRubrique(l.compte)) continue;
    const c = un('SELECT nature FROM comptes WHERE numero = $n', { n: l.compte });
    if (c?.nature !== 'CLIENT') continue;
    const dossier = dossierDeLaLigne(l);
    if (dossier && !dossiersRubriques.has(dossier)) {
      const rubrique = [...dossiersRubriques][0];
      throw new ErreurConformite(
        'COMPENSATION_RUBRIQUES',
        `Une ecriture ne peut pas mouvementer le placement rubrique du dossier ${reference(rubrique)} `
        + `et le compte client du dossier ${reference(dossier)} : les fonds places et leurs produits `
        + `reviennent au dossier qui les a produits.`,
        { dossier_rubrique: rubrique, dossier_client: dossier },
      );
    }
  }
}

/**
 * Coherence des rubriques apres comptabilisation, dossier par dossier :
 * une rubrique n'est jamais debitrice et n'excede jamais les fonds dus au
 * dossier. Appele dans la transaction, sur l'etat resultant de l'ecriture.
 */
export function controleRubriquesDossiers(dossiers) {
  for (const id of new Set(dossiers.filter(Boolean))) {
    const place = rubriqueDuDossier(id);
    if (place < 0) {
      throw new ErreurConformite(
        'RUBRIQUE_DEBITRICE',
        `Dossier ${reference(id)} : le placement rubrique deviendrait debiteur de ${-place} XPF. `
        + `Il n est pas possible de retirer d une rubrique plus que ce qui y a ete place.`,
        { dossier_id: id, place },
      );
    }
    // Un dossier sans fonds places n'a rien a verifier ici. Le cas se
    // presente des que le compte client est debiteur : l'office a avance des
    // fonds, ce que la politique retenue autorise avec alerte. Seul un
    // placement reellement constitue doit etre couvert par les fonds du
    // dossier.
    if (place === 0) continue;

    const dus = fondsDus(id);
    if (place > dus) {
      throw new ErreurConformite(
        'PLACEMENT_SANS_PROVISION',
        `Dossier ${reference(id)} : ${place} XPF seraient places alors que l office ne detient `
        + `que ${dus} XPF pour ce dossier. Un placement ne peut porter que sur les fonds du dossier.`,
        { dossier_id: id, place, fonds_dus: dus },
      );
    }
  }
}

/**
 * Dossiers dont la situation doit etre reverifiee apres l'ecriture : ceux
 * dont la rubrique bouge, et ceux dont le compte client bouge - restituer
 * les fonds d'un dossier dont le placement est encore ouvert laisserait une
 * rubrique sans provision.
 */
export function dossiersConcernes(lignes) {
  const ids = [];
  for (const l of lignes) {
    const c = un('SELECT nature, rubrique FROM comptes WHERE numero = $n', { n: l.compte });
    if (c?.rubrique !== 1 && c?.nature !== 'CLIENT') continue;
    const dossier = dossierDeLaLigne(l);
    if (dossier) ids.push(dossier);
  }
  return ids;
}

/** Obstacle a la cloture d'un dossier : un placement encore ouvert. */
export function controleDossierDenoue(dossier) {
  const place = rubriqueDuDossier(dossier.id);
  if (place !== 0) {
    throw new ErreurConformite(
      'DOSSIER_RUBRIQUE_NON_DENOUEE',
      `Dossier ${dossier.reference} : ${place} XPF restent places en compte rubrique. `
      + `Le placement doit etre denoue avant la cloture du dossier.`,
      { dossier_id: dossier.id, place },
    );
  }
}

// --------------------------------------------------------------------------
// Etat des placements
// --------------------------------------------------------------------------

/**
 * Produits financiers affectes a un dossier.
 *
 * Convention de lecture, a confirmer avec la Chambre : est tenu pour un
 * produit affecte tout credit du compte client porte par une ecriture qui
 * debite, dans le meme mouvement, une rubrique du dossier. C'est la forme que
 * prend l'inscription des interets d'un placement : la banque credite la
 * rubrique, le dossier en est credite d'autant.
 */
function produitsAffectes(dossierId, compteClient) {
  return un(
    `SELECT IFNULL(SUM(lc.credit), 0) AS produits
     FROM lignes lc
     JOIN ecritures e ON e.id = lc.ecriture_id AND e.statut IN ('VALIDEE','CONTREPASSEE')
     WHERE lc.compte = $compte
       AND EXISTS (
         SELECT 1 FROM lignes lr JOIN comptes c ON c.numero = lr.compte
         WHERE lr.ecriture_id = lc.ecriture_id AND c.rubrique = 1
           AND lr.dossier_id = $id AND lr.debit > 0)`,
    { compte: compteClient, id: dossierId },
  ).produits;
}

/** Produits financiers inscrits en produit de l'office (comptes 76). */
function produitsFinanciersOffice() {
  return -un(
    `SELECT IFNULL(SUM(solde), 0) AS solde FROM v_soldes WHERE classe = 7 AND numero LIKE '76%'`,
  ).solde;
}

/**
 * Etat des placements rubriques : ce qu'une inspection demande pour verifier
 * que les fonds places restent rattaches a leur dossier et que leurs produits
 * n'ont pas ete captes par l'office.
 */
export function etatPlacements() {
  const comptes = comptesRubriques().map((c) => ({
    ...c,
    solde: un('SELECT solde FROM v_soldes WHERE numero = $n', { n: c.numero })?.solde ?? 0,
  }));
  const soldeComptes = comptes.reduce((s, c) => s + c.solde, 0);

  const parDossier = tous(
    `SELECT dossier_id, reference, intitule, statut, compte_client,
            SUM(solde) AS place
     FROM v_rubriques GROUP BY dossier_id ORDER BY reference`,
  );

  const dossiers = parDossier.map((d) => {
    const dus = fondsDus(d.dossier_id);
    return {
      dossier_id: d.dossier_id,
      reference: d.reference,
      intitule: d.intitule,
      statut: d.statut,
      compte_client: d.compte_client,
      place: d.place,
      fonds_dus: dus,
      disponible_non_place: dus - d.place,
      produits_affectes: produitsAffectes(d.dossier_id, d.compte_client),
      conforme: d.place >= 0 && d.place <= dus,
    };
  });

  const totalVentile = dossiers.reduce((s, d) => s + d.place, 0);
  return {
    arrete_le: new Date().toISOString().slice(0, 10),
    comptes,
    solde_comptes: soldeComptes,
    dossiers,
    dossiers_places: dossiers.filter((d) => d.place !== 0).length,
    total_ventile: totalVentile,
    ecart_ventilation: soldeComptes - totalVentile,
    ventilation_conforme: soldeComptes === totalVentile,
    total_produits_affectes: dossiers.reduce((s, d) => s + d.produits_affectes, 0),
    produits_financiers_office: produitsFinanciersOffice(),
  };
}

/** Anomalies signalees au tableau de bord et au dossier d'inspection. */
export function anomaliesPlacements() {
  const liste = [];
  const e = etatPlacements();

  if (!e.ventilation_conforme) {
    liste.push({
      gravite: 'CRITIQUE',
      code: 'RUBRIQUES_NON_VENTILEES',
      objet: 'Placements rubriques',
      message: `Le solde des comptes rubriques (${e.solde_comptes} XPF) ne correspond pas a la somme `
        + `des rubriques des dossiers (${e.total_ventile} XPF) : ecart de ${e.ecart_ventilation} XPF.`,
    });
  }

  for (const d of e.dossiers) {
    if (d.place < 0) {
      liste.push({
        gravite: 'CRITIQUE',
        code: 'RUBRIQUE_DEBITRICE',
        objet: `Dossier ${d.reference}`,
        message: `Placement rubrique debiteur de ${-d.place} XPF.`,
      });
    } else if (d.place > d.fonds_dus) {
      liste.push({
        gravite: 'CRITIQUE',
        code: 'PLACEMENT_SANS_PROVISION',
        objet: `Dossier ${d.reference}`,
        message: `${d.place} XPF places pour ${d.fonds_dus} XPF detenus : le placement excede les fonds du dossier.`,
      });
    }
  }

  if (e.produits_financiers_office > 0 && e.total_ventile > 0) {
    liste.push({
      gravite: 'MAJEURE',
      code: 'PRODUITS_FINANCIERS_OFFICE',
      objet: 'Produits financiers',
      message: `${e.produits_financiers_office} XPF de produits financiers inscrits au resultat de l office `
        + `alors que ${e.total_ventile} XPF de fonds clients sont places. L origine de ces produits doit etre `
        + `justifiee : ceux des fonds rubriques reviennent aux dossiers.`,
    });
  }

  return liste;
}
