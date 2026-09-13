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
--
-- LOT 3 bis — déclaration par le membre : une cotisation peut naître « en_attente »
-- lorsqu'un membre déclare lui-même son versement ; le trésorier la valide ou la
-- refuse. SEULES les cotisations « validee » comptent dans les totaux, le statut
-- du mois, l'historique annuel et les exports.
--
-- Les colonnes ajoutées après coup (statut, motif_refus, date_validation,
-- cle_s3) sont posées par src/db.js sur les bases existantes : un
-- CREATE TABLE IF NOT EXISTS n'ajoute rien à une table déjà présente.
CREATE TABLE IF NOT EXISTS cotisations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL,
  montant         REAL NOT NULL CHECK (montant > 0),
  moyen           TEXT NOT NULL CHECK (moyen IN ('Mobile Money', 'Espèce')),
  fichier_s3_url  TEXT,
  cle_s3          TEXT,   -- clé privée du justificatif d'une déclaration
  statut          TEXT NOT NULL DEFAULT 'validee'
                    CHECK (statut IN ('validee', 'en_attente', 'refusee')),
  motif_refus     TEXT,
  date_validation TEXT,
  date_paiement   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

-- Index de lecture : le tableau public interroge les cotisations par membre et par date
CREATE INDEX IF NOT EXISTS idx_cotisations_member ON cotisations (member_id);
CREATE INDEX IF NOT EXISTS idx_cotisations_date ON cotisations (date_paiement);
CREATE INDEX IF NOT EXISTS idx_cotisations_statut ON cotisations (member_id, statut);

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

-- ---------------------------------------------------------------------------
-- LOT 3 bis — Demandes de dépense et décaissements
--
-- Principe : personne ne décaisse sans demande approuvée. Les intendants, le
-- secrétariat et les gestionnaires de compétitions expriment le besoin ; le
-- trésorier approuve, refuse, puis décaisse.
--
-- Cycle de vie d'une demande :
--   en_attente → approuvee → payee   (parcours normal)
--   en_attente → refusee             (le trésorier écarte, motif obligatoire)
--   en_attente → supprimée           (le demandeur se ravise, tant que rien
--                                     n'a été décidé)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demandes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  categorie            TEXT NOT NULL
                         CHECK (categorie IN ('equipement', 'location_stade', 'kine_medical',
                                              'transport', 'arbitrage', 'competition_evenement',
                                              'autre')),
  libelle              TEXT NOT NULL,
  montant_estime       REAL NOT NULL CHECK (montant_estime > 0),
  urgence              TEXT NOT NULL DEFAULT 'normale' CHECK (urgence IN ('normale', 'urgente')),
  justificatif_cle_s3  TEXT,   -- devis éventuel, privé comme tous les documents
  role_demandeur       TEXT NOT NULL
                         CHECK (role_demandeur IN ('intendant', 'secretaire', 'competitions', 'admin')),
  statut               TEXT NOT NULL DEFAULT 'en_attente'
                         CHECK (statut IN ('en_attente', 'approuvee', 'refusee', 'payee')),
  motif_refus          TEXT,
  date_demande         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  date_decision        TEXT
);

CREATE INDEX IF NOT EXISTS idx_demandes_statut ON demandes (statut);
CREATE INDEX IF NOT EXISTS idx_demandes_date ON demandes (date_demande);

-- Sortie de caisse effective.
--
-- La contrainte UNIQUE sur demande_id porte l'invariant : une demande ne peut
-- être payée qu'une fois. Le contrôle applicatif seul laisserait passer deux
-- requêtes simultanées.
CREATE TABLE IF NOT EXISTS decaissements (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  demande_id          INTEGER NOT NULL UNIQUE,
  montant             REAL NOT NULL CHECK (montant > 0),
  date_paiement       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  moyen               TEXT NOT NULL CHECK (moyen IN ('Mobile Money', 'Espèce')),
  paye_par            TEXT NOT NULL CHECK (paye_par IN ('caisse', 'avance_rembourse')),
  beneficiaire        TEXT,
  justificatif_cle_s3 TEXT,
  commentaire         TEXT,
  FOREIGN KEY (demande_id) REFERENCES demandes (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decaissements_date ON decaissements (date_paiement);
