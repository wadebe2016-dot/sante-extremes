/**
 * Authentification par codes de rôle — LOT 7 « DeuxZero ».
 *
 * L'association ne gère pas de comptes nominatifs : chaque fonction du bureau a
 * son code, transmis en en-tête « Authorization: Bearer <code> ». Ce qui change
 * au LOT 7, c'est l'ENDROIT où ces codes vivent.
 *
 * AVANT — dans le .env du serveur :
 *   ADMIN_PASSWORD, TRESORIERS, SECRETAIRE_PASSWORD, CENSEUR_PASSWORD…
 * Un seul jeu de codes, édité à la main par l'éditeur. Tenable pour UNE
 * association ; impossible pour un produit vendu à des dizaines d'associations
 * que l'éditeur ne rencontre jamais.
 *
 * DEPUIS — dans la table « roles_codes » de la base de CHAQUE association,
 * uniquement sous forme hachée, et distribués par le président depuis son
 * téléphone (cf. src/services/roles.js).
 *
 * Trois propriétés à ne pas casser :
 *
 *   1. COMPATIBILITÉ DU RÔLE. « admin » devient « président ». Les appels
 *      exigerRole('admin') des lots précédents continuent de fonctionner, et
 *      « requete.roles » contient les DEUX noms pour un président : cinq
 *      contrôles existants testent encore « roles.includes('admin') ».
 *
 *   2. COMPATIBILITÉ DES CODES DISTRIBUÉS. Les codes du bureau de SDE001 sont
 *      dans les téléphones des intéressés. Le script de migration les reprend en
 *      base ; et si jamais il n'a pas tourné, le repli ci-dessous les accepte
 *      encore et les reprend au passage. Aucun membre du bureau ne doit être
 *      dérangé par ce lot.
 *
 *   3. LE PLAFOND D'ESSAIS S'APPLIQUE PAR ASSOCIATION. Les codes restent courts
 *      et devinables un par un : le limiteur est ce qui les rend acceptables. Il
 *      compte désormais par couple (association, adresse IP) — sans quoi une
 *      association bloquée bloquerait toutes les autres derrière le même nginx.
 */
'use strict';

const crypto = require('crypto');

const limiteur = require('./limiteur');
const roles = require('../services/roles');
const codes = require('../services/codes');

/**
 * Association dont les codes peuvent encore venir du .env.
 *
 * C'est « Santé des extrêmes », seule association existante avant ce lot. Le
 * repli est strictement borné à elle : sans cette borne, les codes du .env
 * ouvriraient N'IMPORTE QUELLE association, ce qui serait exactement la fuite
 * que tout le lot cherche à rendre impossible.
 */
const ASSOCIATION_HISTORIQUE = String(process.env.ASSOCIATION_HISTORIQUE || 'SDE001').toUpperCase();

/** Correspondance rôle → variable d'environnement, pour le seul repli historique. */
const VARIABLES_PAR_ROLE = Object.freeze({
  president: 'ADMIN_PASSWORD', // le rôle s'appelait « admin »
  tresorier: 'TRESORIER_PASSWORD', // repli sans nom (cf. TRESORIERS)
  secretaire: 'SECRETAIRE_PASSWORD',
  censeur: 'CENSEUR_PASSWORD',
  intendant: 'INTENDANT_PASSWORD',
  competitions: 'COMPETITIONS_PASSWORD',
});

/** Rôles acceptés par exigerRole, « admin » compris pour les lots antérieurs. */
const ROLES_CONNUS = Object.freeze([...roles.ROLES, 'admin']);

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
 * Conservée pour le seul repli historique. Les noms doivent correspondre
 * exactement à ceux de la table members — c'est sur cette égalité que reposent
 * les refus « sa propre cotisation ».
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
        console.warn('[auth] entrée TRESORIERS ignorée, format « Nom:code » attendu');
        return null;
      }
      return {
        nom: entree.slice(0, separateur).trim(),
        code: entree.slice(separateur + 1).trim(),
      };
    })
    .filter((tresorier) => tresorier && tresorier.nom && tresorier.code);
}

/** Noms des membres dont les sanctions relèvent du président seul. */
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
 * Comparaison insensible à la casse et aux espaces superflus : les noms sont
 * saisis à la main, et une majuscule d'écart ne doit pas laisser un trésorier
 * valider sa propre cotisation.
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
 * Liste de rôles exposée à l'appelant, pour un rôle donné.
 *
 * Un président reçoit « president » ET « admin » : le second est l'ancien nom, et
 * plusieurs contrôles du code — sanctions sur un membre protégé, pénalités —
 * testent encore « roles.includes('admin') ». Les faire tous basculer d'un coup
 * aurait été la façon la plus sûre d'ouvrir une brèche par étourderie.
 */
function rolesExposes(role) {
  return role === 'president' ? ['president', 'admin'] : [role];
}

/**
 * Reprend en base un code encore présent dans le .env.
 *
 * Appelée au premier usage d'un code historique, elle rend le repli à usage
 * unique : dès la première connexion, le code vit dans « roles_codes » et le
 * .env n'est plus consulté pour lui. C'est la migration des codes qui se fait
 * toute seule, même si le script n'a pas été joué.
 */
async function reprendreCodeHistorique(bd, { role, code, nomMembre }) {
  try {
    let membreId = null;
    if (nomMembre) {
      const membre = await bd.lireUne('SELECT id FROM members WHERE name = ? COLLATE NOCASE', [nomMembre]);
      membreId = membre ? membre.id : null;
      if (!membreId) {
        console.warn(`[auth] reprise du code ${role} : membre « ${nomMembre} » introuvable en base`);
      }
    }

    const empreinte = await codes.hacher(code);
    await bd.executer(
      `INSERT INTO roles_codes (role, membre_id, libelle, code_hash, temporaire, actif)
       VALUES (?, ?, ?, ?, 0, 1)`,
      [role, membreId, nomMembre || null, empreinte]
    );
    console.log(`[auth] code historique repris en base : ${role}${nomMembre ? ` — ${nomMembre}` : ''}`);
  } catch (erreur) {
    // Une reprise qui échoue ne doit pas refuser l'accès : le membre du bureau a
    // présenté un code valable, le repli continuera de l'accepter.
    console.error(`[auth] reprise du code ${role} impossible : ${erreur.message}`);
  }
}

/**
 * Repli historique : le code vient-il du .env de l'association d'origine ?
 *
 * @returns {Promise<object|null>} identification au même format que la base
 */
async function identifierParEnvironnement(bd, code, codeAssociation) {
  if (String(codeAssociation || '').toUpperCase() !== ASSOCIATION_HISTORIQUE) return null;

  for (const [role, variable] of Object.entries(VARIABLES_PAR_ROLE)) {
    const attendu = process.env[variable];
    // Un code vide ne doit jamais correspondre, sous peine d'ouvrir la porte.
    if (!attendu) continue;
    if (!comparerSecrets(code, attendu)) continue;

    await reprendreCodeHistorique(bd, { role, code, nomMembre: null });
    return { id: null, role, membre: null, temporaire: false, libelle: null, historique: true };
  }

  for (const tresorier of listeTresoriers()) {
    if (!comparerSecrets(code, tresorier.code)) continue;

    await reprendreCodeHistorique(bd, { role: 'tresorier', code, nomMembre: tresorier.nom });
    return {
      id: null,
      role: 'tresorier',
      membre: tresorier.nom,
      temporaire: false,
      libelle: tresorier.nom,
      historique: true,
    };
  }

  return null;
}

/**
 * Identifie un code dans une association.
 *
 * @param {object} bd connexion de l'association (requete.db)
 * @param {string} code code présenté
 * @param {string} [codeAssociation] code de l'association, pour le repli historique
 * @returns {Promise<{id: number|null, role: string, roles: string[], membre: string|null,
 *                    temporaire: boolean, expire_le: string|null, libelle: string|null}|null>}
 */
async function identifierCode(bd, code, codeAssociation) {
  if (!code || !bd) return null;

  const ligne = await roles.identifier(bd, code);
  if (ligne) {
    return {
      id: ligne.id,
      role: ligne.role,
      roles: rolesExposes(ligne.role),
      // Repli du nom sur le libellé : un code repris du .env porte le nom de son
      // titulaire dans « libelle » quand aucune fiche de membre ne correspond.
      // Sans ce repli, un trésorier historique perdrait son identité — et avec
      // elle le refus de valider sa propre cotisation (LOT 3 ter).
      membre: ligne.membre_nom || ligne.libelle || null,
      temporaire: ligne.temporaire === 1,
      expire_le: ligne.expire_le || null,
      libelle: ligne.libelle || ligne.membre_nom || null,
      historique: false,
    };
  }

  const repli = await identifierParEnvironnement(bd, code, codeAssociation);
  if (!repli) return null;
  return { ...repli, roles: rolesExposes(repli.role), expire_le: null };
}

/**
 * Fabrique un middleware de contrôle d'accès.
 *
 * @param {string[]} rolesAutorises rôles ouvrant l'accès
 * @param {object} options
 * @param {boolean} [options.temporaireAutorise] laisser passer un code temporaire
 * @param {boolean} [options.toutRole] accepter n'importe quel rôle actif
 */
function construireControle(rolesAutorises, options = {}) {
  const demandes = rolesAutorises.map((role) => roles.normaliserRole(role));
  const inconnus = rolesAutorises.filter((role) => !ROLES_CONNUS.includes(role));
  if (inconnus.length > 0) {
    // Erreur de programmation : elle doit tomber au démarrage, pas en production.
    throw new Error(`exigerRole : rôle inconnu « ${inconnus.join(', ')} »`);
  }

  // Le président ouvre toutes les routes : il n'a pas à être listé partout.
  const acceptes = new Set([...demandes, 'president']);

  return async function verifierAcces(requete, reponse, suite) {
    if (!requete.db) {
      // Le middleware d'association n'a pas tourné : jamais en production, mais
      // un routeur monté par erreur hors de la chaîne ne doit pas ouvrir l'accès.
      console.error(`[auth] aucune base résolue sur ${requete.method} ${requete.originalUrl}`);
      return reponse.status(500).json({ error: 'Configuration serveur incomplète' });
    }

    const codeAssociation = requete.association ? requete.association.code : null;
    // Le plafond d'essais compte par association : une association qui se fait
    // marteler ne doit pas bloquer les autres derrière le même nginx.
    const source = `${codeAssociation || 'sans'}|${limiteur.sourceDe(requete)}`;

    if (limiteur.estBloquee(source)) {
      return limiteur.repondreBloque(reponse, source);
    }

    const code = extraireCode(requete);
    if (!code) {
      console.warn(
        `[auth] en-tête Authorization manquant ou mal formé sur ${requete.method} ${requete.originalUrl}`
      );
      return reponse.status(401).json({ error: 'Code requis' });
    }

    let identite;
    try {
      identite = await identifierCode(requete.db, code, codeAssociation);
    } catch (erreur) {
      console.error(`[auth] identification impossible : ${erreur.message}`);
      return reponse.status(500).json({ error: 'Erreur interne du serveur' });
    }

    const autorise =
      identite && (options.toutRole || identite.roles.some((role) => acceptes.has(role)));

    if (!autorise) {
      // On ne dit jamais si le code est inconnu ou simplement insuffisant : la
      // distinction renseignerait un attaquant sur la validité du code.
      limiteur.enregistrerEchec(source, `rôle attendu : ${[...acceptes].join('|')}`);
      return reponse.status(401).json({ error: 'Code invalide ou droits insuffisants' });
    }

    // Un code temporaire ouvre UNE seule porte : le choix du code personnel. Tant
    // que ce choix n'est pas fait, aucun écran n'est accessible — c'est ce qui
    // garantit que le président ne connaît pas le code définitif de son
    // collaborateur, puisque le code qu'il a remis cesse d'exister.
    if (identite.temporaire && !options.temporaireAutorise) {
      console.warn(`[auth] code temporaire présenté sur ${requete.method} ${requete.originalUrl}`);
      return reponse.status(403).json({
        error: 'Choisissez votre code personnel avant d’accéder à l’application.',
        code: 'code_personnel_requis',
        role: identite.role,
        role_id: identite.id,
      });
    }

    limiteur.reinitialiser(source);
    if (identite.id) await roles.marquerUtilisation(requete.db, identite.id);

    requete.roles = identite.roles;
    requete.roleId = identite.id;
    requete.roleCourant = identite.role;
    requete.codeTemporaire = identite.temporaire;
    // Seul un trésorier nominatif interdit de traiter sa propre cotisation : un
    // code de trésorier sans titulaire ne permet aucun contrôle de ce genre.
    requete.tresorier = identite.role === 'tresorier' ? identite.membre : null;
    // Traçabilité : le nom du titulaire, à défaut le rôle.
    requete.agent = identite.membre || identite.libelle || identite.role;

    console.log(
      `[auth] accès accordé (${identite.role}${identite.membre ? ` — ${identite.membre}` : ''}) ` +
        `sur ${requete.method} ${requete.originalUrl} [${codeAssociation}]`
    );
    return suite();
  };
}

/**
 * Middleware exigeant l'un des rôles listés — le président étant toujours accepté.
 *
 *   routeur.post('/', exigerRole('tresorier'), gestionnaire)
 *
 * En cas de succès :
 *   requete.roles        rôles reconnus (« admin » accompagne « president »)
 *   requete.roleId       identifiant de la ligne roles_codes, ou null (repli .env)
 *   requete.tresorier    nom du trésorier, ou null
 *   requete.agent        nom à inscrire dans les colonnes de traçabilité
 *
 * @param {...string} rolesAutorises rôles ouvrant l'accès à la route
 * @returns {Function} middleware Express
 */
function exigerRole(...rolesAutorises) {
  return construireControle(rolesAutorises);
}

/**
 * Middleware acceptant tout titulaire de rôle actif, CODE TEMPORAIRE COMPRIS.
 *
 * Réservé à l'unique route accessible avec un code temporaire : le choix du code
 * personnel. Partout ailleurs, un code temporaire est refusé en 403.
 */
function exigerTitulaireMemeTemporaire() {
  return construireControle([], { temporaireAutorise: true, toutRole: true });
}

/** Middleware acceptant tout titulaire de rôle actif, code définitif exigé. */
function exigerTitulaire() {
  return construireControle([], { toutRole: true });
}

/**
 * Conservé pour compatibilité avec le LOT 1 : équivaut à exigerRole('president').
 * @deprecated utiliser exigerRole('president')
 */
const verifierAdmin = exigerRole('president');

module.exports = {
  exigerRole,
  exigerTitulaire,
  exigerTitulaireMemeTemporaire,
  identifierCode,
  extraireCode,
  listeTresoriers,
  membresProteges,
  estMembreProtege,
  memeMembre,
  rolesExposes,
  verifierAdmin,
  ROLES_CONNUS,
  VARIABLES_PAR_ROLE,
  ASSOCIATION_HISTORIQUE,
};
