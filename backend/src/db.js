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
 * Colonnes ajoutées après la mise en service, par table.
 *
 * « CREATE TABLE IF NOT EXISTS » ne touche pas une table déjà présente : sur une
 * base de production existante, les colonnes nouvelles doivent être posées une
 * par une. Chaque entrée est purement additive et porte sa valeur par défaut,
 * de sorte que les lignes déjà écrites gardent le comportement d'avant.
 */
const COLONNES_AJOUTEES = {
  cotisations: [
    // L'existant est réputé validé : ces lignes ont été saisies par le trésorier.
    { nom: 'statut', definition: "TEXT NOT NULL DEFAULT 'validee'" },
    { nom: 'motif_refus', definition: 'TEXT' },
    { nom: 'date_validation', definition: 'TEXT' },
    { nom: 'cle_s3', definition: 'TEXT' },
  ],
};

/** Liste les colonnes existantes d'une table. */
function colonnesDe(table) {
  return new Promise((resoudre, rejeter) => {
    obtenirBd().all(`PRAGMA table_info(${table})`, (erreur, lignes) => {
      if (erreur) return rejeter(erreur);
      resoudre((lignes || []).map((ligne) => ligne.name));
    });
  });
}

/**
 * Ajoute les colonnes manquantes aux tables déjà créées.
 *
 * SQLite ne connaît pas « ADD COLUMN IF NOT EXISTS » : on inspecte donc la table
 * avant d'écrire. Aucune colonne n'est jamais supprimée ni retypée.
 */
async function completerColonnes() {
  for (const [table, colonnes] of Object.entries(COLONNES_AJOUTEES)) {
    let existantes;
    try {
      existantes = await colonnesDe(table);
    } catch (erreur) {
      console.error(`[migration] lecture impossible de ${table} : ${erreur.message}`);
      throw erreur;
    }

    // Table absente : schema.sql vient de la créer avec toutes ses colonnes.
    if (existantes.length === 0) continue;

    for (const colonne of colonnes) {
      if (existantes.includes(colonne.nom)) continue;

      await executer(`ALTER TABLE ${table} ADD COLUMN ${colonne.nom} ${colonne.definition}`);
      console.log(`[migration] colonne ajoutée : ${table}.${colonne.nom}`);
    }
  }
}

/** Exécute un script SQL multi-instructions. */
function executerScript(sql) {
  return new Promise((resoudre, rejeter) => {
    obtenirBd().exec(sql, (erreur) => (erreur ? rejeter(erreur) : resoudre()));
  });
}

/**
 * Migration complète, en deux temps.
 *
 * L'ORDRE COMPTE : les colonnes manquantes sont ajoutées AVANT l'application de
 * schema.sql. Ce dernier crée un index sur « cotisations (member_id, statut) » ;
 * sur une base antérieure, cette colonne n'existe pas encore et tout le script
 * échouerait — donc aussi les instructions censées la créer.
 *
 * Sur une base neuve, la table n'existe pas : completerColonnes ne fait rien et
 * schema.sql la crée d'emblée avec toutes ses colonnes.
 */
async function migrer() {
  let schema;
  try {
    schema = fs.readFileSync(CHEMIN_SCHEMA, 'utf8');
  } catch (erreur) {
    console.error(`[migration] schema.sql illisible : ${erreur.message}`);
    throw erreur;
  }

  try {
    await completerColonnes();
    await executerScript(schema);
  } catch (erreur) {
    console.error(`[migration] échec de l'application du schéma : ${erreur.message}`);
    throw erreur;
  }

  console.log('[migration] schéma appliqué (members, cotisations, sanctions, documents)');
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
