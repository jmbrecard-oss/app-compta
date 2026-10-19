# Conformité — note technique

## Avertissement préalable

**Ce logiciel n'est pas agréé.** L'agrément d'un logiciel de comptabilité notariale
est une procédure officielle : audit par l'instance professionnelle, homologation,
engagement de l'éditeur, maintenance réglementaire suivie. Aucun code ne confère
cet agrément, et ce document ne le prétend pas.

Ce qui suit décrit la **conformité technique aux règles de tenue de la comptabilité
notariale** — c'est-à-dire ce qu'un contrôle vérifie. C'est le socle sur lequel une
démarche d'agrément peut s'appuyer, pas l'agrément lui-même.

Avant tout usage en production, faites valider ce dossier par la Chambre des
notaires de Nouvelle-Calédonie et par votre expert-comptable.

---

## 1. Séparation des fonds de l'office et des fonds des clients

| Règle | Mise en œuvre | Vérifiable par |
|---|---|---|
| Les fonds reçus pour le compte des clients sont détenus sur des comptes de dépôt distincts | Comptes de nature `DEPOT_FONDS_CLIENTS` (512500, 512600), distincts du compte office (512100) | Plan comptable, [`src/pcn.js`](src/pcn.js) |
| Aucune confusion entre une recette de l'office et un mouvement de fonds clients | `controleEtancheite` : une écriture ne peut pas mouvementer simultanément un compte de dépôt clients et un compte de charge ou de produit. Les émoluments transitent obligatoirement par le compte client du dossier | [`controles.js`](src/domain/controles.js) · test « étanchéité » |
| Les fonds clients sont représentés à tout instant | `controleRepresentationFonds` : la somme des disponibilités affectées doit couvrir le total dû aux clients. Contrôle **bloquant** à chaque comptabilisation | test « prélèvement sur les fonds clients refusé » |

## 2. Comptes clients individualisés

| Règle | Mise en œuvre |
|---|---|
| Un compte distinct par dossier, jamais un compte collectif | Chaque dossier reçoit à l'ouverture un compte `411xxxxx` qui lui est propre et qui n'est jamais réattribué. Le compte collectif 411000 est marqué `collectif` et son imputation est refusée |
| **Aucun compte client ne peut être débiteur** | `controleSoldeClients`, exécuté après insertion des lignes, dans la transaction : si le solde devient débiteur, toute l'écriture est annulée et reste en brouillon. L'office ne peut donc jamais avancer de fonds |
| Pas de compensation entre dossiers | Le contrôle porte dossier par dossier. Un dossier créditeur ne compense jamais un dossier débiteur. L'état des comptes clients liste chaque dossier séparément |
| Un dossier ne se clôt que soldé | `cloreDossier` refuse tant que le solde n'est pas nul |

## 3. Inaltérabilité et piste d'audit

| Règle | Mise en œuvre |
|---|---|
| Une écriture comptabilisée ne peut plus être modifiée ni supprimée | Déclencheurs SQLite `trg_ecriture_maj_interdite`, `trg_ecriture_suppr_interdite`, idem sur les lignes. Le verrou est **dans la base** : il résiste à un accès direct par un outil tiers |
| Seule correction possible : la contre-passation | `contrepasser` génère l'écriture miroir, exige un motif écrit et conserve le lien entre les deux écritures |
| Chaînage cryptographique | Chaque écriture comptabilisée porte une empreinte SHA-256 calculée sur son contenu **et** sur l'empreinte de la précédente. Toute altération d'une écriture ancienne casse la chaîne de toutes les suivantes |
| Vérification à la demande | `verifierChaineEcritures()` recalcule la chaîne complète ; exposé dans l'écran Inspection et contrôlé avant toute clôture d'exercice |
| Journal d'audit en ajout seul | Table `audit`, également chaînée, protégée par déclencheurs contre toute mise à jour ou suppression. Chaque opération y est tracée nominativement avec horodatage |
| Numérotation chronologique continue | Le numéro de pièce est attribué **à la comptabilisation**, pas à la saisie : la séquence par journal et par exercice est continue, sans trou. Un brouillon abandonné ne consomme aucun numéro |
| Pas de rétro-datation | `controleChronologie` refuse une écriture antérieure à la dernière écriture déjà comptabilisée dans le même journal |
| Exercice clos verrouillé | `controleExercice` refuse toute écriture dont la date tombe dans un exercice clos |

## 4. Tenue de la comptabilité

- Partie double contrôlée à la comptabilisation (`controleEquilibre`), écriture de
  montant nul refusée.
- Montants en **entiers de XPF** : le franc Pacifique n'a pas de subdivision.
  Tout montant non entier est refusé ; aucun arrondi n'est pratiqué silencieusement.
- Plan comptable notarial adapté au territoire : TGC (3 / 6 / 11 / 22 %) au lieu de
  la TVA, CAFAT, patente, droits d'enregistrement et taxe hypothécaire à reverser.
- Journaux séparés pour la banque office (BQO) et le dépôt des fonds clients (BQC).
- Lettrage refusé sur un lot déséquilibré (un lettrage déséquilibré masquerait un
  solde non justifié).
- Compte d'attente 471000 signalé dès qu'il n'est pas soldé, et bloquant à la clôture.

## 5. Contrôles périodiques

- **Rapprochement bancaire** : ne peut être clos que si l'écart entre le solde
  rapproché et le solde du relevé est nul.
- **Clôture d'exercice** : `controlePreCloture` énumère les obstacles — brouillons
  non traités, comptes d'attente non soldés, dossiers débiteurs, fonds non
  représentés, chaîne altérée, rapprochement bancaire manquant. La clôture génère
  les à-nouveaux et scelle l'exercice par une empreinte.
- **Rôles** : le rôle `INSPECTEUR` dispose d'un accès en lecture intégrale et
  d'aucun droit d'écriture.

## 6. Restitution des données

- **Export FEC** : fichier des écritures comptables à 18 colonnes, séparateur
  tabulation, dates AAAAMMJJ. Les brouillons en sont exclus par construction.
  Le dossier tient lieu de compte auxiliaire pour les comptes clients.
- **Dossier d'inspection** : balance, état des comptes clients, état de
  représentation des fonds, anomalies, rapprochements, volumétrie, état de la
  chaîne d'inaltérabilité, piste d'audit — rassemblés sur un écran unique.
- Exports CSV de la balance et de l'état des comptes clients.

---

## Ce qui n'est pas couvert

Périmètre volontairement limité au noyau comptable. Ne sont pas traités :

- le **tarif réglementé** : barèmes d'émoluments, calcul automatique des débours
  et des taxes, génération du compte définitif client ;
- les **déclarations fiscales** (TGC, résultat) et la **paie** ;
- la **gestion des actes** et le répertoire ;
- l'**archivage à valeur probante** externalisé et la sauvegarde hors site ;
- la signature électronique et l'interface avec les téléprocédures.

## Points à arbitrer avec la Chambre avant mise en production

1. **Numérotation des comptes clients** : le format retenu est `411` + 5 chiffres.
   À confirmer avec le plan en vigueur localement.
2. **Seuil de représentation des fonds** : le contrôle actuel exige une couverture
   ≥ 100 % en permanence, sans tolérance. À confirmer.
3. **Comptes de dépôt** : la liste (512500, 512600) doit correspondre aux comptes
   réellement ouverts auprès de l'établissement teneur.
4. **Durée de conservation** et modalités de sauvegarde de la base.
5. **Rapprochement obligatoire** : la clôture exige aujourd'hui un rapprochement
   clos à la date de fin d'exercice pour chaque compte rapprochable.
