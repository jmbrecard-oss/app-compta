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
| **Aucun compte client débiteur** | `controleSoldeClients`, exécuté après insertion des lignes dans la transaction : si le solde devient débiteur, l'écriture entière est annulée et reste en brouillon |
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

### 7. Sommes encaissées pour le compte de tiers

Les droits d'enregistrement (448600), la taxe hypothécaire et le salaire du conservateur
(448700) et les autres débours à reverser (448800) ne sont ni des produits de l'office, ni des
fonds dont il dispose : ils transitent par lui. Le client les verse, l'office les détient, le
Trésor les reçoit. Entre les deux, ils restent dus — et doivent pouvoir se justifier affaire
par affaire.

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Toute somme due à un tiers désigne le dossier qui l'a supportée | `controleDebours` : contrôle **bloquant**, ligne par ligne. Une ligne sur un compte de débours sans dossier est refusée ; l'écriture qui ne désigne qu'une seule affaire la lui fait hériter, celle qui en mêle plusieurs doit imputer ligne à ligne. Les à-nouveaux, qui reprennent un solde déjà justifié, en sont exemptés | tests « une somme due au Tresor doit designer le dossier qui l a supportee », « un debours imputable a deux dossiers a la fois est refuse », « l appel de droits sur un dossier unique rattache le debours a ce dossier » |
| Un débours encaissé ne devient jamais un produit ni une charge de l'office | Une écriture qui **solde** un compte de débours par un compte de classe 6 ou 7 est refusée. Seul ce sens est interdit : l'acte qui appelle émoluments et droits en une seule écriture les crédite ensemble par le débit du compte du client, et reste régulier | tests « un debours encaisse pour un tiers ne peut pas devenir un produit de l office », « l appel d emoluments et de droits dans une meme ecriture reste regulier » |
| On ne reverse pas plus que ce qui a été appelé | `controleReversementDebours`, exécuté **après insertion des lignes dans la transaction** : si le compte de débours devenait débiteur pour le dossier, l'écriture entière est annulée et reste en brouillon | test « on ne reverse pas au Tresor plus que ce qui a ete appele sur le dossier » |
| Les sommes dues aux tiers sont représentées, au même titre que les fonds clients | `controleRepresentationTiers` : les disponibilités doivent couvrir **la somme** du dû aux clients et du dû aux tiers. Sans lui, un droit d'enregistrement appelé quitte le compte du client sans quitter le compte de dépôt : le seul contrôle des comptes clients y voit un excédent disponible, et laisse virer au compte de l'office un argent qui est dû au Trésor | test « les sommes dues aux tiers ne peuvent pas etre virees au compte de l office » |
| État de contrôle des sommes dues | `etatSommesDues` : compte par compte et dossier par dossier, ce qui a été appelé, ce qui a été reversé, ce qui reste dû, et **depuis quand**. Les reversements s'imputent sur les appels les plus anciens, de sorte que l'ancienneté affichée soit celle du reliquat réel. Écran dédié, export CSV, intégré au dossier d'inspection | tests « le reversement s impute sur les appels les plus anciens », « l etat des sommes dues chiffre compte par compte et dossier par dossier », « l etat des sommes dues figure au dossier d inspection » |
| Une somme due trop ancienne est signalée, et fait obstacle à la clôture | Au-delà du délai paramétré pour le compte, anomalie **majeure** au tableau de bord et obstacle énuméré par `controlePreCloture` | tests « une somme due au-dela du delai de reversement est signalee », « une somme due non reversee fait obstacle a la cloture de l exercice » |
| La justification survit au changement d'exercice | `repriseDeboursParDossier` : les à-nouveaux reprennent ces comptes **dossier par dossier**, non pour leur solde global. Un à-nouveau global perdrait au 1ᵉʳ janvier le rattachement de la dette à l'affaire | test « la reprise a nouveau conserve le detail par dossier des sommes dues » |

**Les délais de reversement ne sont pas dans le code.** Ils relèvent de la réglementation
fiscale du territoire et des conventions de l'office avec le Trésor. Ils sont lus, avec la liste
des comptes concernés, dans `src/parametres/debours-nc.json`, que `COMPTA_DEBOURS` permet de
remplacer. Le paramétrage est validé **en bloc** — mal formé, il est refusé entier, jamais
appliqué à moitié — et chaque lecture en conserve l'**empreinte SHA-256**, de sorte qu'un
contrôle reste vérifiable après remplacement des paramètres.

**Le fichier livré est fictif — et l'application le dit.** Il porte `"statut": "NON_VALIDE"`,
un avertissement explicite et aucune source. Tant qu'il l'est, une anomalie **CRITIQUE**
`PARAMETRES_DEBOURS_NON_VALIDES` remonte au tableau de bord, à l'état des sommes dues et au
dossier d'inspection : les ancienneté signalées sont indicatives et sans valeur réglementaire.
Les contrôles qui ne dépendent d'aucun délai — justification par dossier, interdiction du
reversement excédentaire, représentation — s'appliquent, eux, sans réserve.

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
   tolérance, et portant sur le dû aux clients **et** sur les sommes encaissées pour le compte
   de tiers (Partie II, section 7). À confirmer.
3. **Comptes de dépôt** : la liste (512500, 512600) doit correspondre aux comptes réellement
   ouverts auprès de l'établissement teneur.
4. **Durée de conservation** et modalités de sauvegarde de la base.
5. **Rapprochement obligatoire** : la clôture exige aujourd'hui un rapprochement clos à la
   date de fin d'exercice pour chaque compte rapprochable.
6. **Comptes de tiers et délais de reversement** : la liste retenue (448600, 448700, 448800) et
   les délais au-delà desquels une somme due est signalée relèvent du paramétrage
   `src/parametres/debours-nc.json`, livré **non validé** et sans source. La périodicité réelle
   des reversements au Trésor et à la conservation des hypothèques doit être établie avant toute
   mise en service, de même que le sort d'un débours appelé et non consommé.

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
