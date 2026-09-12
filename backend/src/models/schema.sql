-- Schéma de la base SQLite — Santé des extrêmes (LOT 1)
-- Deux tables : les membres de l'association et leurs cotisations.

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
