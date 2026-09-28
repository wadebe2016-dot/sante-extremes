/**
 * Cache des connexions d'association — LOT 7 « DeuxZero ».
 *
 * Ouvrir un fichier SQLite et rejouer sa migration coûte quelques dizaines de
 * millisecondes. Le faire à chaque requête serait absurde ; garder toutes les
 * bases ouvertes indéfiniment épuiserait les descripteurs de fichier de
 * l'instance dès quelques centaines d'associations.
 *
 * D'où un cache borné à cinquante connexions, ordonné par dernier usage : la
 * base la moins récemment servie est fermée quand la cinquante et unième arrive.
 * Cinquante est large — les associations actives à un instant donné se comptent
 * sur les doigts d'une main — et laisse une marge confortable sous la limite
 * système.
 *
 * Une entrée du cache tient la PROMESSE d'ouverture, pas la connexion : deux
 * requêtes simultanées sur la même association neuve ne doivent pas rejouer la
 * migration deux fois en parallèle.
 */
'use strict';

const { ouvrir } = require('./connexion');
const { migrer } = require('./migration');
const annuaire = require('./annuaire');

const CONNEXIONS_MAX = Number(process.env.CONNEXIONS_MAX) > 0 ? Number(process.env.CONNEXIONS_MAX) : 50;

// Map conserve l'ordre d'insertion : re-insérer une clé la remet en queue, ce
// qui suffit à tenir l'ordre « du plus ancien usage au plus récent ».
const cache = new Map();

/**
 * Ferme les connexions excédentaires, la plus anciennement utilisée d'abord.
 */
async function evincer() {
  while (cache.size > CONNEXIONS_MAX) {
    const [code, entree] = cache.entries().next().value;
    cache.delete(code);
    console.log(`[locataires] connexion évincée du cache : ${code}`);
    try {
      const bd = await entree;
      await bd.fermer();
    } catch (erreur) {
      console.error(`[locataires] fermeture de ${code} impossible : ${erreur.message}`);
    }
  }
}

/**
 * Connexion à la base d'une association, ouverte et migrée.
 *
 * @param {object} association ligne de l'annuaire (code, fichier_db)
 * @returns {Promise<object>} connexion de src/bd/connexion.js
 */
function obtenirBase(association) {
  const code = association.code;

  const dejaOuverte = cache.get(code);
  if (dejaOuverte) {
    // Remise en queue : c'est ce qui fait de Map un cache LRU.
    cache.delete(code);
    cache.set(code, dejaOuverte);
    return dejaOuverte;
  }

  const ouverture = (async () => {
    const chemin = annuaire.cheminBase(association.fichier_db);
    const bd = ouvrir(chemin, code);
    try {
      await migrer(bd);
    } catch (erreur) {
      // Une base illisible ne doit pas rester en cache : la requête suivante
      // doit pouvoir retenter après correction du fichier.
      await bd.fermer().catch(() => {});
      throw erreur;
    }
    return bd;
  })();

  cache.set(code, ouverture);

  // Une ouverture qui échoue sort du cache : sans cela, toutes les requêtes
  // suivantes hériteraient de la promesse rejetée.
  ouverture.catch(() => {
    if (cache.get(code) === ouverture) cache.delete(code);
  });

  evincer().catch((erreur) => console.error(`[locataires] éviction impossible : ${erreur.message}`));

  return ouverture;
}

/** Nombre de connexions actuellement en cache (supervision et tests). */
function tailleCache() {
  return cache.size;
}

/** Ferme tout le cache (arrêt du serveur, ou remise à zéro entre deux tests). */
async function fermerToutes() {
  const entrees = [...cache.entries()];
  cache.clear();
  for (const [code, entree] of entrees) {
    try {
      const bd = await entree;
      await bd.fermer();
    } catch (erreur) {
      console.error(`[locataires] fermeture de ${code} impossible : ${erreur.message}`);
    }
  }
}

module.exports = { obtenirBase, tailleCache, fermerToutes, CONNEXIONS_MAX };
