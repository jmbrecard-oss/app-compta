/**
 * Plan comptable notarial - adaptation Nouvelle-Caledonie.
 *
 * Structure derivee du plan comptable particulier de la profession notariale
 * (classes 1 a 7, separation stricte comptabilite office / comptabilite clients),
 * avec les specificites locales :
 *   - devise XPF, sans decimale ;
 *   - TGC (taxe generale sur la consommation) a la place de la TVA ;
 *   - CAFAT a la place de l'URSSAF ;
 *   - patente et centimes additionnels en impots et taxes.
 *
 * Les comptes clients individualises (411xxxxx) ne figurent pas ici : ils sont
 * crees automatiquement a l'ouverture de chaque dossier.
 *
 * Colonnes : [numero, intitule, nature, sens_normal, lettrable, rapprochable, collectif]
 */

const C = (numero, intitule, opts = {}) => ({
  numero,
  intitule,
  classe: Number(numero[0]),
  type: Number(numero[0]) <= 5 ? 'BILAN' : 'GESTION',
  nature: opts.nature ?? 'STANDARD',
  sens_normal: opts.sens ?? 'INDIFFERENT',
  lettrable: opts.lettrable ? 1 : 0,
  rapprochable: opts.rapprochable ? 1 : 0,
  collectif: opts.collectif ? 1 : 0,
});

export const PLAN_COMPTABLE = [
  // ------------------------------------------------- 1. capitaux permanents
  C('101000', 'Capital de l office', { sens: 'CREDIT' }),
  C('106000', 'Reserves', { sens: 'CREDIT' }),
  C('108000', 'Compte de l exploitant', { sens: 'INDIFFERENT' }),
  C('110000', 'Report a nouveau (solde crediteur)', { sens: 'CREDIT' }),
  C('119000', 'Report a nouveau (solde debiteur)', { sens: 'DEBIT' }),
  C('120000', 'Resultat de l exercice - benefice', { sens: 'CREDIT' }),
  C('129000', 'Resultat de l exercice - perte', { sens: 'DEBIT' }),
  C('145000', 'Provision pour risques professionnels', { sens: 'CREDIT' }),
  C('164000', 'Emprunts aupres des etablissements de credit', { sens: 'CREDIT' }),

  // ------------------------------------------------------- 2. immobilisations
  C('205000', 'Logiciels et licences', { sens: 'DEBIT' }),
  C('207000', 'Droit de presentation de clientele', { sens: 'DEBIT' }),
  C('213000', 'Constructions', { sens: 'DEBIT' }),
  C('218300', 'Materiel de bureau et informatique', { sens: 'DEBIT' }),
  C('218400', 'Mobilier de l office', { sens: 'DEBIT' }),
  C('280500', 'Amortissements des logiciels', { sens: 'CREDIT' }),
  C('281830', 'Amortissements du materiel de bureau', { sens: 'CREDIT' }),
  C('281840', 'Amortissements du mobilier', { sens: 'CREDIT' }),

  // ---------------------------------------------------------- 4. comptes de tiers
  C('401000', 'Fournisseurs', { sens: 'CREDIT', lettrable: true }),
  C('404000', 'Fournisseurs d immobilisations', { sens: 'CREDIT', lettrable: true }),
  C('409000', 'Fournisseurs debiteurs - avances', { sens: 'DEBIT', lettrable: true }),

  C('411000', 'Comptes clients - compte collectif (non mouvemente)', {
    nature: 'CLIENT', sens: 'CREDIT', collectif: true,
  }),
  C('416000', 'Clients douteux ou litigieux', { sens: 'DEBIT', lettrable: true }),

  C('421000', 'Personnel - remunerations dues', { sens: 'CREDIT', lettrable: true }),
  C('425000', 'Personnel - avances et acomptes', { sens: 'DEBIT', lettrable: true }),
  C('431000', 'CAFAT', { sens: 'CREDIT', lettrable: true }),
  C('437000', 'Autres organismes sociaux (retraite, mutuelle)', { sens: 'CREDIT', lettrable: true }),

  C('444000', 'Impot sur le revenu / sur les societes', { sens: 'CREDIT' }),
  C('445600', 'TGC deductible', { nature: 'TAXE', sens: 'DEBIT' }),
  C('445700', 'TGC collectee', { nature: 'TAXE', sens: 'CREDIT' }),
  C('445500', 'TGC a decaisser', { nature: 'TAXE', sens: 'CREDIT' }),
  C('447000', 'Patente et autres impots locaux', { sens: 'CREDIT' }),
  C('448600', 'Droits d enregistrement a reverser au Tresor', { nature: 'TAXE', sens: 'CREDIT', lettrable: true }),
  C('448700', 'Taxe hypothecaire et salaire du conservateur a reverser', { nature: 'TAXE', sens: 'CREDIT', lettrable: true }),
  C('448800', 'Autres debours a reverser pour le compte des clients', { nature: 'TAXE', sens: 'CREDIT', lettrable: true }),

  C('467000', 'Autres comptes debiteurs ou crediteurs', { sens: 'INDIFFERENT', lettrable: true }),
  C('471000', 'Compte d attente - a solder imperativement', { nature: 'ATTENTE', sens: 'INDIFFERENT' }),
  C('473000', 'Virements internes entre comptes', { sens: 'INDIFFERENT', lettrable: true }),

  // -------------------------------------------------------- 5. comptes financiers
  C('512100', 'Banque - compte de l office', { nature: 'BANQUE_OFFICE', sens: 'DEBIT', rapprochable: true }),
  C('512500', 'Compte de depot des fonds clients', {
    nature: 'DEPOT_FONDS_CLIENTS', sens: 'DEBIT', rapprochable: true,
  }),
  C('512600', 'Compte de depot des fonds clients - placements rubriques', {
    nature: 'DEPOT_FONDS_CLIENTS', sens: 'DEBIT', rapprochable: true,
  }),
  C('514000', 'Cheques et effets a encaisser', { sens: 'DEBIT' }),
  C('531000', 'Caisse de l office', { nature: 'CAISSE', sens: 'DEBIT' }),
  C('580000', 'Virements de fonds', { sens: 'INDIFFERENT' }),

  // ------------------------------------------------------------------ 6. charges
  C('606300', 'Fournitures d entretien et petit equipement', { sens: 'DEBIT' }),
  C('606400', 'Fournitures administratives', { sens: 'DEBIT' }),
  C('613000', 'Loyers et charges locatives', { sens: 'DEBIT' }),
  C('615000', 'Entretien et reparations', { sens: 'DEBIT' }),
  C('616000', 'Assurance responsabilite civile professionnelle', { sens: 'DEBIT' }),
  C('618000', 'Documentation juridique et abonnements', { sens: 'DEBIT' }),
  C('622000', 'Honoraires et prestations exterieures', { sens: 'DEBIT' }),
  C('622600', 'Cotisations professionnelles (Chambre, instances)', { sens: 'DEBIT' }),
  C('625000', 'Deplacements et missions', { sens: 'DEBIT' }),
  C('626000', 'Frais postaux et telecommunications', { sens: 'DEBIT' }),
  C('627000', 'Services bancaires', { sens: 'DEBIT' }),
  C('631000', 'Patente et impots locaux', { sens: 'DEBIT' }),
  C('641000', 'Remunerations du personnel', { sens: 'DEBIT' }),
  C('645000', 'Charges sociales - CAFAT et retraite', { sens: 'DEBIT' }),
  C('661000', 'Charges d interets', { sens: 'DEBIT' }),
  C('681100', 'Dotations aux amortissements', { sens: 'DEBIT' }),

  // ----------------------------------------------------------------- 7. produits
  C('706100', 'Emoluments d actes (tarif reglemente)', { sens: 'CREDIT' }),
  C('706200', 'Emoluments de formalites', { sens: 'CREDIT' }),
  C('706300', 'Emoluments de negociation', { sens: 'CREDIT' }),
  C('706400', 'Honoraires libres (actes non tarifes)', { sens: 'CREDIT' }),
  C('708000', 'Produits des activites annexes', { sens: 'CREDIT' }),
  C('758000', 'Produits divers de gestion courante', { sens: 'CREDIT' }),
  C('768000', 'Autres produits financiers', { sens: 'CREDIT' }),
  C('791000', 'Transferts de charges', { sens: 'CREDIT' }),
];

export const JOURNAUX = [
  { code: 'AN', libelle: 'A nouveaux', type: 'ANOUVEAU', compte_contrepartie: null },
  { code: 'BQO', libelle: 'Banque - compte office', type: 'BANQUE', compte_contrepartie: '512100' },
  { code: 'BQC', libelle: 'Banque - depot des fonds clients', type: 'BANQUE', compte_contrepartie: '512500' },
  { code: 'CAI', libelle: 'Caisse', type: 'CAISSE', compte_contrepartie: '531000' },
  { code: 'ACH', libelle: 'Achats et frais generaux', type: 'ACHATS', compte_contrepartie: '401000' },
  { code: 'EMO', libelle: 'Emoluments et honoraires', type: 'VENTES', compte_contrepartie: null },
  { code: 'OD', libelle: 'Operations diverses', type: 'OD', compte_contrepartie: null },
];

/** Prefixe des comptes clients individualises : 411 + 5 chiffres. */
export const PREFIXE_COMPTE_CLIENT = '411';

/** Taux de TGC applicables en Nouvelle-Caledonie (en pour mille, pour rester entier). */
export const TAUX_TGC = [
  { code: 'TGC0', libelle: 'Exonere', taux_millieme: 0 },
  { code: 'TGC3', libelle: 'Taux reduit 3 %', taux_millieme: 30 },
  { code: 'TGC6', libelle: 'Taux particulier 6 %', taux_millieme: 60 },
  { code: 'TGC11', libelle: 'Taux general 11 %', taux_millieme: 110 },
  { code: 'TGC22', libelle: 'Taux superieur 22 %', taux_millieme: 220 },
];

/**
 * Comptes d'emoluments et d'honoraires.
 *
 * Toute ecriture les mouvementant se rattache a un dossier : l'article 2 de
 * l'arrete du 27 janvier 2006 soumet la taxe des actes a l'examen de
 * conformite, ce qui suppose de pouvoir remonter de chaque produit a l'acte
 * qui l'a genere.
 */
export const COMPTES_EMOLUMENTS = ['706100', '706200', '706300', '706400'];

/**
 * Comptes de tiers portant les sommes encaissees pour le compte d'autrui et
 * destinees a etre reversees (Tresor, conservation des hypotheques, divers).
 * Meme exigence de rattachement au dossier.
 */
export const COMPTES_DEBOURS_TIERS = ['448600', '448700', '448800'];

/** Compte de TGC collectee sur les emoluments. */
export const COMPTE_TGC_COLLECTEE = '445700';
