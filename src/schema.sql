-- ============================================================================
-- Comptabilite notariale - Nouvelle-Caledonie
-- Schema de la base. Toutes les sommes sont des ENTIERS en XPF (0 decimale).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- l'office --
CREATE TABLE IF NOT EXISTS office (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  denomination  TEXT NOT NULL,
  notaire_titulaire TEXT NOT NULL DEFAULT '',
  adresse       TEXT NOT NULL DEFAULT '',
  ridet         TEXT NOT NULL DEFAULT '',          -- identifiant entreprise NC
  chambre       TEXT NOT NULL DEFAULT 'Chambre des notaires de Nouvelle-Caledonie',
  devise        TEXT NOT NULL DEFAULT 'XPF',
  decimales     INTEGER NOT NULL DEFAULT 0,
  cree_le       TEXT NOT NULL
);

-- ------------------------------------------------------------ utilisateurs --
-- Chaque ecriture est imputee nominativement : exigence de piste d'audit.
CREATE TABLE IF NOT EXISTS utilisateurs (
  id         INTEGER PRIMARY KEY,
  identifiant TEXT NOT NULL UNIQUE,
  nom        TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('NOTAIRE','COMPTABLE','CLERC','INSPECTEUR')),
  mdp_hash   TEXT NOT NULL,
  mdp_sel    TEXT NOT NULL,
  actif      INTEGER NOT NULL DEFAULT 1,
  cree_le    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  jeton      TEXT PRIMARY KEY,
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id),
  ouvert_le  TEXT NOT NULL,
  expire_le  TEXT NOT NULL
);

-- --------------------------------------------------------------- exercices --
CREATE TABLE IF NOT EXISTS exercices (
  id           INTEGER PRIMARY KEY,
  libelle      TEXT NOT NULL UNIQUE,
  date_debut   TEXT NOT NULL,
  date_fin     TEXT NOT NULL,
  statut       TEXT NOT NULL DEFAULT 'OUVERT' CHECK (statut IN ('OUVERT','CLOS')),
  cloture_le   TEXT,
  cloture_par  TEXT,
  cloture_hash TEXT,
  CHECK (date_debut < date_fin)
);

-- ---------------------------------------------------- plan comptable (PCN) --
-- nature :
--   CLIENT               compte client individualise rattache a un dossier
--   DEPOT_FONDS_CLIENTS  compte de depot des fonds detenus pour le compte des clients
--   BANQUE_OFFICE        compte bancaire propre a l'office
--   CAISSE               especes
--   TAXE                 sommes dues au Tresor (enregistrement, TGC...)
--   ATTENTE              compte d'attente, doit etre solde a la cloture
--   STANDARD             le reste
CREATE TABLE IF NOT EXISTS comptes (
  numero       TEXT PRIMARY KEY,
  intitule     TEXT NOT NULL,
  classe       INTEGER NOT NULL CHECK (classe BETWEEN 1 AND 8),
  type         TEXT NOT NULL CHECK (type IN ('BILAN','GESTION')),
  nature       TEXT NOT NULL DEFAULT 'STANDARD'
                 CHECK (nature IN ('STANDARD','CLIENT','DEPOT_FONDS_CLIENTS',
                                   'BANQUE_OFFICE','CAISSE','TAXE','ATTENTE')),
  sens_normal  TEXT CHECK (sens_normal IN ('DEBIT','CREDIT','INDIFFERENT')),
  lettrable    INTEGER NOT NULL DEFAULT 0,
  rapprochable INTEGER NOT NULL DEFAULT 0,
  collectif    INTEGER NOT NULL DEFAULT 0,   -- compte de regroupement, non mouvemente
  actif        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_comptes_nature ON comptes(nature);

-- ----------------------------------------------------------------- dossiers --
-- Un dossier = une affaire = un compte client individualise. Regle de base de
-- la comptabilite notariale : pas de compte client collectif unique.
CREATE TABLE IF NOT EXISTS dossiers (
  id            INTEGER PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  intitule      TEXT NOT NULL,
  nature_acte   TEXT NOT NULL DEFAULT '',
  notaire       TEXT NOT NULL DEFAULT '',
  collaborateur TEXT NOT NULL DEFAULT '',
  compte_client TEXT NOT NULL UNIQUE REFERENCES comptes(numero),
  statut        TEXT NOT NULL DEFAULT 'OUVERT' CHECK (statut IN ('OUVERT','SOLDE','ARCHIVE')),
  ouvert_le     TEXT NOT NULL,
  solde_le      TEXT
);

-- ----------------------------------------------------------------- journaux --
CREATE TABLE IF NOT EXISTS journaux (
  code                TEXT PRIMARY KEY,
  libelle             TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('BANQUE','CAISSE','ACHATS','VENTES','OD','ANOUVEAU')),
  compte_contrepartie TEXT REFERENCES comptes(numero),
  actif               INTEGER NOT NULL DEFAULT 1
);

-- ----------------------------------------------------------------- ecritures --
CREATE TABLE IF NOT EXISTS ecritures (
  id             INTEGER PRIMARY KEY,
  exercice_id    INTEGER NOT NULL REFERENCES exercices(id),
  journal        TEXT NOT NULL REFERENCES journaux(code),
  numero         INTEGER NOT NULL,          -- sequence continue par journal + exercice
  date_ecriture  TEXT NOT NULL,             -- AAAA-MM-JJ
  date_piece     TEXT,
  piece_ref      TEXT NOT NULL DEFAULT '',
  libelle        TEXT NOT NULL,
  dossier_id     INTEGER REFERENCES dossiers(id),
  statut         TEXT NOT NULL DEFAULT 'BROUILLON'
                   CHECK (statut IN ('BROUILLON','VALIDEE','CONTREPASSEE')),
  cree_le        TEXT NOT NULL,
  cree_par       TEXT NOT NULL,
  valide_le      TEXT,
  valide_par     TEXT,
  -- contre-passation : seule facon de corriger une ecriture validee
  contrepassee_par  INTEGER REFERENCES ecritures(id),
  contrepassation_de INTEGER REFERENCES ecritures(id),
  -- chainage cryptographique (inalterabilite)
  rang_chaine    INTEGER,
  hash           TEXT,
  hash_precedent TEXT,
  UNIQUE (exercice_id, journal, numero)
);
CREATE INDEX IF NOT EXISTS idx_ecr_date   ON ecritures(date_ecriture);
CREATE INDEX IF NOT EXISTS idx_ecr_statut ON ecritures(statut);
CREATE INDEX IF NOT EXISTS idx_ecr_chaine ON ecritures(rang_chaine);

CREATE TABLE IF NOT EXISTS lignes (
  id          INTEGER PRIMARY KEY,
  ecriture_id INTEGER NOT NULL REFERENCES ecritures(id) ON DELETE CASCADE,
  ordre       INTEGER NOT NULL,
  compte      TEXT NOT NULL REFERENCES comptes(numero),
  dossier_id  INTEGER REFERENCES dossiers(id),
  libelle     TEXT NOT NULL,
  debit       INTEGER NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit      INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  lettrage    TEXT,
  rapprochement_id INTEGER REFERENCES rapprochements(id),
  CHECK (debit = 0 OR credit = 0),
  CHECK (debit + credit > 0)
);
CREATE INDEX IF NOT EXISTS idx_lig_ecr     ON lignes(ecriture_id);
CREATE INDEX IF NOT EXISTS idx_lig_compte  ON lignes(compte);
CREATE INDEX IF NOT EXISTS idx_lig_dossier ON lignes(dossier_id);

-- ------------------------------------------------------- rapprochements --
CREATE TABLE IF NOT EXISTS rapprochements (
  id           INTEGER PRIMARY KEY,
  compte       TEXT NOT NULL REFERENCES comptes(numero),
  date_arrete  TEXT NOT NULL,
  solde_releve INTEGER NOT NULL,
  statut       TEXT NOT NULL DEFAULT 'EN_COURS' CHECK (statut IN ('EN_COURS','CLOS')),
  cree_le      TEXT NOT NULL,
  cree_par     TEXT NOT NULL,
  clos_le      TEXT,
  UNIQUE (compte, date_arrete)
);

-- ------------------------------------------------------------ journal d'audit --
-- Chaine inalterable de tous les evenements significatifs.
CREATE TABLE IF NOT EXISTS audit (
  id             INTEGER PRIMARY KEY,
  horodatage     TEXT NOT NULL,
  utilisateur    TEXT NOT NULL,
  action         TEXT NOT NULL,
  objet          TEXT NOT NULL,
  objet_id       TEXT,
  details        TEXT NOT NULL DEFAULT '',
  hash           TEXT NOT NULL,
  hash_precedent TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit(horodatage);

-- ======================================================================
-- INALTERABILITE : verrous au niveau du moteur de base de donnees.
-- Une ecriture validee ne peut etre ni modifiee ni supprimee, y compris
-- par un acces direct a la base. Seuls le chainage et la contre-passation
-- restent modifiables.
-- ======================================================================
CREATE TRIGGER IF NOT EXISTS trg_ecriture_maj_interdite
BEFORE UPDATE ON ecritures
WHEN OLD.statut IN ('VALIDEE','CONTREPASSEE')
 AND (NEW.exercice_id   <> OLD.exercice_id
   OR NEW.journal       <> OLD.journal
   OR NEW.numero        <> OLD.numero
   OR NEW.date_ecriture <> OLD.date_ecriture
   OR NEW.libelle       <> OLD.libelle
   OR NEW.piece_ref     <> OLD.piece_ref
   OR IFNULL(NEW.dossier_id,-1) <> IFNULL(OLD.dossier_id,-1)
   OR IFNULL(NEW.hash,'')       <> IFNULL(OLD.hash,'')
   OR NEW.cree_par      <> OLD.cree_par)
BEGIN
  SELECT RAISE(ABORT, 'INALTERABILITE: ecriture validee, modification interdite (contre-passation obligatoire)');
END;

CREATE TRIGGER IF NOT EXISTS trg_ecriture_suppr_interdite
BEFORE DELETE ON ecritures
WHEN OLD.statut IN ('VALIDEE','CONTREPASSEE')
BEGIN
  SELECT RAISE(ABORT, 'INALTERABILITE: ecriture validee, suppression interdite');
END;

CREATE TRIGGER IF NOT EXISTS trg_ligne_maj_interdite
BEFORE UPDATE ON lignes
WHEN (SELECT statut FROM ecritures WHERE id = OLD.ecriture_id) IN ('VALIDEE','CONTREPASSEE')
 AND (NEW.compte <> OLD.compte OR NEW.debit <> OLD.debit OR NEW.credit <> OLD.credit
   OR NEW.libelle <> OLD.libelle OR IFNULL(NEW.dossier_id,-1) <> IFNULL(OLD.dossier_id,-1))
BEGIN
  SELECT RAISE(ABORT, 'INALTERABILITE: ligne d''une ecriture validee, modification interdite');
END;

CREATE TRIGGER IF NOT EXISTS trg_ligne_suppr_interdite
BEFORE DELETE ON lignes
WHEN (SELECT statut FROM ecritures WHERE id = OLD.ecriture_id) IN ('VALIDEE','CONTREPASSEE')
BEGIN
  SELECT RAISE(ABORT, 'INALTERABILITE: ligne d''une ecriture validee, suppression interdite');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_immuable_maj
BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'INALTERABILITE: le journal d''audit est en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_immuable_suppr
BEFORE DELETE ON audit
BEGIN
  SELECT RAISE(ABORT, 'INALTERABILITE: le journal d''audit est en ajout seul');
END;

-- ---------------------------------------------------------------- vues --
-- Soldes calcules sur les seules ecritures comptabilisees (validees ou
-- contre-passees) ; les brouillons n'entrent jamais dans un solde.
CREATE VIEW IF NOT EXISTS v_soldes AS
SELECT c.numero, c.intitule, c.nature, c.classe,
       IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.debit  ELSE 0 END), 0) AS total_debit,
       IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.credit ELSE 0 END), 0) AS total_credit,
       IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.debit  ELSE 0 END), 0)
     - IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.credit ELSE 0 END), 0) AS solde
FROM comptes c
LEFT JOIN lignes    l ON l.compte = c.numero
LEFT JOIN ecritures e ON e.id = l.ecriture_id
GROUP BY c.numero;

-- Situation de chaque dossier. solde > 0 = dossier DEBITEUR = anomalie grave :
-- l'office aurait avance des fonds pour le compte du client.
CREATE VIEW IF NOT EXISTS v_soldes_dossiers AS
SELECT d.id, d.reference, d.intitule, d.statut, d.compte_client,
       IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.debit  ELSE 0 END), 0) AS total_debit,
       IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.credit ELSE 0 END), 0) AS total_credit,
       IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.debit  ELSE 0 END), 0)
     - IFNULL(SUM(CASE WHEN e.statut IN ('VALIDEE','CONTREPASSEE') THEN l.credit ELSE 0 END), 0) AS solde
FROM dossiers d
LEFT JOIN lignes    l ON l.compte = d.compte_client
LEFT JOIN ecritures e ON e.id = l.ecriture_id
GROUP BY d.id;
