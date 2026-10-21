# Comptabilité notariale — Nouvelle-Calédonie

Noyau comptable pour office notarial : comptes clients individualisés par dossier,
séparation stricte des fonds de l'office et des fonds des clients, écritures
inaltérables, export FEC et dossier d'inspection.

Application web **locale** : les données ne quittent jamais le poste ou le serveur
de l'étude. Aucune dépendance externe — Node.js seul suffit (SQLite est intégré au
moteur depuis Node 22.5).

> **Ce logiciel n'est pas attesté et ne peut pas être utilisé en production par un
> office.** En métropole, l'arrêté du 27 janvier 2006 impose qu'un **commissaire aux
> comptes** atteste la conformité de tout logiciel de comptabilité notariale *avant* sa
> mise en service, que le Conseil supérieur du notariat en tienne la liste, et que les
> inspecteurs vérifient que l'office utilise bien un logiciel de cette liste. En
> Nouvelle-Calédonie, l'applicabilité de ce texte reste à établir auprès de la Chambre.
> Le détail et les sources : [CONFORMITE.md](CONFORMITE.md).

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

**Pièces justificatives.** Aucune écriture ne se comptabilise sans la référence de
la pièce qui la justifie, datée et jamais postérieure à l'écriture. Dans les journaux
d'achats et d'émoluments, une même référence ne peut pas être comptabilisée deux
fois : la double imputation d'une facture est refusée. Un relevé bancaire, lui,
justifie autant d'écritures qu'il comporte de lignes.

**Comptabilisation.** À cet instant, et seulement à cet instant, l'écriture reçoit
son numéro de séquence, passe les contrôles bloquants et entre dans la chaîne
d'empreintes. Elle devient alors immuable : la base elle-même refuse toute
modification. La seule correction possible est la contre-passation, qui exige un
motif conservé.

**Contrôles bloquants.** Équilibre, montants entiers en XPF, exercice ouvert,
chronologie du journal, étanchéité office/clients, solde client jamais débiteur,
représentation permanente des fonds clients, rattachement au dossier de tout
émolument et de tout débours à reverser. Un refus annule toute l'écriture et
la laisse en brouillon, avec le motif exact.
représentation permanente des fonds clients, justification par une pièce. Un refus
annule toute l'écriture et la laisse en brouillon, avec le motif exact.

**Taxe des actes.** Liquidation des émoluments, des débours et des taxes à partir d'un
barème **paramétrable** : tranches, taux, assiettes, minimums, comptes d'imputation et
règle d'arrondi sont lus dans un fichier de données, jamais écrits dans le code. Calcul
entier de bout en bout, un seul arrondi par prestation, justification conservée tranche
par tranche. Une taxe passe par projet, arrêté — où elle est recalculée et confrontée au
barème — puis comptabilisation, qui génère l'écriture de l'acte. Compte définitif du
client et état des sommes restant à reverser au Trésor.

> Le barème livré est **fictif** et doit être remplacé par le tarif du décret
> n° 78-321/CG du 26 septembre 1978. Voir [CONFORMITE.md](CONFORMITE.md).
**Espèces.** Les espèces ne laissent aucune trace bancaire : la pièce justificative
est exigée à la comptabilisation, un règlement reste sous le plafond — unitaire et
cumulé par dossier, pour que le fractionnement ne le contourne pas — et une caisse
n'est jamais créditrice, à aucune date. Les espèces reçues pour un client ont leur
propre caisse (`531500`), comptée dans la représentation des fonds et jamais mêlée à
celle de l'office. Un registre reprend chaque mouvement avec son solde progressif.
Les plafonds sont lus dans `src/parametres/especes-nc.json` : **les valeurs livrées
sont fictives** et doivent être validées par la Chambre.
**Placements de fonds clients.** Les fonds placés en compte rubriqué restent rattachés
nominativement à leur dossier : un mouvement sans dossier désigné est refusé, un dossier
ne peut pas voir placer plus que ce qu'il détient ni retirer plus qu'il n'a placé, et les
produits du placement reviennent au dossier qui les a produits. Un état de contrôle
rapproche la somme des rubriques du solde des comptes de placement.

**Rapprochement bancaire.** Pointage des mouvements, calcul du solde rapproché,
clôture refusée tant qu'un écart subsiste. La *continuité* est surveillée : chaque
compte rapprochable a son calendrier de périodes depuis son premier mouvement, les
périodes non rapprochées sont relancées automatiquement, et un arrêté ne peut pas être
clos tant que le précédent ne l'est pas. Un arrêté en cours de mois ne couvre aucune
période.

**TGC.** État préparatoire à la déclaration : la taxe collectée et la taxe déductible
sont ventilées par taux à partir des seules écritures comptabilisées, puis rapprochées
du mouvement des comptes 445600 / 445700. Toute taxe comptabilisée doit correspondre à
un taux en vigueur appliqué à l'assiette de la même écriture, sinon l'écriture est
refusée. Les périodes échues et non déclarées sont relancées et font obstacle à la
clôture. L'écriture de déclaration est proposée en brouillon.

> Les taux, la périodicité et la règle d'arrondi ne sont pas dans le code : ils sont lus
> dans `src/parametres/tgc-nc.json`, **livré non vérifié** et à confronter au texte en
> vigueur avant tout usage. Le chargeur refuse un fichier qui se déclarerait conforme
> sans citer sa source.

**États.** Balance, grand livre, journaux, compte de résultat, bilan, état des
comptes clients, état de représentation des fonds, état des taxes, état des sommes à
reverser aux tiers, compte définitif du client. Exports FEC (18 colonnes) et CSV.
comptes clients, état de représentation des fonds, registre des espèces. Exports FEC
(18 colonnes) et CSV. Tous s'impriment sur une feuille dédiée : identité de l'office
en tête, en-têtes de tableaux répétés, aucune colonne tronquée.
comptes clients, état de représentation des fonds. Exports FEC (18 colonnes) et CSV.
Tous les états s'impriment : en-têtes de tableaux répétés sur chaque page, aucune
colonne tronquée, identité de l'office en tête du document.
comptes clients, état de représentation des fonds, état des placements rubriqués.
Exports FEC (18 colonnes) et CSV.
comptes clients, état de représentation des fonds. Exports FEC (18 colonnes), archive
scellée et CSV.

**Inspection.** Un écran rassemble ce qu'un contrôle demande : volumétrie, état de
la chaîne d'inaltérabilité, mouvements d'espèces, anomalies classées par gravité,
exercices, piste d'audit nominative et horodatée.
la chaîne d'inaltérabilité, continuité des rapprochements bancaires, anomalies classées
par gravité, exercices, piste d'audit nominative et horodatée.

**Clôture d'exercice.** Diagnostic préalable listant chaque obstacle — dont chaque
période d'un compte rapprochable restée sans rapprochement clos —, génération des
**Archive scellée.** La chaîne complète des écritures comptabilisées s'exporte en un
document unique, scellé par une empreinte, relisible sans l'application. Un utilitaire
séparé le vérifie — il n'ouvre pas la base et ne connaît que le fichier reçu :

```bash
node src/verifier-archive.js 1234567-ARCHIVE-20261020.json --racine <empreinte déposée>
```

Il rend un rapport contrôle par contrôle et un code de sortie 0 ou 1. Sans `--racine`,
il établit la cohérence interne de l'archive ; avec, il établit qu'il s'agit bien de
l'archive arrêtée par l'office. La racine — empreinte de la dernière écriture, qui résume
toutes les précédentes — doit être conservée **hors** de l'archive : c'est elle, et elle
seule, qui rend une falsification détectable. Voir
[CONFORMITE.md](CONFORMITE.md), Partie II § 7.
la chaîne d'inaltérabilité, justification des écritures par les pièces, anomalies
classées par gravité, exercices, piste d'audit nominative et horodatée.

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
  erreurs.js          refus de conformité (code, message, contexte)
  baremes/
    bareme-nc.json    barème du tarif — données séparées du code, à remplacer
  domain/
    controles.js      règles de conformité — le cœur du dispositif
    ecritures.js      cycle brouillon → comptabilisation → contre-passation
    dossiers.js       dossiers et comptes clients individualisés
    bareme.js         moteur de liquidation du tarif (aucun chiffre en dur)
    tarif.js          taxe des actes : projet → arrêté → comptabilisation
    especes.js        plafonds, caisse jamais créditrice, registre des espèces
    placements.js     comptes rubriqués, placements et produits affectés
    rapprochement.js  rapprochement bancaire
    surveillance.js   périodicité des rapprochements, relance des périodes manquantes
    lettrage.js       lettrage des comptes de tiers
    tgc.js            contrôle de la taxe, état préparatoire, relance des périodes
    cloture.js        exercices, pré-clôture, à-nouveaux
  parametres/
    especes-nc.json   plafonds des espèces — VALEURS FICTIVES, à faire valider
    tgc-nc.json       taux et périodicité de TGC — À VALIDER auprès de la DSF
  reports/
    etats.js          balance, grand livre, résultat, comptes clients, inspection
    fec.js            export FEC et CSV
    archive.js        édition de l'archive scellée
    verification-archive.js  vérification d'une archive, sans accès à la base
  verifier-archive.js utilitaire de vérification indépendant (ligne de commande)
  server.js           API HTTP et service des fichiers statiques
public/               interface (HTML/CSS/JS, sans framework)
test/                 tests de conformité
test/                 51 tests de conformité
test/                 35 tests de conformité
test/                 32 tests de conformité
test/                 34 tests de conformité
test/                 28 tests de conformité
```

## Exploitation

- La base est le fichier `data/compta.sqlite` (plus `-wal` et `-shm`).
  **Sauvegardez les trois.** Une base notariale perdue ne se reconstitue pas.
- Le serveur n'écoute que sur `127.0.0.1`. Pour le partager dans l'étude :
  `HOTE=0.0.0.0 PORT=7420 npm start`, derrière un reverse proxy TLS, sur le réseau
  interne uniquement.
- Le barème du tarif est le fichier `src/baremes/bareme-nc.json`. Pour en utiliser un
  autre : `COMPTA_BAREME=/chemin/vers/bareme.json npm start`. Un fichier modifié est
  repris sans redémarrage, et chaque taxe conserve l'empreinte de celui qui l'a produite.
- Les mots de passe sont dérivés par PBKDF2-SHA512 (210 000 itérations).
  Les sessions durent 12 heures.
- Changez le mot de passe initial dès la première connexion.

## Limites

**Le barème du tarif livré est fictif.** Le moteur de calcul de la taxe des actes est en
place, mais les taux et tranches de `src/baremes/bareme-nc.json` sont inventés pour les
besoins des tests. Ils doivent être remplacés par ceux du décret n° 78-321/CG du
26 septembre 1978 et la correspondance validée par la Chambre. Tant que ce n'est pas fait,
l'application le signale comme une anomalie critique et aucune taxe qu'elle produit n'a de
valeur.

Ne sont pas couverts les déclarations fiscales, la paie, la gestion des actes et
l'archivage à valeur probante. Voir la section correspondante de
Périmètre : noyau comptable. Ne sont pas couverts le tarif réglementé et le calcul
des émoluments, les déclarations fiscales, la paie, la gestion des actes et
l'archivage à valeur probante. Les plafonds de règlement en espèces livrés avec
l'application sont **fictifs** : ils rendent le dispositif de contrôle démontrable,
ils ne disent pas le droit. Voir la section correspondante de
des émoluments, la télédéclaration et la liasse de résultat, la paie, la gestion des
actes et l'archivage à valeur probante. Les paramètres de TGC livrés n'ont pas été
relevés sur le texte en vigueur et doivent l'être avant tout usage. Voir la section correspondante de
des émoluments, les déclarations fiscales, la paie, la gestion des actes, ni
l'horodatage qualifié et la sauvegarde hors site de l'archive. Voir la section correspondante de
[CONFORMITE.md](CONFORMITE.md), ainsi que les points à arbitrer avec la Chambre
avant toute mise en production.
