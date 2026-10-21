# Conformité — note technique

## Partie I. Le cadre réglementaire réel

### 1. France métropolitaine : une attestation, pas un agrément

Le régime applicable est fixé par l'**arrêté du 27 janvier 2006 relatif à l'attestation de
conformité des logiciels de comptabilité des offices de notaires** (NOR : JUSC0620003A,
JORF n° 39 du 15 février 2006, texte n° 20), entré en vigueur le 1ᵉʳ juillet 2006.

| Article | Ce qu'il impose |
|---|---|
| **art. 1** | **Tout** logiciel de comptabilité d'un office de notaire fait l'objet, **par un commissaire aux comptes**, d'une attestation de conformité aux prescriptions de l'arrêté et de ses annexes. L'attestation intervient **préalablement à la mise en service** dans l'office — qu'il s'agisse d'un logiciel initial **ou modifié**. Elle est délivrée pour **trois ans**, sous réserve que le logiciel ne soit pas modifié dans ce délai. |
| **art. 2** | L'examen porte sur **l'ensemble** de la comptabilité notariale — activités accessoires et taxe des actes comprises — et sur **tous les modules dès lors qu'ils génèrent des écritures comptables**. Seuls sont pris en compte les tests réalisés en conditions d'exploitation réelle et supervisés par le concepteur. |
| **art. 3** | Le commissaire aux comptes établit un rapport identifiant le **nom et le numéro de version** du logiciel ainsi que les modules rattachés, et y atteste — ou refuse d'attester, en motivant son refus. |
| **art. 4** | Le rapport est remis au **Conseil supérieur du notariat**, qui centralise les rapports et **dresse la liste des logiciels attestés**. Le CSN délivre un **récépissé de dépôt** notifié au concepteur. À l'installation dans un office, le concepteur en remet copie au notaire, **qui doit la conserver**. |
| **art. 6** | Lors des **inspections d'offices** prévues par le décret n° 74-737 du 12 août 1974, les inspecteurs ont **l'obligation de vérifier** que le logiciel utilisé correspond à celui du récépissé et figure sur la liste établie par le CSN. |

**Qui agrée, précisément ?** Ni la Chambre, ni le CSN. C'est un **commissaire aux comptes**
qui atteste la conformité ; le CSN tient le **registre** et délivre le récépissé. Le mot
« agrément » est un raccourci de la profession, juridiquement inexact.

**L'effet pratique est néanmoins celui d'un agrément.** Un notaire qui tiendrait sa
comptabilité sur un logiciel absent de la liste du CSN serait en défaut, et l'inspection le
relèverait : l'article 6 fait de cette vérification une **obligation** pour l'inspecteur, pas
une faculté. Trois éditeurs occupent aujourd'hui ce marché attesté : Genapi (Septeo),
Fiducial et Fichorga.

### 2. Nouvelle-Calédonie : le régime métropolitain ne s'applique pas de plein droit

Deux éléments, qui se combinent :

1. **Spécialité législative.** En Nouvelle-Calédonie, une norme métropolitaine n'est
   applicable que si un texte l'y étend **expressément**. À défaut de mention, elle ne
   s'applique pas.
2. **Le notariat calédonien est hors du statut métropolitain.** L'ordonnance n° 45-2590 du
   2 novembre 1945 portant statut du notariat écarte explicitement la Nouvelle-Calédonie,
   la Polynésie française et Wallis-et-Futuna du territoire d'exercice des notaires qu'elle
   régit. Le décret n° 45-0117 du 19 décembre 1945, pris pour son application, ne comporte
   qu'une seule disposition outre-mer (art. 39-1) et elle vise **Saint-Pierre-et-Miquelon
   seulement**.

L'arrêté du 27 janvier 2006 ne comporte aucune clause d'extension outre-mer dans ses huit
articles. **Rien dans les sources consultées n'établit donc son applicabilité directe en
Nouvelle-Calédonie** — et rien n'établit non plus le contraire de façon certaine : il faudrait
vérifier l'existence d'un texte local d'extension ou d'un texte calédonien équivalent, ce que
les sources publiques consultées ne permettent pas de trancher.

Ce qui est certain, en revanche : **le territoire dispose de sa propre réglementation
notariale**. Le tarif des notaires y est fixé par le **décret n° 78-321/CG du 26 septembre
1978** (JONC du 29 septembre 1978), texte local sans équivalent métropolitain.

> **Question à poser à la Chambre des notaires de Nouvelle-Calédonie, avant tout
> développement commercial :**
> 1. L'arrêté du 27 janvier 2006 est-il rendu applicable en Nouvelle-Calédonie, et par quel
>    texte ?
> 2. À défaut, quelles exigences locales pèsent sur un logiciel de comptabilité d'office ?
> 3. Quelle instance tient la liste des logiciels admis, et selon quelle procédure ?
> 4. Les inspections d'offices calédoniennes vérifient-elles l'origine du logiciel comptable ?
>
> Tant que ces quatre réponses ne sont pas écrites, **aucun office ne peut raisonnablement
> adopter cette application comme outil comptable de production.**

### 3. Conséquences directes sur ce projet

**a) Le cycle de vie du logiciel doit être figé par version.** L'attestation porte sur un
**numéro de version précis** (art. 3) et tombe à la moindre modification (art. 1). Un produit
dont le code change en continu est structurellement incompatible avec ce régime. La
discipline à adopter :

- une **version attestée** figée, identifiée par un tag git immuable, seule déployée en
  office ;
- une branche de développement distincte, où les évolutions s'accumulent ;
- une **nouvelle attestation** avant chaque mise en service d'une version modifiée ;
- la conservation, pour chaque office, de la copie du récépissé (art. 4).

**b) Le périmètre d'examen est plus large que le noyau actuel.** L'article 2 impose que la
vérification porte sur la **taxe des actes** et sur **tous les modules générant des écritures**.
Le calcul des émoluments — aujourd'hui hors périmètre — devra donc être couvert, et en
Nouvelle-Calédonie sur la base du décret n° 78-321/CG, non du tarif métropolitain.

**c) L'interlocuteur est un commissaire aux comptes**, à mandater et à rémunérer, pas une
instance professionnelle à solliciter. Son examen suppose des **tests en conditions
d'exploitation réelle supervisés par le concepteur** (art. 2) : il faut donc un office
partenaire acceptant une exploitation pilote.

---

## Partie II. Conformité technique du logiciel

Ce qui suit décrit l'état du code au regard des règles de tenue de la comptabilité
notariale — c'est-à-dire ce qu'un contrôle vérifie. C'est le socle sur lequel une démarche
d'attestation peut s'appuyer ; ce n'est pas l'attestation.

### 1. Séparation des fonds de l'office et des fonds des clients

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Fonds clients détenus sur des comptes de dépôt distincts | Comptes de nature `DEPOT_FONDS_CLIENTS` (512500, 512600), distincts du compte office (512100) | [`src/pcn.js`](src/pcn.js) |
| Aucune confusion entre recette de l'office et mouvement de fonds clients | `controleEtancheite` : une écriture ne peut mouvementer à la fois un compte de dépôt clients et un compte de charge ou de produit ; les émoluments transitent par le compte client du dossier | test « étanchéité » |
| Fonds clients représentés à tout instant | `controleRepresentationFonds` : les disponibilités affectées doivent couvrir le total dû aux clients. Contrôle **bloquant** à chaque comptabilisation | test « prélèvement sur les fonds clients refusé » |

### 2. Comptes clients individualisés

| Règle | Mise en œuvre |
|---|---|
| Un compte distinct par dossier, jamais un compte collectif | Compte `411xxxxx` créé à l'ouverture du dossier, jamais réattribué. Le compte collectif 411000 est marqué `collectif` ; son imputation est refusée |
| **Compte client débiteur : alerte, pas refus** | `alerteSoldeClients` signale sans bloquer — un débours réglé avant l'arrivée de la provision est courant et ne doit pas empêcher la saisie. L'alerte est remontée à l'écran, tracée dans la piste d'audit, et le dossier entre à l'`etatComptesDebiteurs` avec la date de bascule et son ancienneté. La régularisation reste **exigée avant la clôture** de l'exercice |
| Pas de compensation entre dossiers | Contrôle dossier par dossier ; un dossier créditeur ne compense jamais un dossier débiteur |
| Un dossier ne se clôt que soldé | `cloreDossier` refuse tant que le solde n'est pas nul |

### 3. Inaltérabilité et piste d'audit

| Règle | Mise en œuvre |
|---|---|
| Écriture comptabilisée non modifiable ni supprimable | Déclencheurs SQLite `trg_ecriture_maj_interdite`, `trg_ecriture_suppr_interdite` et équivalents sur les lignes. Le verrou est **dans la base** : il résiste à un accès direct par un outil tiers |
| Correction par contre-passation seulement | `contrepasser` génère l'écriture miroir, exige un motif écrit, conserve le lien entre les deux |
| Chaînage cryptographique | Empreinte SHA-256 de chaque écriture, calculée sur son contenu **et** sur l'empreinte précédente. Toute altération ancienne casse la chaîne de toutes les suivantes |
| Vérification à la demande | `verifierChaineEcritures()` recalcule la chaîne ; exposé dans l'écran Inspection, contrôlé avant toute clôture |
| Journal d'audit en ajout seul | Table `audit` chaînée, protégée par déclencheurs. Chaque opération tracée nominativement et horodatée |
| Numérotation chronologique continue | Numéro attribué **à la comptabilisation**, pas à la saisie : séquence continue par journal et exercice, sans trou. Un brouillon abandonné ne consomme aucun numéro |
| Pas de rétro-datation | `controleChronologie` refuse une écriture antérieure à la dernière comptabilisée dans le même journal |
| Exercice clos verrouillé | `controleExercice` refuse toute écriture datée dans un exercice clos |

### 4. Tenue de la comptabilité

- Partie double contrôlée à la comptabilisation ; écriture de montant nul refusée.
- Montants en **entiers de XPF** : le franc Pacifique n'a pas de subdivision. Tout montant
  non entier est refusé, aucun arrondi silencieux.
- Plan comptable notarial adapté au territoire : TGC (3 / 6 / 11 / 22 %) au lieu de la TVA,
  CAFAT, patente, droits d'enregistrement et taxe hypothécaire à reverser.
- Journaux séparés pour la banque office (BQO) et le dépôt des fonds clients (BQC).
- Lettrage refusé sur un lot déséquilibré.
- Compte d'attente 471000 signalé dès qu'il n'est pas soldé, bloquant à la clôture.

### 5. Contrôles périodiques

- **Rapprochement bancaire** : clôture refusée tant qu'un écart subsiste entre solde
  rapproché et solde du relevé.
- **Clôture d'exercice** : `controlePreCloture` énumère les obstacles — brouillons, comptes
  d'attente non soldés, dossiers débiteurs, fonds non représentés, chaîne altérée,
  rapprochement manquant. La clôture génère les à-nouveaux et scelle l'exercice par une
  empreinte.
- **Rôles** : `INSPECTEUR` dispose d'un accès en lecture intégrale et d'aucun droit d'écriture.

### 6. Restitution des données

- **Export FEC** : 18 colonnes, séparateur tabulation, dates AAAAMMJJ. Brouillons exclus par
  construction. Le dossier tient lieu de compte auxiliaire pour les comptes clients.
- **Dossier d'inspection** : balance, état des comptes clients, représentation des fonds,
  anomalies, rapprochements, volumétrie, état de la chaîne, piste d'audit — sur un écran unique.
- Exports CSV de la balance et de l'état des comptes clients.

---

## Partie III. Écarts restants

### Hors périmètre actuel

- **Tarif réglementé** : barèmes d'émoluments, débours, taxes, compte définitif client.
  L'article 2 de l'arrêté de 2006 impose pourtant que la taxe des actes soit couverte —
  c'est donc un **écart bloquant** pour une future attestation, à traiter sur la base du
  décret n° 78-321/CG pour la Nouvelle-Calédonie.
- Déclarations fiscales (TGC, résultat) et paie.
- Gestion des actes et répertoire.
- Archivage à valeur probante externalisé, sauvegarde hors site.
- Signature électronique et téléprocédures.

### Points à arbitrer avec la Chambre

1. **Numérotation des comptes clients** : format retenu `411` + 5 chiffres, à confirmer.
2. **Seuil de représentation des fonds** : couverture ≥ 100 % exigée en permanence, sans
   tolérance. À confirmer.
3. **Comptes de dépôt** : la liste (512500, 512600) doit correspondre aux comptes réellement
   ouverts auprès de l'établissement teneur.
4. **Durée de conservation** et modalités de sauvegarde de la base.
5. **Rapprochement obligatoire** : la clôture exige aujourd'hui un rapprochement clos à la
   date de fin d'exercice pour chaque compte rapprochable.

---

## Sources

- [Arrêté du 27 janvier 2006 relatif à l'attestation de conformité des logiciels de comptabilité des offices de notaires](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000000788636) — Légifrance
- [Décret n° 74-737 du 12 août 1974 relatif aux inspections des études de notaires](https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000679504/2023-06-13) — Légifrance
- [Ordonnance n° 45-2590 du 2 novembre 1945 relative au statut du notariat](https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000699572) — Légifrance
- [Décret n° 45-0117 du 19 décembre 1945, art. 39-1 (dispositions outre-mer)](https://www.legifrance.gouv.fr/codes/section_lc/JORFTEXT000000682446/LEGISCTA000034575495/) — Légifrance
- [Décret n° 45-0117, section III « De la comptabilité »](https://www.legifrance.gouv.fr/codes/section_lc/JORFTEXT000000682446/LEGISCTA000006145597/) — Légifrance
- [Codes applicables en Nouvelle-Calédonie — principe de spécialité législative](https://decat.gouv.nc/textes-juridiques-textes-generaux/codes-applicables-en-nouvelle-caledonie) — Gouvernement de la Nouvelle-Calédonie
- [Tarif des notaires en Nouvelle-Calédonie, décret n° 78-321/CG du 26 septembre 1978](https://www.immocal.nc/les-frais-de-notaire-nouvelle-caledonie/) — référence secondaire, texte à vérifier sur Juridoc

*Recherche effectuée le 19 octobre 2026. Les textes évoluent : vérifier les versions en
vigueur avant toute décision engageante.*
