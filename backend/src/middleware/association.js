/**
 * Résolution du locataire — LOT 7 « DeuxZero ».
 *
 * C'est la pièce qui rend le produit multi-associations, et c'est la seule dont
 * une défaillance serait grave : deux associations qui verraient les cotisations
 * l'une de l'autre, c'est le produit mort.
 *
 * La garantie ne repose pas sur un filtre SQL — un « WHERE association_id = ? »
 * oublié dans une requête sur cinquante suffirait. Elle repose sur le FICHIER :
 * chaque association a sa base SQLite, et « requete.db » est ouverte sur ce
 * fichier-là. Une requête fautive ne peut pas lire des lignes qui ne sont pas
 * dans le fichier qu'elle interroge.
 *
 * Toute requête porte donc l'en-tête « X-Association: <CODE> », à quatre
 * exceptions près, listées et justifiées dans ROUTES_SANS_ENTETE.
 */
'use strict';

const annuaire = require('../bd/annuaire');
const locataires = require('../bd/locataires');
const parametres = require('../services/parametres');

/**
 * Routes accessibles sans en-tête d'association, et pourquoi.
 *
 *   GET  /api/health                      supervision : nginx et systemd
 *                                         interrogent le service, pas une
 *                                         association ;
 *   POST /api/associations                création : le code n'existe pas encore ;
 *   POST /api/associations/verifier-code  un membre saisit un code pour savoir à
 *                                         quelle association il appartient ;
 *   POST /api/reinitialisation/demander   celui qui a perdu son code n'a plus
 *   POST /api/reinitialisation/confirmer  d'application configurée : il saisit
 *   POST /api/reinitialisation/president  le code d'association à la main, dans
 *                                         le CORPS de la requête, et ces trois
 *                                         routes le résolvent elles-mêmes.
 *
 * Les deux AUTRES routes de réinitialisation — le contre-seing et son état — ne
 * sont pas dispensées : celui qui contresigne a toujours son code et son
 * application configurée. Elles passent par l'en-tête comme tout le reste.
 *
 * Toute autre route sans en-tête est refusée en 400. Il n'y a pas de base « par
 * défaut » : c'est ce qui interdit qu'un oubli d'en-tête aille lire SDE001.
 */
const ROUTES_SANS_ENTETE = Object.freeze([
  { methode: 'GET', chemin: '/api/health' },
  { methode: 'POST', chemin: '/api/associations' },
  { methode: 'POST', chemin: '/api/associations/verifier-code' },
  { methode: 'POST', chemin: '/api/reinitialisation/demander' },
  { methode: 'POST', chemin: '/api/reinitialisation/confirmer' },
  { methode: 'POST', chemin: '/api/reinitialisation/president' },
  // L'espace de l'éditeur ne parle d'aucune association en particulier : il
  // agrège la consommation SMS de toutes. Il a sa propre protection, distincte
  // des codes de rôle (ADMIN_PRODUIT_CODE).
  { methode: '*', prefixe: '/api/admin-produit' },
]);

/** Cette requête est-elle dispensée de l'en-tête ? */
function dispensee(requete) {
  const chemin = requete.path.replace(/\/+$/, '') || '/';
  return ROUTES_SANS_ENTETE.some((regle) => {
    if (regle.methode !== '*' && regle.methode !== requete.method) return false;
    if (regle.prefixe) return chemin === regle.prefixe || chemin.startsWith(`${regle.prefixe}/`);
    return chemin === regle.chemin;
  });
}

/**
 * Ouvre la base d'une association et charge ses paramètres.
 *
 * Partagé avec les routes de réinitialisation, qui lisent le code dans le corps
 * de la requête et non dans l'en-tête.
 *
 * @param {object} association ligne de l'annuaire
 * @returns {Promise<object>} connexion prête à l'emploi
 */
async function ouvrirPour(association) {
  const bd = await locataires.obtenirBase(association);
  await parametres.charger(bd);
  return bd;
}

/**
 * Middleware de résolution : pose « requete.db » et « requete.association ».
 *
 * Les codes de retour sont distincts à dessein — c'est un diagnostic destiné à
 * l'application, pas à un attaquant, et un code d'association n'est pas un
 * secret : il se dicte au téléphone entre membres.
 *
 *   400  en-tête absent ou mal formé
 *   404  code inconnu de l'annuaire
 *   403  association suspendue
 *   503  base illisible (disque plein, fichier corrompu)
 */
function resoudreAssociation(requete, reponse, suite) {
  if (dispensee(requete)) return suite();

  const entete = requete.headers['x-association'];
  const code = annuaire.normaliserCode(entete);

  if (!code) {
    console.warn(
      `[association] en-tête X-Association ${entete ? 'mal formé' : 'absent'} sur ` +
        `${requete.method} ${requete.originalUrl}`
    );
    return reponse.status(400).json({
      error: "Association non précisée. Renseignez l'en-tête X-Association.",
      code: 'association_requise',
    });
  }

  return annuaire
    .trouverParCode(code)
    .then(async (association) => {
      if (!association) {
        console.warn(`[association] code inconnu : ${code}`);
        return reponse.status(404).json({
          error: 'Association inconnue. Vérifiez le code à six caractères.',
          code: 'association_inconnue',
        });
      }

      if (association.statut === 'suspendue') {
        console.warn(`[association] accès refusé, association suspendue : ${code}`);
        return reponse.status(403).json({
          error: 'Cette association est suspendue.',
          code: 'association_suspendue',
        });
      }

      requete.db = await ouvrirPour(association);
      requete.association = association;
      return suite();
    })
    .catch((erreur) => {
      console.error(`[association] résolution impossible pour ${code} : ${erreur.message}`);
      return reponse.status(503).json({
        error: 'Données de l’association momentanément indisponibles.',
        code: 'association_indisponible',
      });
    });
}

/**
 * Résout une association depuis le CORPS de la requête (« code_association »).
 *
 * Réservé aux routes de réinitialisation : leur appelant a perdu son code de
 * rôle, il n'a plus d'application configurée, il saisit tout à la main.
 *
 * Ne renvoie jamais 404 : dire « ce code n'existe pas » à cet endroit précis
 * transformerait la route en énumérateur d'associations. Les refus sont donc
 * remontés à l'appelant, qui répond de façon neutre.
 *
 * @returns {Promise<{association: object, bd: object}|{refus: string}>}
 */
async function resoudreDepuisCorps(codeAssociation) {
  const code = annuaire.normaliserCode(codeAssociation);
  if (!code) return { refus: 'code_invalide' };

  const association = await annuaire.trouverParCode(code);
  if (!association) return { refus: 'association_inconnue' };
  if (association.statut === 'suspendue') return { refus: 'association_suspendue' };

  const bd = await ouvrirPour(association);
  return { association, bd };
}

module.exports = { resoudreAssociation, resoudreDepuisCorps, ouvrirPour, ROUTES_SANS_ENTETE };
