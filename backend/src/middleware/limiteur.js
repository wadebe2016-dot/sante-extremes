/**
 * Limiteur d'essais de code — Santé des extrêmes (LOT 3 bis).
 *
 * Les codes de rôle sont passés à six chiffres : un million de combinaisons,
 * qu'un script épuise en quelques heures s'il peut essayer sans frein. Le
 * plafond n'est donc plus un confort, c'est la condition qui rend ces codes
 * courts acceptables.
 *
 * Cinq échecs par adresse IP sur quinze minutes ; au-delà, 429 jusqu'à
 * expiration de la fenêtre. Un succès remet le compteur à zéro : l'utilisateur
 * légitime qui se trompe deux fois n'est jamais pénalisé.
 *
 * Compteur en mémoire, remis à zéro au redémarrage du service — suffisant pour
 * une instance unique, qui est le déploiement retenu.
 */
'use strict';

const FENETRE_MS = 15 * 60 * 1000;
const ECHECS_MAX = 5;

const tentatives = new Map();

/** Supprime les compteurs dont la fenêtre est écoulée. */
function purger(maintenant) {
  for (const [source, suivi] of tentatives) {
    if (maintenant - suivi.debut > FENETRE_MS) tentatives.delete(source);
  }
}

/** Identifie l'appelant. Derrière nginx, trust proxy fournit l'IP réelle. */
function sourceDe(requete) {
  return requete.ip || requete.connection?.remoteAddress || 'inconnue';
}

/**
 * La source a-t-elle épuisé son quota d'échecs ?
 * @returns {boolean}
 */
function estBloquee(source) {
  const maintenant = Date.now();
  purger(maintenant);

  const suivi = tentatives.get(source);
  if (!suivi) return false;
  if (maintenant - suivi.debut > FENETRE_MS) {
    tentatives.delete(source);
    return false;
  }

  return suivi.nombre >= ECHECS_MAX;
}

/**
 * Comptabilise et journalise un échec.
 *
 * Le journal porte le rôle visé, la source et l'horodatage : c'est la seule
 * trace permettant de constater une attaque après coup. Le code essayé n'y
 * figure JAMAIS — un journal n'est pas un endroit où écrire des secrets, même
 * faux, car un utilisateur légitime s'y trompe de touche.
 */
function enregistrerEchec(source, contexte = '') {
  const maintenant = Date.now();
  purger(maintenant);

  const suivi = tentatives.get(source);
  if (!suivi || maintenant - suivi.debut > FENETRE_MS) {
    tentatives.set(source, { debut: maintenant, nombre: 1 });
  } else {
    suivi.nombre += 1;
  }

  const nombre = tentatives.get(source).nombre;
  console.warn(
    `[securite] code refusé — ${contexte || 'rôle non précisé'} — source ${source} — ` +
      `${new Date(maintenant).toISOString()} — échec ${nombre}/${ECHECS_MAX}`
  );

  if (nombre >= ECHECS_MAX) {
    console.warn(`[securite] source ${source} bloquée pour ${FENETRE_MS / 60000} minutes`);
  }
}

/** Un code accepté efface l'ardoise de la source. */
function reinitialiser(source) {
  tentatives.delete(source);
}

/** Secondes restantes avant déblocage, pour l'en-tête Retry-After. */
function secondesRestantes(source) {
  const suivi = tentatives.get(source);
  if (!suivi) return 0;
  return Math.max(1, Math.ceil((FENETRE_MS - (Date.now() - suivi.debut)) / 1000));
}

/** Réponse 429 commune. */
function repondreBloque(reponse, source) {
  reponse.set('Retry-After', String(secondesRestantes(source)));
  return reponse
    .status(429)
    .json({ error: 'Trop de codes erronés. Réessayez dans quelques minutes.' });
}

module.exports = {
  sourceDe,
  estBloquee,
  enregistrerEchec,
  reinitialiser,
  secondesRestantes,
  repondreBloque,
  FENETRE_MS,
  ECHECS_MAX,
};
