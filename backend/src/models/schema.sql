-- Schéma de la base SQLite — Santé des extrêmes
-- LOT 1 : membres et cotisations.
-- LOT 3 : sanctions (pénalités, suspensions) et documents (règlement, fiches santé).
--
-- Migration STRICTEMENT ADDITIVE : toutes les instructions sont en
-- « IF NOT EXISTS ». Aucune table n'est supprimée, aucune colonne n'est
-- retirée, aucune donnée existante n'est touchée. Le fichier est rejoué à
-- chaque démarrage du serveur (src/index.js) sans effet de bord.

PRAGMA foreign_keys = ON;

-- Table des membres de l'association (~50 personnes)
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Table des paiements de cotisation, rattachés à un membre
CREATE TABLE IF NOT EXISTS cotisations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id      INTEGER NOT NULL,
  montant        REAL NOT NULL CHECK (montant > 0),
  moyen          TEXT NOT NULL CHECK (moyen IN ('Mobile Money', 'Espèce')),
  fichier_s3_url TEXT,
  date_paiement  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

-- Index de lecture : le tableau public interroge les cotisations par membre et par date
CREATE INDEX IF NOT EXISTS idx_cotisations_member ON cotisations (member_id);
CREATE INDEX IF NOT EXISTS idx_cotisations_date ON cotisations (date_paiement);

-- ---------------------------------------------------------------------------
-- LOT 3 — Sanctions : pénalités financières et suspensions
--
-- Les pénalités sont comptabilisées À PART des cotisations : leur règlement
-- n'entre ni dans le total reçu, ni dans l'historique annuel, ni dans le
-- statut payé/impayé du mois. D'où une table distincte de « cotisations ».
--
-- Cycle de vie du statut :
--   due     → reglee   (le trésorier encaisse la pénalité)
--   due     → annulee  (le censeur revient sur sa décision — suppression douce)
--   due     → levee    (suspension levée avant son terme)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sanctions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('penalite', 'suspension')),
  motif           TEXT NOT NULL,
  montant         REAL CHECK (montant IS NULL OR montant > 0), -- pénalités uniquement
  date_fin        TEXT,                                        -- suspensions uniquement (AAAA-MM-JJ)
  statut          TEXT NOT NULL DEFAULT 'due'
                    CHECK (statut IN ('due', 'reglee', 'levee', 'annulee')),
  date_sanction   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  date_reglement  TEXT,
  moyen_reglement TEXT,
  fichier_s3_url  TEXT,
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sanctions_member ON sanctions (member_id);
CREATE INDEX IF NOT EXISTS idx_sanctions_statut ON sanctions (statut);
CREATE INDEX IF NOT EXISTS idx_sanctions_date ON sanctions (date_sanction);

-- ---------------------------------------------------------------------------
-- LOT 3 — Documents déposés sur S3
--
-- Seule la clé S3 est conservée : les fichiers ne sont JAMAIS servis par une
-- URL publique, le backend produit une URL pré-signée de courte durée à chaque
-- consultation.
--
--   reglement    règlement intérieur, un seul document courant (member_id NULL).
--                Les versions antérieures restent en base et sur S3 : on ne
--                supprime pas un règlement, on en publie un nouveau.
--   fiche_sante  fiche de santé individuelle (données sensibles), une par
--                membre ; le remplacement archive la précédente.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('reglement', 'fiche_sante')),
  member_id   INTEGER,
  cle_s3      TEXT NOT NULL,
  nom_fichier TEXT NOT NULL,
  taille      INTEGER,
  courant     INTEGER NOT NULL DEFAULT 1, -- 1 = version en vigueur, 0 = archivée
  date_depot  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (type, courant);
CREATE INDEX IF NOT EXISTS idx_documents_member ON documents (member_id);
