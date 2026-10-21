import { sha256, empreinteEcriture, empreinteAudit, GENESE } from '../hash.js';

/**
 * Verification d'une archive scellee - procedure independante.
 *
 * Ce module ne touche jamais a la base de donnees : il ne connait que le
 * fichier d'archive qu'on lui remet et la formule d'empreinte publiee
 * (src/hash.js). C'est ce qui lui donne sa valeur de preuve : un inspecteur
 * peut le rejouer sur sa propre machine, sans l'application, sans la base, et
 * obtenir le meme verdict que l'office.
 *
 * Ce qu'il etablit : le contenu de l'archive est exactement celui qui a ete
 * comptabilise, dans le meme ordre, sans ajout, suppression ni retouche.
 *
 * Ce qu'il n'etablit pas a lui seul : qu'il s'agit bien de l'archive de
 * l'office. Une chaine d'empreintes integralement reforgee est coherente avec
 * elle-meme. Seule la confrontation a la racine deposee hors de l'archive
 * (option racine_attendue) ferme cette porte - voir CONFORMITE.md.
 */

export const FORMAT = 'ARCHIVE-COMPTA-NOTARIALE-NC';
export const VERSION = 1;

/**
 * Forme canonique : cles triees, aucun espace, aucune ambiguite de
 * representation. Deux archives au contenu identique produisent la meme
 * chaine de caracteres, quelle que soit la mise en forme du fichier.
 */
export function canonique(valeur) {
  if (valeur === null) return 'null';
  const t = typeof valeur;
  if (t === 'string' || t === 'boolean') return JSON.stringify(valeur);
  if (t === 'number') {
    if (!Number.isFinite(valeur)) throw new Error(`Valeur numerique non representable : ${valeur}`);
    return JSON.stringify(valeur);
  }
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`;
  if (t === 'object') {
    const corps = Object.keys(valeur)
      .sort()
      .filter((c) => valeur[c] !== undefined)
      .map((c) => `${JSON.stringify(c)}:${canonique(valeur[c])}`);
    return `{${corps.join(',')}}`;
  }
  throw new Error(`Type non serialisable dans une archive : ${t}`);
}

/** Scelle de l'archive : empreinte de tout le document, hors le scelle lui-meme. */
export function scelleDe(archive) {
  const { scelle, ...reste } = archive;
  return sha256(canonique(reste));
}

/**
 * Racine de la chaine : empreinte de la derniere ecriture comptabilisee.
 * C'est la valeur a deposer hors de l'archive (proces-verbal de la Chambre,
 * registre de l'office, courrier au commissaire aux comptes) : elle resume en
 * 64 caracteres l'integralite des ecritures anterieures.
 */
export function empreinteRacine(ecritures) {
  if (!Array.isArray(ecritures) || ecritures.length === 0) return GENESE;
  let derniere = ecritures[0];
  for (const e of ecritures) if (e.rang_chaine > derniere.rang_chaine) derniere = e;
  return derniere.hash;
}

const estEntier = (n) => Number.isInteger(n);

/**
 * Verifie une archive, fournie sous forme de texte JSON ou d'objet deja lu.
 * Ne leve jamais : tout defaut est rendu comme anomalie, y compris un fichier
 * illisible. Un verificateur qui plante ne prouve rien.
 */
export function verifierArchive(entree, { racine_attendue = null } = {}) {
  const anomalies = [];
  const controles = [];
  const signaler = (code, message, extra = {}) => anomalies.push({ code, message, ...extra });
  const noter = (intitule, codesSurveilles) => {
    const echecs = anomalies.filter((a) => codesSurveilles.includes(a.code));
    controles.push({
      intitule,
      verdict: echecs.length ? 'ECHEC' : 'OK',
      detail: echecs.length ? `${echecs.length} anomalie(s) : ${[...new Set(echecs.map((e) => e.code))].join(', ')}` : '',
    });
  };
  const rapport = (extra = {}) => ({
    valide: anomalies.length === 0,
    format: extra.format ?? null,
    version: extra.version ?? null,
    scelle: extra.scelle ?? { attendu: null, recalcule: null, intact: false },
    racine_chaine: extra.racine_chaine ?? null,
    racine_audit: extra.racine_audit ?? null,
    volumetrie: extra.volumetrie ?? null,
    controles,
    anomalies,
  });

  // ------------------------------------------------------------- lecture --

  let archive = entree;
  if (typeof entree === 'string') {
    try {
      archive = JSON.parse(entree);
    } catch {
      signaler('ARCHIVE_ILLISIBLE', 'Le fichier n est pas un document JSON exploitable.');
      return rapport();
    }
  }
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    signaler('ARCHIVE_ILLISIBLE', 'L archive attendue est un objet JSON.');
    return rapport();
  }
  if (archive.format !== FORMAT || archive.version !== VERSION) {
    signaler(
      'FORMAT_INCONNU',
      `Format d archive non reconnu : ${archive.format ?? '(absent)'} version ${archive.version ?? '(absente)'}. `
      + `Attendu : ${FORMAT} version ${VERSION}.`,
    );
    return rapport({ format: archive.format ?? null, version: archive.version ?? null });
  }

  const contenu = archive.contenu;
  if (!contenu || typeof contenu !== 'object'
      || !Array.isArray(contenu.ecritures) || !Array.isArray(contenu.audit)
      || !Array.isArray(contenu.comptes) || !Array.isArray(contenu.dossiers)
      || !Array.isArray(contenu.exercices)) {
    signaler('ARCHIVE_ILLISIBLE', 'L archive ne comporte pas les sections attendues.');
    return rapport({ format: archive.format, version: archive.version });
  }

  // -------------------------------------------------------------- scelle --

  let recalcule = null;
  try {
    recalcule = scelleDe(archive);
  } catch (e) {
    signaler('ARCHIVE_ILLISIBLE', `Contenu non serialisable : ${e.message}`);
    return rapport({ format: archive.format, version: archive.version });
  }
  if (recalcule !== archive.scelle) {
    signaler(
      'SCELLE_ROMPU',
      'Le scelle ne correspond pas au contenu : le fichier a ete modifie depuis son edition.',
      { attendu: archive.scelle ?? null, recalcule },
    );
  }
  noter('Scelle du document', ['SCELLE_ROMPU']);

  const scelle = { attendu: archive.scelle ?? null, recalcule, intact: recalcule === archive.scelle };

  // ------------------------------------------- chaine d'empreintes des ecritures

  const ecritures = contenu.ecritures.slice().sort((a, b) => a.rang_chaine - b.rang_chaine);
  let precedent = GENESE;
  let rangAttendu = 1;
  for (const e of ecritures) {
    if (e.rang_chaine !== rangAttendu) {
      signaler(
        'RANG_MANQUANT',
        `Rang de chaine ${rangAttendu} attendu, ${e.rang_chaine} trouve : une ecriture a ete retiree `
        + 'de l archive, ou un rang y figure deux fois.',
        { rang_chaine: e.rang_chaine, rang_attendu: rangAttendu, journal: e.journal, numero: e.numero },
      );
      rangAttendu = e.rang_chaine;
    }
    if (e.hash_precedent !== precedent) {
      signaler(
        'CHAINAGE_ROMPU',
        `Ecriture ${e.journal}-${e.numero} : le maillon precedent declare ne correspond pas a l ecriture qui precede.`,
        { rang_chaine: e.rang_chaine, journal: e.journal, numero: e.numero },
      );
    }
    let recalculee = null;
    try {
      recalculee = empreinteEcriture(e, Array.isArray(e.lignes) ? e.lignes : [], e.hash_precedent ?? GENESE);
    } catch {
      recalculee = null;
    }
    if (recalculee !== e.hash) {
      signaler(
        'ECRITURE_ALTEREE',
        `Ecriture ${e.journal}-${e.numero} du ${e.date_ecriture} : le contenu ne correspond plus a son empreinte.`,
        { rang_chaine: e.rang_chaine, journal: e.journal, numero: e.numero, attendu: e.hash ?? null, recalcule: recalculee },
      );
    }
    precedent = e.hash;
    rangAttendu++;
  }
  noter('Chaine d empreintes des ecritures', ['RANG_MANQUANT', 'CHAINAGE_ROMPU', 'ECRITURE_ALTEREE']);

  // -------------------------------------------------------- numerotation --
  // Une suppression suivie d'un re-chainage complet laisse malgre tout un trou
  // dans la numerotation du journal : ce controle-la ne se contourne pas sans
  // renumeroter tout le journal.

  const parJournal = new Map();
  for (const e of ecritures) {
    const cle = `${e.exercice_id}|${e.journal}`;
    if (!parJournal.has(cle)) parJournal.set(cle, []);
    parJournal.get(cle).push(e.numero);
  }
  for (const [cle, numeros] of parJournal) {
    const [exercice, journal] = cle.split('|');
    const tries = numeros.slice().sort((a, b) => a - b);
    for (let i = 0; i < tries.length; i++) {
      if (tries[i] !== i + 1) {
        signaler(
          'NUMEROTATION_DISCONTINUE',
          `Journal ${journal} (exercice ${exercice}) : numerotation interrompue, ${i + 1} attendu, ${tries[i]} trouve.`,
          { journal, exercice_id: Number(exercice), numero_attendu: i + 1, numero_trouve: tries[i] },
        );
        break;
      }
    }
  }
  noter('Continuite de la numerotation par journal', ['NUMEROTATION_DISCONTINUE']);

  // ------------------------------------------------------------ equilibre --

  let totalDebit = 0;
  let totalCredit = 0;
  let totalLignes = 0;
  for (const e of ecritures) {
    const lignes = Array.isArray(e.lignes) ? e.lignes : [];
    totalLignes += lignes.length;
    let debit = 0;
    let credit = 0;
    for (const l of lignes) {
      if (!estEntier(l.debit) || !estEntier(l.credit) || l.debit < 0 || l.credit < 0) {
        signaler(
          'MONTANT_NON_ENTIER',
          `Ecriture ${e.journal}-${e.numero}, compte ${l.compte} : montant non entier ou negatif. `
          + 'Le franc Pacifique ne comporte pas de decimale.',
          { rang_chaine: e.rang_chaine, compte: l.compte, debit: l.debit, credit: l.credit },
        );
        continue;
      }
      if (l.debit !== 0 && l.credit !== 0) {
        signaler(
          'LIGNE_INCOHERENTE',
          `Ecriture ${e.journal}-${e.numero}, compte ${l.compte} : une ligne ne peut porter a la fois un debit et un credit.`,
          { rang_chaine: e.rang_chaine, compte: l.compte },
        );
      }
      debit += l.debit;
      credit += l.credit;
    }
    totalDebit += debit;
    totalCredit += credit;
    if (debit !== credit) {
      signaler(
        'ECRITURE_DESEQUILIBREE',
        `Ecriture ${e.journal}-${e.numero} du ${e.date_ecriture} : ${debit} XPF au debit contre ${credit} XPF au credit.`,
        { rang_chaine: e.rang_chaine, journal: e.journal, numero: e.numero, debit, credit, ecart: debit - credit },
      );
    }
  }
  if (totalDebit !== totalCredit) {
    signaler(
      'ARCHIVE_DESEQUILIBREE',
      `L archive n est pas equilibree : ${totalDebit} XPF au debit contre ${totalCredit} XPF au credit.`,
      { total_debit: totalDebit, total_credit: totalCredit, ecart: totalDebit - totalCredit },
    );
  }
  noter('Partie double et montants entiers', [
    'MONTANT_NON_ENTIER', 'LIGNE_INCOHERENTE', 'ECRITURE_DESEQUILIBREE', 'ARCHIVE_DESEQUILIBREE',
  ]);

  // --------------------------------------------------------------- statuts --

  for (const e of ecritures) {
    if (e.statut !== 'VALIDEE' && e.statut !== 'CONTREPASSEE') {
      signaler(
        'BROUILLON_DANS_ARCHIVE',
        `Ecriture ${e.journal}-${e.numero} au statut ${e.statut} : une archive ne contient que des ecritures comptabilisees.`,
        { rang_chaine: e.rang_chaine, statut: e.statut ?? null },
      );
    }
  }
  noter('Ecritures comptabilisees seulement', ['BROUILLON_DANS_ARCHIVE']);

  // ------------------------------------------------------------ references --

  const comptes = new Set(contenu.comptes.map((c) => c.numero));
  const dossiers = new Set(contenu.dossiers.map((d) => d.id));
  for (const e of ecritures) {
    for (const l of Array.isArray(e.lignes) ? e.lignes : []) {
      if (!comptes.has(l.compte)) {
        signaler(
          'COMPTE_INCONNU',
          `Ecriture ${e.journal}-${e.numero} : le compte ${l.compte} ne figure pas au plan comptable de l archive.`,
          { rang_chaine: e.rang_chaine, compte: l.compte },
        );
      }
      if (l.dossier_id !== null && l.dossier_id !== undefined && !dossiers.has(l.dossier_id)) {
        signaler(
          'DOSSIER_INCONNU',
          `Ecriture ${e.journal}-${e.numero} : le dossier ${l.dossier_id} ne figure pas dans l archive.`,
          { rang_chaine: e.rang_chaine, dossier_id: l.dossier_id },
        );
      }
    }
  }
  noter('Integrite des references (comptes, dossiers)', ['COMPTE_INCONNU', 'DOSSIER_INCONNU']);

  // -------------------------------------------------------- chaine d'audit --

  let precedentAudit = GENESE;
  for (const evt of contenu.audit) {
    if (evt.hash_precedent !== precedentAudit) {
      signaler(
        'AUDIT_CHAINAGE_ROMPU',
        `Journal d audit : chainage rompu a l evenement ${evt.id} (${evt.action}).`,
        { id: evt.id ?? null, action: evt.action ?? null },
      );
    }
    let recalculeAudit = null;
    try {
      recalculeAudit = empreinteAudit(evt, evt.hash_precedent ?? GENESE);
    } catch {
      recalculeAudit = null;
    }
    if (recalculeAudit !== evt.hash) {
      signaler(
        'AUDIT_ALTERE',
        `Journal d audit : l evenement ${evt.id} (${evt.action}) a ete retouche.`,
        { id: evt.id ?? null, action: evt.action ?? null },
      );
    }
    precedentAudit = evt.hash;
  }
  noter('Chaine du journal d audit', ['AUDIT_CHAINAGE_ROMPU', 'AUDIT_ALTERE']);

  // ---------------------------------------------------------- exercices clos --

  for (const ex of contenu.exercices) {
    if (ex.statut === 'CLOS' && !ex.cloture_hash) {
      signaler(
        'EXERCICE_CLOS_SANS_EMPREINTE',
        `L exercice ${ex.libelle} est declare clos sans empreinte de cloture.`,
        { exercice: ex.libelle ?? null },
      );
    }
  }
  noter('Scellement des exercices clos', ['EXERCICE_CLOS_SANS_EMPREINTE']);

  // ------------------------------------------------- confrontation a la racine --

  const racineChaine = empreinteRacine(ecritures);
  if (racine_attendue) {
    if (racine_attendue !== racineChaine) {
      signaler(
        'RACINE_DIFFERENTE',
        'La racine de la chaine ne correspond pas a la valeur deposee : cette archive n est pas celle qui a ete arretee.',
        { attendue: racine_attendue, trouvee: racineChaine },
      );
    }
    noter('Confrontation a la racine deposee', ['RACINE_DIFFERENTE']);
  }

  return rapport({
    format: archive.format,
    version: archive.version,
    scelle,
    racine_chaine: racineChaine,
    racine_audit: precedentAudit,
    volumetrie: {
      ecritures: ecritures.length,
      lignes: totalLignes,
      evenements_audit: contenu.audit.length,
      exercices: contenu.exercices.length,
      dossiers: contenu.dossiers.length,
      comptes: contenu.comptes.length,
      total_debit: totalDebit,
      total_credit: totalCredit,
    },
  });
}
