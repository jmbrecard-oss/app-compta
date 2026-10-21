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
Le calcul des émoluments doit donc être couvert, et en Nouvelle-Calédonie sur la base du
décret n° 78-321/CG, non du tarif métropolitain. Le moteur de liquidation existe désormais
(Partie II, section 4) ; **le barème qu'il applique reste à établir à partir de ce texte**.

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
| Les espèces reçues d'un client ne se mêlent pas à celles de l'office | Caisse distincte `531500`, de nature `DEPOT_FONDS_CLIENTS` : elle entre dans la représentation des fonds. `controleEspeces` refuse toute écriture mouvementant à la fois la caisse de l'office (`531000`) et un compte client ou un compte de dépôt clients | test « la caisse de l office ne peut pas recevoir les fonds d un client » |

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

### 4. Taxe des actes et tarif

L'article 2 de l'arrêté de 2006 soumet à l'examen de conformité **la taxe des actes** et
**tous les modules dès lors qu'ils génèrent des écritures comptables**. Le barème applicable
en Nouvelle-Calédonie relève du **décret n° 78-321/CG du 26 septembre 1978**, dont le texte
n'a pas été consulté. Le logiciel ne contient donc aucun chiffre de tarif : il fournit un
**moteur de barèmes paramétrable**, alimenté par un fichier de données séparé.

> **Le barème livré (`src/baremes/bareme-nc.json`) est fictif.** Ses taux, tranches et
> minimums sont inventés, uniquement pour faire fonctionner et tester le moteur. Il porte
> `"statut": "FICTIF"` et doit être remplacé ligne à ligne par le tarif en vigueur, la
> substitution étant validée par la Chambre. Tant qu'il est fictif, l'application remonte une
> anomalie **critique** au tableau de bord et au dossier d'inspection, et le compte définitif
> du client porte la mention qu'il ne peut pas lui être remis.

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Aucun chiffre de tarif dans le code | Taux, tranches, minimums, comptes d'imputation, taux de TGC et règle d'arrondi lus dans un fichier de données. `COMPTA_BAREME` désigne le fichier en service ; un fichier remplacé est repris sans redémarrage | [`src/domain/bareme.js`](src/domain/bareme.js), [`src/baremes/bareme-nc.json`](src/baremes/bareme-nc.json) |
| Un barème mal formé n'est jamais utilisé à moitié | `validerBareme` : tranches strictement croissantes, dernière tranche ouverte, taux entiers en parties par million, catégorie, mode et compte d'imputation contrôlés | tests « tranches non croissantes », « dernière tranche bornée », « taux non entier » |
| Aucun flottant, aucun arrondi silencieux | Liquidation entière en `BigInt`. L'arrondi n'intervient **qu'une fois**, sur le total de la prestation, selon le mode inscrit dans le barème — la direction de l'arrondi est une question de tarif, pas d'implémentation | test « l'arrondi n'intervient qu'une fois […] et il est paramétrable » |
| Une assiette absente ne vaut pas zéro | Un émolument proportionnel liquidé sans assiette facturerait le minimum du barème sur un champ vide : refusé | test « une assiette non entière, négative ou nulle est refusée » |
| La liquidation se justifie devant un contrôle | Chaque ligne conserve le détail tranche par tranche et la valeur exacte avant arrondi | test « la justification de la liquidation est exacte au centième » |
| Une taxe arrêtée est conforme au barème | `arreterTaxe` recalcule chaque ligne depuis le barème et refuse toute divergence. Le recalcul repart des **entrées** conservées — assiette, quantité, montant libre saisi — jamais du résultat enregistré, faute de quoi il se contenterait de relire ce qu'il doit vérifier | tests « une taxe dont une ligne a été retouchée ne peut pas être arrêtée », « le recalcul de l'arrêté repart des entrées, pas du résultat enregistré » |
| Une taxe arrêtée est figée | Déclencheurs `trg_taxe_maj_interdite`, `trg_taxe_suppr_interdite` et équivalents sur les lignes — **y compris à l'insertion** : ajouter une ligne après coup altère la taxe sans passer par un `UPDATE`. Le `statut` est lui-même verrouillé : seule la progression arrêtée → comptabilisée est permise, un retour en arrière rouvrirait tout le reste. Le verrou est dans la base | tests « une taxe comptabilisée est verrouillée dans la base, par tous les chemins », « une taxe arrêtée non comptabilisée est déjà figée » |
| Une taxe reste vérifiable après changement de barème | Chaque taxe conserve le code, le statut et l'**empreinte SHA-256** du fichier de barème qui l'a produite | test « une taxe arrêtée porte l'empreinte du barème qui l'a produite » |
| L'office n'avance jamais les droits ni les émoluments | L'écriture de taxe débite le compte client du dossier ; `controleSoldeClients` la refuse si le dossier n'est pas provisionné | test « la taxe d'un dossier sans provision est refusée » |
| Émoluments et débours rattachés à l'acte | `controleRattachementActe` : contrôle **bloquant**, appliqué **ligne par ligne** — une ligne de compte client présente ailleurs dans l'écriture ne rattache pas à l'acte le produit qui l'accompagne. Aucune ligne sur 706100-706400 ni sur 448600/448700/448800 sans dossier, les à-nouveaux exceptés, qui reprennent des soldes et non des actes. Lorsque l'écriture ne désigne qu'un seul dossier, ces lignes en héritent automatiquement ; si elle en concerne plusieurs, le dossier doit être désigné sur la ligne | tests « un émolument comptabilisé hors dossier est refusé », « un débours à reverser au Trésor comptabilisé hors dossier est refusé », « un émolument ne peut pas s'abriter derrière le dossier d'une autre ligne », « un émolument hérite du dossier quand l'écriture n'en concerne qu'un » |
| Justification des sommes dues aux tiers | `etatDeboursAReverser` : droits d'enregistrement, taxe hypothécaire et débours restant à reverser, par compte **et par dossier**. Un dossier sur lequel l'office a reversé plus qu'il n'a encaissé remonte en anomalie majeure | écran Inspection |
| Une taxe annulée sort des produits et du compte du client | Contre-passer l'écriture de taxe n'altère pas la taxe — la table est inaltérable — mais les états s'en tiennent au statut de l'**écriture** : une taxe contre-passée est présentée à part, et ne compte plus ni dans les produits ni dans ce que le client doit. Sans quoi le compte remis au client annoncerait une taxe que la comptabilité ne porte plus, tout en affichant un solde qui la contredit | test « une taxe contre-passée sort du compte définitif et des produits » |
| Une écriture reste toujours corrigeable | La contre-passation est exemptée du contrôle de rattachement : elle n'ajoute aucun produit, elle annule l'existant. Sans cette exemption, toute écriture comptabilisée **avant** l'entrée en vigueur du contrôle deviendrait définitivement figée — la base interdisant de retoucher une ligne validée, et la contre-passation étant le seul moyen de corriger | test « une écriture antérieure au contrôle reste contre-passable » |
| Compte définitif du client | `compteDefinitif` : versé par le client, émoluments, TGC, débours, solde lui revenant. Le total taxé et le total imputé au dossier sont distingués : le solde doit pouvoir se justifier. Taxes non comptabilisées et taxes annulées signalées. Export CSV | test « le compte définitif du dossier récapitule provisions, émoluments et débours » |

Cycle d'une taxe : **projet** (modifiable, sans effet comptable) → **arrêtée** (recalculée,
confrontée au barème, verrouillée en base) → **comptabilisée** (une écriture lui est attachée
et passe sans exception tous les contrôles de comptabilisation). Une taxe comptabilisée ne se
corrige que par contre-passation de l'écriture et nouvelle taxe.

### 5. Tenue de la comptabilité

- Partie double contrôlée à la comptabilisation ; écriture de montant nul refusée.
- Montants en **entiers de XPF** : le franc Pacifique n'a pas de subdivision. Tout montant
  non entier est refusé, aucun arrondi silencieux.
- Plan comptable notarial adapté au territoire : TGC au lieu de la TVA, CAFAT, patente,
  droits d'enregistrement et taxe hypothécaire à reverser. Les taux appliqués par les
  contrôles ne sont pas écrits dans le code : voir le § 6 ci-dessous.
- Journaux séparés pour la banque office (BQO) et le dépôt des fonds clients (BQC).
- Lettrage refusé sur un lot déséquilibré.
- Compte d'attente 471000 signalé dès qu'il n'est pas soldé, bloquant à la clôture.

### 5. Mouvements d'espèces

Les espèces ne laissent aucune trace bancaire : ni relevé, ni rapprochement, ni contrepartie
chez un tiers. Le registre de caisse et la pièce justificative en sont la seule preuve. D'où un
jeu de contrôles **bloquants**, et un registre destiné au contrôle.

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Une caisse n'est jamais créditrice | `controleCaisseNonCreditrice` : le contrôle porte sur le **solde progressif**, pas sur le solde final. Une sortie antérieure à la rentrée correspondante laisse un solde final positif et une caisse pourtant à découvert ; elle est refusée | tests « la caisse ne peut pas devenir créditrice » et « … ni à une date intermédiaire » |
| Tout mouvement d'espèces porte sa pièce justificative | `controleEspeces` exige la référence de pièce (reçu, bordereau, facture acquittée) dès qu'un compte de la subdivision 53 est mouvementé | test « un mouvement d especes sans piece justificative est refuse » |
| Un règlement en espèces reste sous le plafond | Plafond lu dans le fichier de paramètres, appliqué au total des espèces déplacées **dans un sens** : fractionner un règlement sur plusieurs lignes ne le fait pas passer sous le plafond. Un virement entre comptes de trésorerie de l'office (versement en banque, retrait au guichet) ne règle personne : il n'y est pas soumis | tests « un reglement en especes au-dela du plafond est refuse », « un reglement fractionne sur plusieurs lignes ne passe pas sous le plafond », « le versement des especes en banque n est pas un reglement » |
| Les règlements cumulés d'un même dossier aussi | `controleCumulEspecesDossier`, évalué après insertion dans la transaction : barre le fractionnement d'un versement en plusieurs remises unitairement conformes. Le plafond est propre à chaque dossier | test « le cumul des especes recues sur un dossier est plafonne » |
| Chaque remise est imputable à une affaire | Un règlement en espèces ne peut concerner qu'un seul dossier : au-delà, il faut une écriture par affaire | test « un reglement en especes ne peut pas concerner deux dossiers » |
| Registre des espèces | `registreDesEspeces` : caisse par caisse, chaque mouvement avec sa pièce, son dossier et le solde progressif ; minimum atteint et sa date ; ventilation des espèces reçues par dossier. Écran dédié, export CSV, intégré au dossier d'inspection | tests « le registre des especes retrace chaque mouvement » et « le registre se borne a la periode demandee » |

**Les plafonds ne sont pas dans le code.** Ils relèvent d'un texte — et ce texte n'est pas établi
pour la Nouvelle-Calédonie. Ils sont donc lus dans `src/parametres/especes-nc.json`, que
`COMPTA_ESPECES` permet de remplacer, et validés en bloc : un paramétrage mal formé est refusé
entier, jamais appliqué à moitié. Chaque lecture conserve l'**empreinte SHA-256** du fichier, de
sorte qu'un contrôle reste vérifiable après remplacement des paramètres.

**Le fichier livré est fictif — et l'application le dit.** Il porte `"statut": "NON_VALIDE"`, un
avertissement explicite et aucune source. Tant qu'il l'est, une anomalie **CRITIQUE**
`PARAMETRES_ESPECES_NON_VALIDES` remonte au tableau de bord, au registre et au dossier
d'inspection. Les plafonds n'en sont pas moins appliqués : une limite trop stricte se desserre,
une limite absente ne protège de rien.

### 6. Contrôles périodiques

**Rapprochement bancaire.** Un rapprochement isolé ne prouve rien. Entre deux arrêtés
rapprochés, aucune vérification externe ne couvre les fonds détenus : seule une série
continue établit que les sommes inscrites en comptabilité correspondent, période après
période, aux avoirs réellement détenus par l'établissement teneur du compte. Le logiciel
surveille donc la *continuité* des rapprochements, compte par compte.

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Un rapprochement ne se clôt pas sur un écart | `cloreRapprochement` refuse tant que solde rapproché ≠ solde du relevé | refus `RAPPROCHEMENT_NON_JUSTIFIE` |
| Arrêté normalisé et solde du relevé entier | `ouvrirRapprochement` refuse une date hors format AAAA-MM-JJ — le calendrier des périodes en dépend — et un solde de relevé non entier : pas de troncature silencieuse du franc Pacifique | test « un rapprochement exige une date d'arrêté et un solde de relevé exploitables » |
| Périodicité surveillée compte par compte | `calendrierRapprochements` construit le calendrier depuis le premier mouvement comptabilisé et qualifie chaque période : couverte, en cours, attendue, manquante | test « le calendrier part du premier mouvement comptabilisé et ne retient que les périodes révolues » |
| Un arrêté en cours de période ne couvre pas la période | seul un rapprochement clos **au dernier jour** de la période la couvre ; un arrêté au 15 du mois laisse la fin de mois non vérifiée | test « un rapprochement arrêté en cours de mois ne couvre pas la période » |
| Un rapprochement ouvert et jamais clos ne vaut pas rapprochement | période `MANQUANTE`, signalée `inacheve` | test « un rapprochement ouvert mais jamais clos ne couvre pas la période » |
| Délai de production du relevé | une période n'est exigible qu'au terme du délai paramétré ; avant, elle est `ATTENDUE` et n'alimente aucune relance | test « une période n'est exigible qu'au terme du délai de production du relevé » |
| **Pas de rapprochement sans le précédent** | `cloreRapprochement` refuse (`RAPPROCHEMENT_ANTERIEUR_MANQUANT`) tant qu'une période antérieure n'est pas close : le solde d'ouverture de la période n'aurait jamais été justifié. Le rapprochement peut être préparé et pointé, pas clos | test « clore un rapprochement est refusé tant qu'une période antérieure ne l'est pas » |
| Relance automatique des périodes non effectuées | `relancesRapprochements` alimente le tableau de bord, l'écran Rapprochement et le dossier d'inspection. Gravité majorée sur les comptes de dépôt des fonds clients : ce sont les fonds d'autrui qui cessent d'être contrôlés | tests « la gravité des relances distingue les fonds clients des comptes de l'office » et « les anomalies signalent les rapprochements périodiques non effectués » |
| **Toutes les périodes de l'exercice rapprochées avant la clôture** | `controlePreCloture` énumère chaque période non couverte, compte par compte. Un unique rapprochement au 31 décembre ne suffit plus | test « la pré-clôture refuse un exercice dont les périodes intermédiaires ne sont pas rapprochées » |
| Périodicité et délai paramétrables | `PERIODICITE_MOIS` et `DELAI_PRODUCTION_JOURS` dans [`src/domain/surveillance.js`](src/domain/surveillance.js) — valeurs par défaut (mensuelle, 15 jours) **à confirmer par la Chambre** | test « la périodicité du rapprochement est paramétrable » |

- **Clôture d'exercice** : `controlePreCloture` énumère les obstacles — brouillons, comptes
  d'attente non soldés, dossiers débiteurs, fonds non représentés, chaîne altérée,
  rapprochement manquant, **caisse créditrice à une date quelconque de l'exercice**. La clôture
  génère les à-nouveaux et scelle l'exercice par une empreinte.
  d'attente non soldés, dossiers débiteurs, fonds non représentés, placements rubriqués
  incohérents, chaîne altérée, rapprochement manquant. La clôture génère les à-nouveaux et
  scelle l'exercice par une empreinte. Les placements eux-mêmes ne font pas obstacle : ils
  courent d'un exercice sur l'autre.
- **Rôles** : `INSPECTEUR` dispose d'un accès en lecture intégrale et d'aucun droit d'écriture.

### 6. Taxe générale sur la consommation

L'article 2 de l'arrêté de 2006 impose que l'examen de conformité porte sur **tous les
modules générant des écritures comptables**. La TGC en fait partie : elle produit des
écritures, elle alimente une dette envers le Trésor et son solde figure au bilan.

**Les taux ne sont pas dans le code.** Ils sont lus dans
[`src/parametres/tgc-nc.json`](src/parametres/tgc-nc.json), livré avec le statut
`A_VALIDER` et un avertissement nominatif. Le chargeur **refuse** un fichier qui se
déclarerait `VALIDE` sans porter la référence du texte applicable et sans que chaque taux
soit marqué comme sourcé : un chiffre ne peut pas se présenter comme réglementaire sans sa
source. Tant que le statut vaut `A_VALIDER`, l'état produit porte la mention qu'il est un
document de travail, et le dossier d'inspection le signale.

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Toute taxe comptabilisée est justifiée par une assiette et un taux en vigueur | `controleTgc` : pour chaque écriture mouvementant 445600 ou 445700, la taxe doit correspondre à un taux en vigueur appliqué à l'assiette présente dans la même écriture — produits (classe 7) pour la collectée, charges et immobilisations (classes 6 et 2) pour la déductible. Comparaison en entiers, fenêtre d'un franc pour absorber la règle d'arrondi | test « une TGC collectée qui ne correspond à aucun taux en vigueur est refusée » |
| Pas de taxe hors de toute opération | Refus `TGC_SANS_ASSIETTE` | test « une TGC collectée sans assiette est refusée » |
| Une écriture mêlant plusieurs taux doit être scindée | Le refus nomme le taux implicite calculé et invite à scinder : c'est ce qui rend la déclaration justifiable ligne à ligne | message de `TGC_ASSIETTE_INCOHERENTE` |
| Une déclaration boucle sur les soldes réels | Écriture de liquidation : collectée soldée = déductible imputée + taxe portée au Trésor, sinon refus `TGC_LIQUIDATION_INCOHERENTE` | test « une déclaration dont l'arithmétique ne boucle pas est refusée » |
| On ne déclare pas plus de taxe que la comptabilité n'en porte | `TGC_SOLDE_INSUFFISANT` : le débit de 445700, le crédit de 445600 et le règlement sur 445500 sont plafonnés par le solde du compte à la date de l'écriture | tests « une déclaration qui liquide plus de TGC que la comptabilité n'en porte est refusée » et « un règlement au Trésor supérieur à la TGC déclarée est refusé » |
| Les à-nouveaux ne constituent pas de taxe | Le journal de type `ANOUVEAU` est hors du champ du contrôle d'assiette et de la ventilation | test « les à-nouveaux ne sont pas soumis au contrôle d'assiette » |
| L'état déclaratif est justifié par la comptabilité | `etatTgc` ventile la taxe par taux à partir des seules écritures comptabilisées, puis confronte cette ventilation au mouvement des comptes 445600 / 445700 : tout écart et toute écriture non rattachable à un taux sont nommés | test « l'état préparatoire rapproche la ventilation du mouvement comptable » |
| Les déclarations échues sont relancées | `periodesTgc` énumère les périodes selon la périodicité paramétrée et signale celles dont la TGC collectée n'est pas soldée au-delà du délai de dépôt. Remonté au tableau de bord, au dossier d'inspection et **en obstacle de pré-clôture** | tests « une période échue dont la TGC collectée n'est pas liquidée est signalée » et « la pré-clôture refuse un exercice dont la TGC échue n'est pas liquidée » |
| La déclaration passe par le circuit normal | L'écriture de liquidation proposée est créée **en brouillon** : elle repasse par tous les contrôles et par la comptabilisation nominative | test « l'écriture de liquidation proposée est équilibrée et passe les contrôles » |

Un crédit de TGC ne génère aucune dette : le reliquat déductible reste au bilan, en report.

Restent hors périmètre : la télédéclaration elle-même, les seuils qui déterminent la
périodicité, et le traitement d'un éventuel remboursement de crédit.

### 7. Restitution des données

- **Export FEC** : 18 colonnes, séparateur tabulation, dates AAAAMMJJ. Brouillons exclus par
  construction. Le dossier tient lieu de compte auxiliaire pour les comptes clients.
- **Dossier d'inspection** : balance, état des comptes clients, représentation des fonds,
  mouvements d'espèces, anomalies, rapprochements, volumétrie, état de la chaîne, piste d'audit —
  sur un écran unique.
- Exports CSV de la balance, de l'état des comptes clients et du registre des espèces.
- **Impression** : feuille `@media print` dédiée aux états destinés au contrôle — identité de
  l'office en tête, navigation et barres d'outils retirées, en-têtes de tableaux répétés de page
  en page, colonnes jamais tronquées par un défilement horizontal, signalements rendus lisibles
  en noir et blanc.
  placements rubriqués, anomalies, rapprochements, volumétrie, état de la chaîne, piste
  d'audit — sur un écran unique.
- Exports CSV de la balance, de l'état des comptes clients et des placements rubriqués.

### 7. Placements de fonds clients en compte rubriqué

Les fonds qu'un office détient durablement pour un dossier — séquestre, succession, prix de
vente en attente de formalités — peuvent être placés sur un compte de dépôt ouvert par
sous-comptes nominatifs, dit **compte rubriqué** (512600). Les règles qui en découlent sont
bloquantes : elles refusent la comptabilisation, elles ne se contentent pas de la signaler.

| Règle | Mise en œuvre | Preuve |
|---|---|---|
| Rubrication nominative : les fonds placés restent rattachés à un dossier identifié | `controleRubrication` : toute ligne portée sur un compte marqué `rubrique` désigne le dossier propriétaire. Un mouvement sans dossier est refusé | test « un mouvement sur un compte rubrique sans dossier designe est refuse » |
| On ne place que les fonds du dossier | `controleRubriquesDossiers` : après comptabilisation, la rubrique d'un dossier n'excède jamais les fonds que l'office lui doit. Le contrôle est rejoué dès que le compte client bouge, de sorte qu'une restitution laissant un placement ouvert est elle aussi refusée | tests « placer plus que les fonds detenus pour le dossier est refuse » et « restituer la totalite des fonds en laissant un placement ouvert est refuse » |
| Une rubrique n'est jamais débitrice | Même contrôle : retirer d'une rubrique plus qu'il n'y a été placé est refusé | test « retirer plus que le placement du dossier est refuse » |
| Les produits financiers du placement reviennent au dossier qui les a produits | L'inscription des produits d'un compte de dépôt clients en produit de l'office est déjà refusée par `controleEtancheite`. `controleNonCompensationRubriques` ajoute l'autre moitié de la règle : une écriture ne peut pas mouvementer la rubrique d'un dossier et le compte client d'un **autre** dossier | tests « l appropriation des produits du placement par l office est refusee » et « le placement d un dossier ne peut pas alimenter le compte client d un autre » |
| Un dossier ne se clôt pas sur un placement ouvert | `cloreDossier` examine la rubrique avant le solde du compte client : des fonds placés sont des fonds détenus | test « un dossier dont les fonds sont encore places ne peut pas etre clos » |

**État de contrôle.** `etatPlacements()` présente, dossier par dossier, les fonds placés, les
fonds détenus, la part non placée et les produits affectés, et confronte la somme des
rubriques au solde des comptes rubriqués : un écart signifie que des fonds placés ne sont
rattachés à aucun dossier. L'état figure au dossier d'inspection, s'exporte en CSV et alimente
trois anomalies — `RUBRIQUES_NON_VENTILEES`, `PLACEMENT_SANS_PROVISION`, `RUBRIQUE_DEBITRICE`.

**Signalement.** Des produits financiers inscrits au résultat de l'office alors que des fonds
clients sont placés déclenchent l'anomalie `PRODUITS_FINANCIERS_OFFICE` : l'origine de ces
produits doit être justifiée. Le signalement n'est pas bloquant — l'office perçoit légitimement
les intérêts de son propre compte — mais il est porté au dossier d'inspection.

**Convention de lecture.** Est tenu pour *produit affecté* à un dossier tout crédit de son
compte client porté par une écriture qui débite, dans le même mouvement, une rubrique de ce
dossier. C'est la forme que prend l'inscription des intérêts d'un placement. Cette convention
figure parmi les points à arbitrer ci-dessous.

---

## Partie III. Écarts restants

### Hors périmètre actuel

- Déclarations fiscales (TGC, résultat) et paie.
- **Tarif réglementé** : barèmes d'émoluments, débours, taxes, compte définitif client.
  L'article 2 de l'arrêté de 2006 impose pourtant que la taxe des actes soit couverte —
  c'est donc un **écart bloquant** pour une future attestation, à traiter sur la base du
  décret n° 78-321/CG pour la Nouvelle-Calédonie.
- **Déclarations fiscales** : la TGC dispose désormais d'un état préparatoire justifié et
  de contrôles bloquants (Partie II, § 6) ; restent hors périmètre la télédéclaration, la
  liasse de résultat et la paie.
- Gestion des actes et répertoire.
- Archivage à valeur probante externalisé, sauvegarde hors site.
- Signature électronique et téléprocédures.

### Points à arbitrer avec la Chambre

1. **Contenu du barème du tarif — bloquant.** Le moteur de calcul de la taxe des actes est en
   place et couvert par des tests (Partie II, section 4), mais **le fichier de barème livré est
   fictif**. Il doit être remplacé par le tarif du décret n° 78-321/CG du 26 septembre 1978,
   dont le texte reste à obtenir — vraisemblablement auprès de la Chambre ou sur Juridoc — puis
   la correspondance entre ce texte et le fichier doit être validée **ligne à ligne**. Tant que
   ce point n'est pas réglé, aucune taxe produite par l'application n'a de valeur. Trois
   questions se posent au passage :
   - la **règle d'arrondi** du tarif (au franc supérieur, inférieur ou le plus proche) ;
   - l'assujettissement à la **TGC** et les taux applicables. Le moteur n'impose
     aucune règle : il applique à chaque prestation le taux que le fichier lui
     attribue. Que les débours et les droits à reverser en soient exonérés — ce que
     le fichier livré suppose — doit donc être confirmé, et non déduit du code ;
   - les **comptes d'imputation** des droits d'enregistrement et de la taxe hypothécaire
     (448600 et 448700 retenus ici).
2. **Numérotation des comptes clients** : format retenu `411` + 5 chiffres, à confirmer.
3. **Seuil de représentation des fonds** : couverture ≥ 100 % exigée en permanence, sans
   tolérance. À confirmer.
4. **Comptes de dépôt** : la liste (512500, 512600) doit correspondre aux comptes réellement
   ouverts auprès de l'établissement teneur.
5. **Durée de conservation** et modalités de sauvegarde de la base.
6. **Rapprochement obligatoire** : la clôture exige aujourd'hui un rapprochement clos à la
1. **Plafond des règlements en espèces.** Les montants de `src/parametres/especes-nc.json` sont
   **fictifs** et ne proviennent d'aucun texte. En métropole, la limitation des règlements en
   espèces relève de l'article L. 112-6 du code monétaire et financier ; son applicabilité en
   Nouvelle-Calédonie et le montant du plafond local restent à établir. Trois réponses sont
   attendues : le montant d'un règlement unitaire, l'existence et le montant d'un plafond cumulé
   par dossier, l'encaisse maximale admise. Tant qu'elles manquent, le fichier reste
   `NON_VALIDE` et l'application le signale en anomalie critique.
2. **Espèces reçues pour le compte d'un client** : elles transitent par la caisse `531500`, qui
   entre dans la représentation des fonds. À confirmer que la Chambre admet une encaisse en
   espèces comme représentation, et dans quelles limites de délai de versement en banque.
3. **Numérotation des comptes clients** : format retenu `411` + 5 chiffres, à confirmer.
4. **Seuil de représentation des fonds** : couverture ≥ 100 % exigée en permanence, sans
   tolérance. À confirmer.
5. **Comptes de dépôt** : la liste (512500, 512600) doit correspondre aux comptes réellement
   ouverts auprès de l'établissement teneur.
6. **Durée de conservation** et modalités de sauvegarde de la base.
7. **Rapprochement obligatoire** : la clôture exige aujourd'hui un rapprochement clos à la
   date de fin d'exercice pour chaque compte rapprochable.
6. **Paramètres de TGC** : taux en vigueur, périodicité de déclaration, délai de dépôt,
   règle d'arrondi et sort du crédit de TGC. Ces cinq valeurs sont livrées avec le statut
   `A_VALIDER` ; elles relèvent de la Direction des services fiscaux de la
   Nouvelle-Calédonie et doivent être relevées sur le texte avant toute mise en service.
6. **Comptes rubriqués** : la liste des comptes de placement nominatifs (512600 aujourd'hui)
   doit correspondre aux comptes réellement ouverts auprès de l'établissement teneur. Trois
   points restent à trancher : les produits des fonds rubriqués reviennent-ils en totalité au
   dossier en Nouvelle-Calédonie ; la convention retenue pour identifier un produit affecté
   (cf. partie II, § 7) est-elle celle attendue d'un contrôle ; le dénouement du placement
   doit-il précéder la clôture du dossier, comme le logiciel l'impose aujourd'hui.
4. **Durée de conservation** et modalités de sauvegarde de la base.
5. **Périodicité des rapprochements** : la clôture exige désormais que **chaque période**
   de l'exercice soit rapprochée et close, et non le seul arrêté de fin d'exercice. Trois
   paramètres restent à confirmer : la **périodicité** (mensuelle par défaut), le **délai de
   production du relevé** (15 jours), et la règle selon laquelle une période n'est couverte
   que par un arrêté au **dernier jour** de la période. Aucun texte calédonien consulté ne
   les fixe ; ils sont paramétrables dans `src/domain/surveillance.js`.

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
