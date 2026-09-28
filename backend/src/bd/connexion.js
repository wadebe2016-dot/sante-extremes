/**
 * Connexion à UNE base SQLite — LOT 7 « DeuxZero ».
 *
 * Jusqu'au LOT 6, le backend n'ouvrait qu'une base et src/db.js en tenait la
 * connexion dans une variable de module. Ce singleton était le seul chemin
 * d'accès aux données : tout le code métier l'appelait sans jamais dire de
 * QUELLE association il parlait.
 *
 * Le produit devenant multi-associations, ce raccourci n'est plus tenable : une
 * requête doit porter sa base, et une base doit appartenir à une seule
 * association. Ce module ne fabrique donc plus un singleton mais un OBJET de
 * connexion, que le middleware d'association pose sur « requete.db ».
 *
 * L'étanchéité ne repose pas sur la discipline du code appelant : une connexion
 * SQLite est ouverte sur UN fichier. Même une requête fautive — un « WHERE »
 * oublié, une jointure de travers — ne peut pas atteindre les lignes d'une
 * autre association, elles ne sont pas dans le fichier.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

/**
 * Crée le dossier parent d'une base si nécessaire (ex. data/associations).
 * @param {string} chemin chemin du fichier de base
 */
function preparerDossier(chemin) {
  const dossier = path.dirname(path.resolve(chemin));
  if (!fs.existsSync(dossier)) {
    fs.mkdirSync(dossier, { recursive: true });
    console.log(`[bd] dossier de données créé : ${dossier}`);
  }
}

/**
 * Ouvre une base SQLite et retourne son objet de connexion.
 *
 * L'objet expose exactement les quatre primitives dont le code métier a besoin.
 * Aucune n'expose l'objet sqlite3 lui-même : une route ne doit pas pouvoir
 * changer de fichier en cours de route.
 *
 * @param {string} chemin chemin du fichier SQLite
 * @param {string} [etiquette] nom lisible pour les journaux (code d'association)
 * @returns {{chemin: string, etiquette: string, executer: Function, lireUne: Function,
 *            lireToutes: Function, executerScript: Function, fermer: Function}}
 */
function ouvrir(chemin, etiquette = '') {
  preparerDossier(chemin);

  const nom = etiquette || path.basename(chemin);
  const base = new sqlite3.Database(chemin, (erreur) => {
    if (erreur) {
      console.error(`[bd] échec d'ouverture de ${chemin} : ${erreur.message}`);
      throw erreur;
    }
    console.log(`[bd] base ouverte : ${nom} (${chemin})`);
  });

  // Les suppressions de membres doivent entraîner celles de leurs cotisations.
  base.run('PRAGMA foreign_keys = ON');
  // Une seule instance écrit, mais les lectures d'export sont longues : le
  // mode WAL évite qu'un export bloque une déclaration de cotisation.
  base.run('PRAGMA journal_mode = WAL');
  // Deux requêtes concurrentes sur la même base peuvent se croiser : plutôt
  // que d'échouer aussitôt sur « SQLITE_BUSY », on attend cinq secondes.
  base.configure('busyTimeout', 5000);

  /** Exécute une requête d'écriture. Résout { id, changements }. */
  function executer(sql, parametres = []) {
    return new Promise((resoudre, rejeter) => {
      base.run(sql, parametres, function rappel(erreur) {
        if (erreur) return rejeter(erreur);
        resoudre({ id: this.lastID, changements: this.changes });
      });
    });
  }

  /** Récupère une seule ligne (ou undefined). */
  function lireUne(sql, parametres = []) {
    return new Promise((resoudre, rejeter) => {
      base.get(sql, parametres, (erreur, ligne) => {
        if (erreur) return rejeter(erreur);
        resoudre(ligne);
      });
    });
  }

  /** Récupère toutes les lignes correspondantes. */
  function lireToutes(sql, parametres = []) {
    return new Promise((resoudre, rejeter) => {
      base.all(sql, parametres, (erreur, lignes) => {
        if (erreur) return rejeter(erreur);
        resoudre(lignes || []);
      });
    });
  }

  /** Exécute un script SQL multi-instructions. */
  function executerScript(sql) {
    return new Promise((resoudre, rejeter) => {
      base.exec(sql, (erreur) => (erreur ? rejeter(erreur) : resoudre()));
    });
  }

  /** Ferme la connexion. Idempotent : une base déjà fermée ne lève rien. */
  function fermer() {
    return new Promise((resoudre) => {
      base.close((erreur) => {
        if (erreur) console.error(`[bd] erreur à la fermeture de ${nom} : ${erreur.message}`);
        else console.log(`[bd] connexion fermée : ${nom}`);
        resoudre();
      });
    });
  }

  return { chemin, etiquette: nom, executer, lireUne, lireToutes, executerScript, fermer };
}

/** Liste les colonnes existantes d'une table ; tableau vide si la table manque. */
async function colonnesDe(bd, table) {
  const lignes = await bd.lireToutes(`PRAGMA table_info(${table})`);
  return lignes.map((ligne) => ligne.name);
}

module.exports = { ouvrir, colonnesDe, preparerDossier };
