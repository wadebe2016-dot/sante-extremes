/**
 * Annuaire global des associations — LOT 7 « DeuxZero ».
 *
 * Une seule chose vit ici : la liste des associations et le chemin de leur base.
 * AUCUNE donnée métier — ni membre, ni cotisation, ni montant, ni code de rôle.
 *
 * Ce n'est pas une élégance d'architecte, c'est la garantie d'étanchéité : si
 * l'annuaire portait ne serait-ce qu'un total encaissé, une requête de
 * l'association A pourrait lire un chiffre de l'association B. Il n'y a rien à
 * lire ici, donc rien à fuir.
 *
 * La seule exception est « sms_envoyes », et elle est délibérée : la facture SMS
 * est celle de l'éditeur, pas celle des associations. Il faut pouvoir la suivre
 * d'un seul endroit, et le destinataire n'y figure que masqué.
 */
'use strict';

const path = require('path');

const { ouvrir } = require('./connexion');

const DOSSIER_DONNEES = process.env.DATA_DIR || './data';
const CHEMIN_ANNUAIRE = process.env.ANNUAIRE_PATH || path.join(DOSSIER_DONNEES, 'annuaire.db');
const DOSSIER_ASSOCIATIONS = path.join(DOSSIER_DONNEES, 'associations');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS associations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  code                 TEXT NOT NULL UNIQUE,
  nom                  TEXT NOT NULL,
  ville                TEXT,
  telephone_president  TEXT NOT NULL,
  date_creation        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  statut               TEXT NOT NULL DEFAULT 'active' CHECK (statut IN ('active', 'suspendue')),
  fichier_db           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_associations_statut ON associations (statut);

-- Consommation SMS, pour l'éditeur seul.
--
-- Le destinataire est enregistré MASQUÉ (+237******789) : suivre un volume ne
-- demande pas de conserver les numéros des membres du bureau de chaque client.
CREATE TABLE IF NOT EXISTS sms_envoyes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  association  TEXT,
  destinataire TEXT NOT NULL,
  motif        TEXT NOT NULL,
  fournisseur  TEXT NOT NULL,
  identifiant  TEXT,
  succes       INTEGER NOT NULL DEFAULT 0,
  erreur       TEXT,
  date_envoi   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sms_envoyes_date ON sms_envoyes (date_envoi);
CREATE INDEX IF NOT EXISTS idx_sms_envoyes_association ON sms_envoyes (association, date_envoi);
`;

let connexion = null;

/** Ouvre l'annuaire (une seule fois) et applique son schéma. */
async function obtenirAnnuaire() {
  if (connexion) return connexion;

  connexion = ouvrir(CHEMIN_ANNUAIRE, 'annuaire');
  try {
    await connexion.executerScript(SCHEMA);
  } catch (erreur) {
    console.error(`[annuaire] schéma inapplicable : ${erreur.message}`);
    throw erreur;
  }
  console.log('[annuaire] schéma appliqué (associations, sms_envoyes)');
  return connexion;
}

/** Chemin du fichier de base d'une association, tel qu'inscrit dans l'annuaire. */
function cheminBase(fichierDb) {
  return path.isAbsolute(fichierDb) ? fichierDb : path.join(DOSSIER_DONNEES, fichierDb);
}

/**
 * Normalise un code d'association : six caractères, majuscules et chiffres.
 * @returns {string} code normalisé, ou chaîne vide si le format est invalide
 */
function normaliserCode(valeur) {
  const code = String(valeur || '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : '';
}

/**
 * Association portant ce code, ou undefined.
 *
 * Le code est normalisé avant la requête : la saisie sur un téléphone produit
 * des minuscules et des espaces, et refuser « sde001 » serait incompréhensible
 * pour l'utilisateur.
 */
async function trouverParCode(code) {
  const normalise = normaliserCode(code);
  if (!normalise) return undefined;

  const annuaire = await obtenirAnnuaire();
  return annuaire.lireUne(
    'SELECT id, code, nom, ville, telephone_president, date_creation, statut, fichier_db' +
      ' FROM associations WHERE code = ?',
    [normalise]
  );
}

/** Toutes les associations, par ordre de création. */
async function lister() {
  const annuaire = await obtenirAnnuaire();
  return annuaire.lireToutes(
    'SELECT id, code, nom, ville, statut, date_creation, fichier_db' +
      ' FROM associations ORDER BY date_creation ASC, id ASC'
  );
}

/**
 * Inscrit une association dans l'annuaire.
 *
 * Le chemin du fichier est RELATIF au dossier de données : une sauvegarde
 * restaurée ailleurs, ou un passage de /home/ubuntu à /srv, ne doit pas rendre
 * l'annuaire faux.
 *
 * @returns {Promise<object>} l'association telle qu'inscrite
 */
async function inscrire({ code, nom, ville, telephonePresident }) {
  const normalise = normaliserCode(code);
  if (!normalise) throw new Error(`code d'association invalide : « ${code} »`);

  const annuaire = await obtenirAnnuaire();
  const fichier = path.posix.join('associations', `${normalise}.db`);

  await annuaire.executer(
    'INSERT INTO associations (code, nom, ville, telephone_president, fichier_db)' +
      ' VALUES (?, ?, ?, ?, ?)',
    [normalise, String(nom).trim(), ville ? String(ville).trim() : null, telephonePresident, fichier]
  );

  console.log(`[annuaire] association inscrite : ${normalise} — ${nom}`);
  return trouverParCode(normalise);
}

/** Un code est-il déjà pris ? */
async function codePris(code) {
  const existante = await trouverParCode(code);
  return Boolean(existante);
}

/**
 * Inscrit un envoi SMS au journal de consommation.
 *
 * Volontairement tolérante : un échec d'écriture ici ne doit PAS faire échouer
 * la réinitialisation de code du membre qui attend son SMS. On journalise
 * l'incident et on continue.
 */
async function journaliserSms(envoi) {
  try {
    const annuaire = await obtenirAnnuaire();
    await annuaire.executer(
      'INSERT INTO sms_envoyes (association, destinataire, motif, fournisseur, identifiant, succes, erreur)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        envoi.association || null,
        envoi.destinataire,
        envoi.motif,
        envoi.fournisseur,
        envoi.identifiant || null,
        envoi.succes ? 1 : 0,
        envoi.erreur || null,
      ]
    );
  } catch (incident) {
    console.error(`[annuaire] journal SMS non écrit : ${incident.message}`);
  }
}

/** Statistiques d'envoi par association et par mois, pour l'éditeur. */
async function statistiquesSms() {
  const annuaire = await obtenirAnnuaire();
  return annuaire.lireToutes(`
    SELECT substr(date_envoi, 1, 7) AS mois,
           COALESCE(association, 'sans association') AS association,
           fournisseur,
           COUNT(*) AS envois,
           SUM(CASE WHEN succes = 1 THEN 1 ELSE 0 END) AS reussis,
           SUM(CASE WHEN succes = 1 THEN 0 ELSE 1 END) AS echecs
      FROM sms_envoyes
     GROUP BY mois, association, fournisseur
     ORDER BY mois DESC, association ASC
  `);
}

/** Ferme l'annuaire (arrêt du serveur). */
async function fermerAnnuaire() {
  if (!connexion) return;
  const ouverte = connexion;
  connexion = null;
  await ouverte.fermer();
}

module.exports = {
  obtenirAnnuaire,
  trouverParCode,
  lister,
  inscrire,
  codePris,
  journaliserSms,
  statistiquesSms,
  fermerAnnuaire,
  normaliserCode,
  cheminBase,
  DOSSIER_DONNEES,
  DOSSIER_ASSOCIATIONS,
  CHEMIN_ANNUAIRE,
};
