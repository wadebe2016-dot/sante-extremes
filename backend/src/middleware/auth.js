/**
 * Authentification par codes de rôle — Santé des extrêmes (LOT 3).
 *
 * L'association ne gère pas de comptes nominatifs : chaque fonction partage un
 * code, transmis en en-tête « Authorization: Bearer <code> ». Les codes ne sont
 * jamais écrits en dur, ils viennent de l'environnement :
 *
 *   ADMIN_PASSWORD       admin       — tous les droits
 *   TRESORIER_PASSWORD   tresorier   — cotisations, encaissement des pénalités
 *   SECRETAIRE_PASSWORD  secretaire  — membres, règlement intérieur, fiches santé
 *   CENSEUR_PASSWORD     censeur     — sanctions
 *
 * Le code admin ouvre toutes les routes : il n'a pas besoin d'être listé dans
 * les appels à exigerRole().
 */
'use strict';

const crypto = require('crypto');

/** Correspondance rôle → variable d'environnement portant son code. */
const VARIABLES_PAR_ROLE = Object.freeze({
  admin: 'ADMIN_PASSWORD',
  tresorier: 'TRESORIER_PASSWORD',
  secretaire: 'SECRETAIRE_PASSWORD',
  censeur: 'CENSEUR_PASSWORD',
});

const ROLES_CONNUS = Object.freeze(Object.keys(VARIABLES_PAR_ROLE));

/**
 * Comparaison à temps constant : la durée ne dépend pas du nombre de caractères
 * corrects, ce qui interdit de deviner un code octet par octet.
 */
function comparerSecrets(recu, attendu) {
  const tamponRecu = Buffer.from(String(recu), 'utf8');
  const tamponAttendu = Buffer.from(String(attendu), 'utf8');
  if (tamponRecu.length !== tamponAttendu.length) return false;
  return crypto.timingSafeEqual(tamponRecu, tamponAttendu);
}

/**
 * Extrait le code porté par l'en-tête Authorization.
 * @returns {string|null} le code, ou null si l'en-tête est absent ou mal formé
 */
function extraireCode(requete) {
  const entete = requete.headers.authorization || '';
  const [schema, jeton] = entete.split(' ');
  if (schema !== 'Bearer' || !jeton) return null;
  return jeton;
}

/**
 * Rôles auxquels correspond un code donné.
 *
 * Un même code peut être partagé par plusieurs fonctions : on renvoie donc une
 * liste. Un rôle dont la variable d'environnement n'est pas définie ne peut
 * jamais correspondre — sans quoi un code vide ouvrirait la porte.
 *
 * @param {string} code code reçu
 * @returns {string[]} rôles correspondants, éventuellement vide
 */
function rolesDuCode(code) {
  if (!code) return [];

  const roles = [];
  for (const [role, variable] of Object.entries(VARIABLES_PAR_ROLE)) {
    const attendu = process.env[variable];
    if (!attendu) continue;
    if (comparerSecrets(code, attendu)) roles.push(role);
  }
  return roles;
}

/**
 * Middleware exigeant l'un des rôles listés — le rôle admin étant toujours
 * accepté en plus.
 *
 *   routeur.post('/', exigerRole('tresorier'), gestionnaire)
 *
 * En cas de succès, requete.roles contient les rôles reconnus pour ce code.
 *
 * @param {...string} rolesAutorises rôles ouvrant l'accès à la route
 * @returns {Function} middleware Express
 */
function exigerRole(...rolesAutorises) {
  const inconnus = rolesAutorises.filter((role) => !ROLES_CONNUS.includes(role));
  if (inconnus.length > 0) {
    // Erreur de programmation : on la fait remonter au démarrage, pas en production.
    throw new Error(`exigerRole : rôle inconnu « ${inconnus.join(', ')} »`);
  }

  const acceptes = new Set([...rolesAutorises, 'admin']);

  return function verifierAcces(requete, reponse, suite) {
    const auMoinsUnCodeConfigure = [...acceptes].some((role) => process.env[VARIABLES_PAR_ROLE[role]]);

    if (!auMoinsUnCodeConfigure) {
      const variables = [...acceptes].map((role) => VARIABLES_PAR_ROLE[role]).join(' ou ');
      console.error(`[auth] aucun code configuré (${variables}) : accès refusé sur ${requete.originalUrl}`);
      return reponse.status(500).json({ error: 'Configuration serveur incomplète' });
    }

    const code = extraireCode(requete);
    if (!code) {
      console.warn(`[auth] en-tête Authorization manquant ou mal formé sur ${requete.method} ${requete.originalUrl}`);
      return reponse.status(401).json({ error: 'Code requis' });
    }

    const roles = rolesDuCode(code);
    const autorises = roles.filter((role) => acceptes.has(role));

    if (autorises.length === 0) {
      // On ne dit jamais si le code est inconnu ou simplement insuffisant :
      // la distinction renseignerait un attaquant sur la validité du code.
      console.warn(`[auth] code refusé sur ${requete.method} ${requete.originalUrl}`);
      return reponse.status(401).json({ error: 'Code invalide ou droits insuffisants' });
    }

    requete.roles = roles;
    console.log(`[auth] accès accordé (${autorises.join(', ')}) sur ${requete.method} ${requete.originalUrl}`);
    return suite();
  };
}

/**
 * Conservé pour compatibilité avec le LOT 1 : équivaut à exigerRole('admin').
 * @deprecated utiliser exigerRole('admin')
 */
const verifierAdmin = exigerRole('admin');

module.exports = {
  exigerRole,
  rolesDuCode,
  extraireCode,
  verifierAdmin,
  ROLES_CONNUS,
  VARIABLES_PAR_ROLE,
};
