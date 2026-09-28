/**
 * Migration des bases — point d'entrée en ligne de commande.
 *
 * CE FICHIER N'EXPOSE PLUS DE CONNEXION. Jusqu'au LOT 6, il tenait la base
 * unique dans une variable de module, et les quatorze routeurs y puisaient
 * « executer », « lireUne » et « lireToutes » sans jamais dire de quelle
 * association ils parlaient. C'était le seul obstacle réel au multi-associations.
 *
 * Depuis le LOT 7 :
 *   · src/bd/connexion.js  ouvre UNE base et rend ses primitives ;
 *   · src/bd/migration.js  applique le schéma à une connexion donnée ;
 *   · src/bd/annuaire.js   tient la liste des associations ;
 *   · src/bd/locataires.js met les connexions en cache (LRU, 50) ;
 *   · le middleware d'association pose « requete.db », et c'est la SEULE voie
 *     d'accès aux données depuis une route.
 *
 * Un « require('../db') » qui chercherait encore « executer » échoue désormais au
 * démarrage : c'est voulu, une base globale oubliée quelque part serait une
 * fuite entre associations.
 *
 *   node src/db.js          migre toutes les associations de l'annuaire
 *   node src/db.js SDE001   migre une association précise
 */
'use strict';

require('dotenv').config();

const annuaire = require('./bd/annuaire');
const locataires = require('./bd/locataires');
const { migrer } = require('./bd/migration');

/**
 * Migre les bases demandées.
 *
 * @param {string[]} codes codes d'association ; toutes si la liste est vide
 * @returns {Promise<number>} nombre de bases migrées
 */
async function migrerAssociations(codes = []) {
  const associations = codes.length
    ? await Promise.all(codes.map((code) => annuaire.trouverParCode(code)))
    : await annuaire.lister();

  const trouvees = associations.filter(Boolean);
  const introuvables = codes.filter((code, rang) => !associations[rang]);

  if (introuvables.length > 0) {
    throw new Error(`association(s) inconnue(s) : ${introuvables.join(', ')}`);
  }

  if (trouvees.length === 0) {
    console.warn("[migration] aucune association dans l'annuaire : rien à migrer");
    console.warn('[migration] pour reprendre la base historique : node scripts/migrer-vers-multi.js');
    return 0;
  }

  for (const association of trouvees) {
    const bd = await locataires.obtenirBase(association);
    // obtenirBase migre déjà ; ce second passage éprouve l'idempotence, qui est
    // la propriété sur laquelle repose tout le reste.
    await migrer(bd);
    console.log(`[migration] ${association.code} — ${association.nom} : à jour`);
  }

  return trouvees.length;
}

module.exports = { migrerAssociations };

// Exécution directe : `node src/db.js [CODE...]`
if (require.main === module) {
  migrerAssociations(process.argv.slice(2))
    .then(async (nombre) => {
      await locataires.fermerToutes();
      await annuaire.fermerAnnuaire();
      console.log(`[migration] terminée avec succès (${nombre} base(s))`);
      process.exit(0);
    })
    .catch(async (erreur) => {
      console.error(`[migration] interrompue : ${erreur.message}`);
      await locataires.fermerToutes().catch(() => {});
      await annuaire.fermerAnnuaire().catch(() => {});
      process.exit(1);
    });
}
