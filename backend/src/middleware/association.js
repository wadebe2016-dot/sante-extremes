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
 * Toute requête porte donc l'en-tête « X-Association: <CODE> », à quelques
 * exceptions près, listées et justifiées dans ROUTES_SANS_ENTETE.
 *
 * UNE RÉSERVE, TRANSITOIRE, À LIRE AVANT DE SE FIER À CE QUI PRÉCÈDE : quand la
 * variable d'environnement ASSOCIATION_PAR_DEFAUT est renseignée, une requête
 * SANS en-tête est résolue vers cette association au lieu d'être refusée. Il
 * existe donc, sur une instance ainsi configurée, une base « par défaut ».
 *
 * Ce n'est pas un confort mais un correctif d'urgence : les applications déjà
 * installées chez les membres de l'association historique ont été écrites avant
 * ce lot et n'envoient pas l'en-tête. Sans ce repli, elles reçoivent 400 sur
 * toutes les routes métier — l'application est hors service pour tout le monde,
 * et trente-neuf téléphones ne se mettent pas à jour en une soirée.
 *
 * Le repli est volontairement étroit :
 *   · il ne s'applique QUE si l'en-tête est ABSENT. Un en-tête présent mais mal
 *     formé reste refusé en 400 : c'est un défaut d'application, pas un client
 *     ancien, et le masquer le rendrait introuvable ;
 *   · la variable n'est JAMAIS posée par défaut et ne figure pas dans
 *     .env.example : une installation neuve est stricte ;
 *   · chaque usage laisse la trace « repli vers <CODE> (en-tête absent) » dans
 *     les journaux. C'est elle qui dit quand le dispositif peut disparaître :
 *     plus aucune ligne de ce genre, plus besoin de la variable.
 *
 * Conditions de suppression et procédure : docs/multi-associations.md.
 */
'use strict';

const annuaire = require('../bd/annuaire');
const locataires = require('../bd/locataires');
const parametres = require('../services/parametres');

/**
 * Routes accessibles sans en-tête d'association, et pourquoi.
 *
 *   GET  /health                          supervision : nginx et systemd
 *   GET  /api/health                      interrogent le service, pas une
 *                                         association. LES DEUX CHEMINS sont
 *                                         dispensés : les scripts de déploiement
 *                                         sondent « /api/health », mais la
 *                                         supervision appelle « /health », et ce
 *                                         second chemin recevait 400 ;
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
 * Toute autre route sans en-tête est refusée en 400 — SAUF si
 * ASSOCIATION_PAR_DEFAUT est renseignée, cf. l'en-tête de ce fichier. Sans cette
 * variable, il n'existe aucune base « par défaut », et c'est ce qui interdit
 * qu'un oubli d'en-tête aille lire SDE001.
 */
const ROUTES_SANS_ENTETE = Object.freeze([
  { methode: 'GET', chemin: '/health' },
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
 * Association de repli pour les applications antérieures au LOT 7.
 *
 * Lue à CHAQUE requête, et non au chargement du module : l'exploitant doit
 * pouvoir poser la variable puis redémarrer sans que le comportement dépende de
 * l'ordre des « require », et les tests doivent pouvoir la basculer.
 *
 * Une valeur mal formée est traitée comme une absence — mieux vaut refuser
 * franchement en 400 que résoudre vers un code fantaisiste — et le dit, parce
 * qu'une variable posée de travers pendant une panne se diagnostique mal.
 *
 * @returns {string} code normalisé, ou chaîne vide si aucun repli n'est configuré
 */
function associationParDefaut() {
  const brut = process.env.ASSOCIATION_PAR_DEFAUT;
  if (brut === undefined || brut === null || String(brut).trim() === '') return '';

  const code = annuaire.normaliserCode(brut);
  if (!code) {
    console.error(
      `[association] ASSOCIATION_PAR_DEFAUT « ${brut} » n'est pas un code valide ` +
        '(six lettres ou chiffres) : le repli est inactif'
    );
    return '';
  }
  return code;
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
 *   400  en-tête mal formé, ou absent sans repli configuré
 *   404  code inconnu de l'annuaire
 *   403  association suspendue
 *   503  base illisible (disque plein, fichier corrompu)
 *
 * L'ABSENCE et la MALFORMATION de l'en-tête sont traitées séparément, et cette
 * distinction porte tout le correctif d'urgence : une application antérieure au
 * LOT 7 n'envoie RIEN, tandis qu'un en-tête présent mais illisible trahit un
 * défaut d'application. Le premier cas mérite un repli, le second un refus.
 */
function resoudreAssociation(requete, reponse, suite) {
  if (dispensee(requete)) return suite();

  const entete = requete.headers['x-association'];
  const absent = entete === undefined || entete === null || String(entete).trim() === '';
  let code = annuaire.normaliserCode(entete);

  // En-tête PRÉSENT mais illisible : refus, toujours, et même quand un repli est
  // configuré. Le masquer rendrait le défaut introuvable, et un client qui envoie
  // un en-tête sait en envoyer un bon.
  if (!absent && !code) {
    console.warn(
      `[association] en-tête X-Association mal formé sur ${requete.method} ${requete.originalUrl}`
    );
    return reponse.status(400).json({
      error: "Code d'association mal formé : six lettres ou chiffres attendus.",
      code: 'association_requise',
    });
  }

  if (absent) {
    const repli = associationParDefaut();

    if (!repli) {
      console.warn(
        `[association] en-tête X-Association absent sur ${requete.method} ${requete.originalUrl}`
      );
      return reponse.status(400).json({
        error: "Association non précisée. Renseignez l'en-tête X-Association.",
        code: 'association_requise',
      });
    }

    // Cette ligne est le compteur du dispositif transitoire : tant qu'elle
    // apparaît, des applications antérieures au LOT 7 sont encore en service.
    console.warn(
      `[association] repli vers ${repli} (en-tête absent) sur ${requete.method} ${requete.originalUrl}`
    );
    code = repli;
    requete.associationParRepli = true;
  }

  return annuaire
    .trouverParCode(code)
    .then(async (association) => {
      if (!association) {
        // Le repli pointe sur une association absente de l'annuaire : c'est une
        // erreur de configuration, pas une saisie fautive d'un membre, et elle
        // laisserait l'application hors service en répondant 404 partout.
        if (requete.associationParRepli) {
          console.error(
            `[association] ASSOCIATION_PAR_DEFAUT « ${code} » est inconnue de l'annuaire : ` +
              'le repli ne peut pas aboutir'
          );
        } else {
          console.warn(`[association] code inconnu : ${code}`);
        }
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

module.exports = {
  resoudreAssociation,
  resoudreDepuisCorps,
  ouvrirPour,
  associationParDefaut,
  ROUTES_SANS_ENTETE,
};
