# Comptabilité notariale — Nouvelle-Calédonie

Noyau comptable pour office notarial : comptes clients individualisés par dossier,
séparation stricte des fonds de l'office et des fonds des clients, écritures
inaltérables, export FEC et dossier d'inspection.

Application web **locale** : les données ne quittent jamais le poste ou le serveur
de l'étude. Aucune dépendance externe — Node.js seul suffit (SQLite est intégré au
moteur depuis Node 22.5).

> **L'agrément de la profession est une procédure officielle qu'aucun logiciel ne
> s'attribue lui-même.** Ce projet vise la conformité technique aux règles que
> vérifie un contrôle de comptabilité. Voir [CONFORMITE.md](CONFORMITE.md).

## Démarrer

```bash
cd ~/Desktop/compta-notariale && npm start
```

Au premier lancement, le plan comptable, les journaux, l'exercice courant et un
compte notaire sont créés ; l'identifiant et le mot de passe s'affichent dans le
terminal. L'interface est ensuite sur http://127.0.0.1:7420.

Pour renseigner l'office dès l'installation :

```bash
node src/init.js --office "SCP DUPONT & ASSOCIÉS" --notaire "Me Dupont" --ridet 1234567.001
```

Tests :

```bash
npm test
```

## Ce que fait l'application

**Dossiers.** Chaque dossier reçoit à son ouverture un compte client individualisé
(`411xxxxx`) qui lui reste attaché à vie. Son compte ne peut jamais devenir
débiteur : l'office n'avance pas de fonds pour un client. Un dossier ne se clôt
que soldé.

**Saisie.** Modèles d'écritures pour les opérations courantes — réception de fonds,
débours, facturation des émoluments, virement vers le compte office, restitution du
solde. Équilibre affiché en direct. Une écriture naît en brouillon ; elle n'existe
comptablement qu'une fois comptabilisée.

**Comptabilisation.** À cet instant, et seulement à cet instant, l'écriture reçoit
son numéro de séquence, passe les contrôles bloquants et entre dans la chaîne
d'empreintes. Elle devient alors immuable : la base elle-même refuse toute
modification. La seule correction possible est la contre-passation, qui exige un
motif conservé.

**Contrôles bloquants.** Équilibre, montants entiers en XPF, exercice ouvert,
chronologie du journal, étanchéité office/clients, solde client jamais débiteur,
représentation permanente des fonds clients. Un refus annule toute l'écriture et
la laisse en brouillon, avec le motif exact.

**Rapprochement bancaire.** Pointage des mouvements, calcul du solde rapproché,
clôture refusée tant qu'un écart subsiste.

**États.** Balance, grand livre, journaux, compte de résultat, bilan, état des
comptes clients, état de représentation des fonds. Exports FEC (18 colonnes) et CSV.

**Inspection.** Un écran rassemble ce qu'un contrôle demande : volumétrie, état de
la chaîne d'inaltérabilité, anomalies classées par gravité, exercices, piste
d'audit nominative et horodatée.

**Clôture d'exercice.** Diagnostic préalable listant chaque obstacle, génération des
à-nouveaux, scellement de l'exercice par une empreinte.

## Rôles

| Rôle | Droits |
|---|---|
| `NOTAIRE` | tout, y compris l'administration des utilisateurs |
| `COMPTABLE` | saisie, comptabilisation, contre-passation, clôture |
| `CLERC` | consultation et saisie de brouillons |
| `INSPECTEUR` | **lecture seule intégrale** — pour le contrôle |

```bash
curl -X POST localhost:7420/api/utilisateurs -H 'content-type: application/json' \
  -d '{"identifiant":"inspecteur","nom":"Chambre","role":"INSPECTEUR","motDePasse":"..."}'
```

## Organisation du code

```
src/
  schema.sql          tables, vues et déclencheurs d'inaltérabilité
  pcn.js              plan comptable notarial adapté à la Nouvelle-Calédonie
  db.js hash.js       accès SQLite, empreintes, mots de passe
  audit.js auth.js    journal d'audit chaîné, sessions et droits
  domain/
    controles.js      règles de conformité — le cœur du dispositif
    ecritures.js      cycle brouillon → comptabilisation → contre-passation
    dossiers.js       dossiers et comptes clients individualisés
    rapprochement.js  rapprochement bancaire
    lettrage.js       lettrage des comptes de tiers
    cloture.js        exercices, pré-clôture, à-nouveaux
  reports/
    etats.js          balance, grand livre, résultat, comptes clients, inspection
    fec.js            export FEC et CSV
  server.js           API HTTP et service des fichiers statiques
public/               interface (HTML/CSS/JS, sans framework)
test/                 21 tests de conformité
```

## Exploitation

- La base est le fichier `data/compta.sqlite` (plus `-wal` et `-shm`).
  **Sauvegardez les trois.** Une base notariale perdue ne se reconstitue pas.
- Le serveur n'écoute que sur `127.0.0.1`. Pour le partager dans l'étude :
  `HOTE=0.0.0.0 PORT=7420 npm start`, derrière un reverse proxy TLS, sur le réseau
  interne uniquement.
- Les mots de passe sont dérivés par PBKDF2-SHA512 (210 000 itérations).
  Les sessions durent 12 heures.
- Changez le mot de passe initial dès la première connexion.

## Limites

Périmètre : noyau comptable. Ne sont pas couverts le tarif réglementé et le calcul
des émoluments, les déclarations fiscales, la paie, la gestion des actes et
l'archivage à valeur probante. Voir la section correspondante de
[CONFORMITE.md](CONFORMITE.md), ainsi que les points à arbitrer avec la Chambre
avant toute mise en production.
