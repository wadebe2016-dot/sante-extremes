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
-- cle_s3, date_versement) sont posées par src/db.js sur les bases existantes :
-- un CREATE TABLE IF NOT EXISTS n'ajoute rien à une table déjà présente.
--
-- TROIS DATES, TROIS USAGES — ne pas les confondre :
--   date_paiement   mois dû (le 5 du mois concerné) : répartition mensuelle,
--                   statut payé/impayé, historique annuel, exports ;
--   date_versement  jour de remise de l'argent : trésorerie UNIQUEMENT ;
--   date_validation contrôle du trésorier : traçabilité et journal.
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
  valide_par      TEXT,   -- trésorier ayant validé, refusé ou saisi (LOT 3 ter)
  date_versement  DATETIME, -- jour où l'argent a été remis (entrée en caisse)
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
  encaisse_par    TEXT,   -- trésorier ayant encaissé la pénalité (LOT 3 ter)
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
-- La catégorie n'est PAS contrainte au niveau du schéma (LOT 3 ter).
-- Elle l'était, et ajouter « eau_collation » et « entretien » aurait imposé de
-- reconstruire la table en production — SQLite ne sait pas modifier un CHECK.
-- La liste fermée est désormais tenue par src/routes/demandes.js, qui refuse en
-- 400 toute valeur inconnue : même garantie, sans migration à chaque ajout.
CREATE TABLE IF NOT EXISTS demandes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  categorie            TEXT NOT NULL,
  libelle              TEXT NOT NULL,
  montant_estime       REAL NOT NULL CHECK (montant_estime > 0),
  urgence              TEXT NOT NULL DEFAULT 'normale' CHECK (urgence IN ('normale', 'urgente')),
  justificatif_cle_s3  TEXT,   -- devis éventuel, privé comme tous les documents
  role_demandeur       TEXT NOT NULL
                         CHECK (role_demandeur IN ('intendant', 'secretaire', 'competitions', 'admin')),
  statut               TEXT NOT NULL DEFAULT 'en_attente'
                         CHECK (statut IN ('en_attente', 'approuvee', 'refusee', 'payee')),
  motif_refus          TEXT,
  approuve_par         TEXT,   -- trésorier ayant tranché (LOT 3 ter)
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
  decaisse_par        TEXT,   -- trésorier ayant sorti l'argent (LOT 3 ter)
  justificatif_cle_s3 TEXT,
  commentaire         TEXT,
  FOREIGN KEY (demande_id) REFERENCES demandes (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decaissements_date ON decaissements (date_paiement);

-- ---------------------------------------------------------------------------
-- LOT 3 ter — Paramètres de l'association
--
-- Table clé/valeur volontairement générique : le solde d'ouverture de la
-- trésorerie y vit aujourd'hui, d'autres réglages y viendront sans migration.
--
-- « definit_par » complète « date_maj » : depuis que les trésoriers peuvent
-- fixer le solde d'ouverture, savoir QUAND un réglage a changé ne suffit plus,
-- il faut savoir QUI l'a changé.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parametres (
  cle         TEXT PRIMARY KEY,
  valeur      TEXT,
  definit_par TEXT,
  date_maj    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
