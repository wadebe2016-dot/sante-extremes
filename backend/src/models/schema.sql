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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  -- LOT 7 : numéro de téléphone, au format +237XXXXXXXXX. Il n'est pas
  -- décoratif : la réinitialisation d'un code par SMS n'a pas d'autre point
  -- d'accroche, et un rôle ne peut être attribué qu'à un membre qui en a un.
  telephone     TEXT,
  -- LOT 4 : voir le bloc « Date d'adhésion, statut du membre » en fin de fichier.
  date_adhesion DATE,
  -- LOT 4 bis : la cotisation mensuelle n'est PAS uniforme. Certains membres
  -- sont à 5 000, d'autres à 10 000 (colonne « Contribution attendue » de la
  -- feuille d'origine). Appliquer 10 000 à tout le monde surestimait les
  -- arriérés de ceux qui doivent la moitié.
  contribution  REAL NOT NULL DEFAULT 10000 CHECK (contribution > 0),
  statut        TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'ecarte')),
  date_statut   DATETIME,
  motif_statut  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
-- LOT 4 : les arriérés se lisent par membre et par mois dû.
CREATE INDEX IF NOT EXISTS idx_cotisations_mois ON cotisations (statut, date_paiement);

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
  inflige_par     TEXT,   -- qui a prononcé la sanction (LOT 4)
  mois_concerne   TEXT,   -- mois de cotisation d'une pénalité de retard (AAAA-MM, LOT 4)
  fichier_s3_url  TEXT,
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sanctions_member ON sanctions (member_id);
CREATE INDEX IF NOT EXISTS idx_sanctions_statut ON sanctions (statut);
CREATE INDEX IF NOT EXISTS idx_sanctions_date ON sanctions (date_sanction);
CREATE INDEX IF NOT EXISTS idx_sanctions_mois ON sanctions (member_id, type, mois_concerne);

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

-- ---------------------------------------------------------------------------
-- LOT 5 — Postes d'une demande
--
-- Un samedi, l'intendant engage plusieurs postes à la fois : eau, kiné,
-- location du stade, lavage des chasubles. Il exprime UN besoin ; le trésorier
-- garde la main POSTE PAR POSTE — c'est lui qui engage l'argent, il doit
-- pouvoir approuver l'eau et refuser le kiné.
--
-- D'où cette table : la décision et le paiement vivent sur la LIGNE, plus sur
-- la demande. Les colonnes de « demandes » restent en place et portent
-- désormais l'AGRÉGAT, recalculé par src/routes/demandes.js à chaque décision :
--
--   'en_attente'  au moins une ligne en attente
--   'payee'       sinon, toutes les lignes non refusées sont payées
--   'approuvee'   sinon, au moins une ligne approuvée
--   'refusee'     sinon, toutes les lignes sont refusées
--
-- Une demande d'avant le LOT 5 porte exactement une ligne, créée par la
-- migration à partir de ses propres colonnes : rien n'est perdu, et le statut
-- agrégé d'une demande à une ligne est celui de cette ligne.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demande_lignes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  demande_id     INTEGER NOT NULL,
  categorie      TEXT NOT NULL,
  libelle        TEXT NOT NULL,
  montant_estime REAL NOT NULL CHECK (montant_estime > 0),
  statut         TEXT NOT NULL DEFAULT 'en_attente'
                   CHECK (statut IN ('en_attente', 'approuvee', 'refusee', 'payee')),
  motif_refus    TEXT,
  approuve_par   TEXT,   -- trésorier ayant tranché CE poste
  date_decision  TEXT,
  FOREIGN KEY (demande_id) REFERENCES demandes (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_demande_lignes_demande ON demande_lignes (demande_id);
CREATE INDEX IF NOT EXISTS idx_demande_lignes_statut ON demande_lignes (statut);

-- Sortie de caisse effective.
--
-- La contrainte UNIQUE sur ligne_id porte l'invariant : un POSTE ne peut être
-- payé qu'une fois. Le contrôle applicatif seul laisserait passer deux requêtes
-- simultanées. On décaisse toujours une ligne, jamais une demande : une demande
-- à quatre postes donne lieu à quatre sorties de caisse distinctes, chacune
-- avec son moyen, son bénéficiaire et son justificatif.
CREATE TABLE IF NOT EXISTS decaissements (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ligne_id            INTEGER NOT NULL UNIQUE,
  montant             REAL NOT NULL CHECK (montant > 0),
  date_paiement       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  moyen               TEXT NOT NULL CHECK (moyen IN ('Mobile Money', 'Espèce')),
  paye_par            TEXT NOT NULL CHECK (paye_par IN ('caisse', 'avance_rembourse')),
  beneficiaire        TEXT,
  decaisse_par        TEXT,   -- trésorier ayant sorti l'argent (LOT 3 ter)
  justificatif_cle_s3 TEXT,
  commentaire         TEXT,
  FOREIGN KEY (ligne_id) REFERENCES demande_lignes (id) ON DELETE CASCADE
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

-- ---------------------------------------------------------------------------
-- LOT 4 — Date d'adhésion, statut du membre
--
-- Ces colonnes sont ajoutées à « members » par src/db.js sur les bases
-- existantes : un CREATE TABLE IF NOT EXISTS n'ajoute rien à une table déjà
-- présente. Elles figurent ici pour qu'une base neuve naisse complète.
--
--   contribution   montant mensuel attendu de CE membre, en francs CFA. Tous
--                  les calculs de montant dû s'en servent — arriérés, mesures,
--                  feuille de séance, exports. À la migration, il est déduit du
--                  montant le plus fréquent parmi ses cotisations validées.
--   date_adhesion  mois d'entrée dans l'association, au 1ᵉʳ du mois. C'est le
--                  point de départ de TOUT calcul d'arriéré : un membre entré
--                  en mai ne doit rien pour janvier. À la migration, elle est
--                  déduite de la première cotisation validée, à défaut du mois
--                  de création de la fiche.
--   statut         'actif' ou 'ecarte'. Le terme employé partout est « mis à
--                  l'écart » — jamais « radié ». Un membre écarté sort des
--                  éligibles d'une séance et du total « X/38 à jour », mais
--                  reste dans l'historique et dans les exports.
--   date_statut    horodatage du dernier changement de statut.
--   motif_statut   raison invoquée, telle que saisie par le secrétariat.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- LOT 4 — Événements de statut des membres
--
-- Le journal d'activité (src/routes/journal.js) se reconstitue à partir des
-- tables métier : cotisations, sanctions, demandes, décaissements. Une mise à
-- l'écart ne laissait aucune trace exploitable — « members.statut » dit l'état
-- courant, pas l'histoire. D'où cette table, qui consigne chaque bascule avec
-- son auteur.
--
-- Elle n'est JAMAIS purgée : une réintégration n'efface pas la mise à l'écart
-- qui l'a précédée, sans quoi la décision serait impossible à justifier en
-- assemblée.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evenements_membres (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('mise_a_l_ecart', 'reintegration')),
  motif      TEXT,
  acteur     TEXT,
  mois       TEXT,   -- mois de cotisation à l'origine de la mesure (AAAA-MM)
  date_evenement TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evenements_membres_membre ON evenements_membres (member_id);
CREATE INDEX IF NOT EXISTS idx_evenements_membres_date ON evenements_membres (date_evenement);

-- ---------------------------------------------------------------------------
-- LOT 7 « DeuxZero » — Codes de rôle tenus par l'association
--
-- Jusqu'ici les codes de rôle vivaient dans le .env du serveur : un seul jeu de
-- codes pour une seule association. Un produit vendu à des dizaines
-- d'associations ne peut pas fonctionner ainsi — et l'éditeur n'entre jamais en
-- contact avec elles, donc personne ne peut éditer un fichier à leur place.
--
-- Les codes sont donc dans la base DE L'ASSOCIATION, et seulement HACHÉS. Le
-- code en clair n'existe qu'à deux instants : celui où il est tiré au sort et
-- affiché une seule fois, et celui où son porteur le saisit. Aucune route,
-- aucun export, aucun journal ne peut le restituer — le président lui-même ne
-- connaît pas le code définitif de ses collaborateurs.
--
--   role            fonction ouverte par ce code
--   membre_id       titulaire ; NULL pour un code non encore rattaché
--   libelle         nom d'usage affiché (« Trésorier Junior »)
--   code_hash       « scrypt$N$r$p$sel$empreinte », cf. src/services/codes.js
--   temporaire      1 = code de passation, à usage unique, qui EXIGE le choix
--                   d'un code personnel à la première connexion
--   expire_le       échéance d'un code temporaire (24 h) ; NULL pour un définitif
--   actif           0 = révoqué ou consommé ; une ligne n'est jamais supprimée,
--                   l'historique des accès doit rester lisible
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles_codes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  role                 TEXT NOT NULL
                         CHECK (role IN ('president', 'secretaire', 'tresorier',
                                         'censeur', 'intendant', 'competitions')),
  membre_id            INTEGER,
  libelle              TEXT,
  code_hash            TEXT NOT NULL,
  temporaire           INTEGER NOT NULL DEFAULT 0,
  expire_le            DATETIME,
  actif                INTEGER NOT NULL DEFAULT 1,
  cree_le              DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  derniere_utilisation DATETIME,
  FOREIGN KEY (membre_id) REFERENCES members (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_roles_codes_actif ON roles_codes (actif, role);
CREATE INDEX IF NOT EXISTS idx_roles_codes_membre ON roles_codes (membre_id);

-- ---------------------------------------------------------------------------
-- LOT 7 — Réinitialisations par SMS
--
-- Un membre du bureau qui perd son code se dépanne seul. Ce mécanisme est aussi
-- une porte d'entrée potentielle et une facture SMS : chaque tentative est
-- inscrite ici, c'est sur cette table que reposent les trois quotas (3 par mois
-- et par association, 5 échecs → blocage d'une heure, expiration à 15 minutes).
--
-- Le téléphone est enregistré en clair — il faut pouvoir compter les tentatives
-- d'un numéro — mais il n'est JAMAIS journalisé autrement que masqué
-- (+237******789), et le code SMS n'est stocké que haché.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reinitialisations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telephone     TEXT NOT NULL,
  role_id       INTEGER,
  role          TEXT,
  code_hash     TEXT,
  expire_le     DATETIME,
  tentatives    INTEGER NOT NULL DEFAULT 0,
  bloque_jusqua DATETIME,
  resultat      TEXT NOT NULL DEFAULT 'demandee'
                  CHECK (resultat IN ('demandee', 'confirmee', 'expiree',
                                      'bloquee', 'refusee', 'hors_quota')),
  adresse_ip    TEXT,
  date_demande  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  date_fin      DATETIME
);

CREATE INDEX IF NOT EXISTS idx_reinitialisations_tel ON reinitialisations (telephone, date_demande);
CREATE INDEX IF NOT EXISTS idx_reinitialisations_date ON reinitialisations (date_demande);

-- ---------------------------------------------------------------------------
-- LOT 7 — Réinitialisation du code président : le contre-seing
--
-- Il n'y a personne au-dessus du président : aucune autorité ne peut attester
-- que la demande vient bien de lui. La garantie est donc COLLÉGIALE — deux
-- autres titulaires de rôle doivent confirmer dans les 24 heures, sans quoi la
-- demande expire silencieusement.
--
-- Les confirmations vivent dans leur propre table : « deux titulaires » veut
-- dire deux PERSONNES DIFFÉRENTES, et un simple compteur laisserait le même
-- collaborateur confirmer deux fois.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demandes_president (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  demandeur      TEXT NOT NULL,          -- téléphone du président, masqué en journal
  confirmations  INTEGER NOT NULL DEFAULT 0,
  etat           TEXT NOT NULL DEFAULT 'en_attente'
                   CHECK (etat IN ('en_attente', 'confirmee', 'expiree', 'annulee')),
  adresse_ip     TEXT,
  date_demande   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expire_le      DATETIME NOT NULL,
  date_fin       DATETIME
);

CREATE TABLE IF NOT EXISTS confirmations_president (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  demande_id   INTEGER NOT NULL,
  role_id      INTEGER NOT NULL,
  role         TEXT,
  date_confirmation DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (demande_id, role_id),
  FOREIGN KEY (demande_id) REFERENCES demandes_president (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_demandes_president_etat ON demandes_president (etat, expire_le);
