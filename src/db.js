import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ici = dirname(fileURLToPath(import.meta.url));
export const RACINE = join(ici, '..');

let db = null;

export function ouvrirBase(chemin = process.env.COMPTA_DB ?? join(RACINE, 'data', 'compta.sqlite')) {
  if (db) return db;
  if (chemin !== ':memory:') mkdirSync(dirname(chemin), { recursive: true });
  db = new DatabaseSync(chemin);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrer(db);
  db.exec(readFileSync(join(ici, 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Mises a niveau du schema d'une base deja installee.
 *
 * schema.sql est rejoue a chaque ouverture, mais CREATE TABLE IF NOT EXISTS
 * n'ajoute aucune colonne a une table existante. Les ajouts de colonne sont
 * donc declares ici, et appliques AVANT schema.sql pour que les vues qui s'y
 * appuient puissent etre creees.
 */
const MIGRATIONS = [
  { table: 'comptes', colonne: 'rubrique', sql: 'ALTER TABLE comptes ADD COLUMN rubrique INTEGER NOT NULL DEFAULT 0' },
];

function migrer(db) {
  for (const m of MIGRATIONS) {
    const colonnes = db.prepare(`PRAGMA table_info(${m.table})`).all().map((c) => c.name);
    if (colonnes.length && !colonnes.includes(m.colonne)) db.exec(m.sql);
  }
}

export function base() {
  if (!db) ouvrirBase();
  return db;
}

/** Lecture : toutes les lignes. */
export function tous(sql, params = {}) {
  return base().prepare(sql).all(params);
}

/** Lecture : premiere ligne ou undefined. */
export function un(sql, params = {}) {
  return base().prepare(sql).get(params);
}

/** Ecriture : renvoie { changes, lastInsertRowid }. */
export function exec(sql, params = {}) {
  return base().prepare(sql).run(params);
}

// Les transactions ne s'imbriquent pas en SQLite : on compte la profondeur.
let profondeur = 0;

export function transaction(fn) {
  const racine = profondeur === 0;
  if (racine) base().exec('BEGIN IMMEDIATE');
  profondeur++;
  try {
    const r = fn();
    profondeur--;
    if (racine) base().exec('COMMIT');
    return r;
  } catch (e) {
    profondeur--;
    if (racine) {
      try { base().exec('ROLLBACK'); } catch { /* transaction deja annulee */ }
    }
    throw e;
  }
}

export function fermerBase() {
  if (db) { db.close(); db = null; profondeur = 0; }
}
