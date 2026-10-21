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
  // En-tete repris sur chaque page a l'impression : un etat sorti du logiciel
  // doit porter l'office dont il emane et la date a laquelle il a ete edite.
  $('#entete-impression').innerHTML = `
    <div class="titre">${echapper(office.denomination)}${office.ridet ? ` — RIDET ${echapper(office.ridet)}` : ''}</div>
    <div class="detail">${ouvert ? `Exercice ${echapper(ouvert.libelle)} — ` : ''}édité le ${dateFr(aujourdhui())}
      par ${echapper(etat.utilisateur.nom)}</div>`;
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
    nom: 'Reversement des droits d\'enregistrement au Trésor',
    journal: 'BQC',
    lignes: [
      { compte: '448600', sens: 'debit', dossier: true },
      { compte: '512500', sens: 'credit' },
    ],
  },
  {
    nom: 'Reversement de la taxe hypothécaire',
    journal: 'BQC',
    lignes: [
      { compte: '448700', sens: 'debit', dossier: true },
      { compte: '512500', sens: 'credit' },
    nom: 'Espèces reçues d\'un client',
    journal: 'CAI',
    lignes: [
      { compte: '531500', sens: 'debit' },
      { compte: '', sens: 'credit', client: true },
    ],
  },
  {
    nom: 'Versement des espèces clients en banque',
    journal: 'CAI',
    lignes: [
      { compte: '512500', sens: 'debit' },
      { compte: '531500', sens: 'credit' },
    ],
  },
  {
    nom: 'Dépense de l\'office réglée en espèces',
    journal: 'CAI',
    lignes: [
      { compte: '606400', sens: 'debit' },
      { compte: '531000', sens: 'credit' },
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

/**
 * La valeur est l'identifiant du dossier, pas son compte : une ligne peut
 * devoir designer un dossier sans etre imputee a son compte client - c'est le
 * cas des droits d'enregistrement et des debours a reverser.
 */
function optionsDossiers(selection = '') {
  return `<option value="">—</option>` + etat.dossiers
    .map((d) => `<option value="${d.id}" data-compte="${d.compte_client}" ${String(d.id) === String(selection) ? 'selected' : ''}>${echapper(d.reference)} — ${echapper(d.intitule)}</option>`)
    .join('');
}

const estCompteClient = (numero) => /^411\d{5}$/.test(numero ?? '');

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

  // Le choix d'un dossier impute son compte client, sauf si la ligne porte
  // deja un autre compte : on se contente alors de la rattacher au dossier.
  $('.l-dossier', tr).addEventListener('change', (e) => {
    const compte = $('.l-compte', tr);
    const choisi = e.target.selectedOptions[0]?.dataset.compte;
    if (choisi && (!compte.value || estCompteClient(compte.value))) compte.value = choisi;
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
    if (l.dossier) $('.l-dossier', tr).title = 'Dossier au titre duquel la somme est due — obligatoire';
  }
  recalculer();
}

function lireLignes() {
  return $$('#lignes tr').map((tr) => ({
    compte: $('.l-compte', tr).value,
    dossier_id: Number($('.l-dossier', tr).value) || null,
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
      const posee = await api(`/ecritures/${ecriture.id}/valider`, { methode: 'POST', corps: {} });
      // Une alerte n'empêche pas la comptabilisation : elle la commente.
      if (posee.alertes?.length) {
        message(`Écriture comptabilisée (${ecriture.journal}). ⚠ ${posee.alertes.map((a) => a.message).join(' ')}`, true);
      } else {
        message(`Écriture comptabilisée (${ecriture.journal}).`);
      }
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
          <button class="secondaire" id="compte-definitif">Compte définitif</button>
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
  $('#compte-definitif')?.addEventListener('click', garde(() => compteDefinitif(id)));
  $('#clore-dossier')?.addEventListener('click', garde(async () => {
    await api(`/dossiers/${id}/clore`, { methode: 'POST', corps: {} });
    message('Dossier clos.');
    await vueDossiers();
  }));
}

/**
 * Compte définitif : ce que le client a versé, ce que l'acte lui a coûté,
 * ce qui lui revient. C'est l'état remis au client en fin de dossier.
 */
async function compteDefinitif(id) {
  const c = await api(`/etats/compte-definitif/${id}`);
  $('#detail-dossier').insertAdjacentHTML('beforeend', `
    <div class="carte" style="margin-top:1rem">
      <header>
        <h2>Compte définitif — ${echapper(c.dossier.reference)}</h2>
        <a href="/api/export/compte-definitif/${id}" class="pastille minuscule">export CSV</a>
      </header>
      ${c.bareme_fictif ? `<div class="alerte"><strong>Barème non validé</strong>
        Les émoluments portés à ce compte ont été liquidés sur un barème sans valeur réglementaire.
        Ce document ne peut pas être remis à un client.</div>` : ''}
      <table>
        <tbody>
          <tr><th>Versé par le client (ou pour son compte)</th><td class="nb">${xpf(c.recu)}</td></tr>
          <tr><th>Émoluments</th><td class="nb">${xpf(c.detail.emoluments)}</td></tr>
          <tr><th>TGC sur émoluments</th><td class="nb">${xpf(c.detail.tgc)}</td></tr>
          <tr><th>Débours et taxes</th><td class="nb">${xpf(c.detail.debours)}</td></tr>
          <tr><th>Total taxé</th><td class="nb">${xpf(c.total_taxe)}</td></tr>
          <tr><th>Total imputé au dossier</th><td class="nb">${xpf(c.impute)}</td></tr>
          <tr><th>Solde détenu pour le client</th>
            <td class="${c.solde_detenu < 0 ? 'nb negatif' : 'nb'}"><strong>${xpf(c.solde_detenu)}</strong></td></tr>
        </tbody>
      </table>
      ${c.taxes_non_comptabilisees.length ? `<div class="alerte majeure"><strong>Taxes non comptabilisées</strong>
        ${c.taxes_non_comptabilisees.length} taxe(s) de ce dossier ne sont pas passées en comptabilité :
        le compte ci-dessus ne les reflète pas.</div>` : ''}
      ${c.taxes_annulees.length ? `<div class="alerte information"><strong>Taxes annulées</strong>
        ${c.taxes_annulees.map((t) => `${echapper(t.reference)} (${xpf(t.total_du)} XPF)`).join(', ')} —
        écriture contre-passée, montant exclu du compte ci-dessus.</div>` : ''}
    </div>`);
}

// ============================================================== taxe des actes

/** Bandeau permanent : un barème non validé n'a aucune portée. */
function avertissementBareme(b) {
  if (!b.fictif) {
    return `<div class="alerte information"><strong>Barème ${echapper(b.code)}</strong>
      ${echapper(b.libelle)} — référence : ${echapper(b.texte_reference)}.</div>`;
  }
  return `<div class="alerte"><strong>Barème non validé — ${echapper(b.code)}</strong>
    ${echapper(b.avertissement)}</div>`;
}

const CATEGORIE_LIBELLE = { EMOLUMENT: 'Émolument', DEBOURS: 'Débours', TAXE: 'Taxe' };

async function vueTaxe() {
  const [bareme, etats, dossiers] = await Promise.all([
    api('/tarif/bareme'),
    api('/etats/taxes'),
    api('/dossiers?statut=OUVERT'),
  ]);
  etat.bareme = bareme;

  const tableauTaxes = (liste, actions) => liste.length === 0
    ? '<p class="vide">Aucune.</p>'
    : `<table>
        <thead><tr><th>Réf.</th><th>Dossier</th><th>Acte</th><th>Date</th>
          <th class="nb">Émoluments</th><th class="nb">TGC</th><th class="nb">Débours</th>
          <th class="nb">Total dû</th><th></th></tr></thead>
        <tbody>${liste.map((t) => `
          <tr>
            <td class="compte"><button class="lien" data-taxe="${t.id}">${echapper(t.reference)}</button></td>
            <td>${echapper(t.dossier_reference)}</td>
            <td>${echapper(t.acte)}</td>
            <td>${dateFr(t.date_acte)}</td>
            <td class="nb">${xpf(t.total_emoluments)}</td>
            <td class="nb">${xpf(t.total_tgc)}</td>
            <td class="nb">${xpf(t.total_debours)}</td>
            <td class="nb"><strong>${xpf(t.total_du)}</strong></td>
            <td>${actions(t)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  $('#contenu').innerHTML = `
    ${avertissementBareme(bareme)}

    <div class="carte">
      <header>
        <h2>Taxer un acte</h2>
        <span class="pastille minuscule">arrondi ${echapper(bareme.arrondi.toLowerCase())}</span>
      </header>
      <form id="form-taxe">
        <div class="barre-outils">
          <label style="min-width:220px">Dossier
            <select name="dossier_id" required>
              <option value="">—</option>
              ${dossiers.map((d) => `<option value="${d.id}">${echapper(d.reference)} — ${echapper(d.intitule)}</option>`).join('')}
            </select>
          </label>
          <label style="min-width:260px">Acte <input name="acte" required placeholder="Vente MARTIN / DUPONT"></label>
          <label>Date de l'acte <input name="date_acte" type="date" value="${aujourdhui()}" required></label>
        </div>
        <div class="defilant">
          <table class="lignes-saisie">
            <thead><tr><th>Prestation du barème</th><th class="nb">Assiette</th><th class="nb">Quantité</th>
              <th class="nb">Montant libre</th><th class="nb">Liquidation</th><th></th></tr></thead>
            <tbody id="lignes-taxe"></tbody>
          </table>
        </div>
        <div class="barre-outils" style="margin:.6rem 0 0">
          <button type="button" id="ajouter-prestation" class="secondaire">Ajouter une prestation</button>
          <button type="submit">Enregistrer le projet de taxe</button>
        </div>
      </form>
      <div id="liquidation"></div>
    </div>

    <div class="carte" style="margin-top:1rem">
      <header><h2>À comptabiliser</h2><span class="pastille ${etats.a_comptabiliser.length ? 'majeure' : 'ok'}">${etats.a_comptabiliser.length}</span></header>
      <p class="vide" style="font-style:normal;padding:0 0 .6rem">
        Taxe arrêtée et remise au client, mais pas encore passée en comptabilité : le produit n'est pas enregistré.</p>
      ${tableauTaxes(etats.a_comptabiliser, (t) => `<button class="lien" data-comptabiliser="${t.id}">Comptabiliser</button>`)}
    </div>

    <div class="carte" style="margin-top:1rem">
      <header><h2>Projets</h2><span class="pastille minuscule">${etats.projets.length}</span></header>
      ${tableauTaxes(etats.projets, (t) => `
        <button class="lien" data-arreter="${t.id}">Arrêter</button>
        <button class="lien" data-supprimer-taxe="${t.id}">Supprimer</button>`)}
    </div>

    <div class="carte" style="margin-top:1rem">
      <header>
        <h2>Taxes comptabilisées</h2>
        <span class="pastille minuscule">${xpf(etats.totaux.du)} XPF</span>
      </header>
      ${tableauTaxes(etats.comptabilisees, () => '')}
    </div>

    ${etats.annulees.length ? `
      <div class="carte" style="margin-top:1rem">
        <header><h2>Taxes annulées</h2><span class="pastille minuscule">${etats.annulees.length}</span></header>
        <p class="vide" style="font-style:normal;padding:0 0 .6rem">
          Taxes dont l'écriture a été contre-passée. Elles restent en base, inaltérées,
          mais ne comptent plus dans les produits ni dans le compte du client.</p>
        ${tableauTaxes(etats.annulees, () => '')}
      </div>` : ''}

    <div id="detail-taxe"></div>`;

  const lignes = $('#lignes-taxe');
  const ajouterLigne = () => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><select name="code">${bareme.prestations.map((p) => `
        <option value="${echapper(p.code)}" data-mode="${p.mode}">
          ${echapper(p.libelle)} — ${CATEGORIE_LIBELLE[p.categorie]}
        </option>`).join('')}</select></td>
      <td><input name="assiette" type="number" min="0" step="1" class="nb" value="0"></td>
      <td><input name="quantite" type="number" min="1" step="1" class="nb" value="1"></td>
      <td><input name="montant" type="number" min="0" step="1" class="nb" value="0"></td>
      <td class="nb liquidation-ligne">—</td>
      <td><button type="button" class="lien" data-retirer>retirer</button></td>`;
    tr.querySelector('[data-retirer]').addEventListener('click', () => { tr.remove(); liquider(); });
    tr.querySelectorAll('input, select').forEach((c) => c.addEventListener('change', liquider));
    lignes.append(tr);
    liquider();
  };

  const prestationsSaisies = () => $$('#lignes-taxe tr').map((tr) => ({
    code: tr.querySelector('[name=code]').value,
    mode: tr.querySelector('[name=code]').selectedOptions[0]?.dataset.mode,
    assiette: Number(tr.querySelector('[name=assiette]').value || 0),
    quantite: Number(tr.querySelector('[name=quantite]').value || 1),
    montant: Number(tr.querySelector('[name=montant]').value || 0),
  }));

  /** Une ligne dont l'assiette n'est pas encore saisie n'est pas liquidable. */
  const incomplete = (p) => (p.mode === 'TRANCHES' || p.mode === 'PROPORTIONNEL') && !p.assiette;

  /** Liquidation en direct : l'utilisateur voit le calcul avant d'enregistrer. */
  const liquider = garde(async () => {
    const prestations = prestationsSaisies();
    if (!prestations.length) {
      $('#liquidation').innerHTML = '';
      return;
    }
    if (prestations.some(incomplete)) {
      $$('#lignes-taxe tr').forEach((tr, i) => {
        tr.querySelector('.liquidation-ligne').textContent = incomplete(prestations[i]) ? 'assiette ?' : '';
      });
      $('#liquidation').innerHTML = '<p class="vide">Renseignez l\'assiette de chaque émolument proportionnel.</p>';
      return;
    }
    const t = await api('/tarif/simulation', { methode: 'POST', corps: { acte: 'simulation', prestations } });
    $$('#lignes-taxe tr').forEach((tr, i) => {
      tr.querySelector('.liquidation-ligne').textContent = xpf(t.lignes[i].montant);
    });
    $('#liquidation').innerHTML = `
      <h3>Liquidation</h3>
      <table>
        <thead><tr><th>Prestation</th><th>Justification du calcul</th><th class="nb">Montant</th><th class="nb">TGC</th></tr></thead>
        <tbody>${t.lignes.map((l) => `
          <tr><td>${echapper(l.libelle)}</td>
            <td class="compte">${echapper(l.detail)}</td>
            <td class="nb">${xpf(l.montant)}</td>
            <td class="nb">${l.tgc_montant ? xpf(l.tgc_montant) : ''}</td></tr>`).join('')}
        </tbody>
        <tfoot>
          <tr><th colspan="2">Émoluments</th><th class="nb">${xpf(t.total_emoluments)}</th><th class="nb">${xpf(t.total_tgc)}</th></tr>
          <tr><th colspan="2">Débours et taxes</th><th class="nb">${xpf(t.total_debours)}</th><th></th></tr>
          <tr><th colspan="2">Total dû par le client</th><th class="nb">${xpf(t.total_du)}</th><th></th></tr>
        </tfoot>
      </table>`;
  });

  $('#ajouter-prestation').addEventListener('click', ajouterLigne);
  ajouterLigne();

  $('#form-taxe').addEventListener('submit', garde(async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    await api('/taxes', {
      methode: 'POST',
      corps: {
        dossier_id: Number(f.dossier_id),
        acte: f.acte,
        date_acte: f.date_acte,
        prestations: prestationsSaisies(),
      },
    });
    message('Projet de taxe enregistré.');
    await vueTaxe();
  }));

  $$('[data-arreter]').forEach((b) => b.addEventListener('click', garde(async () => {
    await api(`/taxes/${b.dataset.arreter}/arreter`, { methode: 'POST', corps: {} });
    message('Taxe arrêtée : elle est désormais figée.');
    await vueTaxe();
  })));

  $$('[data-supprimer-taxe]').forEach((b) => b.addEventListener('click', garde(async () => {
    await api(`/taxes/${b.dataset.supprimerTaxe}`, { methode: 'DELETE' });
    message('Projet supprimé.');
    await vueTaxe();
  })));

  $$('[data-comptabiliser]').forEach((b) => b.addEventListener('click', garde(async () => {
    const r = await api(`/taxes/${b.dataset.comptabiliser}/comptabiliser`, { methode: 'POST', corps: {} });
    message(`Taxe comptabilisée : écriture ${r.ecriture.journal}-${r.ecriture.numero}.`);
    await vueTaxe();
  })));

  $$('[data-taxe]').forEach((b) => b.addEventListener('click', garde(() => detailTaxe(b.dataset.taxe))));
}

async function detailTaxe(id) {
  const t = await api(`/taxes/${id}`);
  $('#detail-taxe').innerHTML = `
    <div class="carte" style="margin-top:1rem">
      <header>
        <h2>${echapper(t.reference)} — ${echapper(t.acte)}</h2>
        <span class="pastille ${t.statut === 'COMPTABILISEE' ? 'ok' : 'minuscule'}">${echapper(t.statut.toLowerCase())}</span>
      </header>
      <p>Dossier ${echapper(t.dossier_reference)} — ${echapper(t.dossier_intitule)}, acte du ${dateFr(t.date_acte)}.</p>
      <div class="defilant"><table>
        <thead><tr><th>Prestation</th><th>Nature</th><th class="compte">Compte</th>
          <th>Justification du calcul</th><th class="nb">Montant</th><th class="nb">TGC</th></tr></thead>
        <tbody>${t.lignes.map((l) => `
          <tr>
            <td>${echapper(l.libelle)}</td>
            <td>${CATEGORIE_LIBELLE[l.categorie] ?? echapper(l.categorie)}</td>
            <td class="compte">${echapper(l.compte)}</td>
            <td class="compte">${echapper(l.detail)}</td>
            <td class="nb">${xpf(l.montant)}</td>
            <td class="nb">${l.tgc_montant ? xpf(l.tgc_montant) : ''}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><th colspan="4">Total dû</th><th class="nb">${xpf(t.total_du)}</th><th></th></tr></tfoot>
      </table></div>
      <h3>Barème appliqué</h3>
      <p>${echapper(t.bareme_code)} — statut <strong>${echapper(t.bareme_statut)}</strong>.
        ${t.bareme_statut !== 'VALIDE' ? 'Cette taxe est sans valeur réglementaire.' : ''}</p>
      <p class="empreinte">empreinte du barème : ${echapper(t.bareme_empreinte)}</p>
    </div>`;
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
        <button type="button" id="e-imprimer" class="secondaire">Imprimer</button>
      </div>
      <div id="rendu-etat"></div>
    </div>`;

  etat.comptes = etat.comptes.length ? etat.comptes : await api('/comptes');
  $('#e-compte').innerHTML = etat.comptes.map((c) => `<option value="${c.numero}">${c.numero} — ${echapper(c.intitule)}</option>`).join('');
  $('#choix-etat').addEventListener('change', (e) => {
    $('#zone-compte').hidden = e.target.value !== 'grand-livre';
  });
  $('#e-editer').addEventListener('click', garde(editerEtat));
  $('#e-imprimer').addEventListener('click', () => window.print());
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

// ===================================================================== caisse

async function vueCaisse() {
  const p = new URLSearchParams();
  if (etat.caisseDepuis) p.set('depuis', etat.caisseDepuis);
  if (etat.caisseJusqu) p.set('jusqu', etat.caisseJusqu);
  const r = await api(`/etats/registre-especes?${p}`);
  const par = r.parametres;

  $('#contenu').innerHTML = `
    <section class="carte" aria-labelledby="titre-caisse">
      <h2 id="titre-caisse">Registre des espèces</h2>
      <p>Arrêté le ${dateFr(r.arrete_le)}${r.periode.depuis || r.periode.jusqu
        ? ` — période du ${dateFr(r.periode.depuis) || 'origine'} au ${dateFr(r.periode.jusqu) || 'ce jour'}` : ''}.
        Un mouvement d'espèces ne laisse aucune trace bancaire : ce registre et la pièce justificative
        en sont la seule preuve.</p>

      ${par.statut === 'VALIDE' ? '' : `
        <div class="alerte" role="alert">
          <strong>Critique — plafonds non validés</strong>
          ${echapper(par.avertissement ?? '')}
        </div>`}

      <div class="barre-outils sans-impression">
        <label for="c-depuis">Du <input type="date" id="c-depuis" value="${etat.caisseDepuis ?? ''}"></label>
        <label for="c-jusqu">Au <input type="date" id="c-jusqu" value="${etat.caisseJusqu ?? ''}"></label>
        <button id="c-editer" class="secondaire">Éditer</button>
        <span style="flex:1"></span>
        <a href="/api/export/registre-especes.csv?${p}" download><button type="button" class="secondaire">Registre CSV</button></a>
        <button type="button" id="c-imprimer" class="secondaire">Imprimer</button>
      </div>

      <dl class="parametres">
        <div><dt>Paramétrage</dt><dd>${echapper(par.code)} <span class="pastille ${par.statut === 'VALIDE' ? 'ok' : 'critique'}">${par.statut === 'VALIDE' ? 'validé' : 'non validé'}</span></dd></div>
        <div><dt>Plafond d'un règlement</dt><dd>${par.plafond_reglement_xpf === null ? 'aucun' : `${xpf(par.plafond_reglement_xpf)} XPF`}</dd></div>
        <div><dt>Plafond cumulé par dossier</dt><dd>${par.plafond_cumul_dossier_xpf === null ? 'aucun' : `${xpf(par.plafond_cumul_dossier_xpf)} XPF`}</dd></div>
        <div><dt>Encaisse maximale</dt><dd>${par.encaisse_maximale_xpf === null ? 'aucune' : `${xpf(par.encaisse_maximale_xpf)} XPF`}</dd></div>
        <div><dt>Source</dt><dd>${echapper(par.source ?? 'aucune — valeurs fictives')}</dd></div>
        <div><dt>Empreinte du fichier</dt><dd class="empreinte">${echapper(par.empreinte.slice(0, 32))}…</dd></div>
      </dl>
    </section>

    ${r.caisses.map((c) => `
      <section class="carte saut-de-page" style="margin-top:1rem" aria-labelledby="caisse-${echapper(c.compte)}">
        <header>
          <h2 id="caisse-${echapper(c.compte)}">${echapper(c.compte)} — ${echapper(c.intitule)}</h2>
          <span class="pastille ${c.fonds_clients ? 'minuscule' : 'minuscule'}">${c.fonds_clients ? 'fonds clients' : 'office'}</span>
        </header>
        <div class="grille">
          <div><span class="libelle-indicateur">Solde</span>
            <div class="indicateur ${c.solde_final < 0 ? 'negatif' : ''}">${xpf(c.solde_final)} <small>XPF</small></div></div>
          <div><span class="libelle-indicateur">Encaissements</span><div class="indicateur">${xpf(c.encaissements)}</div></div>
          <div><span class="libelle-indicateur">Décaissements</span><div class="indicateur">${xpf(c.decaissements)}</div></div>
          <div><span class="libelle-indicateur">Minimum atteint</span>
            <div class="indicateur ${c.jamais_creditrice ? '' : 'negatif'}">${xpf(c.solde_minimum)}</div>
            <p>${c.jamais_creditrice
              ? 'La caisse n\'a jamais été créditrice.'
              : `Créditrice le ${dateFr(c.date_minimum)} — impossible physiquement.`}</p></div>
        </div>
        ${c.mouvements.length ? `
          <div class="defilant"><table>
            <caption class="sr-seulement">Mouvements d'espèces de la caisse ${echapper(c.compte)}</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Pièce</th><th scope="col">Écriture</th>
              <th scope="col">Libellé</th><th scope="col">Dossier</th>
              <th scope="col" class="nb">Encaissé</th><th scope="col" class="nb">Décaissé</th>
              <th scope="col" class="nb">Solde</th><th scope="col">Signalement</th></tr></thead>
            <tbody>${c.mouvements.map((m) => `
              <tr${m.solde_negatif ? ' class="ligne-critique"' : ''}>
                <td>${dateFr(m.date_ecriture)}</td>
                <td class="compte">${m.sans_piece ? '<span class="pastille critique">absente</span>' : echapper(m.piece_ref)}</td>
                <td class="compte">${echapper(m.journal)}-${m.numero}</td>
                <td>${echapper(m.libelle)}</td>
                <td>${echapper(m.dossier ?? '')}</td>
                <td class="nb">${m.debit ? xpf(m.debit) : ''}</td>
                <td class="nb">${m.credit ? xpf(m.credit) : ''}</td>
                <td class="${montantClasse(m.solde_progressif)}">${xpf(m.solde_progressif)}</td>
                <td>${[
                  m.au_dela_du_plafond ? '<span class="pastille critique">au-delà du plafond</span>' : '',
                  m.solde_negatif ? '<span class="pastille critique">caisse créditrice</span>' : '',
                  m.statut === 'CONTREPASSEE' ? '<span class="pastille majeure">contre-passée</span>' : '',
                ].join(' ')}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr><th colspan="5">Solde d'ouverture ${xpf(c.solde_ouverture)} XPF — solde de clôture</th>
              <th class="nb">${xpf(c.encaissements)}</th><th class="nb">${xpf(c.decaissements)}</th>
              <th class="nb">${xpf(c.solde_final)}</th><th></th></tr></tfoot>
          </table></div>`
        : '<p class="vide">Aucun mouvement d\'espèces sur la période.</p>'}
      </section>`).join('')}

    <section class="carte saut-de-page" style="margin-top:1rem" aria-labelledby="titre-cumul">
      <h2 id="titre-cumul">Espèces par dossier</h2>
      <p>Ventilation des espèces reçues et remises, dossier par dossier. Le plafond cumulé barre
         le fractionnement d'un versement en plusieurs remises inférieures au plafond unitaire.</p>
      ${r.cumul_par_dossier.length ? `
        <table>
          <thead><tr><th scope="col">Dossier</th><th scope="col">Intitulé</th>
            <th scope="col" class="nb">Espèces reçues</th><th scope="col" class="nb">Espèces remises</th><th scope="col"></th></tr></thead>
          <tbody>${r.cumul_par_dossier.map((d) => `
            <tr${d.au_dela_du_plafond_cumule ? ' class="ligne-critique"' : ''}>
              <td>${echapper(d.reference)}</td><td>${echapper(d.intitule)}</td>
              <td class="nb">${xpf(d.encaissements)}</td><td class="nb">${xpf(d.decaissements)}</td>
              <td>${d.au_dela_du_plafond_cumule ? '<span class="pastille critique">cumul au-delà du plafond</span>' : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
      : '<p class="vide">Aucune espèce reçue ou remise pour un dossier.</p>'}
    </section>`;

  $('#c-editer').addEventListener('click', garde(async () => {
    etat.caisseDepuis = $('#c-depuis').value || null;
    etat.caisseJusqu = $('#c-jusqu').value || null;
    await vueCaisse();
  }));
  $('#c-imprimer').addEventListener('click', () => window.print());
}

// ================================================================ inspection

async function vueInspection() {
  const d = await api('/etats/inspection');
  const esp = d.registre_especes;
  const chaine = await api('/controles/chaine');
  const audit = await api('/audit?limite=100');
  const exercices = d.exercices;

  $('#contenu').innerHTML = `
    <div class="carte">
      <header>
        <h2>Dossier d'inspection</h2>
        <button type="button" id="i-imprimer" class="secondaire sans-impression">Imprimer le dossier</button>
      </header>
      <p>État des pièces à présenter lors du contrôle de comptabilité, arrêté le ${dateFr(d.edite_le)}.</p>
      <div class="grille">
        <div><span class="libelle-indicateur">Écritures comptabilisées</span><div class="indicateur">${d.volumetrie.ecritures_comptabilisees}</div></div>
        <div><span class="libelle-indicateur">Dossiers ouverts</span><div class="indicateur">${d.volumetrie.dossiers_ouverts}</div></div>
        <div><span class="libelle-indicateur">Contre-passations</span><div class="indicateur">${d.volumetrie.contrepassations}</div></div>
        <div><span class="libelle-indicateur">Fonds clients</span><div class="indicateur">${xpf(d.representation_fonds.du_aux_clients)}</div></div>
      </div>
    </div>

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
      <h2>Taxe des actes</h2>
      ${avertissementBareme(d.taxes.bareme)}
      <div class="grille">
        <div><span class="libelle-indicateur">Émoluments comptabilisés</span><div class="indicateur">${xpf(d.taxes.totaux.emoluments)}</div></div>
        <div><span class="libelle-indicateur">TGC collectée</span><div class="indicateur">${xpf(d.taxes.totaux.tgc)}</div></div>
        <div><span class="libelle-indicateur">Débours et taxes</span><div class="indicateur">${xpf(d.taxes.totaux.debours)}</div></div>
        <div><span class="libelle-indicateur">Taxes arrêtées non comptabilisées</span>
          <div class="indicateur ${d.taxes.a_comptabiliser.length ? 'negatif' : ''}">${d.taxes.a_comptabiliser.length}</div></div>
      </div>
      <p class="empreinte">Empreinte du barème en service : ${echapper(d.taxes.bareme.empreinte)}</p>
    </div>

    <div class="carte" style="margin-top:1rem">
      <h2>Sommes encaissées pour le compte de tiers</h2>
      <p>Droits d'enregistrement, taxe hypothécaire et débours restant à reverser, arrêtés au ${dateFr(d.debours_a_reverser.arrete_le)}.</p>
      <table>
        <thead><tr><th class="compte">Compte</th><th>Intitulé</th><th class="nb">Dû aux tiers</th></tr></thead>
        <tbody>${d.debours_a_reverser.comptes.map((c) => `
          <tr><td class="compte">${echapper(c.numero)}</td><td>${echapper(c.intitule)}</td>
            <td class="${c.du_au_tiers < 0 ? 'nb negatif' : 'nb'}">${xpf(c.du_au_tiers)}</td></tr>`).join('')}
        </tbody>
        <tfoot><tr><th colspan="2">Total</th><th class="nb">${xpf(d.debours_a_reverser.total_du_au_tiers)}</th></tr></tfoot>
      </table>
      ${d.debours_a_reverser.par_dossier.length ? `
        <h3>Justification dossier par dossier</h3>
        <div class="defilant"><table>
          <thead><tr><th class="compte">Compte</th><th>Dossier</th><th>Intitulé</th><th class="nb">Dû aux tiers</th></tr></thead>
          <tbody>${d.debours_a_reverser.par_dossier.map((x) => `
            <tr><td class="compte">${echapper(x.compte)}</td><td>${echapper(x.reference)}</td>
              <td>${echapper(x.intitule)}</td>
              <td class="${x.du_au_tiers < 0 ? 'nb negatif' : 'nb'}">${xpf(x.du_au_tiers)}</td></tr>`).join('')}
          </tbody>
        </table></div>` : '<p class="vide">Aucune somme restant à reverser.</p>'}
    </div>

    <div class="carte" style="margin-top:1rem">
    <div class="carte saut-de-page" style="margin-top:1rem">
      <h2>Mouvements d'espèces</h2>
      <p>Les espèces ne laissent aucune trace bancaire. Registre détaillé sur l'écran Caisse.</p>
      ${esp.parametres.statut === 'VALIDE' ? '' : `
        <div class="alerte" role="alert"><strong>Critique — plafonds non validés</strong>
          Paramétrage ${echapper(esp.parametres.code)} : ${echapper(esp.parametres.avertissement ?? '')}</div>`}
      <table>
        <thead><tr><th scope="col">Caisse</th><th scope="col">Intitulé</th>
          <th scope="col" class="nb">Encaissé</th><th scope="col" class="nb">Décaissé</th>
          <th scope="col" class="nb">Solde</th><th scope="col" class="nb">Minimum atteint</th>
          <th scope="col">Jamais créditrice</th></tr></thead>
        <tbody>${esp.caisses.map((c) => `
          <tr${c.jamais_creditrice ? '' : ' class="ligne-critique"'}>
            <td class="compte">${echapper(c.compte)}</td><td>${echapper(c.intitule)}</td>
            <td class="nb">${xpf(c.encaissements)}</td><td class="nb">${xpf(c.decaissements)}</td>
            <td class="${montantClasse(c.solde_final)}">${xpf(c.solde_final)}</td>
            <td class="${montantClasse(c.solde_minimum)}">${xpf(c.solde_minimum)}</td>
            <td>${c.jamais_creditrice ? '<span class="pastille ok">oui</span>'
              : `<span class="pastille critique">créditrice le ${dateFr(c.date_minimum)}</span>`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p>${esp.totaux.mouvements} mouvement(s) sur la période —
         ${esp.totaux.sans_piece} sans pièce justificative,
         ${esp.totaux.au_dela_du_plafond} au-delà du plafond unitaire.</p>
    </div>

    <div class="carte saut-de-page" style="margin-top:1rem">
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

  $('#i-imprimer').addEventListener('click', () => window.print());
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

// ======================================================================= TGC

/**
 * Etat preparatoire a la declaration de TGC. Ce n'est pas une declaration :
 * c'est la justification comptable de ce qui sera declare, ventilee par taux
 * et rapprochee du mouvement des comptes de taxe.
 */
async function vueTgc() {
  const { periodes } = await api('/etats/tgc/periodes');
  // On ouvre sur ce qui reclame une action : la plus ancienne periode en
  // retard, a defaut la derniere periode ou la taxe a bouge.
  const defaut = periodes.find((p) => p.en_retard)
    ?? periodes.filter((p) => p.collectee || p.deductible).pop()
    ?? periodes[periodes.length - 1];

  $('#contenu').innerHTML = `
    <div class="carte">
      <header>
        <h2>Déclaration de TGC — état préparatoire</h2>
        <button id="tgc-imprimer" class="secondaire" type="button">Imprimer</button>
      </header>
      <div class="barre-outils" id="tgc-outils">
        <label for="tgc-periode">Période
          <select id="tgc-periode">
            ${periodes.slice().reverse().map((p) => `
              <option value="${p.debut}|${p.fin}"${p === defaut ? ' selected' : ''}>${echapper(p.libelle)}${p.en_retard ? ' — en retard' : ''}</option>`).join('')}
            <option value="libre">Période libre…</option>
          </select>
        </label>
        <label id="tgc-zone-dates" hidden>Du <input type="date" id="tgc-depuis"></label>
        <label id="tgc-zone-dates2" hidden>Au <input type="date" id="tgc-jusqu"></label>
        <button id="tgc-editer" class="secondaire" type="button">Éditer</button>
        <span style="flex:1"></span>
        <a id="tgc-csv" href="/api/export/tgc.csv" download><button type="button" class="secondaire">Export CSV</button></a>
      </div>
      <div id="tgc-rendu"></div>
    </div>`;

  $('#tgc-periode').addEventListener('change', (ev) => {
    const libre = ev.target.value === 'libre';
    $('#tgc-zone-dates').hidden = !libre;
    $('#tgc-zone-dates2').hidden = !libre;
  });
  $('#tgc-editer').addEventListener('click', garde(editerTgc));
  $('#tgc-imprimer').addEventListener('click', () => window.print());
  if (defaut) {
    $('#tgc-depuis').value = defaut.debut;
    $('#tgc-jusqu').value = defaut.fin;
  }
  await editerTgc(periodes);
}

function bornesTgc() {
  const choix = $('#tgc-periode').value;
  if (choix === 'libre') return { depuis: $('#tgc-depuis').value, jusqu: $('#tgc-jusqu').value };
  const [depuis, jusqu] = choix.split('|');
  return { depuis, jusqu };
}

/** Une periode sans mouvement n'est pas « declaree » : elle est sans objet. */
const etiquettePeriodeTgc = (p) => {
  if (p.en_retard) return '<span class="pastille critique">en retard</span>';
  if (!p.collectee && !p.deductible && !p.reste_a_liquider) return '<span class="pastille minuscule">néant</span>';
  if (p.liquidee) return '<span class="pastille ok">déclarée</span>';
  return '<span class="pastille minuscule">à déclarer</span>';
};

const ligneTaux = (t) => `
  <tr>
    <td>${echapper(t.libelle)}</td>
    <td class="nb">${(t.taux_millieme / 10).toLocaleString('fr-FR')} %</td>
    <td class="nb">${xpf(t.assiette)}</td>
    <td class="nb">${xpf(t.taxe)}</td>
    <td class="nb">${t.ecritures}</td>
  </tr>`;

const tableTaux = (titre, bloc) => `
  <h3>${titre}</h3>
  ${bloc.taux.length ? `<table>
    <thead><tr><th>Taux</th><th class="nb">Barème</th><th class="nb">Assiette</th><th class="nb">Taxe</th><th class="nb">Écritures</th></tr></thead>
    <tbody>${bloc.taux.map(ligneTaux).join('')}</tbody>
    <tfoot><tr><th colspan="2">Total</th><th class="nb">${xpf(bloc.assiette_totale)}</th>
      <th class="nb">${xpf(bloc.total)}</th><th></th></tr></tfoot>
  </table>` : '<p class="vide">Aucun mouvement sur la période.</p>'}`;

async function editerTgc(periodesConnues = null) {
  const { depuis, jusqu } = bornesTgc();
  const p = new URLSearchParams();
  if (depuis) p.set('depuis', depuis);
  if (jusqu) p.set('jusqu', jusqu);
  const e = await api(`/etats/tgc?${p}`);
  const periodes = periodesConnues ?? (await api('/etats/tgc/periodes')).periodes;
  $('#tgc-csv').href = `/api/export/tgc.csv?${p}`;

  const retards = periodes.filter((x) => x.en_retard);

  $('#tgc-rendu').innerHTML = `
    ${e.parametres.statut === 'VALIDE' ? '' : `
      <div class="alerte majeure">
        <strong>Barème non validé</strong>
        ${echapper(e.parametres.avertissement)}
      </div>`}

    ${retards.length ? `
      <div class="alerte">
        <strong>Déclaration en retard</strong>
        ${retards.length} période(s) échue(s) non déclarée(s), la plus ancienne étant
        ${echapper(retards[0].libelle)} (échéance ${dateFr(retards[0].echeance)},
        ${xpf(retards[0].reste_a_liquider)} XPF de TGC collectée).
      </div>` : ''}

    <div class="grille">
      <div class="carte">
        <div class="libelle-indicateur">TGC nette de la période</div>
        <div class="indicateur ${e.net.montant < 0 ? 'negatif' : ''}">${xpf(Math.abs(e.net.montant))} <small>XPF</small></div>
        <p>${e.net.a_decaisser ? 'À décaisser au profit du Trésor.' : e.net.credit_reportable ? 'Crédit de TGC reportable.' : 'Rien à déclarer.'}</p>
      </div>
      <div class="carte">
        <div class="libelle-indicateur">Justification</div>
        <span class="pastille ${e.controle.justifie ? 'ok' : 'critique'}">
          ${e.controle.justifie ? 'ventilation rapprochée' : 'écart non justifié'}
        </span>
        <p>TGC collectée ventilée par taux : ${xpf(e.controle.ventile_collectee)} XPF,
           dont ${xpf(e.controle.liquide_collectee)} XPF déjà portés en déclaration.
           Écart avec le mouvement des comptes de taxe :
           <strong>${xpf(e.controle.ecart_collectee)} XPF</strong> en collectée,
           <strong>${xpf(e.controle.ecart_deductible)} XPF</strong> en déductible.</p>
      </div>
      <div class="carte">
        <div class="libelle-indicateur">Soldes au ${dateFr(e.periode.jusqu ?? e.arrete_le)}</div>
        <table><tbody>
          <tr><td class="compte">${echapper(e.comptes.collectee)}</td><td>TGC collectée</td><td class="nb">${xpf(e.soldes.collectee)}</td></tr>
          <tr><td class="compte">${echapper(e.comptes.deductible)}</td><td>TGC déductible</td><td class="nb">${xpf(e.soldes.deductible)}</td></tr>
          <tr><td class="compte">${echapper(e.comptes.a_decaisser)}</td><td>TGC à décaisser</td><td class="nb">${xpf(e.soldes.a_decaisser)}</td></tr>
        </tbody></table>
      </div>
    </div>

    ${tableTaux('TGC collectée', e.collectee)}
    ${tableTaux('TGC déductible', e.deductible)}

    ${e.non_ventilees.length ? `
      <h3>Écritures non rattachables à un taux</h3>
      <div class="alerte"><strong>À justifier</strong>
        Ces écritures portent de la TGC sans assiette identifiable : la déclaration ne peut pas s'en prévaloir.</div>
      <table>
        <thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th>Sens</th><th class="nb">Assiette</th><th class="nb">Taxe</th></tr></thead>
        <tbody>${e.non_ventilees.map((n) => `
          <tr><td>${dateFr(n.date_ecriture)}</td><td class="compte">${echapper(n.journal)}-${n.numero}</td>
            <td>${echapper(n.libelle)}</td><td>${echapper(n.cote)}</td>
            <td class="nb">${xpf(n.assiette)}</td><td class="nb">${xpf(n.taxe)}</td></tr>`).join('')}
        </tbody>
      </table>` : ''}

    <h3>Périodes de déclaration (${echapper(e.parametres.periodicite.toLowerCase())})</h3>
    <div class="defilant"><table>
      <thead><tr><th>Période</th><th>Échéance</th><th class="nb">Collectée</th><th class="nb">Déductible</th>
        <th class="nb">Net</th><th class="nb">Reste à déclarer</th><th>État</th></tr></thead>
      <tbody>${periodes.slice().reverse().map((x) => `
        <tr><td>${echapper(x.libelle)}</td><td>${dateFr(x.echeance)}</td>
          <td class="nb">${xpf(x.collectee)}</td><td class="nb">${xpf(x.deductible)}</td>
          <td class="nb">${xpf(x.net)}</td><td class="nb">${xpf(x.reste_a_liquider)}</td>
          <td>${etiquettePeriodeTgc(x)}</td></tr>`).join('')}
      </tbody>
    </table></div>

    ${e.soldes.collectee > 0 && etat.utilisateur.role !== 'INSPECTEUR' ? `
      <div class="barre-outils" style="margin-top:1rem">
        <button id="tgc-preparer" type="button">Préparer l'écriture de déclaration</button>
      </div>
      <p class="vide">L'écriture est créée en brouillon : elle ne sera comptabilisée qu'après vérification et validation.</p>`
      : ''}`;

  $('#tgc-preparer')?.addEventListener('click', garde(async () => {
    const b = await api('/tgc/liquidation', { methode: 'POST', corps: bornesTgc() });
    message(`Brouillon de déclaration créé (écriture ${b.id}). À vérifier puis comptabiliser.`);
    await afficher('ecritures');
  }));
}

const VUES = {
  tableau: vueTableau,
  saisie: vueSaisie,
  ecritures: vueEcritures,
  dossiers: vueDossiers,
  taxe: vueTaxe,
  rapprochement: vueRapprochement,
  etats: vueEtats,
  caisse: vueCaisse,
  tgc: vueTgc,
  inspection: vueInspection,
};

// Reprise de session si le cookie est encore valide.
api('/moi').then(demarrer).catch(() => { $('#connexion').hidden = false; });
