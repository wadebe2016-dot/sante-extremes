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
 *
 * Une entrée peut porter un ordre « apres » : une requête jouée juste après
 * l'ALTER, donc une seule fois dans la vie de la base, pour donner une valeur de
 * départ aux lignes existantes.
 */
const COLONNES_AJOUTEES = {
  members: [
    // LOT 4 — mois d'entrée dans l'association, point de départ de tout calcul
    // d'arriéré. Sans elle, un membre entré en mai se voyait réclamer janvier à
    // avril : quatre mois qu'il ne devait pas.
    {
      nom: 'date_adhesion',
      definition: 'DATE',
      // Remplissage UNIQUE, au moment même de l'ajout de la colonne. La
      // première cotisation VALIDÉE d'un membre prouve qu'il était là ce
      // mois-là ; à défaut, la création de sa fiche fait foi. « substr » plutôt
      // que « strftime » : la valeur de départ ne doit dépendre d'aucune
      // tolérance de format sur les dates déjà écrites.
      apres: `UPDATE members SET date_adhesion = COALESCE(
                (SELECT substr(MIN(c.date_paiement), 1, 7) || '-01'
                   FROM cotisations c
                  WHERE c.member_id = members.id AND c.statut = 'validee'),
                substr(created_at, 1, 7) || '-01'
              )`,
    },
    // LOT 4 bis — contribution mensuelle attendue, propre à chaque membre.
    //
    // La cotisation n'a jamais été uniforme : certains membres sont à 5 000,
    // d'autres à 10 000. Le calcul appliquait 10 000 à tous et surestimait les
    // arriérés de la moitié de l'effectif.
    {
      nom: 'contribution',
      definition: 'REAL NOT NULL DEFAULT 10000',
      // Remplissage UNIQUE, au moment même de l'ajout de la colonne. Ce qu'un
      // membre verse d'habitude est la meilleure preuve de ce qu'on attend de
      // lui : on retient le montant le PLUS FRÉQUENT parmi ses cotisations
      // validées. À égalité de fréquence, le plus récemment versé l'emporte —
      // c'est l'attente en vigueur, pas celle d'il y a deux ans. Sans aucune
      // cotisation, la valeur par défaut s'applique.
      apres: `UPDATE members SET contribution = COALESCE(
                (SELECT c.montant
                   FROM cotisations c
                  WHERE c.member_id = members.id
                    AND c.statut = 'validee'
                    AND c.montant > 0
                  GROUP BY c.montant
                  ORDER BY COUNT(*) DESC, MAX(c.date_paiement) DESC
                  LIMIT 1),
                10000)`,
    },
    // LOT 4 — « mis à l'écart », jamais « radié ». Le CHECK vit dans
    // schema.sql, pour les bases neuves : SQLite ne sait pas ajouter une
    // contrainte à une table existante, et la liste fermée est tenue par
    // src/routes/admin.js, qui refuse en 400 toute autre valeur.
    { nom: 'statut', definition: "TEXT NOT NULL DEFAULT 'actif'" },
    { nom: 'date_statut', definition: 'DATETIME' },
    { nom: 'motif_statut', definition: 'TEXT' },
  ],
  cotisations: [
    // L'existant est réputé validé : ces lignes ont été saisies par le trésorier.
    { nom: 'statut', definition: "TEXT NOT NULL DEFAULT 'validee'" },
    { nom: 'motif_refus', definition: 'TEXT' },
    { nom: 'date_validation', definition: 'TEXT' },
    { nom: 'cle_s3', definition: 'TEXT' },
    // LOT 3 ter — qui a validé, refusé ou saisi cette cotisation
    { nom: 'valide_par', definition: 'TEXT' },
    // Date de versement — le jour où l'argent a réellement été remis. C'est la
    // seule date qui compte pour la caisse : « date_paiement » porte le mois dû
    // (le 5 du mois), « date_validation » le contrôle du trésorier.
    {
      nom: 'date_versement',
      definition: 'DATETIME',
      // Remplissage UNIQUE, au moment même de l'ajout de la colonne : pour une
      // ligne déjà en base, l'entrée en caisse la plus proche de la vérité est
      // sa validation, et à défaut son mois dû. La requête ne se rejoue jamais,
      // la colonne n'étant ajoutée qu'une fois.
      apres: 'UPDATE cotisations SET date_versement = COALESCE(date_validation, date_paiement)',
    },
  ],
  sanctions: [
    // LOT 3 ter — qui a encaissé la pénalité
    { nom: 'encaisse_par', definition: 'TEXT' },
    // LOT 4 — qui a prononcé la sanction. Le journal inscrivait « censeur »
    // en dur ; depuis que les pénalités de retard s'appliquent par lots
    // (POST /api/mesures/penalites), il faut le nom de celui qui a confirmé.
    { nom: 'inflige_par', definition: 'TEXT' },
    // LOT 4 — mois de cotisation à l'origine d'une pénalité de retard
    // (AAAA-MM). C'est lui qui porte l'idempotence : un membre déjà pénalisé
    // pour ce mois ne l'est pas une seconde fois.
    { nom: 'mois_concerne', definition: 'TEXT' },
  ],
  demandes: [
    // LOT 3 ter — qui a approuvé ou refusé la demande
    { nom: 'approuve_par', definition: 'TEXT' },
  ],
  decaissements: [
    // LOT 3 ter — qui a sorti l'argent de la caisse
    { nom: 'decaisse_par', definition: 'TEXT' },
  ],
  parametres: [
    // Solde d'ouverture ouvert aux trésoriers — qui a fixé ce réglage.
    { nom: 'definit_par', definition: 'TEXT' },
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

      // Valeur de départ des lignes déjà écrites, posée une seule fois.
      if (colonne.apres) {
        const resultat = await executer(colonne.apres);
        console.log(
          `[migration] ${table}.${colonne.nom} initialisée sur ${resultat.changements} ligne(s)`
        );
      }
    }
  }
}

/**
 * Libère « demandes.categorie » de sa contrainte CHECK sur une base existante.
 *
 * SQLite ne sait pas modifier un CHECK : ajouter « eau_collation » et
 * « entretien » à la liste fermée impose de reconstruire la table. C'est la
 * seule opération non strictement additive de tout le projet, d'où les
 * précautions :
 *   - elle ne s'exécute QUE si la contrainte est encore présente ;
 *   - toutes les lignes sont recopiées, colonne par colonne, dans une
 *     transaction ;
 *   - les clés étrangères sont désactivées le temps de l'échange, sans quoi la
 *     suppression de « demandes » buterait sur « decaissements ».
 *
 * La liste fermée n'est pas perdue : elle est tenue par src/routes/demandes.js,
 * qui refuse en 400 toute catégorie inconnue.
 */
async function libererCategorieDemandes() {
  const table = await lireUne("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'demandes'");
  if (!table || !table.sql) return; // table absente : schema.sql la créera sans CHECK
  if (!/CHECK\s*\(\s*categorie\s+IN/i.test(table.sql)) return; // déjà libérée

  console.log('[migration] reconstruction de « demandes » pour libérer la catégorie');

  const colonnes = (await colonnesDe('demandes')).join(', ');

  await executerScript('PRAGMA foreign_keys = OFF');
  try {
    await executerScript('BEGIN IMMEDIATE');
    await executerScript(`
      CREATE TABLE demandes_nouveau (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        categorie            TEXT NOT NULL,
        libelle              TEXT NOT NULL,
        montant_estime       REAL NOT NULL CHECK (montant_estime > 0),
        urgence              TEXT NOT NULL DEFAULT 'normale' CHECK (urgence IN ('normale', 'urgente')),
        justificatif_cle_s3  TEXT,
        role_demandeur       TEXT NOT NULL
                               CHECK (role_demandeur IN ('intendant', 'secretaire', 'competitions', 'admin')),
        statut               TEXT NOT NULL DEFAULT 'en_attente'
                               CHECK (statut IN ('en_attente', 'approuvee', 'refusee', 'payee')),
        motif_refus          TEXT,
        approuve_par         TEXT,
        date_demande         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        date_decision        TEXT
      )
    `);
    await executerScript(`INSERT INTO demandes_nouveau (${colonnes}) SELECT ${colonnes} FROM demandes`);
    await executerScript('DROP TABLE demandes');
    await executerScript('ALTER TABLE demandes_nouveau RENAME TO demandes');
    await executerScript('COMMIT');
    console.log('[migration] « demandes » reconstruite, lignes préservées');
  } catch (erreur) {
    await executerScript('ROLLBACK').catch(() => {});
    console.error(`[migration] reconstruction de « demandes » impossible : ${erreur.message}`);
    throw erreur;
  } finally {
    await executerScript('PRAGMA foreign_keys = ON');
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
    await libererCategorieDemandes();
    await executerScript(schema);
  } catch (erreur) {
    console.error(`[migration] échec de l'application du schéma : ${erreur.message}`);
    throw erreur;
  }

  console.log(
    '[migration] schéma appliqué (members, cotisations, sanctions, documents, evenements_membres)'
  );
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
