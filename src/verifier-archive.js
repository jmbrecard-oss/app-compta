#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { verifierArchive } from './reports/verification-archive.js';

/**
 * Verification independante d'une archive scellee.
 *
 * Cet utilitaire n'ouvre pas la base de donnees et n'a besoin ni de
 * l'application ni du serveur : il lit un fichier d'archive et rend un
 * verdict. Un inspecteur, un commissaire aux comptes ou l'office lui-meme
 * peuvent le lancer sur une copie du fichier, hors de l'etude :
 *
 *   node src/verifier-archive.js 1234567-ARCHIVE-20261020.json
 *   node src/verifier-archive.js archive.json --racine <empreinte deposee>
 *
 * Code de sortie : 0 si l'archive est conforme, 1 sinon.
 */

const AIDE = `Usage : node src/verifier-archive.js <archive.json> [--racine <empreinte>]

  <archive.json>        archive editee par l'office (export "Archive scellee")
  --racine <empreinte>  empreinte de racine deposee hors de l'archive, a
                        confronter au contenu du fichier. Sans elle, la
                        verification etablit la coherence interne de l'archive,
                        pas le fait qu'il s'agisse bien de celle de l'office.
`;

function principal(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--aide') || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(AIDE);
    return args.length ? 0 : 1;
  }

  let racineAttendue = null;
  let chemin = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--racine') {
      racineAttendue = args[++i] ?? null;
      if (!racineAttendue) {
        process.stdout.write('L option --racine attend une empreinte.\n\n' + AIDE);
        return 1;
      }
    } else if (!chemin) {
      chemin = args[i];
    }
  }

  if (!chemin) {
    process.stdout.write('Aucun fichier d archive indique.\n\n' + AIDE);
    return 1;
  }

  let texte;
  try {
    texte = readFileSync(chemin, 'utf8');
  } catch (e) {
    process.stdout.write(`Fichier illisible : ${e.message}\n`);
    return 1;
  }

  const r = verifierArchive(texte, { racine_attendue: racineAttendue });
  const lignes = [];
  const ecrire = (s = '') => lignes.push(s);

  ecrire('Verification d archive comptable - procedure independante');
  ecrire('='.repeat(72));
  ecrire(`Fichier  : ${basename(chemin)}`);
  ecrire(`Format   : ${r.format ?? '(inconnu)'} version ${r.version ?? '?'}`);

  if (r.scelle?.recalcule) {
    ecrire(`Scelle   : ${r.scelle.recalcule}`);
    ecrire(`           ${r.scelle.intact ? 'intact - le document n a pas ete modifie' : 'ROMPU - le document a ete modifie depuis son edition'}`);
  }
  if (r.racine_chaine) {
    ecrire(`Racine   : ${r.racine_chaine}`);
    ecrire(racineAttendue
      ? `           confrontee a l empreinte deposee (${racineAttendue.slice(0, 16)}...)`
      : '           empreinte a confronter au depot conserve hors de l archive');
  }

  if (r.volumetrie) {
    ecrire();
    ecrire('Volumetrie');
    ecrire(`  ecritures comptabilisees : ${r.volumetrie.ecritures} (${r.volumetrie.lignes} lignes)`);
    ecrire(`  total debit / credit     : ${r.volumetrie.total_debit} / ${r.volumetrie.total_credit} XPF`);
    ecrire(`  dossiers / comptes       : ${r.volumetrie.dossiers} / ${r.volumetrie.comptes}`);
    ecrire(`  evenements d audit       : ${r.volumetrie.evenements_audit}`);
  }

  if (r.controles.length) {
    ecrire();
    ecrire('Controles');
    for (const c of r.controles) {
      ecrire(`  [${c.verdict === 'OK' ? ' OK ' : 'ECHEC'}] ${c.intitule}${c.detail ? ` - ${c.detail}` : ''}`);
    }
  }

  if (r.anomalies.length) {
    ecrire();
    ecrire(`Anomalies (${r.anomalies.length})`);
    for (const a of r.anomalies.slice(0, 50)) ecrire(`  ${a.code} : ${a.message}`);
    if (r.anomalies.length > 50) ecrire(`  ... et ${r.anomalies.length - 50} autre(s).`);
  }

  ecrire();
  ecrire('='.repeat(72));
  if (r.valide) {
    ecrire('ARCHIVE CONFORME');
    ecrire(racineAttendue
      ? 'Le contenu correspond a l empreinte deposee : archive authentifiee.'
      : 'Coherence interne etablie. Pour authentifier l archive, relancer avec'
        + "\n--racine suivi de l empreinte deposee hors de l archive.");
  } else {
    ecrire('ARCHIVE NON CONFORME');
    ecrire('Cette archive ne peut pas etre opposee : voir les anomalies ci-dessus.');
  }

  process.stdout.write(lignes.join('\n') + '\n');
  return r.valide ? 0 : 1;
}

process.exitCode = principal(process.argv);
