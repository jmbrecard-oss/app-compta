// Interface de la comptabilite notariale. Aucune dependance externe.

const etat = { utilisateur: null, journaux: [], comptes: [], dossiers: [], vue: 'tableau' };

// ------------------------------------------------------------------ outils

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** XPF : entier, sans decimale, separateur de milliers insecable. */
const xpf = (n) => (n === null || n === undefined ? '' : new Intl.NumberFormat('fr-FR').format(Math.trunc(n)));

const montantClasse = (n) => (n < 0 ? 'nb negatif' : 'nb');

const dateFr = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

const aujourdhui = () => new Date().toISOString().slice(0, 10);

function message(texte, erreur = false) {
  const b = $('#bandeau-message');
  b.textContent = texte;
  b.className = `message${erreur ? ' erreur-message' : ''}`;
  b.hidden = false;
  clearTimeout(message.minuteur);
  message.minuteur = setTimeout(() => { b.hidden = true; }, erreur ? 8000 : 3500);
}

async function api(chemin, options = {}) {
  const reponse = await fetch(`/api${chemin}`, {
    method: options.methode ?? 'GET',
    headers: options.corps ? { 'content-type': 'application/json' } : {},
    body: options.corps ? JSON.stringify(options.corps) : undefined,
  });
  if (reponse.headers.get('content-type')?.includes('application/json')) {
    const donnees = await reponse.json();
    if (!reponse.ok) {
      const e = new Error(donnees.erreur ?? 'Erreur');
      e.code = donnees.code;
      e.details = donnees.details;
      throw e;
    }
    return donnees;
  }
  if (!reponse.ok) throw new Error('Erreur serveur');
  return reponse;
}

/** Enveloppe un gestionnaire pour afficher proprement les refus de conformite. */
const garde = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { message(e.message, true); }
};

// --------------------------------------------------------------- connexion

$('#form-connexion').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const donnees = Object.fromEntries(new FormData(ev.target));
  try {
    const r = await api('/connexion', { methode: 'POST', corps: donnees });
    document.cookie = `jeton=${encodeURIComponent(r.jeton)}; path=/; SameSite=Strict; max-age=43200`;
    await demarrer();
  } catch (e) {
    $('#erreur-connexion').textContent = e.message;
  }
});

$('#btn-deconnexion').addEventListener('click', async () => {
  await api('/deconnexion', { methode: 'POST', corps: {} }).catch(() => {});
  document.cookie = 'jeton=; path=/; max-age=0';
  location.reload();
});

$$('#menu button').forEach((b) => b.addEventListener('click', () => afficher(b.dataset.vue)));

async function demarrer() {
  etat.utilisateur = await api('/moi');
  const { office, exercices } = await api('/office');
  etat.journaux = await api('/journaux');
  etat.exercices = exercices;

  $('#connexion').hidden = true;
  $('#application').hidden = false;
  $('#nom-office').textContent = office.denomination;
  const ouvert = exercices.find((e) => e.statut === 'OUVERT');
  $('#exercice-courant').textContent = ouvert ? `Exercice ${ouvert.libelle}` : 'Aucun exercice ouvert';
  $('#nom-utilisateur').textContent = `${etat.utilisateur.nom} — ${etat.utilisateur.role.toLowerCase()}`;
  await afficher('tableau');
}

async function afficher(vue) {
  etat.vue = vue;
  $$('#menu button').forEach((b) => b.classList.toggle('actif', b.dataset.vue === vue));
  $('#contenu').innerHTML = '<p class="vide">Chargement…</p>';
  try {
    await VUES[vue]();
  } catch (e) {
    $('#contenu').innerHTML = `<div class="alerte"><strong>Erreur</strong>${echapper(e.message)}</div>`;
  }
}

// ============================================================ tableau de bord

async function vueTableau() {
  const d = await api('/tableau-de-bord');
  const f = d.representation_fonds;
  const critiques = d.anomalies.filter((a) => a.gravite === 'CRITIQUE');

  $('#contenu').innerHTML = `
    <div class="grille">
      <div class="carte">
        <div class="libelle-indicateur">Fonds détenus pour les clients</div>
        <div class="indicateur">${xpf(f.du_aux_clients)} <small>XPF</small></div>
        <p>Représentés par ${xpf(f.representation_totale)} XPF de disponibilités.</p>
        <span class="pastille ${f.conforme ? 'ok' : 'critique'}">
          ${f.conforme ? `Fonds représentés (marge ${xpf(f.ecart)} XPF)` : `Déficit de ${xpf(-f.ecart)} XPF`}
        </span>
      </div>
      <div class="carte">
        <div class="libelle-indicateur">Résultat de l'exercice</div>
        <div class="indicateur ${d.resultat.resultat < 0 ? 'negatif' : ''}">${xpf(d.resultat.resultat)} <small>XPF</small></div>
        <p>${xpf(d.resultat.produits)} de produits — ${xpf(d.resultat.charges)} de charges.</p>
      </div>
      <div class="carte">
        <div class="libelle-indicateur">Dossiers</div>
        <div class="indicateur">${d.dossiers.ouverts}</div>
        <p>${d.dossiers.debiteurs > 0
            ? `<span class="pastille critique">${d.dossiers.debiteurs} compte(s) client débiteur(s)</span>`
            : '<span class="pastille ok">Aucun compte client débiteur</span>'}</p>
      </div>
      <div class="carte">
        <div class="libelle-indicateur">Inaltérabilité</div>
        <div class="indicateur">${d.chaine.valide ? '✓' : '✕'}</div>
        <p>${d.chaine.valide
            ? `${d.chaine.ecritures} écritures scellées, chaîne intègre.`
            : `Chaîne rompue à l'écriture ${d.chaine.ecriture_id} : ${echapper(d.chaine.motif)}`}</p>
        <p class="empreinte">${echapper((d.chaine.hash_final ?? '').slice(0, 32))}…</p>
      </div>
    </div>

    ${critiques.length ? `<h3>Anomalies bloquantes</h3>${d.anomalies.map(carteAnomalie).join('')}`
      : `<h3>Contrôles de conformité</h3>
         ${d.anomalies.length ? d.anomalies.map(carteAnomalie).join('')
           : '<div class="alerte information"><strong>Conforme</strong>Aucune anomalie détectée.</div>'}`}

    <h3>Trésorerie</h3>
    <div class="carte defilant">
      <table>
        <thead><tr><th>Compte</th><th>Intitulé</th><th>Nature</th><th class="nb">Solde (XPF)</th></tr></thead>
        <tbody>${d.tresorerie.map((t) => `
          <tr>
            <td class="compte">${echapper(t.numero)}</td>
            <td>${echapper(t.intitule)}</td>
            <td>${t.nature === 'DEPOT_FONDS_CLIENTS' ? '<span class="pastille minuscule">fonds clients</span>' : '<span class="pastille minuscule">office</span>'}</td>
            <td class="${montantClasse(t.solde)}">${xpf(t.solde)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/**
 * Placements en compte rubrique : ce que le controle verifie d'abord, c'est
 * que la somme des rubriques des dossiers reconstitue exactement le solde du
 * compte de depot, et que chaque dossier reste couvert par ses propres fonds.
 */
const cartePlacements = (p) => `
  <div class="carte" style="margin-top:1rem">
    <header>
      <h2>Placements en compte rubriqué</h2>
      <a class="lien" href="/api/export/placements.csv" download>Exporter (CSV)</a>
    </header>
    <div class="alerte ${p.ventilation_conforme ? 'information' : ''}">
      <strong>Ventilation des fonds placés</strong>
      ${p.ventilation_conforme
        ? `${xpf(p.solde_comptes)} XPF placés, intégralement rattachés aux dossiers.`
        : `Écart de ${xpf(p.ecart_ventilation)} XPF entre le solde des comptes rubriqués et la somme des rubriques des dossiers.`}
    </div>
    ${p.dossiers.length ? `
    <div class="defilant"><table>
      <thead><tr>
        <th>Dossier</th><th>Intitulé</th>
        <th class="nb">Placé</th><th class="nb">Fonds détenus</th>
        <th class="nb">Non placé</th><th class="nb">Produits affectés</th>
      </tr></thead>
      <tbody>${p.dossiers.map((d) => `
        <tr>
          <td class="compte">${echapper(d.reference)}</td>
          <td>${echapper(d.intitule)}</td>
          <td class="${d.conforme ? 'nb' : 'nb negatif'}">${xpf(d.place)}${d.conforme ? '' : ' ⚠'}</td>
          <td class="nb">${xpf(d.fonds_dus)}</td>
          <td class="nb">${xpf(d.disponible_non_place)}</td>
          <td class="nb">${xpf(d.produits_affectes)}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <th colspan="2">Total</th><th class="nb">${xpf(p.total_ventile)}</th>
        <th></th><th></th><th class="nb">${xpf(p.total_produits_affectes)}</th>
      </tr></tfoot>
    </table></div>`
      : '<p class="vide">Aucun dossier n\'a de fonds placés en compte rubriqué.</p>'}
    <p class="vide" style="font-style:normal">
      Les produits d'un placement reviennent au dossier qui les a produits : leur inscription
      en produit de l'office est refusée à la comptabilisation.
    </p>
  </div>`;

const carteAnomalie = (a) => `
  <div class="alerte ${a.gravite.toLowerCase()}">
    <strong>${echapper(a.gravite)} — ${echapper(a.objet)}</strong>${echapper(a.message)}
  </div>`;

// ==================================================================== saisie

const MODELES = [
  {
    nom: 'Réception de fonds d\'un client',
    journal: 'BQC',
    lignes: [
      { compte: '512500', sens: 'debit' },
      { compte: '', sens: 'credit', client: true },
    ],
  },
  {
    nom: 'Paiement d\'un débours pour le client',
    journal: 'BQC',
    lignes: [
      { compte: '', sens: 'debit', client: true },
      { compte: '512500', sens: 'credit' },
    ],
  },
  {
    nom: 'Facturation des émoluments au dossier',
    journal: 'EMO',
    lignes: [
      { compte: '', sens: 'debit', client: true },
      { compte: '706100', sens: 'credit' },
      { compte: '445700', sens: 'credit' },
    ],
  },
  {
    nom: 'Virement des émoluments vers le compte office',
    journal: 'OD',
    lignes: [
      { compte: '512100', sens: 'debit' },
      { compte: '512500', sens: 'credit' },
    ],
  },
  {
    nom: 'Restitution du solde au client',
    journal: 'BQC',
    lignes: [
      { compte: '', sens: 'debit', client: true },
      { compte: '512500', sens: 'credit' },
    ],
  },
  {
    nom: 'Placement des fonds du dossier en compte rubriqué',
    journal: 'BQC',
    lignes: [
      { compte: '512600', sens: 'debit', dossier: true },
      { compte: '512500', sens: 'credit' },
    ],
  },
  {
    nom: 'Dénouement d\'un placement rubriqué',
    journal: 'BQC',
    lignes: [
      { compte: '512500', sens: 'debit' },
      { compte: '512600', sens: 'credit', dossier: true },
    ],
  },
  {
    nom: 'Produits du placement affectés au dossier',
    journal: 'BQC',
    lignes: [
      { compte: '512600', sens: 'debit', dossier: true },
      { compte: '', sens: 'credit', client: true },
    ],
  },
  { nom: 'Écriture libre', journal: 'OD', lignes: [{ compte: '' }, { compte: '' }] },
];

async function vueSaisie() {
  etat.comptes = await api('/comptes');
  etat.dossiers = await api('/dossiers?statut=OUVERT');

  $('#contenu').innerHTML = `
    <div class="carte">
      <h2>Saisie d'une écriture</h2>
      <form id="form-saisie">
        <div class="barre-outils">
          <label>Modèle
            <select id="modele">${MODELES.map((m, i) => `<option value="${i}">${echapper(m.nom)}</option>`).join('')}</select>
          </label>
          <label>Journal
            <select name="journal" id="champ-journal">
              ${etat.journaux.map((j) => `<option value="${j.code}">${j.code} — ${echapper(j.libelle)}</option>`).join('')}
            </select>
          </label>
          <label>Date <input type="date" name="date_ecriture" value="${aujourdhui()}" required></label>
          <label>Pièce <input name="piece_ref" placeholder="n° de pièce"></label>
          <label style="flex:1">Libellé <input name="libelle" required placeholder="Objet de l'écriture"></label>
        </div>

        <div class="defilant">
          <table class="lignes-saisie">
            <thead><tr><th style="width:22%">Compte</th><th style="width:22%">Dossier</th><th>Libellé</th><th class="nb" style="width:13%">Débit</th><th class="nb" style="width:13%">Crédit</th><th></th></tr></thead>
            <tbody id="lignes"></tbody>
          </table>
        </div>

        <div class="barre-outils" style="margin-top:.6rem">
          <button type="button" class="secondaire" id="ajouter-ligne">+ Ligne</button>
          <div class="totaux-saisie" style="flex:1">
            <span>Débit <strong id="total-debit">0</strong></span>
            <span>Crédit <strong id="total-credit">0</strong></span>
            <span id="ecart"></span>
          </div>
          <button type="submit" class="secondaire">Enregistrer en brouillon</button>
          <button type="button" id="enregistrer-valider">Comptabiliser</button>
        </div>
      </form>
    </div>

    <div class="carte" style="margin-top:1rem">
      <h2>Brouillons en attente</h2>
      <div id="liste-brouillons"></div>
    </div>`;

  appliquerModele(0);
  $('#modele').addEventListener('change', (e) => appliquerModele(Number(e.target.value)));
  $('#ajouter-ligne').addEventListener('click', () => ajouterLigne());
  $('#form-saisie').addEventListener('input', recalculer);
  $('#form-saisie').addEventListener('submit', garde(async (e) => { e.preventDefault(); await soumettre(false); }));
  $('#enregistrer-valider').addEventListener('click', garde(() => soumettre(true)));
  await rafraichirBrouillons();
}

function optionsComptes(selection = '') {
  return `<option value="">—</option>` + etat.comptes
    .filter((c) => !c.collectif && c.actif)
    .map((c) => `<option value="${c.numero}" ${c.numero === selection ? 'selected' : ''}>${c.numero} ${echapper(c.intitule)}</option>`)
    .join('');
}

function optionsDossiers(selection = '') {
  return `<option value="">—</option>` + etat.dossiers
    .map((d) => `<option value="${d.id}" data-compte="${d.compte_client}" ${String(d.id) === String(selection) ? 'selected' : ''}>${echapper(d.reference)} — ${echapper(d.intitule)}</option>`)
    .join('');
}

function ajouterLigne(modele = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="l-compte">${optionsComptes(modele.compte ?? '')}</select></td>
    <td><select class="l-dossier">${optionsDossiers('')}</select></td>
    <td><input class="l-libelle" placeholder="(libellé de l'écriture)"></td>
    <td><input class="l-debit nb" type="number" step="1" min="0" inputmode="numeric"></td>
    <td><input class="l-credit nb" type="number" step="1" min="0" inputmode="numeric"></td>
    <td><button type="button" class="lien l-suppr">✕</button></td>`;
  $('#lignes').append(tr);

  // Le choix d'un dossier impute son compte client tant qu'aucun compte n'est
  // saisi. Sur une ligne deja imputee — placement rubrique, debours — il se
  // borne a designer le dossier, qui est transmis avec la ligne.
  $('.l-dossier', tr).addEventListener('change', (e) => {
    const compteClient = e.target.selectedOptions[0]?.dataset.compte;
    const champ = $('.l-compte', tr);
    if (compteClient && !champ.value) champ.value = compteClient;
    recalculer();
  });
  // Debit et credit s'excluent sur une meme ligne.
  $('.l-debit', tr).addEventListener('input', () => { if ($('.l-debit', tr).value) $('.l-credit', tr).value = ''; });
  $('.l-credit', tr).addEventListener('input', () => { if ($('.l-credit', tr).value) $('.l-debit', tr).value = ''; });
  $('.l-suppr', tr).addEventListener('click', () => { tr.remove(); recalculer(); });
  return tr;
}

function appliquerModele(index) {
  const m = MODELES[index];
  $('#champ-journal').value = m.journal;
  $('#lignes').innerHTML = '';
  for (const l of m.lignes) {
    const tr = ajouterLigne(l);
    if (l.client) $('.l-compte', tr).title = 'Sélectionner le dossier';
    if (l.dossier) $('.l-dossier', tr).title = 'Compte rubriqué : le dossier propriétaire des fonds est obligatoire';
  }
  recalculer();
}

function lireLignes() {
  return $$('#lignes tr').map((tr) => ({
    compte: $('.l-compte', tr).value,
    dossier_id: $('.l-dossier', tr).value ? Number($('.l-dossier', tr).value) : null,
    libelle: $('.l-libelle', tr).value,
    debit: Number($('.l-debit', tr).value || 0),
    credit: Number($('.l-credit', tr).value || 0),
  })).filter((l) => l.compte && (l.debit || l.credit));
}

function recalculer() {
  const lignes = lireLignes();
  const debit = lignes.reduce((s, l) => s + l.debit, 0);
  const credit = lignes.reduce((s, l) => s + l.credit, 0);
  $('#total-debit').textContent = xpf(debit);
  $('#total-credit').textContent = xpf(credit);
  const ecart = debit - credit;
  $('#ecart').innerHTML = ecart === 0
    ? '<span class="pastille ok">équilibrée</span>'
    : `<span class="desequilibre">écart ${xpf(ecart)} XPF</span>`;
}

async function soumettre(valider) {
  const form = $('#form-saisie');
  const donnees = Object.fromEntries(new FormData(form));
  const lignes = lireLignes();
  if (lignes.length < 2) throw new Error('Une écriture comporte au moins deux lignes imputées.');
  for (const l of lignes) if (!l.libelle) l.libelle = donnees.libelle;

  const ecriture = await api('/ecritures', { methode: 'POST', corps: { ...donnees, lignes } });
  if (valider) {
    try {
      await api(`/ecritures/${ecriture.id}/valider`, { methode: 'POST', corps: {} });
      message(`Écriture comptabilisée (${ecriture.journal}).`);
    } catch (e) {
      // L'ecriture reste en brouillon : le refus est explique a l'utilisateur.
      message(`Comptabilisation refusée — ${e.message} L'écriture est conservée en brouillon.`, true);
      await rafraichirBrouillons();
      return;
    }
  } else {
    message('Brouillon enregistré.');
  }
  form.reset();
  $('#champ-journal').value = ecriture.journal;
  appliquerModele(Number($('#modele').value));
  await rafraichirBrouillons();
}

async function rafraichirBrouillons() {
  const liste = await api('/ecritures?statut=BROUILLON&limite=50');
  const cible = $('#liste-brouillons');
  if (!cible) return;
  if (!liste.length) { cible.innerHTML = '<p class="vide">Aucun brouillon.</p>'; return; }
  cible.innerHTML = `
    <div class="defilant"><table>
      <thead><tr><th>Date</th><th>Journal</th><th>Libellé</th><th class="nb">Montant</th><th></th></tr></thead>
      <tbody>${liste.map((e) => `
        <tr>
          <td>${dateFr(e.date_ecriture)}</td>
          <td class="compte">${echapper(e.journal)}</td>
          <td>${echapper(e.libelle)}</td>
          <td class="nb">${xpf(e.total_debit)}</td>
          <td style="text-align:right">
            <button class="secondaire" data-valider="${e.id}">Comptabiliser</button>
            <button class="lien" data-supprimer="${e.id}">Supprimer</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;

  $$('[data-valider]', cible).forEach((b) => b.addEventListener('click', garde(async () => {
    await api(`/ecritures/${b.dataset.valider}/valider`, { methode: 'POST', corps: {} });
    message('Écriture comptabilisée.');
    await rafraichirBrouillons();
  })));
  $$('[data-supprimer]', cible).forEach((b) => b.addEventListener('click', garde(async () => {
    await api(`/ecritures/${b.dataset.supprimer}`, { methode: 'DELETE' });
    message('Brouillon supprimé.');
    await rafraichirBrouillons();
  })));
}

// ================================================================= ecritures

async function vueEcritures() {
  $('#contenu').innerHTML = `
    <div class="carte">
      <h2>Écritures comptabilisées</h2>
      <div class="barre-outils">
        <label>Journal <select id="f-journal"><option value="">Tous</option>
          ${etat.journaux.map((j) => `<option value="${j.code}">${j.code}</option>`).join('')}</select></label>
        <label>Du <input type="date" id="f-depuis"></label>
        <label>Au <input type="date" id="f-jusqu"></label>
        <button id="f-chercher" class="secondaire">Filtrer</button>
      </div>
      <div id="liste-ecritures"></div>
    </div>`;
  $('#f-chercher').addEventListener('click', chargerEcritures);
  await chargerEcritures();
}

async function chargerEcritures() {
  const p = new URLSearchParams();
  if ($('#f-journal').value) p.set('journal', $('#f-journal').value);
  if ($('#f-depuis').value) p.set('depuis', $('#f-depuis').value);
  if ($('#f-jusqu').value) p.set('jusqu', $('#f-jusqu').value);
  const liste = (await api(`/ecritures?${p}`)).filter((e) => e.statut !== 'BROUILLON');

  $('#liste-ecritures').innerHTML = liste.length ? liste.map((e) => `
    <details class="bloc">
      <summary>
        ${echapper(e.journal)}-${String(e.numero).padStart(5, '0')} · ${dateFr(e.date_ecriture)} · ${echapper(e.libelle)}
        <span class="nb" style="float:right">${xpf(e.total_debit)} XPF</span>
        ${e.statut === 'CONTREPASSEE' ? '<span class="pastille majeure">contre-passée</span>' : ''}
      </summary>
      <table>
        <thead><tr><th>Compte</th><th>Libellé</th><th class="nb">Débit</th><th class="nb">Crédit</th></tr></thead>
        <tbody>${e.lignes.map((l) => `
          <tr><td class="compte">${echapper(l.compte)}</td><td>${echapper(l.libelle)}</td>
              <td class="nb">${l.debit ? xpf(l.debit) : ''}</td><td class="nb">${l.credit ? xpf(l.credit) : ''}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="empreinte">Scellée le ${dateFr(e.valide_le)} par ${echapper(e.valide_par ?? '')} — empreinte ${echapper((e.hash ?? '').slice(0, 24))}…</p>
      ${e.statut === 'VALIDEE'
        ? `<button class="secondaire" data-contrepasser="${e.id}">Contre-passer</button>`
        : ''}
    </details>`).join('') : '<p class="vide">Aucune écriture sur la période.</p>';

  $$('[data-contrepasser]').forEach((b) => b.addEventListener('click', garde(async () => {
    const motif = prompt('Motif de la contre-passation (conservé dans la piste d\'audit) :');
    if (!motif) return;
    await api(`/ecritures/${b.dataset.contrepasser}/contrepasser`, {
      methode: 'POST', corps: { motif, date_ecriture: aujourdhui() },
    });
    message('Écriture contre-passée.');
    await chargerEcritures();
  })));
}

// ================================================================== dossiers

async function vueDossiers() {
  const liste = await api('/dossiers');
  $('#contenu').innerHTML = `
    <div class="grille" style="grid-template-columns: 1fr 1.4fr; align-items:start">
      <div class="carte">
        <h2>Ouvrir un dossier</h2>
        <form id="form-dossier" style="display:grid;gap:.6rem">
          <label>Référence <input name="reference" required placeholder="2026-00147"></label>
          <label>Intitulé <input name="intitule" required placeholder="SUCCESSION MARTIN"></label>
          <label>Nature de l'acte <input name="nature_acte" placeholder="Vente, succession, donation…"></label>
          <label>Notaire <input name="notaire"></label>
          <button type="submit">Ouvrir le dossier</button>
        </form>
        <p class="vide" style="font-style:normal">Un compte client individualisé est créé automatiquement et rattaché au dossier.</p>
      </div>

      <div class="carte defilant">
        <header><h2>Dossiers</h2><span class="pastille minuscule">${liste.length}</span></header>
        <table>
          <thead><tr><th>Référence</th><th>Intitulé</th><th>Compte</th><th class="nb">Fonds détenus</th><th></th></tr></thead>
          <tbody>${liste.map((d) => `
            <tr>
              <td><button class="lien" data-dossier="${d.id}">${echapper(d.reference)}</button></td>
              <td>${echapper(d.intitule)}</td>
              <td class="compte">${echapper(d.compte_client)}</td>
              <td class="${d.solde > 0 ? 'nb negatif' : 'nb'}">${xpf(-d.solde)}${d.solde > 0 ? ' ⚠' : ''}</td>
              <td>${d.statut === 'OUVERT' ? '' : `<span class="pastille minuscule">${echapper(d.statut.toLowerCase())}</span>`}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div id="detail-dossier"></div>`;

  $('#form-dossier').addEventListener('submit', garde(async (e) => {
    e.preventDefault();
    await api('/dossiers', { methode: 'POST', corps: Object.fromEntries(new FormData(e.target)) });
    message('Dossier ouvert.');
    await vueDossiers();
  }));

  $$('[data-dossier]').forEach((b) => b.addEventListener('click', garde(() => detailDossier(b.dataset.dossier))));
}

async function detailDossier(id) {
  const d = await api(`/dossiers/${id}`);
  $('#detail-dossier').innerHTML = `
    <div class="carte" style="margin-top:1rem">
      <header>
        <h2>${echapper(d.reference)} — ${echapper(d.intitule)}</h2>
        <div>
          <span class="pastille ${d.solde > 0 ? 'critique' : 'ok'}">
            ${d.solde > 0 ? `Débiteur de ${xpf(d.solde)} XPF` : `Fonds détenus : ${xpf(-d.solde)} XPF`}
          </span>
          ${d.place_en_rubrique ? `<span class="pastille minuscule">dont ${xpf(d.place_en_rubrique)} XPF placés en compte rubriqué</span>` : ''}
          ${d.statut === 'OUVERT' && d.solde === 0 ? `<button class="secondaire" id="clore-dossier">Clore</button>` : ''}
        </div>
      </header>
      <div class="defilant">
        <table>
          <thead><tr><th>Date</th><th>Journal</th><th>Pièce</th><th>Libellé</th><th class="nb">Débit</th><th class="nb">Crédit</th></tr></thead>
          <tbody>${d.mouvements.map((m) => `
            <tr>
              <td>${dateFr(m.date_ecriture)}</td>
              <td class="compte">${echapper(m.journal)}-${m.numero}</td>
              <td>${echapper(m.piece_ref)}</td>
              <td>${echapper(m.libelle)}</td>
              <td class="nb">${m.debit ? xpf(m.debit) : ''}</td>
              <td class="nb">${m.credit ? xpf(m.credit) : ''}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="4">Solde</th>
            <th class="nb">${xpf(d.total_debit)}</th><th class="nb">${xpf(d.total_credit)}</th></tr></tfoot>
        </table>
      </div>
    </div>`;
  $('#clore-dossier')?.addEventListener('click', garde(async () => {
    await api(`/dossiers/${id}/clore`, { methode: 'POST', corps: {} });
    message('Dossier clos.');
    await vueDossiers();
  }));
}

// ============================================================ rapprochement

async function vueRapprochement() {
  const comptes = (await api('/comptes')).filter((c) => c.rapprochable);
  const liste = await api('/rapprochements');
  $('#contenu').innerHTML = `
    <div class="carte">
      <h2>Nouveau rapprochement</h2>
      <form id="form-rappro" class="barre-outils">
        <label>Compte <select name="compte">${comptes.map((c) => `<option value="${c.numero}">${c.numero} — ${echapper(c.intitule)}</option>`).join('')}</select></label>
        <label>Arrêté au <input type="date" name="date_arrete" value="${aujourdhui()}" required></label>
        <label>Solde du relevé (XPF) <input type="number" step="1" name="solde_releve" required></label>
        <button type="submit">Ouvrir</button>
      </form>
    </div>
    <div class="carte" style="margin-top:1rem">
      <h2>Rapprochements</h2>
      ${liste.length ? `<table>
        <thead><tr><th>Compte</th><th>Arrêté au</th><th class="nb">Solde relevé</th><th>Statut</th><th></th></tr></thead>
        <tbody>${liste.map((r) => `
          <tr><td class="compte">${echapper(r.compte)}</td><td>${dateFr(r.date_arrete)}</td>
            <td class="nb">${xpf(r.solde_releve)}</td>
            <td><span class="pastille ${r.statut === 'CLOS' ? 'ok' : 'minuscule'}">${r.statut.toLowerCase()}</span></td>
            <td><button class="lien" data-rappro="${r.id}">Ouvrir</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="vide">Aucun rapprochement.</p>'}
    </div>
    <div id="detail-rappro"></div>`;

  $('#form-rappro').addEventListener('submit', garde(async (e) => {
    e.preventDefault();
    const r = await api('/rapprochements', { methode: 'POST', corps: Object.fromEntries(new FormData(e.target)) });
    await vueRapprochement();
    await detailRapprochement(r.id);
  }));
  $$('[data-rappro]').forEach((b) => b.addEventListener('click', garde(() => detailRapprochement(b.dataset.rappro))));
}

async function detailRapprochement(id) {
  const r = await api(`/rapprochements/${id}`);
  const ligne = (m, pointe) => `
    <tr>
      <td><input type="checkbox" data-ligne="${m.id}" ${pointe ? 'checked' : ''} ${r.statut === 'CLOS' ? 'disabled' : ''}></td>
      <td>${dateFr(m.date_ecriture)}</td>
      <td class="compte">${echapper(m.journal)}-${m.numero}</td>
      <td>${echapper(m.libelle)}</td>
      <td class="nb">${m.debit ? xpf(m.debit) : ''}</td>
      <td class="nb">${m.credit ? xpf(m.credit) : ''}</td>
    </tr>`;

  $('#detail-rappro').innerHTML = `
    <div class="carte" style="margin-top:1rem">
      <header>
        <h2>${echapper(r.compte)} au ${dateFr(r.date_arrete)}</h2>
        <span class="pastille ${r.justifie ? 'ok' : 'critique'}">
          ${r.justifie ? 'Rapprochement justifié' : `Écart de ${xpf(r.ecart)} XPF`}
        </span>
      </header>
      <div class="grille">
        <div><span class="libelle-indicateur">Solde comptable</span><div class="indicateur">${xpf(r.solde_comptable)}</div></div>
        <div><span class="libelle-indicateur">Moins suspens</span><div class="indicateur">${xpf(r.total_suspens)}</div></div>
        <div><span class="libelle-indicateur">Solde rapproché</span><div class="indicateur">${xpf(r.solde_rapproche)}</div></div>
        <div><span class="libelle-indicateur">Solde du relevé</span><div class="indicateur">${xpf(r.solde_releve)}</div></div>
      </div>
      <h3>Mouvements</h3>
      <div class="defilant"><table>
        <thead><tr><th></th><th>Date</th><th>Pièce</th><th>Libellé</th><th class="nb">Débit</th><th class="nb">Crédit</th></tr></thead>
        <tbody>
          ${r.pointes.map((m) => ligne(m, true)).join('')}
          ${r.en_suspens.map((m) => ligne(m, false)).join('')}
        </tbody>
      </table></div>
      ${r.statut === 'CLOS' ? '' : `
        <div class="barre-outils" style="margin-top:1rem">
          <button id="enregistrer-pointage" class="secondaire">Enregistrer le pointage</button>
          <button id="clore-rappro" ${r.justifie ? '' : 'disabled'}>Clore le rapprochement</button>
        </div>`}
    </div>`;

  $('#enregistrer-pointage')?.addEventListener('click', garde(async () => {
    const coches = $$('[data-ligne]').filter((c) => c.checked).map((c) => Number(c.dataset.ligne));
    const decoches = $$('[data-ligne]').filter((c) => !c.checked).map((c) => Number(c.dataset.ligne));
    if (coches.length) await api(`/rapprochements/${id}/pointer`, { methode: 'POST', corps: { lignes: coches, pointe: true } });
    if (decoches.length) await api(`/rapprochements/${id}/pointer`, { methode: 'POST', corps: { lignes: decoches, pointe: false } });
    message('Pointage enregistré.');
    await detailRapprochement(id);
  }));
  $('#clore-rappro')?.addEventListener('click', garde(async () => {
    await api(`/rapprochements/${id}/clore`, { methode: 'POST', corps: {} });
    message('Rapprochement clos.');
    await vueRapprochement();
  }));
}

// ===================================================================== états

async function vueEtats() {
  $('#contenu').innerHTML = `
    <div class="carte">
      <div class="barre-outils">
        <label>État <select id="choix-etat">
          <option value="balance">Balance générale</option>
          <option value="clients">État des comptes clients</option>
          <option value="resultat">Compte de résultat</option>
          <option value="bilan">Bilan</option>
          <option value="grand-livre">Grand livre</option>
          <option value="journal">Journal</option>
        </select></label>
        <label>Du <input type="date" id="e-depuis"></label>
        <label>Au <input type="date" id="e-jusqu"></label>
        <label id="zone-compte" hidden>Compte <select id="e-compte"></select></label>
        <button id="e-editer" class="secondaire">Éditer</button>
        <span style="flex:1"></span>
        <a href="/api/export/fec" download><button type="button">Export FEC</button></a>
        <a href="/api/export/balance.csv" download><button type="button" class="secondaire">Balance CSV</button></a>
        <a href="/api/export/comptes-clients.csv" download><button type="button" class="secondaire">Clients CSV</button></a>
        <a href="/api/export/placements.csv" download><button type="button" class="secondaire">Placements CSV</button></a>
      </div>
      <div id="rendu-etat"></div>
    </div>`;

  etat.comptes = etat.comptes.length ? etat.comptes : await api('/comptes');
  $('#e-compte').innerHTML = etat.comptes.map((c) => `<option value="${c.numero}">${c.numero} — ${echapper(c.intitule)}</option>`).join('');
  $('#choix-etat').addEventListener('change', (e) => {
    $('#zone-compte').hidden = e.target.value !== 'grand-livre';
  });
  $('#e-editer').addEventListener('click', garde(editerEtat));
  await editerEtat();
}

async function editerEtat() {
  const p = new URLSearchParams();
  if ($('#e-depuis').value) p.set('depuis', $('#e-depuis').value);
  if ($('#e-jusqu').value) p.set('jusqu', $('#e-jusqu').value);
  const cible = $('#rendu-etat');

  switch ($('#choix-etat').value) {
    case 'balance': {
      const b = await api(`/etats/balance?${p}`);
      cible.innerHTML = `
        <div class="defilant"><table>
          <thead><tr><th>Compte</th><th>Intitulé</th><th class="nb">Débit</th><th class="nb">Crédit</th><th class="nb">Solde D</th><th class="nb">Solde C</th></tr></thead>
          <tbody>${b.lignes.map((l) => `
            <tr><td class="compte">${echapper(l.numero)}</td><td>${echapper(l.intitule)}</td>
              <td class="nb">${xpf(l.debit)}</td><td class="nb">${xpf(l.credit)}</td>
              <td class="nb">${l.solde_debiteur ? xpf(l.solde_debiteur) : ''}</td>
              <td class="nb">${l.solde_crediteur ? xpf(l.solde_crediteur) : ''}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="2">Totaux ${b.equilibree ? '<span class="pastille ok">équilibrée</span>' : '<span class="pastille critique">déséquilibrée</span>'}</th>
            <th class="nb">${xpf(b.totaux.debit)}</th><th class="nb">${xpf(b.totaux.credit)}</th>
            <th class="nb">${xpf(b.totaux.solde_debiteur)}</th><th class="nb">${xpf(b.totaux.solde_crediteur)}</th></tr></tfoot>
        </table></div>`;
      break;
    }
    case 'clients': {
      const e = await api('/etats/comptes-clients');
      const f = e.representation;
      cible.innerHTML = `
        <div class="alerte ${f.conforme ? 'information' : ''}">
          <strong>Représentation des fonds clients au ${dateFr(e.arrete_le)}</strong>
          Dû aux clients : ${xpf(f.du_aux_clients)} XPF — disponibilités affectées : ${xpf(f.representation_totale)} XPF —
          ${f.conforme ? `marge de ${xpf(f.ecart)} XPF.` : `DÉFICIT de ${xpf(-f.ecart)} XPF.`}
        </div>
        <div class="defilant"><table>
          <thead><tr><th>Dossier</th><th>Intitulé</th><th>Compte</th><th class="nb">Fonds détenus</th></tr></thead>
          <tbody>${e.dossiers.map((d) => `
            <tr><td>${echapper(d.reference)}</td><td>${echapper(d.intitule)}</td>
              <td class="compte">${echapper(d.compte_client)}</td>
              <td class="${d.fonds_detenus < 0 ? 'nb negatif' : 'nb'}">${xpf(d.fonds_detenus)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="3">Total des fonds détenus</th><th class="nb">${xpf(e.total_fonds_detenus)}</th></tr></tfoot>
        </table></div>`;
      break;
    }
    case 'resultat': {
      const r = await api(`/etats/resultat?${p}`);
      const bloc = (titre, lignes, cle) => `
        <h3>${titre}</h3><table><tbody>${lignes.map((l) => `
          <tr><td class="compte">${echapper(l.numero)}</td><td>${echapper(l.intitule)}</td>
            <td class="nb">${xpf(l[cle])}</td></tr>`).join('')}</tbody></table>`;
      cible.innerHTML = `
        ${bloc('Produits', r.produits, 'solde_crediteur')}
        ${bloc('Charges', r.charges, 'solde_debiteur')}
        <h3>Résultat : <span class="${r.resultat < 0 ? 'negatif' : ''}">${xpf(r.resultat)} XPF</span></h3>`;
      break;
    }
    case 'bilan': {
      const b = await api(`/etats/bilan?${p}`);
      cible.innerHTML = `
        <div class="grille">
          <div><h3>Actif — ${xpf(b.total_actif)} XPF</h3><table><tbody>${b.actif.map((l) => `
            <tr><td class="compte">${echapper(l.numero)}</td><td>${echapper(l.intitule)}</td><td class="nb">${xpf(l.solde_debiteur)}</td></tr>`).join('')}</tbody></table></div>
          <div><h3>Passif — ${xpf(b.total_passif)} XPF</h3><table><tbody>${b.passif.map((l) => `
            <tr><td class="compte">${echapper(l.numero)}</td><td>${echapper(l.intitule)}</td><td class="nb">${xpf(l.solde_crediteur)}</td></tr>`).join('')}</tbody></table></div>
        </div>
        <h3>Résultat de la période : ${xpf(b.resultat)} XPF</h3>`;
      break;
    }
    case 'grand-livre': {
      const g = await api(`/etats/grand-livre/${$('#e-compte').value}?${p}`);
      cible.innerHTML = `
        <h3>${echapper(g.compte.numero)} — ${echapper(g.compte.intitule)}</h3>
        <div class="defilant"><table>
          <thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th class="nb">Débit</th><th class="nb">Crédit</th><th class="nb">Solde</th></tr></thead>
          <tbody>
            <tr><td colspan="5"><em>Solde antérieur</em></td><td class="nb">${xpf(g.solde_anterieur)}</td></tr>
            ${g.mouvements.map((m) => `
              <tr><td>${dateFr(m.date_ecriture)}</td><td class="compte">${echapper(m.journal)}-${m.numero}</td>
                <td>${echapper(m.libelle)}</td>
                <td class="nb">${m.debit ? xpf(m.debit) : ''}</td><td class="nb">${m.credit ? xpf(m.credit) : ''}</td>
                <td class="nb">${xpf(m.solde_progressif)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="5">Solde final</th><th class="nb">${xpf(g.solde_final)}</th></tr></tfoot>
        </table></div>`;
      break;
    }
    case 'journal': {
      const j = await api(`/etats/journal?${p}`);
      cible.innerHTML = j.ecritures.length ? `<div class="defilant"><table>
        <thead><tr><th>Journal</th><th>N°</th><th>Date</th><th>Compte</th><th>Libellé</th><th class="nb">Débit</th><th class="nb">Crédit</th></tr></thead>
        <tbody>${j.ecritures.flatMap((e) => e.lignes.map((l, i) => `
          <tr><td>${i === 0 ? echapper(e.journal) : ''}</td><td>${i === 0 ? e.numero : ''}</td>
            <td>${i === 0 ? dateFr(e.date_ecriture) : ''}</td>
            <td class="compte">${echapper(l.compte)}</td><td>${echapper(l.libelle)}</td>
            <td class="nb">${l.debit ? xpf(l.debit) : ''}</td><td class="nb">${l.credit ? xpf(l.credit) : ''}</td></tr>`)).join('')}
        </tbody></table></div>` : '<p class="vide">Aucune écriture.</p>';
      break;
    }
  }
}

// ================================================================ inspection

async function vueInspection() {
  const d = await api('/etats/inspection');
  const chaine = await api('/controles/chaine');
  const audit = await api('/audit?limite=100');
  const exercices = d.exercices;

  $('#contenu').innerHTML = `
    <div class="carte">
      <h2>Dossier d'inspection</h2>
      <p>État des pièces à présenter lors du contrôle de comptabilité, arrêté le ${dateFr(d.edite_le)}.</p>
      <div class="grille">
        <div><span class="libelle-indicateur">Écritures comptabilisées</span><div class="indicateur">${d.volumetrie.ecritures_comptabilisees}</div></div>
        <div><span class="libelle-indicateur">Dossiers ouverts</span><div class="indicateur">${d.volumetrie.dossiers_ouverts}</div></div>
        <div><span class="libelle-indicateur">Contre-passations</span><div class="indicateur">${d.volumetrie.contrepassations}</div></div>
        <div><span class="libelle-indicateur">Fonds clients</span><div class="indicateur">${xpf(d.representation_fonds.du_aux_clients)}</div></div>
      </div>
    </div>

    ${cartePlacements(d.placements)}

    <div class="carte" style="margin-top:1rem">
      <h2>Intégrité de la comptabilité</h2>
      <div class="alerte ${chaine.ecritures.valide ? 'information' : ''}">
        <strong>Chaîne des écritures</strong>
        ${chaine.ecritures.valide
          ? `${chaine.ecritures.ecritures} écritures scellées, aucune altération détectée.`
          : `Rupture à l'écriture ${chaine.ecritures.ecriture_id} : ${echapper(chaine.ecritures.motif)}`}
      </div>
      <p class="empreinte">Empreinte de clôture : ${echapper(chaine.ecritures.hash_final ?? '')}</p>
      <div class="alerte ${chaine.audit.valide ? 'information' : ''}">
        <strong>Journal d'audit</strong>
        ${chaine.audit.valide
          ? `${chaine.audit.evenements} événements tracés, chaîne intègre.`
          : `Rupture à l'événement ${chaine.audit.rupture_id} : ${echapper(chaine.audit.motif)}`}
      </div>
    </div>

    <div class="carte" style="margin-top:1rem">
      <h2>Anomalies relevées</h2>
      ${d.anomalies.length ? d.anomalies.map(carteAnomalie).join('')
        : '<div class="alerte information"><strong>Conforme</strong>Aucune anomalie.</div>'}
    </div>

    <div class="carte" style="margin-top:1rem">
      <h2>Exercices</h2>
      <table>
        <thead><tr><th>Exercice</th><th>Période</th><th>Statut</th><th>Clôture</th><th></th></tr></thead>
        <tbody>${exercices.map((e) => `
          <tr>
            <td>${echapper(e.libelle)}</td>
            <td>${dateFr(e.date_debut)} – ${dateFr(e.date_fin)}</td>
            <td><span class="pastille ${e.statut === 'CLOS' ? 'ok' : 'minuscule'}">${e.statut.toLowerCase()}</span></td>
            <td class="empreinte">${echapper((e.cloture_hash ?? '').slice(0, 20))}</td>
            <td>${e.statut === 'OUVERT' ? `<button class="lien" data-precloture="${e.id}">Contrôler la clôture</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div id="zone-precloture"></div>
    </div>

    <div class="carte" style="margin-top:1rem">
      <h2>Piste d'audit</h2>
      <div class="defilant"><table>
        <thead><tr><th>Horodatage</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Détail</th></tr></thead>
        <tbody>${audit.map((a) => `
          <tr><td>${echapper(a.horodatage.replace('T', ' ').slice(0, 19))}</td>
            <td>${echapper(a.utilisateur)}</td><td>${echapper(a.action)}</td>
            <td>${echapper(a.objet)} ${echapper(a.objet_id ?? '')}</td>
            <td>${echapper(a.details)}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  $$('[data-precloture]').forEach((b) => b.addEventListener('click', garde(async () => {
    const r = await api(`/exercices/${b.dataset.precloture}/pre-cloture`);
    $('#zone-precloture').innerHTML = `
      <h3>Clôture de l'exercice ${echapper(r.exercice.libelle)}</h3>
      ${r.pret
        ? `<div class="alerte information"><strong>Prêt</strong>Toutes les conditions de clôture sont réunies.</div>
           <button id="confirmer-cloture" class="danger">Clôturer définitivement</button>`
        : r.obstacles.map((o) => `<div class="alerte"><strong>${echapper(o.code)}</strong>${echapper(o.message)}</div>`).join('')}`;
    $('#confirmer-cloture')?.addEventListener('click', garde(async () => {
      if (!confirm('La clôture est irréversible. Confirmer ?')) return;
      const res = await api(`/exercices/${b.dataset.precloture}/cloturer`, { methode: 'POST', corps: {} });
      message(`Exercice clôturé. Résultat : ${xpf(res.resultat)} XPF.`);
      await vueInspection();
    }));
  })));
}

const VUES = {
  tableau: vueTableau,
  saisie: vueSaisie,
  ecritures: vueEcritures,
  dossiers: vueDossiers,
  rapprochement: vueRapprochement,
  etats: vueEtats,
  inspection: vueInspection,
};

// Reprise de session si le cookie est encore valide.
api('/moi').then(demarrer).catch(() => { $('#connexion').hidden = false; });
