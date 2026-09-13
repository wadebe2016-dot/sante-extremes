#!/usr/bin/env node
/**
 * Persistance de la base SQLite sur S3 — Santé des extrêmes (LOT 2).
 *
 * Le conteneur Fargate n'a pas de disque durable : la base vit sur S3 et le
 * système de fichiers local ne sert que de cache de travail.
 *
 *   restore  télécharge s3://$S3_DB_BUCKET/$S3_DB_KEY vers $DB_PATH (au démarrage)
 *   backup   prend un instantané cohérent de $DB_PATH et le téléverse
 *   watch    exécute « backup » toutes les $DB_SYNC_INTERVAL_SECONDS secondes
 *
 * Cohérence de l'instantané : « VACUUM INTO » écrit une copie intègre de la
 * base pendant que le serveur continue de tourner — un simple cp pourrait
 * capturer une page en cours d'écriture. Repli sur une copie de fichier si
 * l'instruction échoue (SQLite trop ancien, disque plein…).
 *
 * Sécurité : aucune clé ici. Les identifiants proviennent du rôle IAM de la
 * tâche ECS (chaîne de credentials par défaut du SDK AWS).
 *
 * Le versioning S3 du bucket tient lieu d'historique de sauvegardes.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sqlite3 = require('sqlite3');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const CHEMIN_BD = process.env.DB_PATH || './data/sde.db';
const BUCKET = process.env.S3_DB_BUCKET || '';
const CLE = process.env.S3_DB_KEY || 'sqlite/sde.db';
const REGION = process.env.AWS_REGION || 'eu-west-3';
const PERIODE_MS = Math.max(30, Number(process.env.DB_SYNC_INTERVAL_SECONDS || 300)) * 1000;

// Empreinte du dernier envoi réussi : évite de téléverser une base inchangée.
const CHEMIN_EMPREINTE = path.join(os.tmpdir(), 'sde-db-sync.sha256');

let client = null;

function obtenirClient() {
  if (!client) client = new S3Client({ region: REGION });
  return client;
}

function journal(message) {
  console.log(`[db-sync] ${message}`);
}

/** Le module est inerte si aucun bucket n'est configuré (exécution locale). */
function synchronisationActive() {
  if (BUCKET) return true;
  journal('S3_DB_BUCKET non défini : persistance S3 désactivée (base locale uniquement)');
  return false;
}

function empreinteFichier(chemin) {
  return crypto.createHash('sha256').update(fs.readFileSync(chemin)).digest('hex');
}

function preparerDossier(chemin) {
  const dossier = path.dirname(path.resolve(chemin));
  if (!fs.existsSync(dossier)) fs.mkdirSync(dossier, { recursive: true });
}

/**
 * Télécharge la base depuis S3. Absence d'objet = première mise en service :
 * on laisse src/index.js créer la base via la migration.
 */
async function restaurer() {
  if (!synchronisationActive()) return;

  preparerDossier(CHEMIN_BD);

  try {
    const reponse = await obtenirClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: CLE }));
    const octets = Buffer.from(await reponse.Body.transformToByteArray());

    // Écriture atomique : un téléchargement interrompu ne laisse pas de base tronquée.
    const provisoire = `${CHEMIN_BD}.telechargement`;
    fs.writeFileSync(provisoire, octets);
    fs.renameSync(provisoire, CHEMIN_BD);

    // Les journaux WAL/SHM éventuels appartiennent à l'ancienne tâche : ils sont obsolètes.
    for (const suffixe of ['-wal', '-shm', '-journal']) {
      const annexe = `${CHEMIN_BD}${suffixe}`;
      if (fs.existsSync(annexe)) fs.unlinkSync(annexe);
    }

    const empreinte = empreinteFichier(CHEMIN_BD);
    fs.writeFileSync(CHEMIN_EMPREINTE, empreinte);
    journal(`base restaurée depuis s3://${BUCKET}/${CLE} (${octets.length} octets, sha256 ${empreinte.slice(0, 12)})`);
  } catch (erreur) {
    const code = erreur?.name || erreur?.Code || '';
    if (code === 'NoSuchKey' || code === 'NotFound' || erreur?.$metadata?.httpStatusCode === 404) {
      journal(`aucune base sur s3://${BUCKET}/${CLE} : démarrage avec une base vierge (la migration la créera)`);
      return;
    }
    console.error(`[db-sync] échec de la restauration : ${erreur.message}`);
    // Démarrer sur une base vide écraserait les données au prochain backup.
    process.exit(1);
  }
}

/**
 * Produit un instantané cohérent de la base dans un fichier temporaire.
 * @returns {Promise<string>} chemin de l'instantané
 */
function instantanerBase() {
  return new Promise((resoudre, rejeter) => {
    const destination = path.join(os.tmpdir(), `sde-instantane-${process.pid}.db`);
    if (fs.existsSync(destination)) fs.unlinkSync(destination);

    const connexion = new sqlite3.Database(CHEMIN_BD, sqlite3.OPEN_READONLY, (erreurOuverture) => {
      if (erreurOuverture) return rejeter(erreurOuverture);

      connexion.run(`VACUUM INTO '${destination.replace(/'/g, "''")}'`, (erreurVacuum) => {
        connexion.close(() => {
          if (erreurVacuum) {
            console.warn(`[db-sync] VACUUM INTO indisponible (${erreurVacuum.message}), copie simple du fichier`);
            try {
              fs.copyFileSync(CHEMIN_BD, destination);
            } catch (erreurCopie) {
              return rejeter(erreurCopie);
            }
          }
          resoudre(destination);
        });
      });
    });
  });
}

/**
 * Téléverse la base si elle a changé depuis le dernier envoi.
 * @returns {Promise<boolean>} true si un envoi a eu lieu
 */
async function sauvegarder() {
  if (!synchronisationActive()) return false;

  if (!fs.existsSync(CHEMIN_BD)) {
    journal(`aucune base locale à ${CHEMIN_BD} : rien à sauvegarder`);
    return false;
  }

  let instantane;
  try {
    instantane = await instantanerBase();
    const octets = fs.readFileSync(instantane);
    const empreinte = crypto.createHash('sha256').update(octets).digest('hex');

    const precedente = fs.existsSync(CHEMIN_EMPREINTE) ? fs.readFileSync(CHEMIN_EMPREINTE, 'utf8').trim() : '';
    if (empreinte === precedente) {
      journal('base inchangée depuis la dernière sauvegarde : envoi ignoré');
      return false;
    }

    await obtenirClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: CLE,
        Body: octets,
        ContentType: 'application/vnd.sqlite3',
        ContentLength: octets.length,
        Metadata: {
          sha256: empreinte,
          'sauvegarde-le': new Date().toISOString(),
        },
      })
    );

    fs.writeFileSync(CHEMIN_EMPREINTE, empreinte);
    journal(`base sauvegardée vers s3://${BUCKET}/${CLE} (${octets.length} octets, sha256 ${empreinte.slice(0, 12)})`);
    return true;
  } catch (erreur) {
    console.error(`[db-sync] échec de la sauvegarde : ${erreur.message}`);
    throw erreur;
  } finally {
    if (instantane && fs.existsSync(instantane)) {
      try {
        fs.unlinkSync(instantane);
      } catch (erreur) {
        console.warn(`[db-sync] instantané temporaire non supprimé : ${erreur.message}`);
      }
    }
  }
}

/**
 * Sauvegarde périodique. Une erreur ponctuelle (réseau) ne doit pas tuer la
 * boucle : la tentative suivante repartira du même état local.
 */
function surveiller() {
  if (!synchronisationActive()) return;

  journal(`surveillance active : sauvegarde toutes les ${PERIODE_MS / 1000} s`);

  const minuterie = setInterval(() => {
    sauvegarder().catch(() => {
      /* déjà journalisé, on retente au tour suivant */
    });
  }, PERIODE_MS);

  minuterie.unref?.();

  const arreter = async (signal) => {
    journal(`signal ${signal} reçu : sauvegarde finale avant arrêt`);
    clearInterval(minuterie);
    try {
      await sauvegarder();
    } catch (erreur) {
      console.error(`[db-sync] sauvegarde finale échouée : ${erreur.message}`);
      process.exit(1);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => arreter('SIGTERM'));
  process.on('SIGINT', () => arreter('SIGINT'));

  // Maintient le processus vivant (setInterval unref ne suffit pas seul).
  setInterval(() => {}, 1 << 30);
}

async function principal() {
  const commande = process.argv[2];

  switch (commande) {
    case 'restore':
      await restaurer();
      break;
    case 'backup':
      await sauvegarder();
      break;
    case 'watch':
      surveiller();
      return; // processus longue durée
    default:
      console.error('Usage : node scripts/s3-db-sync.js <restore|backup|watch>');
      process.exit(2);
  }
}

module.exports = { restaurer, sauvegarder };

if (require.main === module) {
  principal().catch((erreur) => {
    console.error(`[db-sync] interruption : ${erreur.message}`);
    process.exit(1);
  });
}
