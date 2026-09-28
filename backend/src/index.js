/**
 * Serveur Express — DeuxZero (LOT 7).
 *
 * L'application, mono-association jusqu'au LOT 6, devient un produit
 * multi-associations. Deux changements structurent tout ce fichier :
 *
 *   1. UNE BASE PAR ASSOCIATION. Le middleware resoudreAssociation lit l'en-tête
 *      « X-Association », ouvre la base correspondante et la pose sur
 *      « requete.db ». Il est monté AVANT tous les routeurs métier : aucun d'eux
 *      ne peut être atteint sans base résolue, et aucun ne détient de base
 *      globale. L'étanchéité ne dépend donc pas de la discipline des requêtes
 *      SQL, mais du fichier ouvert.
 *
 *   2. L'ÉDITEUR N'INTERVIENT JAMAIS. Trois routes sont publiques et sans
 *      en-tête : créer une association, reconnaître un code, réinitialiser un
 *      code perdu. C'est ce qui permet à une association de s'inscrire un samedi
 *      matin et de travailler le samedi suivant sans appeler personne.
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const annuaire = require('./bd/annuaire');
const locataires = require('./bd/locataires');
const { resoudreAssociation } = require('./middleware/association');
const { fournisseurActif } = require('./services/sms');

const routesAdmin = require('./routes/admin');
const routesAdminProduit = require('./routes/adminProduit');
const routesArrieres = require('./routes/arrieres');
const routesAssociations = require('./routes/associations');
const routesAuth = require('./routes/auth');
const routesCotisations = require('./routes/cotisations');
const routesDecaissements = require('./routes/decaissements');
const routesDemandes = require('./routes/demandes');
const routesDocuments = require('./routes/documents');
const routesExport = require('./routes/export');
const routesHistorique = require('./routes/historique');
const routesJournal = require('./routes/journal');
const routesMesures = require('./routes/mesures');
const routesParametres = require('./routes/parametres');
const routesPenalites = require('./routes/penalites');
const routesReinitialisation = require('./routes/reinitialisation');
const routesRoles = require('./routes/roles');
const routesSanctions = require('./routes/sanctions');
const routesSeance = require('./routes/seance');
const routesStats = require('./routes/stats');
const routesTresorerie = require('./routes/tresorerie');

const PORT = Number(process.env.PORT || 3000);
const application = express();

// L'application Android n'est pas soumise au CORS : elle n'a pas d'origine.
// La VERSION WEB, elle, en a une — https://app.santedesextremes.com — et le
// navigateur refusera toute réponse de l'API tant qu'elle n'est pas déclarée
// dans CORS_ORIGINS (liste séparée par des virgules ; « * » laisse tout
// passer, ce qui reste le défaut pour un usage local).
//
// Une origine absente de la liste n'est pas REFUSÉE : la réponse part sans
// l'en-tête « Access-Control-Allow-Origin », et c'est le navigateur qui la
// jette. Vu du serveur, la requête aboutit — d'où l'importance de vérifier
// l'EN-TÊTE, et non le code de retour, quand on éprouve la configuration.
const originesAutorisees = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((valeur) => valeur.trim())
  .filter(Boolean);

application.use(
  cors({
    origin: originesAutorisees.includes('*') ? true : originesAutorisees,
    // LOT 7 — sans cette ligne, le navigateur refuse la requête préalable et la
    // version web ne peut plus joindre aucune route métier : « X-Association »
    // n'est pas un en-tête que CORS autorise d'office.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Association'],
    exposedHeaders: ['Retry-After'],
  })
);

// Derrière l'ALB : X-Forwarded-For / X-Forwarded-Proto sont ceux du load balancer
application.set('trust proxy', true);
application.use(express.json({ limit: '1mb' }));
application.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Journal d'accès minimal et structuré. Le code d'association y figure : c'est le
// seul moyen de démêler les journaux de plusieurs clients sur une même instance.
application.use((requete, reponse, suite) => {
  const debut = Date.now();
  reponse.on('finish', () => {
    const association = requete.headers['x-association'] || '-';
    console.log(
      `[http] ${requete.method} ${requete.originalUrl} [${association}] → ` +
        `${reponse.statusCode} (${Date.now() - debut} ms)`
    );
  });
  suite();
});

// Sonde de santé (supervision / conteneur). Dispensée d'en-tête : elle interroge
// le service, pas une association.
application.get('/api/health', (requete, reponse) => {
  reponse.status(200).json({
    status: 'ok',
    service: 'deuxzero-backend',
    sms: fournisseurActif(),
    bases_en_cache: locataires.tailleCache(),
  });
});

// ---------------------------------------------------------------------------
// Résolution du locataire — AVANT tout routeur métier.
//
// Ce qui suit cette ligne ne peut plus être atteint sans « requete.db ». Les
// quatre routes dispensées d'en-tête sont listées dans le middleware lui-même,
// une par une, avec leur justification : c'est volontairement une liste fermée
// et non un motif, pour qu'aucune route nouvelle ne s'y glisse par inadvertance.
// ---------------------------------------------------------------------------
application.use(resoudreAssociation);

// Création d'association et reconnaissance d'un code : publiques et sans en-tête.
application.use('/api/associations', routesAssociations);
// Réinitialisation d'un code perdu : le demandeur n'a plus rien de configuré.
application.use('/api/reinitialisation', routesReinitialisation);
// Espace de l'éditeur, protégé par ADMIN_PRODUIT_CODE et sans donnée métier.
application.use('/api/admin-produit', routesAdminProduit);

// Routes publiques de l'association : consultation et exports, aucun code requis
application.use('/api/stats', routesStats);
application.use('/api/historique', routesHistorique);
application.use('/api/journal', routesJournal);
application.use('/api/tresorerie', routesTresorerie);
application.use('/api/decaissements', routesDecaissements); // lecture publique, justificatif restreint
application.use('/api/export', routesExport);
// LOT 4 — arriérés et feuille de séance : lecture publique et sans code. Les
// censeurs contrôlent à l'entrée du terrain, le bureau lit les arriérés en
// assemblée ; exiger un code là aurait rendu les deux écrans inutilisables.
application.use('/api/arrieres', routesArrieres);
application.use('/api/seance', routesSeance);
application.use('/api/mesures', routesMesures); // lecture publique, écriture censeur/secrétaire

// Vérification d'un code de rôle (aucune action métier)
application.use('/api/auth', routesAuth);

// Routes protégées : le contrôle du rôle est posé dans chaque routeur
application.use('/api/admin', routesAdmin); // secrétaire
application.use('/api/cotisations', routesCotisations); // trésorier
application.use('/api/penalites', routesPenalites); // trésorier
application.use('/api/sanctions', routesSanctions); // lecture publique, écriture censeur
application.use('/api/demandes', routesDemandes); // lecture publique, écriture intendant/secrétaire/compétitions
application.use('/api/documents', routesDocuments); // règlement public, fiches santé secrétaire
application.use('/api/roles', routesRoles); // président : attribution et révocation des accès
application.use('/api/parametres', routesParametres); // lecture tout rôle, écriture président

// Route inconnue
application.use((requete, reponse) => {
  console.warn(`[http] route inconnue : ${requete.method} ${requete.originalUrl}`);
  reponse.status(404).json({ error: 'Ressource introuvable' });
});

// Gestionnaire d'erreurs global : rien ne doit remonter en trace brute au client
application.use((erreur, requete, reponse, suite) => {
  console.error(`[http] erreur non gérée sur ${requete.method} ${requete.originalUrl} : ${erreur.message}`);
  if (reponse.headersSent) return suite(erreur);
  return reponse.status(500).json({ error: 'Erreur interne du serveur' });
});

/**
 * Avertissements de configuration, au démarrage.
 *
 * Trois réglages peuvent être corrects en recette et dangereux en production. Les
 * signaler au démarrage est le seul moment où quelqu'un les lit.
 */
function verifierConfiguration() {
  const production = process.env.NODE_ENV === 'production';
  const sms = fournisseurActif();

  if (production && sms === 'journal') {
    console.error(
      '[serveur] ATTENTION : SMS_FOURNISSEUR=journal en production. AUCUN SMS NE PARTIRA — ' +
        'les réinitialisations de code seront inopérantes et les codes apparaîtront dans les logs.'
    );
  }

  if (!String(process.env.ADMIN_PRODUIT_CODE || '').trim()) {
    console.warn(
      "[serveur] ADMIN_PRODUIT_CODE absent : l'espace éditeur (/api/admin-produit) est fermé."
    );
  }

  if (production && originesAutorisees.includes('*')) {
    console.warn(
      '[serveur] CORS_ORIGINS=* en production : toute origine web peut interroger l’API.'
    );
  }

  console.log(`[serveur] routeur SMS : ${sms}`);
}

/**
 * Prépare l'annuaire puis démarre l'écoute HTTP.
 *
 * Les bases d'association ne sont PAS migrées au démarrage : elles le sont à leur
 * première requête, par le cache de locataires. Avec une association, la
 * différence est nulle ; avec deux cents, elle fait la différence entre un
 * redémarrage d'une seconde et un redémarrage d'une minute.
 */
async function demarrer() {
  verifierConfiguration();

  try {
    await annuaire.obtenirAnnuaire();
    const associations = await annuaire.lister();
    console.log(`[serveur] annuaire prêt : ${associations.length} association(s) inscrite(s)`);
    if (associations.length === 0) {
      console.warn(
        '[serveur] annuaire vide. Pour reprendre la base historique : ' +
          'node scripts/migrer-vers-multi.js'
      );
    }
  } catch (erreur) {
    console.error(`[serveur] annuaire inaccessible, arrêt : ${erreur.message}`);
    process.exit(1);
  }

  const serveur = application.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[serveur] DeuxZero à l'écoute sur le port ${PORT} (${process.env.NODE_ENV || 'development'})`
    );
  });

  serveur.on('error', (erreur) => {
    console.error(`[serveur] impossible d'écouter sur le port ${PORT} : ${erreur.message}`);
    process.exit(1);
  });

  // Arrêt propre (systemd envoie SIGTERM)
  const arreter = (signal) => {
    console.log(`[serveur] signal ${signal} reçu, arrêt en cours`);
    serveur.close(async () => {
      await locataires.fermerToutes();
      await annuaire.fermerAnnuaire();
      console.log('[serveur] arrêté proprement');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => arreter('SIGTERM'));
  process.on('SIGINT', () => arreter('SIGINT'));
}

process.on('unhandledRejection', (raison) => {
  console.error(`[serveur] promesse rejetée non gérée : ${raison}`);
});

// Les tests requièrent ce fichier pour son application Express seule, et ouvrent
// leur propre écoute sur un port libre : démarrer ici en plus laisserait le
// processus de test ouvert indéfiniment.
//
// La condition ne porte PAS sur NODE_ENV. La chaîne d'intégration lance le
// serveur avec NODE_ENV=test et l'interroge sur /api/health : s'y raccrocher
// aurait rendu ce contrôle impossible à satisfaire, et la sonde de santé est
// justement ce qui vérifie que le service démarre vraiment.
if (process.env.SERVEUR_SANS_ECOUTE !== '1') demarrer();

module.exports = application;
module.exports.demarrer = demarrer;
