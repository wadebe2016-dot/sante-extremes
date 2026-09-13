/**
 * Vérification d'un code de rôle — Santé des extrêmes (LOT 3).
 *   POST /api/auth/verify  { code }  → 200 { roles: ["tresorier"] } | 401
 *
 * Permet à l'application mobile de savoir quels onglets déverrouiller sans
 * exécuter la moindre action métier. Le code lui-même n'est jamais renvoyé ni
 * journalisé.
 */
'use strict';

const express = require('express');
const { rolesDuCode } = require('../middleware/auth');

const routeur = express.Router();

// Garde-fou anti-force brute : les codes sont courts et partagés, cette route
// est la seule qui permette de les tester sans effet de bord. Compteur en
// mémoire — suffisant pour une instance unique, remis à zéro au redémarrage.
const FENETRE_MS = 5 * 60 * 1000;
const TENTATIVES_MAX = 20;
const tentativesParSource = new Map();

/** Purge les compteurs expirés pour éviter que la table ne grossisse sans fin. */
function purgerCompteurs(maintenant) {
  for (const [source, suivi] of tentativesParSource) {
    if (maintenant - suivi.debut > FENETRE_MS) tentativesParSource.delete(source);
  }
}

/**
 * @returns {boolean} true si la source a dépassé son quota de tentatives
 */
function quotaDepasse(source) {
  const maintenant = Date.now();
  purgerCompteurs(maintenant);

  const suivi = tentativesParSource.get(source);
  if (!suivi || maintenant - suivi.debut > FENETRE_MS) {
    tentativesParSource.set(source, { debut: maintenant, nombre: 1 });
    return false;
  }

  suivi.nombre += 1;
  return suivi.nombre > TENTATIVES_MAX;
}

/** Un code validé remet le compteur à zéro : l'utilisateur légitime n'est pas pénalisé. */
function reinitialiserCompteur(source) {
  tentativesParSource.delete(source);
}

/** POST /api/auth/verify — le code est-il valide, et pour quels rôles ? */
routeur.post('/verify', (requete, reponse) => {
  const source = requete.ip || 'inconnue';
  const code = typeof requete.body?.code === 'string' ? requete.body.code.trim() : '';

  if (!code) {
    console.warn('[auth] vérification refusée : champ « code » manquant');
    return reponse.status(400).json({ error: 'Le code est obligatoire' });
  }

  if (quotaDepasse(source)) {
    console.warn(`[auth] trop de tentatives depuis ${source} : vérification bloquée`);
    return reponse.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes' });
  }

  const roles = rolesDuCode(code);

  if (roles.length === 0) {
    console.warn(`[auth] code refusé à la vérification (source ${source})`);
    return reponse.status(401).json({ error: 'Code invalide' });
  }

  reinitialiserCompteur(source);
  console.log(`[auth] code validé pour les rôles : ${roles.join(', ')}`);
  return reponse.status(200).json({ roles });
});

module.exports = routeur;
