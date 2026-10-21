// L'interface n'est jamais chargee par les autres tests : une erreur de
// syntaxe dans public/app.js ou un onglet sans vue correspondante passent donc
// inapercus, et l'application se presente a l'ecran avec une page blanche
// alors que toute la suite est au vert. C'est arrive lors de la fusion des
// branches : ces verifications existent pour que cela ne se reproduise pas.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (p) => readFileSync(join(racine, p), 'utf8');

const app = lire('public/app.js');
const html = lire('public/index.html');
const css = lire('public/styles.css');

test('public/app.js est syntaxiquement valide', () => {
  // node --check analyse le fichier sans l'executer : pas de DOM necessaire.
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(racine, 'public/app.js')]));
});

test('chaque onglet de la barre de navigation a une vue qui lui repond', () => {
  const onglets = [...html.matchAll(/data-vue="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(onglets.length >= 8, 'la barre de navigation doit etre peuplee');

  const registre = app.slice(app.indexOf('const VUES'));
  for (const onglet of onglets) {
    assert.match(registre, new RegExp(`\\b${onglet}:`),
      `l onglet « ${onglet} » n a aucune entree dans le registre VUES`);
  }
});

test('chaque vue du registre est definie', () => {
  const bloc = app.slice(app.indexOf('const VUES'));
  const fin = bloc.indexOf('};');
  const appelees = [...bloc.slice(0, fin).matchAll(/:\s*(vue[A-Za-z]+)/g)].map((m) => m[1]);
  assert.ok(appelees.length >= 8);
  for (const nom of appelees) {
    assert.match(app, new RegExp(`function ${nom}\\s*\\(`),
      `le registre reference ${nom}, qui n est definie nulle part`);
  }
});

test('les modeles de saisie sont bien formes et sans doublon', () => {
  const debut = app.indexOf('const MODELES = [');
  const corps = app.slice(debut, app.indexOf('\n];\n', debut));
  const noms = [...corps.matchAll(/nom: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);

  assert.ok(noms.length >= 8, 'les modeles d ecriture doivent etre presents');
  assert.equal(new Set(noms).size, noms.length, 'deux modeles portent le meme libelle');

  // Chaque modele doit porter au moins deux lignes : une ecriture est en
  // partie double.
  const modeles = corps.split(/\n  \{/).slice(1);
  for (const m of modeles) {
    const lignes = (m.match(/\{ compte:/g) ?? []).length;
    assert.ok(lignes >= 2, `un modele ne propose que ${lignes} ligne(s)`);
  }
});

test('les accolades de la feuille de style sont equilibrees', () => {
  let profondeur = 0;
  for (const c of css) {
    if (c === '{') profondeur++;
    else if (c === '}') profondeur--;
    assert.ok(profondeur >= 0, 'accolade fermante en trop');
  }
  assert.equal(profondeur, 0, 'accolade ouvrante non refermee');
});

test('les balises de la page sont equilibrees', () => {
  for (const balise of ['div', 'form', 'table', 'main', 'nav']) {
    const ouvertes = (html.match(new RegExp(`<${balise}[ >]`, 'g')) ?? []).length;
    const fermees = (html.match(new RegExp(`</${balise}>`, 'g')) ?? []).length;
    assert.equal(ouvertes, fermees, `balise <${balise}> desequilibree`);
  }
});

test('aucune route de l API n est declaree deux fois', () => {
  const serveur = lire('src/server.js');
  const routes = [...serveur.matchAll(/route\('(\w+)', '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  const doublons = routes.filter((r, i) => routes.indexOf(r) !== i);
  assert.deepEqual(doublons, [], `routes declarees deux fois : ${doublons.join(', ')}`);
});
