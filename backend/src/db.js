/**
 * Accès à la base SQLite embarquée + migration du schéma.
 * Exécuter directement ce fichier (`npm run migrate`) applique schema.sql.
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const CHEMIN_BD = process.env.DB_PATH || './data/sde.db';
const CHEMIN_SCHEMA = path.join(__dirname, 'models', 'schema.sql');

let connexion = null;

/**
 * Crée le dossier parent de la base si nécessaire (ex. ./data).
 */
function preparerDossierBd(cheminBd) {
  const dossier = path.dirname(path.resolve(cheminBd));
  if (!fs.existsSync(dossier)) {
    fs.mkdirSync(dossier, { recursive: true });
    console.log(`[bd] dossier de données créé : ${dossier}`);
  }
}

/**
 * Retourne la connexion SQLite (singleton), en l'ouvrant au premier appel.
 */
function obtenirBd() {
  if (connexion) return connexion;

  preparerDossierBd(CHEMIN_BD);

  connexion = new sqlite3.Database(CHEMIN_BD, (erreur) => {
    if (erreur) {
      console.error(`[bd] échec d'ouverture de ${CHEMIN_BD} : ${erreur.message}`);
      throw erreur;
    }
    console.log(`[bd] base ouverte : ${CHEMIN_BD}`);
  });

  // Les suppressions de membres doivent entraîner celles de leurs cotisations
  connexion.run('PRAGMA foreign_keys = ON');

  return connexion;
}

/** Exécute une requête d'écriture. Résout { id, changements }. */
function executer(sql, parametres = []) {
  return new Promise((resoudre, rejeter) => {
    obtenirBd().run(sql, parametres, function rappel(erreur) {
      if (erreur) return rejeter(erreur);
      resoudre({ id: this.lastID, changements: this.changes });
    });
  });
}

/** Récupère une seule ligne (ou undefined). */
function lireUne(sql, parametres = []) {
  return new Promise((resoudre, rejeter) => {
    obtenirBd().get(sql, parametres, (erreur, ligne) => {
      if (erreur) return rejeter(erreur);
      resoudre(ligne);
    });
  });
}

/** Récupère toutes les lignes correspondantes. */
function lireToutes(sql, parametres = []) {
  return new Promise((resoudre, rejeter) => {
    obtenirBd().all(sql, parametres, (erreur, lignes) => {
      if (erreur) return rejeter(erreur);
      resoudre(lignes || []);
    });
  });
}

/**
 * Applique schema.sql (idempotent : toutes les instructions sont en IF NOT EXISTS).
 */
function migrer() {
  return new Promise((resoudre, rejeter) => {
    let schema;
    try {
      schema = fs.readFileSync(CHEMIN_SCHEMA, 'utf8');
    } catch (erreur) {
      console.error(`[migration] schema.sql illisible : ${erreur.message}`);
      return rejeter(erreur);
    }

    obtenirBd().exec(schema, (erreur) => {
      if (erreur) {
        console.error(`[migration] échec de l'application du schéma : ${erreur.message}`);
        return rejeter(erreur);
      }
      console.log('[migration] schéma appliqué (members, cotisations, index)');
      resoudre();
    });
  });
}

/** Ferme proprement la connexion (arrêt du serveur). */
function fermerBd() {
  return new Promise((resoudre) => {
    if (!connexion) return resoudre();
    connexion.close((erreur) => {
      if (erreur) console.error(`[bd] erreur à la fermeture : ${erreur.message}`);
      else console.log('[bd] connexion fermée');
      connexion = null;
      resoudre();
    });
  });
}

module.exports = { obtenirBd, executer, lireUne, lireToutes, migrer, fermerBd };

// Exécution directe : `node src/db.js` = migration de la base
if (require.main === module) {
  migrer()
    .then(() => fermerBd())
    .then(() => {
      console.log('[migration] terminée avec succès');
      process.exit(0);
    })
    .catch((erreur) => {
      console.error(`[migration] interrompue : ${erreur.message}`);
      process.exit(1);
    });
}
