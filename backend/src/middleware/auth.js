/**
 * Authentification par codes de rôle — Santé des extrêmes.
 *
 * L'association ne gère pas de comptes nominatifs : chaque fonction partage un
 * code, transmis en en-tête « Authorization: Bearer <code> ». Les codes ne sont
 * jamais écrits en dur, ils viennent de l'environnement :
 *
 *   ADMIN_PASSWORD         admin        — tous les droits
 *   TRESORIERS             tresorier    — liste « Nom:code » (LOT 3 ter)
 *   SECRETAIRE_PASSWORD    secretaire   — membres, documents, demandes
 *   CENSEUR_PASSWORD       censeur      — sanctions
 *   INTENDANT_PASSWORD     intendant    — demandes de dépense
 *   COMPETITIONS_PASSWORD  competitions — demandes liées aux compétitions
 *
 * LOT 3 ter — séparation des pouvoirs : les trésoriers ont désormais un code
 * NOMINATIF, ce qui permet de savoir qui a validé quoi et d'interdire à un
 * trésorier de traiter sa propre cotisation ou de se payer lui-même. Un contrôle
 * anonyme ne pourrait rien empêcher de tel.
 *
 * Le code admin ouvre toutes les routes : il n'a pas besoin d'être listé dans
 * les appels à exigerRole().
 */
'use strict';

const crypto = require('crypto');
const limiteur = require('./limiteur');

/** Correspondance rôle → variable d'environnement portant son code. */
const VARIABLES_PAR_ROLE = Object.freeze({
  admin: 'ADMIN_PASSWORD',
  tresorier: 'TRESORIER_PASSWORD', // repli historique, sans nom (cf. TRESORIERS)
  secretaire: 'SECRETAIRE_PASSWORD',
  censeur: 'CENSEUR_PASSWORD',
  intendant: 'INTENDANT_PASSWORD',
  competitions: 'COMPETITIONS_PASSWORD',
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
 * Analyse la variable TRESORIERS : « Nom du membre:code,Autre nom:code ».
 *
 * Les noms doivent correspondre exactement à ceux de la table members — c'est
 * sur cette égalité que reposent les refus « sa propre cotisation ».
 *
 * @returns {Array<{nom: string, code: string}>}
 */
function listeTresoriers() {
  const brut = process.env.TRESORIERS || '';
  if (!brut.trim()) return [];

  return brut
    .split(',')
    .map((entree) => entree.trim())
    .filter(Boolean)
    .map((entree) => {
      // Le nom peut contenir des espaces ; le code est après le DERNIER deux-points.
      const separateur = entree.lastIndexOf(':');
      if (separateur <= 0) {
        console.warn(`[auth] entrée TRESORIERS ignorée, format « Nom:code » attendu`);
        return null;
      }
      return {
        nom: entree.slice(0, separateur).trim(),
        code: entree.slice(separateur + 1).trim(),
      };
    })
    .filter((tresorier) => tresorier && tresorier.nom && tresorier.code);
}

/** Noms des membres dont les sanctions relèvent de l'admin seul. */
function membresProteges() {
  return (process.env.CENSEUR_MEMBRES || '')
    .split(',')
    .map((nom) => nom.trim())
    .filter(Boolean);
}

/**
 * Un membre est-il protégé contre les sanctions du censeur ?
 *
 * Comparaison insensible à la casse et aux espaces superflus : la liste est
 * saisie à la main dans un .env, une majuscule d'écart ne doit pas ouvrir une
 * brèche silencieuse.
 */
function estMembreProtege(nom) {
  const cible = String(nom || '').trim().toLowerCase();
  if (!cible) return false;
  return membresProteges().some((protege) => protege.toLowerCase() === cible);
}

/**
 * Deux noms désignent-ils le même membre ?
 *
 * Comparaison insensible à la casse et aux espaces superflus : les noms de
 * TRESORIERS sont saisis à la main dans un .env, et une majuscule d'écart ne
 * doit pas laisser un trésorier valider sa propre cotisation.
 */
function memeMembre(a, b) {
  const gauche = String(a || '').trim().toLowerCase();
  const droite = String(b || '').trim().toLowerCase();
  return gauche !== '' && gauche === droite;
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
 * Identifie un code : rôles obtenus, et nom du trésorier le cas échéant.
 *
 * Un même code peut être partagé par plusieurs fonctions : on renvoie donc une
 * liste. Un rôle dont la variable d'environnement n'est pas définie ne peut
 * jamais correspondre — sans quoi un code vide ouvrirait la porte.
 *
 * @param {string} code code reçu
 * @returns {{roles: string[], membre: string|null}}
 */
function identifierCode(code) {
  if (!code) return { roles: [], membre: null };

  const roles = [];
  let membre = null;

  for (const [role, variable] of Object.entries(VARIABLES_PAR_ROLE)) {
    const attendu = process.env[variable];
    if (!attendu) continue;
    if (comparerSecrets(code, attendu)) roles.push(role);
  }

  // Trésoriers nominatifs : prioritaires sur le repli anonyme.
  for (const tresorier of listeTresoriers()) {
    if (comparerSecrets(code, tresorier.code)) {
      if (!roles.includes('tresorier')) roles.push('tresorier');
      membre = tresorier.nom;
      break;
    }
  }

  return { roles, membre };
}

/**
 * Rôles auxquels correspond un code.
 * @returns {string[]} rôles correspondants, éventuellement vide
 */
function rolesDuCode(code) {
  return identifierCode(code).roles;
}

/**
 * Middleware exigeant l'un des rôles listés — le rôle admin étant toujours
 * accepté en plus.
 *
 *   routeur.post('/', exigerRole('tresorier'), gestionnaire)
 *
 * En cas de succès :
 *   requete.roles     rôles reconnus pour ce code
 *   requete.tresorier nom du trésorier, ou null (admin, code anonyme, autre rôle)
 *   requete.agent     nom à inscrire dans les colonnes de traçabilité
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
    const auMoinsUnCodeConfigure = [...acceptes].some((role) => {
      if (role === 'tresorier') return process.env.TRESORIERS || process.env.TRESORIER_PASSWORD;
      return process.env[VARIABLES_PAR_ROLE[role]];
    });

    if (!auMoinsUnCodeConfigure) {
      const variables = [...acceptes]
        .map((role) => (role === 'tresorier' ? 'TRESORIERS' : VARIABLES_PAR_ROLE[role]))
        .join(' ou ');
      console.error(`[auth] aucun code configuré (${variables}) : accès refusé sur ${requete.originalUrl}`);
      return reponse.status(500).json({ error: 'Configuration serveur incomplète' });
    }

    const source = limiteur.sourceDe(requete);

    // Les codes font six chiffres : le plafond d'essais s'applique ici aussi,
    // sans quoi les routes protégées deviendraient l'oracle que /auth/verify
    // n'est plus.
    if (limiteur.estBloquee(source)) {
      return limiteur.repondreBloque(reponse, source);
    }

    const code = extraireCode(requete);
    if (!code) {
      console.warn(`[auth] en-tête Authorization manquant ou mal formé sur ${requete.method} ${requete.originalUrl}`);
      return reponse.status(401).json({ error: 'Code requis' });
    }

    const { roles, membre } = identifierCode(code);
    const autorises = roles.filter((role) => acceptes.has(role));

    if (autorises.length === 0) {
      // On ne dit jamais si le code est inconnu ou simplement insuffisant :
      // la distinction renseignerait un attaquant sur la validité du code.
      limiteur.enregistrerEchec(source, `rôle attendu : ${[...acceptes].join('|')}`);
      return reponse.status(401).json({ error: 'Code invalide ou droits insuffisants' });
    }

    limiteur.reinitialiser(source);
    requete.roles = roles;
    requete.tresorier = membre;
    // Traçabilité : le nom du trésorier, ou « admin » quand il agit lui-même.
    requete.agent = membre || (roles.includes('admin') ? 'admin' : autorises[0]);

    console.log(
      `[auth] accès accordé (${autorises.join(', ')}${membre ? ` — ${membre}` : ''}) ` +
        `sur ${requete.method} ${requete.originalUrl}`
    );
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
  identifierCode,
  rolesDuCode,
  extraireCode,
  listeTresoriers,
  membresProteges,
  estMembreProtege,
  memeMembre,
  verifierAdmin,
  ROLES_CONNUS,
  VARIABLES_PAR_ROLE,
};
