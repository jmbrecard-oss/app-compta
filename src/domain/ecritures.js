import { un, tous, exec, transaction } from '../db.js';
import { empreinteEcriture, GENESE } from '../hash.js';
import { tracer } from '../audit.js';
import { COMPTES_EMOLUMENTS, COMPTES_DEBOURS_TIERS } from '../pcn.js';
import {
  ErreurConformite,
  controleEquilibre,
  controleMontantsEntiers,
  controleComptes,
  controleExercice,
  controleChronologie,
  alerteSoldeClients,
  controleRepresentationFonds,
  controleEtancheite,
  controleRattachementActe,
} from './controles.js';
import { controleEspeces, controleCumulEspecesDossier, controleCaisseNonCreditrice } from './especes.js';
import { controleTgc } from './tgc.js';
import {
  controleRubrication,
  controleNonCompensationRubriques,
  controleRubriquesDossiers,
  dossiersConcernes,
} from './placements.js';

const EST_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normaliserLignes(lignes) {
  if (!Array.isArray(lignes) || lignes.length < 2) {
    throw new ErreurConformite('LIGNES_INSUFFISANTES', 'Une ecriture comporte au moins deux lignes.');
  }
  return lignes.map((l, i) => ({
    ordre: i + 1,
    compte: String(l.compte).trim(),
    dossier_id: l.dossier_id ?? null,
    libelle: String(l.libelle ?? '').trim(),
    debit: Math.trunc(Number(l.debit ?? 0)),
    credit: Math.trunc(Number(l.credit ?? 0)),
  }));
}

const COMPTES_DE_L_ACTE = [...COMPTES_EMOLUMENTS, ...COMPTES_DEBOURS_TIERS];

/**
 * Rattache chaque ligne a son dossier.
 *
 * 1. Une ligne de compte client appartient au dossier de ce compte.
 * 2. Une ligne d'emolument ou de debours a reverser se rapporte a l'acte :
 *    elle herite du dossier de l'ecriture lorsque celle-ci n'en designe qu'un
 *    seul. Si l'ecriture en concerne plusieurs, ou aucun, la ligne reste sans
 *    dossier et la comptabilisation la refuse : c'est alors a la saisie de
 *    designer le dossier ligne par ligne.
 *
 * Les a-nouveaux sont exclus de l'heritage : ils reprennent des soldes de
 * comptes, et le solde collectif d'un compte de debours ne se rattache a aucun
 * acte en particulier.
 */
function rattacherDossiers(lignes, { journal = null, dossier_id = null } = {}) {
  for (const l of lignes) {
    if (l.dossier_id) continue;
    const d = un('SELECT id FROM dossiers WHERE compte_client = $c', { c: l.compte });
    if (d) l.dossier_id = d.id;
  }
  if (journal === 'AN') return lignes;

  const designes = new Set(lignes.map((l) => l.dossier_id).filter(Boolean));
  if (dossier_id) designes.add(Number(dossier_id));
  if (designes.size === 1) {
    const [dossier] = [...designes];
    for (const l of lignes) {
      if (!l.dossier_id && COMPTES_DE_L_ACTE.includes(l.compte)) l.dossier_id = dossier;
    }
  }
  return lignes;
}

/** Cree une ecriture en brouillon. Rien n'est comptabilise a ce stade. */
export function creerBrouillon(saisie, utilisateur) {
  const { journal, date_ecriture, libelle } = saisie;
  if (!EST_DATE.test(date_ecriture ?? '')) {
    throw new ErreurConformite('DATE_INVALIDE', 'Date attendue au format AAAA-MM-JJ.');
  }
  if (!String(libelle ?? '').trim()) {
    throw new ErreurConformite('LIBELLE_MANQUANT', 'Le libelle de l ecriture est obligatoire.');
  }
  const j = un('SELECT * FROM journaux WHERE code = $c AND actif = 1', { c: journal });
  if (!j) throw new ErreurConformite('JOURNAL_INCONNU', `Journal ${journal} inconnu ou desactive.`);

  const exercice = controleExercice(date_ecriture);
  const lignes = rattacherDossiers(normaliserLignes(saisie.lignes), { journal, dossier_id: saisie.dossier_id });
  controleMontantsEntiers(lignes);
  controleComptes(lignes);

  return transaction(() => {
    const r = exec(
      `INSERT INTO ecritures
         (exercice_id, journal, numero, date_ecriture, date_piece, piece_ref, libelle,
          dossier_id, statut, cree_le, cree_par)
       VALUES ($ex, $j, 0, $d, $dp, $pr, $lib, $dos, 'BROUILLON', $now, $u)`,
      {
        ex: exercice.id,
        j: journal,
        d: date_ecriture,
        dp: saisie.date_piece ?? date_ecriture,
        pr: String(saisie.piece_ref ?? ''),
        lib: String(libelle).trim(),
        dos: saisie.dossier_id ?? null,
        now: new Date().toISOString(),
        u: utilisateur.identifiant,
      },
    );
    const id = Number(r.lastInsertRowid);
    // Numero provisoire negatif : les numeros definitifs sont attribues a la
    // comptabilisation, pour garantir une sequence continue sans trou.
    exec('UPDATE ecritures SET numero = $n WHERE id = $id', { n: -id, id });
    for (const l of lignes) {
      exec(
        `INSERT INTO lignes (ecriture_id, ordre, compte, dossier_id, libelle, debit, credit)
         VALUES ($e, $o, $c, $dos, $lib, $deb, $cre)`,
        { e: id, o: l.ordre, c: l.compte, dos: l.dossier_id, lib: l.libelle || String(libelle).trim(), deb: l.debit, cre: l.credit },
      );
    }
    tracer(utilisateur.identifiant, 'CREATION_BROUILLON', 'ecriture', id, `${journal} ${date_ecriture} ${libelle}`);
    return lire(id);
  });
}

/** Modifie un brouillon. Interdit des que l'ecriture est comptabilisee. */
export function modifierBrouillon(id, saisie, utilisateur) {
  const e = un('SELECT * FROM ecritures WHERE id = $id', { id });
  if (!e) throw new ErreurConformite('INTROUVABLE', `Ecriture ${id} introuvable.`);
  if (e.statut !== 'BROUILLON') {
    throw new ErreurConformite('NON_MODIFIABLE', 'Ecriture comptabilisee : seule la contre-passation est possible.');
  }
  const lignes = rattacherDossiers(normaliserLignes(saisie.lignes ?? []), {
    journal: e.journal,
    dossier_id: saisie.dossier_id ?? e.dossier_id,
  });
  controleMontantsEntiers(lignes);
  controleComptes(lignes);
  const exercice = controleExercice(saisie.date_ecriture ?? e.date_ecriture);

  return transaction(() => {
    exec(
      `UPDATE ecritures SET exercice_id = $ex, date_ecriture = $d, date_piece = $dp,
         piece_ref = $pr, libelle = $lib, dossier_id = $dos WHERE id = $id`,
      {
        ex: exercice.id,
        d: saisie.date_ecriture ?? e.date_ecriture,
        dp: saisie.date_piece ?? e.date_piece,
        pr: String(saisie.piece_ref ?? e.piece_ref),
        lib: String(saisie.libelle ?? e.libelle).trim(),
        dos: saisie.dossier_id ?? e.dossier_id,
        id,
      },
    );
    exec('DELETE FROM lignes WHERE ecriture_id = $id', { id });
    for (const l of lignes) {
      exec(
        `INSERT INTO lignes (ecriture_id, ordre, compte, dossier_id, libelle, debit, credit)
         VALUES ($e, $o, $c, $dos, $lib, $deb, $cre)`,
        { e: id, o: l.ordre, c: l.compte, dos: l.dossier_id, lib: l.libelle, deb: l.debit, cre: l.credit },
      );
    }
    tracer(utilisateur.identifiant, 'MODIFICATION_BROUILLON', 'ecriture', id, '');
    return lire(id);
  });
}

export function supprimerBrouillon(id, utilisateur) {
  const e = un('SELECT * FROM ecritures WHERE id = $id', { id });
  if (!e) throw new ErreurConformite('INTROUVABLE', `Ecriture ${id} introuvable.`);
  if (e.statut !== 'BROUILLON') {
    throw new ErreurConformite('NON_SUPPRIMABLE', 'Une ecriture comptabilisee ne peut pas etre supprimee.');
  }
  return transaction(() => {
    exec('DELETE FROM lignes WHERE ecriture_id = $id', { id });
    exec('DELETE FROM ecritures WHERE id = $id', { id });
    tracer(utilisateur.identifiant, 'SUPPRESSION_BROUILLON', 'ecriture', id, e.libelle);
    return { supprime: id };
  });
}

/**
 * Comptabilise definitivement une ecriture.
 * Lui attribue son numero de sequence, l'insere dans la chaine d'empreintes
 * et la rend inalterable. Tous les controles bloquants sont executes ici.
 */
export function valider(id, utilisateur) {
  return transaction(() => {
    const e = un('SELECT * FROM ecritures WHERE id = $id', { id });
    if (!e) throw new ErreurConformite('INTROUVABLE', `Ecriture ${id} introuvable.`);
    if (e.statut !== 'BROUILLON') throw new ErreurConformite('DEJA_VALIDEE', 'Ecriture deja comptabilisee.');

    const lignes = tous('SELECT * FROM lignes WHERE ecriture_id = $id ORDER BY ordre', { id });

    controleMontantsEntiers(lignes);
    controleEquilibre(lignes);
    controleComptes(lignes);
    controleEtancheite(lignes);
    controleRattachementActe(lignes, e);
    const especes = controleEspeces(e, lignes);
    controleTgc(lignes, e);
    controleRubrication(lignes);
    controleNonCompensationRubriques(lignes);
    const exercice = controleExercice(e.date_ecriture);
    controleChronologie(e.journal, exercice.id, e.date_ecriture);

    const numero = (un(
      `SELECT IFNULL(MAX(numero), 0) AS n FROM ecritures
       WHERE exercice_id = $ex AND journal = $j AND statut <> 'BROUILLON'`,
      { ex: exercice.id, j: e.journal },
    ).n) + 1;

    const precedent = un('SELECT hash, rang_chaine FROM ecritures WHERE rang_chaine IS NOT NULL ORDER BY rang_chaine DESC LIMIT 1');
    const hashPrecedent = precedent?.hash ?? GENESE;
    const rang = (precedent?.rang_chaine ?? 0) + 1;
    const valide_le = new Date().toISOString();

    const fige = { ...e, numero, exercice_id: exercice.id, valide_le, valide_par: utilisateur.identifiant };
    const hash = empreinteEcriture(fige, lignes, hashPrecedent);

    exec(
      `UPDATE ecritures SET statut = 'VALIDEE', numero = $num, exercice_id = $ex,
         valide_le = $vl, valide_par = $vp, rang_chaine = $rang,
         hash = $h, hash_precedent = $hp
       WHERE id = $id`,
      { num: numero, ex: exercice.id, vl: valide_le, vp: utilisateur.identifiant, rang, h: hash, hp: hashPrecedent, id },
    );

    // Controles sur l'etat resultant, dans la transaction : en cas d'echec,
    // tout est annule et l'ecriture reste en brouillon.
    const comptesClients = lignes
      .map((l) => un('SELECT numero, nature FROM comptes WHERE numero = $n', { n: l.compte }))
      .filter((c) => c?.nature === 'CLIENT')
      .map((c) => c.numero);
    // Le solde client debiteur ALERTE mais ne bloque pas : un debours regle
    // avant l'arrivee de la provision est courant. L'anomalie est tracee,
    // portee a l'etat des comptes debiteurs, et la regularisation est exigee
    // a la cloture de l'exercice.
    const alertes = alerteSoldeClients(comptesClients);

    // La representation des fonds clients, elle, reste bloquante : un deficit
    // signifie que les fonds d'un client ont servi a autre chose.
    controleRubriquesDossiers(dossiersConcernes(lignes));
    controleRepresentationFonds();
    if (especes) {
      controleCumulEspecesDossier(especes.dossiers);
      controleCaisseNonCreditrice();
    }

    tracer(
      utilisateur.identifiant, 'COMPTABILISATION', 'ecriture', id,
      `${e.journal}-${numero} ${e.date_ecriture} ${e.libelle} hash=${hash.slice(0, 16)}`,
    );
    for (const a of alertes) {
      tracer(utilisateur.identifiant, 'ALERTE_SOLDE_DEBITEUR', 'ecriture', id, a.message);
    }
    return { ...lire(id), alertes };
  });
}

/**
 * Contre-passation : unique moyen de corriger une ecriture comptabilisee.
 * Genere une ecriture miroir a la date du jour comptable indiquee.
 */
export function contrepasser(id, { date_ecriture, motif }, utilisateur) {
  return transaction(() => {
    const e = un('SELECT * FROM ecritures WHERE id = $id', { id });
    if (!e) throw new ErreurConformite('INTROUVABLE', `Ecriture ${id} introuvable.`);
    if (e.statut !== 'VALIDEE') {
      throw new ErreurConformite('NON_CONTREPASSABLE', 'Seule une ecriture comptabilisee et non deja contre-passee peut l etre.');
    }
    if (!String(motif ?? '').trim()) {
      throw new ErreurConformite('MOTIF_MANQUANT', 'Le motif de la contre-passation est obligatoire et conserve.');
    }
    const lignes = tous('SELECT * FROM lignes WHERE ecriture_id = $id ORDER BY ordre', { id });
    const date = date_ecriture ?? new Date().toISOString().slice(0, 10);

    const miroir = creerBrouillon(
      {
        journal: e.journal,
        date_ecriture: date,
        piece_ref: e.piece_ref,
        libelle: `CONTRE-PASSATION ${e.journal}-${e.numero} : ${motif}`,
        dossier_id: e.dossier_id,
        lignes: lignes.map((l) => ({
          compte: l.compte,
          dossier_id: l.dossier_id,
          libelle: `Extourne : ${l.libelle}`,
          debit: l.credit,
          credit: l.debit,
        })),
      },
      utilisateur,
    );

    // Le lien vers l'ecriture d'origine est pose AVANT la comptabilisation :
    // les controles doivent savoir qu'ils examinent une extourne, et non une
    // ecriture nouvelle.
    exec('UPDATE ecritures SET contrepassation_de = $id WHERE id = $m', { id, m: miroir.id });

    const validee = valider(miroir.id, utilisateur);
    exec(`UPDATE ecritures SET statut = 'CONTREPASSEE', contrepassee_par = $m WHERE id = $id`, { m: validee.id, id });
    tracer(utilisateur.identifiant, 'CONTRE_PASSATION', 'ecriture', id, `vers ${validee.id} - ${motif}`);
    return { origine: lire(id), contrepassation: lire(validee.id) };
  });
}

// ------------------------------------------------------------------ lecture

export function lire(id) {
  const e = un('SELECT * FROM ecritures WHERE id = $id', { id });
  if (!e) return null;
  e.lignes = tous(
    `SELECT l.*, c.intitule AS compte_intitule, d.reference AS dossier_reference
     FROM lignes l
     JOIN comptes c ON c.numero = l.compte
     LEFT JOIN dossiers d ON d.id = l.dossier_id
     WHERE l.ecriture_id = $id ORDER BY l.ordre`,
    { id },
  );
  e.total_debit = e.lignes.reduce((s, l) => s + l.debit, 0);
  e.total_credit = e.lignes.reduce((s, l) => s + l.credit, 0);
  return e;
}

export function rechercher({ journal, statut, dossier_id, compte, depuis, jusqu, limite = 200 } = {}) {
  const ecritures = tous(
    `SELECT DISTINCT e.* FROM ecritures e
     LEFT JOIN lignes l ON l.ecriture_id = e.id
     WHERE ($journal IS NULL OR e.journal = $journal)
       AND ($statut  IS NULL OR e.statut  = $statut)
       AND ($dossier IS NULL OR e.dossier_id = $dossier OR l.dossier_id = $dossier)
       AND ($compte  IS NULL OR l.compte = $compte)
       AND ($depuis  IS NULL OR e.date_ecriture >= $depuis)
       AND ($jusqu   IS NULL OR e.date_ecriture <= $jusqu)
     ORDER BY e.date_ecriture DESC, e.id DESC
     LIMIT $limite`,
    {
      journal: journal ?? null, statut: statut ?? null, dossier: dossier_id ?? null,
      compte: compte ?? null, depuis: depuis ?? null, jusqu: jusqu ?? null, limite,
    },
  );
  for (const e of ecritures) {
    e.lignes = tous('SELECT * FROM lignes WHERE ecriture_id = $id ORDER BY ordre', { id: e.id });
    e.total_debit = e.lignes.reduce((s, l) => s + l.debit, 0);
  }
  return ecritures;
}

/** Recalcule la chaine d'empreintes de toutes les ecritures comptabilisees. */
export function verifierChaineEcritures() {
  const liste = tous('SELECT * FROM ecritures WHERE rang_chaine IS NOT NULL ORDER BY rang_chaine');
  let precedent = GENESE;
  let rangAttendu = 1;
  for (const e of liste) {
    if (e.rang_chaine !== rangAttendu) {
      return { valide: false, ecriture_id: e.id, motif: `rang de chaine manquant (attendu ${rangAttendu})` };
    }
    if (e.hash_precedent !== precedent) {
      return { valide: false, ecriture_id: e.id, motif: 'chainage rompu' };
    }
    const lignes = tous('SELECT * FROM lignes WHERE ecriture_id = $id ORDER BY ordre', { id: e.id });
    if (empreinteEcriture(e, lignes, precedent) !== e.hash) {
      return { valide: false, ecriture_id: e.id, motif: 'contenu altere depuis la comptabilisation' };
    }
    precedent = e.hash;
    rangAttendu++;
  }
  return { valide: true, ecritures: liste.length, hash_final: precedent };
}
