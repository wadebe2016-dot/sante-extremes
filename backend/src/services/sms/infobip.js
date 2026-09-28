/**
 * Routeur SMS Infobip — ACTIF PAR DÉFAUT, LOT 7 « DeuxZero ».
 *
 * Variables d'environnement :
 *   INFOBIP_BASE_URL    ex. https://xxxxx.api.infobip.com (sans barre finale)
 *   INFOBIP_API_KEY     clé d'API, jamais en dur dans le code
 *   INFOBIP_EXPEDITEUR  nom ou numéro affiché à la réception (ex. DeuxZero)
 *
 * Le retour est le contrat commun : { succes, identifiant, erreur }. Le
 * « messageId » d'Infobip est conservé — c'est la seule façon de retrouver un
 * envoi dans leur console quand un membre affirme n'avoir rien reçu.
 */
'use strict';

const { poster } = require('./transport');

/** Retire la barre finale : l'URL est saisie à la main dans un .env. */
function baseUrl() {
  return String(process.env.INFOBIP_BASE_URL || '').trim().replace(/\/+$/, '');
}

/**
 * Configuration manquante : on le dit clairement, une fois, sans planter.
 * @returns {string|null} message d'erreur, ou null si tout est là
 */
function configurationIncomplete() {
  const manquantes = ['INFOBIP_BASE_URL', 'INFOBIP_API_KEY', 'INFOBIP_EXPEDITEUR'].filter(
    (variable) => !String(process.env[variable] || '').trim()
  );
  if (manquantes.length === 0) return null;
  return `Configuration Infobip incomplète : ${manquantes.join(', ')}`;
}

/**
 * Identifiant de message porté par la réponse d'Infobip.
 *
 * La forme attendue est { messages: [ { messageId, status } ] }. Une réponse
 * d'un autre format ne doit pas faire échouer un envoi déjà accepté : on rend
 * null et l'envoi reste un succès.
 */
function identifiantDe(texte) {
  try {
    const analyse = JSON.parse(texte);
    const premier = Array.isArray(analyse.messages) ? analyse.messages[0] : null;
    return premier && premier.messageId ? String(premier.messageId) : null;
  } catch (erreur) {
    console.warn(`[sms:infobip] réponse non JSON, identifiant non retenu : ${erreur.message}`);
    return null;
  }
}

/** Message d'erreur lisible extrait d'un corps de refus Infobip. */
function erreurDe(texte, repli) {
  try {
    const analyse = JSON.parse(texte);
    const description =
      analyse?.requestError?.serviceException?.text ||
      analyse?.messages?.[0]?.status?.description ||
      null;
    return description ? `${repli} — ${description}` : repli;
  } catch (erreur) {
    return repli;
  }
}

/**
 * Envoie un SMS via Infobip.
 * @returns {Promise<{succes: boolean, identifiant: string|null, erreur: string|null}>}
 */
async function envoyer({ destinataire, message }) {
  const refus = configurationIncomplete();
  if (refus) {
    console.error(`[sms:infobip] ${refus}`);
    return { succes: false, identifiant: null, erreur: refus };
  }

  const resultat = await poster({
    url: `${baseUrl()}/sms/2/text/advanced`,
    entetes: {
      Authorization: `App ${String(process.env.INFOBIP_API_KEY).trim()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    corps: JSON.stringify({
      messages: [
        {
          destinations: [{ to: destinataire }],
          from: String(process.env.INFOBIP_EXPEDITEUR).trim(),
          text: message,
        },
      ],
    }),
    etiquette: 'infobip',
  });

  if (!resultat.ok) {
    return {
      succes: false,
      identifiant: null,
      erreur: erreurDe(resultat.texte, resultat.erreur || 'Envoi refusé par Infobip'),
    };
  }

  return { succes: true, identifiant: identifiantDe(resultat.texte), erreur: null };
}

module.exports = { envoyer, configurationIncomplete };
