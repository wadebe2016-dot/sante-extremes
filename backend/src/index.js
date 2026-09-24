/**
 * Serveur Express — Santé des extrêmes (LOT 1)
 * Expose les routes d'administration, d'enregistrement des cotisations
 * et le tableau public de suivi des paiements.
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { migrer, fermerBd } = require('./db');
const routesAdmin = require('./routes/admin');
const routesArrieres = require('./routes/arrieres');
const routesAuth = require('./routes/auth');
const routesCotisations = require('./routes/cotisations');
const routesDecaissements = require('./routes/decaissements');
const routesDemandes = require('./routes/demandes');
const routesDocuments = require('./routes/documents');
const routesExport = require('./routes/export');
const routesHistorique = require('./routes/historique');
const routesJournal = require('./routes/journal');
const routesMesures = require('./routes/mesures');
const routesPenalites = require('./routes/penalites');
const routesSanctions = require('./routes/sanctions');
const routesSeance = require('./routes/seance');
const routesStats = require('./routes/stats');
const routesTresorerie = require('./routes/tresorerie');

const PORT = Number(process.env.PORT || 3000);
const application = express();

// L'application mobile n'est pas soumise au CORS ; la restriction ne concerne
// que le tableau public consulté depuis un navigateur. CORS_ORIGINS accepte une
// liste séparée par des virgules, « * » (défaut) laissant tout passer.
const originesAutorisees = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((valeur) => valeur.trim())
  .filter(Boolean);

application.use(
  cors({
    origin: originesAutorisees.includes('*') ? true : originesAutorisees,
  })
);

// Derrière l'ALB : X-Forwarded-For / X-Forwarded-Proto sont ceux du load balancer
application.set('trust proxy', true);
application.use(express.json({ limit: '1mb' }));
application.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Journal d'accès minimal et structuré
application.use((requete, reponse, suite) => {
  const debut = Date.now();
  reponse.on('finish', () => {
    console.log(`[http] ${requete.method} ${requete.originalUrl} → ${reponse.statusCode} (${Date.now() - debut} ms)`);
  });
  suite();
});

// Sonde de santé (supervision / conteneur)
application.get('/api/health', (requete, reponse) => {
  reponse.status(200).json({ status: 'ok', service: 'sante-extremes-backend' });
});

// Routes publiques : consultation et exports, aucun code requis
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
 * Applique la migration puis démarre l'écoute HTTP.
 */
async function demarrer() {
  try {
    await migrer();
  } catch (erreur) {
    console.error(`[serveur] migration impossible, arrêt : ${erreur.message}`);
    process.exit(1);
  }

  const serveur = application.listen(PORT, '0.0.0.0', () => {
    console.log(`[serveur] Santé des extrêmes à l'écoute sur le port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });

  serveur.on('error', (erreur) => {
    console.error(`[serveur] impossible d'écouter sur le port ${PORT} : ${erreur.message}`);
    process.exit(1);
  });

  // Arrêt propre (Docker envoie SIGTERM)
  const arreter = (signal) => {
    console.log(`[serveur] signal ${signal} reçu, arrêt en cours`);
    serveur.close(async () => {
      await fermerBd();
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

demarrer();

module.exports = application;
