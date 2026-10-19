import { un, tous, exec, transaction } from '../db.js';
import { tracer } from '../audit.js';
import { ErreurConformite } from '../erreurs.js';
import { creerBrouillon, valider, lire } from './ecritures.js';
import { COMPTE_TGC_COLLECTEE } from '../pcn.js';
import { baremeCourant, calculerPrestation, simulerTaxe, totaliser } from './bareme.js';

/**
 * Taxe des actes : cycle de vie et consequences comptables.
 *
 * Une taxe nait en PROJET (modifiable, sans effet comptable), est ARRETEE
 * (chaque ligne est alors recalculee depuis le bareme et confrontee a ce qui
 * est enregistre, puis la base la verrouille), enfin COMPTABILISEE : une
 * ecriture lui est attachee et passe sans exception tous les controles de
 * comptabilisation.
 *
 * La liquidation elle-meme appartient au moteur de baremes (./bareme.js) :
 * aucun chiffre de tarif ne figure ici.
 */

// Facade : le moteur de baremes reste accessible par ce module, qui est le
// point d'entree du tarif pour le serveur et pour les etats.
export {
  CHEMIN_BAREME_DEFAUT, arrondir, validerBareme, chargerBareme, baremeCourant,
  baremeFictif, calculerPrestation, simulerTaxe,
} from './bareme.js';

// ------------------------------------------------------- cycle de la taxe --

const EST_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Numerotation des taxes : plus grand numero existant, plus un.
 * Comme un brouillon d'ecriture, un projet supprime ne consomme aucune
 * reference - il n'a produit ni ecriture ni document remis au client. Une
 * taxe arretee, elle, n'est plus supprimable : sa reference est definitive.
 */
function prochaineReference() {
  const max = un(
    `SELECT IFNULL(MAX(CAST(SUBSTR(reference, 4) AS INTEGER)), 0) AS n FROM taxes WHERE reference LIKE 'TX-%'`,
  ).n;
  return `TX-${String(max + 1).padStart(5, '0')}`;
}

/** Cree la taxe en PROJET : modifiable, sans effet comptable. */
export function creerTaxe(saisie, utilisateur, bareme = baremeCourant()) {
  const dossier = un('SELECT * FROM dossiers WHERE id = $id', { id: saisie?.dossier_id });
  if (!dossier) {
    throw new ErreurConformite('DOSSIER_INTROUVABLE', 'La taxe d un acte se rattache a un dossier ouvert.', { dossier_id: saisie?.dossier_id });
  }
  if (dossier.statut !== 'OUVERT') {
    throw new ErreurConformite('DOSSIER_CLOS', `Le dossier ${dossier.reference} n est plus ouvert : aucune taxe ne peut lui etre ajoutee.`);
  }
  if (!EST_DATE.test(saisie.date_acte ?? '')) {
    throw new ErreurConformite('DATE_INVALIDE', 'Date de l acte attendue au format AAAA-MM-JJ.');
  }
  if (!String(saisie.acte ?? '').trim()) {
    throw new ErreurConformite('ACTE_MANQUANT', 'La designation de l acte taxe est obligatoire.');
  }
  const liquidation = simulerTaxe(saisie, bareme);

  return transaction(() => {
    const reference = prochaineReference();
    const r = exec(
      `INSERT INTO taxes (reference, dossier_id, acte, date_acte, bareme_code, bareme_statut,
                          bareme_empreinte, total_emoluments, total_debours, total_tgc, total_du,
                          statut, cree_le, cree_par)
       VALUES ($ref, $dos, $acte, $date, $bc, $bs, $be, $em, $deb, $tgc, $du, 'PROJET', $now, $u)`,
      {
        ref: reference, dos: dossier.id, acte: String(saisie.acte).trim(), date: saisie.date_acte,
        bc: bareme.meta.code, bs: bareme.meta.statut, be: bareme.empreinte,
        em: liquidation.total_emoluments, deb: liquidation.total_debours,
        tgc: liquidation.total_tgc, du: liquidation.total_du,
        now: new Date().toISOString(), u: utilisateur.identifiant,
      },
    );
    const id = Number(r.lastInsertRowid);
    for (const l of liquidation.lignes) insererLigne(id, l);
    tracer(utilisateur.identifiant, 'CREATION_TAXE', 'taxe', id, `${reference} ${dossier.reference} ${liquidation.total_du} XPF`);
    return lireTaxe(id);
  });
}

function insererLigne(taxeId, l) {
  exec(
    `INSERT INTO taxes_lignes (taxe_id, ordre, prestation_code, libelle, categorie, compte,
                               assiette, quantite, montant, tgc_code, tgc_montant, detail)
     VALUES ($t, $o, $pc, $lib, $cat, $c, $a, $q, $m, $tc, $tm, $d)`,
    {
      t: taxeId, o: l.ordre, pc: l.code, lib: l.libelle, cat: l.categorie, c: l.compte,
      a: l.assiette, q: l.quantite, m: l.montant, tc: l.tgc_code, tm: l.tgc_montant, d: l.detail,
    },
  );
}

/**
 * Arrete la taxe : chaque ligne est recalculee depuis le bareme et confrontee
 * a ce qui est enregistre. Une taxe retouchee a la main ne passe pas.
 */
export function arreterTaxe(id, utilisateur, bareme = baremeCourant()) {
  return transaction(() => {
    const t = lireTaxe(id);
    if (!t) throw new ErreurConformite('INTROUVABLE', `Taxe ${id} introuvable.`);
    if (t.statut !== 'PROJET') throw new ErreurConformite('TAXE_DEJA_ARRETEE', `La taxe ${t.reference} est deja arretee.`);
    if (!t.lignes.length) throw new ErreurConformite('TAXE_VIDE', 'Une taxe comporte au moins une prestation.');

    for (const l of t.lignes) {
      const attendue = calculerPrestation(
        { code: l.prestation_code, assiette: l.assiette, quantite: l.quantite, montant: l.montant, libelle: l.libelle },
        bareme,
      );
      if (attendue.montant !== l.montant || attendue.tgc_montant !== l.tgc_montant || attendue.compte !== l.compte) {
        throw new ErreurConformite(
          'TAXE_NON_CONFORME_BAREME',
          `Taxe ${t.reference}, ligne ${l.ordre} (${l.prestation_code}) : le bareme ${bareme.meta.code} liquide `
          + `${attendue.montant} XPF (+${attendue.tgc_montant} de TGC) sur le compte ${attendue.compte}, `
          + `la taxe porte ${l.montant} XPF (+${l.tgc_montant}) sur ${l.compte}.`,
          { ligne: l.ordre, prestation: l.prestation_code, attendu: attendue.montant, enregistre: l.montant },
        );
      }
    }

    const totaux = totaliser(t.lignes);
    if (totaux.total_du !== t.total_du
      || totaux.total_emoluments !== t.total_emoluments
      || totaux.total_debours !== t.total_debours
      || totaux.total_tgc !== t.total_tgc) {
      throw new ErreurConformite(
        'TAXE_NON_CONFORME_BAREME',
        `Taxe ${t.reference} : les totaux enregistres ne correspondent pas a la somme des lignes.`,
        { enregistre: t.total_du, recalcule: totaux.total_du },
      );
    }

    exec(
      `UPDATE taxes SET statut = 'ARRETEE', arrete_le = $d, arrete_par = $u,
         bareme_code = $bc, bareme_statut = $bs, bareme_empreinte = $be WHERE id = $id`,
      {
        d: new Date().toISOString(), u: utilisateur.identifiant,
        bc: bareme.meta.code, bs: bareme.meta.statut, be: bareme.empreinte, id,
      },
    );
    tracer(utilisateur.identifiant, 'ARRET_TAXE', 'taxe', id, `${t.reference} ${t.total_du} XPF bareme=${bareme.meta.code}`);
    return lireTaxe(id);
  });
}

/**
 * Ecriture de taxe : le compte client du dossier est debite du total du,
 * les comptes d'emoluments, la TGC collectee et les comptes de debours a
 * reverser sont credites. Les controles de comptabilisation s'appliquent sans
 * exception : si le dossier n'a pas ete provisionne, l'ecriture est refusee,
 * l'office n'ayant pas a avancer les droits pour le compte de son client.
 */
export function comptabiliserTaxe(id, utilisateur, { date_ecriture, journal = 'EMO' } = {}) {
  return transaction(() => {
    const t = lireTaxe(id);
    if (!t) throw new ErreurConformite('INTROUVABLE', `Taxe ${id} introuvable.`);
    if (t.statut === 'COMPTABILISEE') {
      throw new ErreurConformite(
        'TAXE_DEJA_COMPTABILISEE',
        `La taxe ${t.reference} est deja comptabilisee (ecriture ${t.ecriture_id}). La corriger suppose une contre-passation et une nouvelle taxe.`,
        { ecriture_id: t.ecriture_id },
      );
    }
    if (t.statut !== 'ARRETEE') {
      throw new ErreurConformite('TAXE_NON_ARRETEE', `La taxe ${t.reference} doit etre arretee avant d etre comptabilisee.`);
    }
    if (t.total_du <= 0) {
      throw new ErreurConformite(
        'TAXE_SANS_MONTANT',
        `La taxe ${t.reference} ne porte aucun montant : il n y a rien a comptabiliser.`,
      );
    }
    const dossier = un('SELECT * FROM dossiers WHERE id = $id', { id: t.dossier_id });

    // Un credit par compte d'imputation : emoluments, puis TGC, puis debours.
    const cumuls = new Map();
    const ajouter = (compte, libelle, montant) => {
      if (montant <= 0) return;
      const c = cumuls.get(compte) ?? { compte, libelle, montant: 0 };
      c.montant += montant;
      cumuls.set(compte, c);
    };
    for (const l of t.lignes.filter((x) => x.categorie === 'EMOLUMENT')) ajouter(l.compte, l.libelle, l.montant);
    ajouter(COMPTE_TGC_COLLECTEE, 'TGC collectee sur emoluments', t.total_tgc);
    for (const l of t.lignes.filter((x) => x.categorie !== 'EMOLUMENT')) ajouter(l.compte, l.libelle, l.montant);

    const lignes = [
      {
        compte: dossier.compte_client,
        dossier_id: dossier.id,
        libelle: `Taxe ${t.reference} - ${t.acte}`,
        debit: t.total_du,
        credit: 0,
      },
      ...[...cumuls.values()].map((c) => ({
        compte: c.compte,
        dossier_id: dossier.id,
        libelle: c.libelle,
        debit: 0,
        credit: c.montant,
      })),
    ];

    const brouillon = creerBrouillon(
      {
        journal,
        date_ecriture: date_ecriture ?? t.date_acte,
        date_piece: t.date_acte,
        piece_ref: t.reference,
        libelle: `Taxe de l acte - ${t.acte} (${dossier.reference})`,
        dossier_id: dossier.id,
        lignes,
      },
      utilisateur,
    );
    const ecriture = valider(brouillon.id, utilisateur);

    exec(`UPDATE taxes SET statut = 'COMPTABILISEE', ecriture_id = $e WHERE id = $id`, { e: ecriture.id, id });
    tracer(utilisateur.identifiant, 'COMPTABILISATION_TAXE', 'taxe', id, `${t.reference} -> ecriture ${ecriture.id}`);
    return { taxe: lireTaxe(id), ecriture };
  });
}

/** Un projet reste supprimable ; une taxe arretee ne l'est plus. */
export function supprimerTaxe(id, utilisateur) {
  const t = un('SELECT * FROM taxes WHERE id = $id', { id });
  if (!t) throw new ErreurConformite('INTROUVABLE', `Taxe ${id} introuvable.`);
  if (t.statut !== 'PROJET') {
    throw new ErreurConformite('TAXE_NON_SUPPRIMABLE', `La taxe ${t.reference} est arretee : elle ne peut plus etre supprimee.`);
  }
  return transaction(() => {
    exec('DELETE FROM taxes_lignes WHERE taxe_id = $id', { id });
    exec('DELETE FROM taxes WHERE id = $id', { id });
    tracer(utilisateur.identifiant, 'SUPPRESSION_TAXE', 'taxe', id, t.reference);
    return { supprime: id };
  });
}

// ------------------------------------------------------------- lecture --

export function lireTaxe(id) {
  const t = un(
    `SELECT t.*, d.reference AS dossier_reference, d.intitule AS dossier_intitule, d.compte_client
     FROM taxes t JOIN dossiers d ON d.id = t.dossier_id WHERE t.id = $id`,
    { id },
  );
  if (!t) return null;
  t.lignes = tous('SELECT * FROM taxes_lignes WHERE taxe_id = $id ORDER BY ordre', { id });
  return t;
}

export function listerTaxes({ dossier_id, statut } = {}) {
  return tous(
    `SELECT t.*, d.reference AS dossier_reference, d.intitule AS dossier_intitule
     FROM taxes t JOIN dossiers d ON d.id = t.dossier_id
     WHERE ($dos IS NULL OR t.dossier_id = $dos)
       AND ($st  IS NULL OR t.statut = $st)
     ORDER BY t.date_acte DESC, t.id DESC`,
    { dos: dossier_id ?? null, st: statut ?? null },
  );
}

/** Ecriture rattachee a une taxe, pour la consultation. */
export function ecritureDeLaTaxe(id) {
  const t = un('SELECT ecriture_id FROM taxes WHERE id = $id', { id });
  return t?.ecriture_id ? lire(t.ecriture_id) : null;
}
