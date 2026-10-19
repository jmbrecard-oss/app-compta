import { un, tous } from '../db.js';
import { etatRepresentationFonds, etatDeboursAReverser, anomalies } from '../domain/controles.js';
import { baremeCourant, baremeFictif, listerTaxes, lireTaxe } from '../domain/tarif.js';

const bornes = (p = {}) => ({
  depuis: p.depuis ?? null,
  jusqu: p.jusqu ?? null,
});

/** Balance generale : debits, credits et soldes par compte. */
export function balance(p = {}) {
  const { depuis, jusqu } = bornes(p);
  // La jointure sur les ecritures est conditionnelle : sans agregation
  // conditionnelle, les lignes des brouillons seraient malgre tout sommees.
  const lignes = tous(
    `SELECT c.numero, c.intitule, c.classe, c.nature,
            IFNULL(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit  ELSE 0 END), 0) AS debit,
            IFNULL(SUM(CASE WHEN e.id IS NOT NULL THEN l.credit ELSE 0 END), 0) AS credit
     FROM comptes c
     LEFT JOIN lignes l    ON l.compte = c.numero
     LEFT JOIN ecritures e ON e.id = l.ecriture_id
       AND e.statut <> 'BROUILLON'
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     WHERE c.collectif = 0
     GROUP BY c.numero
     HAVING debit <> 0 OR credit <> 0
     ORDER BY c.numero`,
    { depuis, jusqu },
  ).map((r) => ({
    ...r,
    solde_debiteur: Math.max(r.debit - r.credit, 0),
    solde_crediteur: Math.max(r.credit - r.debit, 0),
  }));

  const totaux = lignes.reduce(
    (t, l) => ({
      debit: t.debit + l.debit,
      credit: t.credit + l.credit,
      solde_debiteur: t.solde_debiteur + l.solde_debiteur,
      solde_crediteur: t.solde_crediteur + l.solde_crediteur,
    }),
    { debit: 0, credit: 0, solde_debiteur: 0, solde_crediteur: 0 },
  );

  return { lignes, totaux, equilibree: totaux.debit === totaux.credit, periode: { depuis, jusqu } };
}

/** Grand livre d'un compte, avec solde progressif. */
export function grandLivre(compte, p = {}) {
  const { depuis, jusqu } = bornes(p);
  const c = un('SELECT * FROM comptes WHERE numero = $n', { n: compte });
  if (!c) return null;

  const anterieur = un(
    `SELECT IFNULL(SUM(l.debit - l.credit), 0) AS solde
     FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       AND ($depuis IS NULL OR e.date_ecriture < $depuis)`,
    { c: compte, depuis },
  ).solde;

  let cumul = anterieur;
  const mouvements = tous(
    `SELECT e.id AS ecriture_id, e.date_ecriture, e.journal, e.numero, e.piece_ref, e.statut,
            l.libelle, l.debit, l.credit, l.lettrage, d.reference AS dossier
     FROM lignes l
     JOIN ecritures e ON e.id = l.ecriture_id
     LEFT JOIN dossiers d ON d.id = l.dossier_id
     WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       AND ($depuis IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR e.date_ecriture <= $jusqu)
     ORDER BY e.date_ecriture, e.id, l.ordre`,
    { c: compte, depuis, jusqu },
  ).map((m) => {
    cumul += m.debit - m.credit;
    return { ...m, solde_progressif: cumul };
  });

  return { compte: c, solde_anterieur: anterieur, mouvements, solde_final: cumul, periode: { depuis, jusqu } };
}

/** Journal comptable, ecritures comptabilisees uniquement. */
export function journal(code, p = {}) {
  const { depuis, jusqu } = bornes(p);
  const ecritures = tous(
    `SELECT * FROM ecritures
     WHERE ($code IS NULL OR journal = $code) AND statut <> 'BROUILLON'
       AND ($depuis IS NULL OR date_ecriture >= $depuis)
       AND ($jusqu  IS NULL OR date_ecriture <= $jusqu)
     ORDER BY journal, numero`,
    { code: code ?? null, depuis, jusqu },
  );
  for (const e of ecritures) {
    e.lignes = tous(
      `SELECT l.*, c.intitule AS compte_intitule FROM lignes l
       JOIN comptes c ON c.numero = l.compte
       WHERE l.ecriture_id = $id ORDER BY l.ordre`,
      { id: e.id },
    );
  }
  return { journal: code ?? 'TOUS', ecritures, periode: { depuis, jusqu } };
}

/** Compte de resultat de l'office (classes 6 et 7). */
export function compteDeResultat(p = {}) {
  const b = balance(p);
  const charges = b.lignes.filter((l) => l.classe === 6);
  const produits = b.lignes.filter((l) => l.classe === 7);
  const totalCharges = charges.reduce((s, l) => s + l.debit - l.credit, 0);
  const totalProduits = produits.reduce((s, l) => s + l.credit - l.debit, 0);
  return {
    charges, produits,
    total_charges: totalCharges,
    total_produits: totalProduits,
    resultat: totalProduits - totalCharges,
    periode: b.periode,
  };
}

/** Bilan simplifie de l'office. */
export function bilan(p = {}) {
  const b = balance(p);
  const actif = b.lignes.filter((l) => l.classe <= 5 && l.solde_debiteur > 0);
  const passif = b.lignes.filter((l) => l.classe <= 5 && l.solde_crediteur > 0);
  const resultat = compteDeResultat(p).resultat;
  return {
    actif,
    passif,
    total_actif: actif.reduce((s, l) => s + l.solde_debiteur, 0),
    total_passif: passif.reduce((s, l) => s + l.solde_crediteur, 0),
    resultat,
    periode: b.periode,
  };
}

/**
 * Etat des comptes clients : piece maitresse du controle de la comptabilite
 * notariale. Recapitule dossier par dossier les fonds detenus et confronte
 * le total aux disponibilites des comptes de depot.
 */
export function etatComptesClients() {
  const dossiers = tous(
    `SELECT v.*, d.notaire, d.nature_acte, d.ouvert_le
     FROM v_soldes_dossiers v JOIN dossiers d ON d.id = v.id
     WHERE v.solde <> 0 OR v.statut = 'OUVERT'
     ORDER BY v.reference`,
  ).map((d) => ({ ...d, fonds_detenus: -d.solde }));

  const representation = etatRepresentationFonds();
  return {
    arrete_le: new Date().toISOString().slice(0, 10),
    dossiers,
    nombre_dossiers: dossiers.length,
    dossiers_debiteurs: dossiers.filter((d) => d.solde > 0),
    total_fonds_detenus: dossiers.reduce((s, d) => s + Math.max(d.fonds_detenus, 0), 0),
    representation,
  };
}

/**
 * Etat des taxes d'actes.
 *
 * Rapproche la liquidation du tarif de sa traduction comptable : ce qui est
 * encore en projet, ce qui est arrete sans etre comptabilise - donc facture au
 * client sans produit enregistre - et ce qui est comptabilise.
 */
export function etatTaxes({ dossier_id } = {}) {
  const toutes = listerTaxes({ dossier_id });
  const bareme = baremeCourant();
  const somme = (liste, champ) => liste.reduce((s, t) => s + t[champ], 0);
  const comptabilisees = toutes.filter((t) => t.statut === 'COMPTABILISEE');

  return {
    arrete_le: new Date().toISOString().slice(0, 10),
    bareme: {
      code: bareme.meta.code,
      libelle: bareme.meta.libelle,
      statut: bareme.meta.statut,
      texte_reference: bareme.meta.texte_reference,
      a_valider_par: bareme.meta.a_valider_par,
      avertissement: bareme.meta.avertissement,
      empreinte: bareme.empreinte,
      fictif: baremeFictif(bareme),
    },
    projets: toutes.filter((t) => t.statut === 'PROJET'),
    a_comptabiliser: toutes.filter((t) => t.statut === 'ARRETEE'),
    comptabilisees,
    totaux: {
      emoluments: somme(comptabilisees, 'total_emoluments'),
      tgc: somme(comptabilisees, 'total_tgc'),
      debours: somme(comptabilisees, 'total_debours'),
      du: somme(comptabilisees, 'total_du'),
    },
    // Une taxe liquidee sur un bareme qui n'est plus celui du jour reste
    // verifiable : son empreinte designe le fichier qui l'a produite.
    baremes_anterieurs: [...new Set(toutes.map((t) => t.bareme_empreinte))].filter((e) => e !== bareme.empreinte),
  };
}

/**
 * Compte definitif du client.
 *
 * Etat remis au client a la fin du dossier : ce qu'il a verse, ce que l'acte
 * lui a coute - emoluments, TGC, debours reverses pour son compte - et le
 * solde qui lui revient ou qui reste du.
 */
export function compteDefinitif(dossierId) {
  const d = un('SELECT * FROM v_soldes_dossiers WHERE id = $id', { id: dossierId });
  if (!d) return null;
  const fiche = un('SELECT * FROM dossiers WHERE id = $id', { id: dossierId });

  const taxes = listerTaxes({ dossier_id: dossierId }).map((t) => lireTaxe(t.id));
  const comptabilisees = taxes.filter((t) => t.statut === 'COMPTABILISEE');
  const somme = (champ) => comptabilisees.reduce((s, t) => s + t[champ], 0);

  return {
    dossier: fiche,
    arrete_le: new Date().toISOString().slice(0, 10),
    recu: d.total_credit,          // fonds recus du client ou pour son compte
    impute: d.total_debit,         // taxes, debours regles, restitutions
    solde_detenu: d.total_credit - d.total_debit,
    taxes,
    total_taxe: somme('total_du'),
    detail: {
      emoluments: somme('total_emoluments'),
      tgc: somme('total_tgc'),
      debours: somme('total_debours'),
    },
    taxes_non_comptabilisees: taxes.filter((t) => t.statut !== 'COMPTABILISEE'),
    mouvements: tous(
      `SELECT e.date_ecriture, e.journal, e.numero, e.piece_ref, l.libelle, l.debit, l.credit
       FROM lignes l JOIN ecritures e ON e.id = l.ecriture_id
       WHERE l.compte = $c AND e.statut <> 'BROUILLON'
       ORDER BY e.date_ecriture, e.id, l.ordre`,
      { c: fiche.compte_client },
    ),
    bareme_fictif: taxes.some((t) => t.bareme_statut !== 'VALIDE') || baremeFictif(),
  };
}

/**
 * Dossier d'inspection : ensemble des etats remis lors du controle de
 * comptabilite diligente par la Chambre.
 */
export function dossierInspection(p = {}) {
  const chaineEcritures = un(`SELECT COUNT(*) AS n FROM ecritures WHERE statut <> 'BROUILLON'`).n;
  return {
    office: un('SELECT * FROM office WHERE id = 1'),
    edite_le: new Date().toISOString(),
    periode: bornes(p),
    exercices: tous('SELECT * FROM exercices ORDER BY date_debut'),
    balance: balance(p),
    comptes_clients: etatComptesClients(),
    representation_fonds: etatRepresentationFonds(),
    taxes: etatTaxes(),
    debours_a_reverser: etatDeboursAReverser(),
    anomalies: anomalies(),
    comptes_attente: tous(`SELECT * FROM v_soldes WHERE nature = 'ATTENTE'`),
    rapprochements: tous(
      `SELECT r.*, c.intitule FROM rapprochements r JOIN comptes c ON c.numero = r.compte
       ORDER BY r.date_arrete DESC LIMIT 24`,
    ),
    volumetrie: {
      ecritures_comptabilisees: chaineEcritures,
      dossiers_ouverts: un(`SELECT COUNT(*) AS n FROM dossiers WHERE statut = 'OUVERT'`).n,
      contrepassations: un(`SELECT COUNT(*) AS n FROM ecritures WHERE statut = 'CONTREPASSEE'`).n,
    },
  };
}
