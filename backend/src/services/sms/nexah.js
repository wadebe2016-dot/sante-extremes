/**
 * Routeur SMS Nexah — PRÊT, NON ACTIVÉ, LOT 7 « DeuxZero ».
 *
 * Nexah est un agrégateur camerounais : ses SMS partent des réseaux locaux et
 * coûtent sensiblement moins cher qu'un routeur international. L'implémentation
 * est livrée complète et éprouvée par les tests, mais elle n'est pas active :
 * la bascule est une décision de coût, pas de code.
 *
 * Variables d'environnement :
 *   NEXAH_BASE_URL       ex. https://smsvas.com/bulk/public/index.php/api/v1
 *   NEXAH_UTILISATEUR    identifiant du compte
 *   NEXAH_MOT_DE_PASSE   mot de passe du compte
 *   NEXAH_EXPEDITEUR     senderid validé auprès de Nexah
 *
 * L'API Nexah attend un formulaire (user, password, senderid, mobiles, sms) et
 * répond un JSON dont la forme varie selon la version du compte. La lecture est
 * donc défensive : responses[0].messageid, puis messageid, puis id.
 *
 * BASCULE — trois lignes de .env suffisent, cf. docs/sms.md :
 *   SMS_FOURNISSEUR=nexah
 *   NEXAH_UTILISATEUR=...  NEXAH_MOT_DE_PASSE=...  NEXAH_EXPEDITEUR=DeuxZero
 * puis « sudo systemctl restart sde-api ». Aucun autre fichier n'est touché.
 */
'use strict';

const { poster } = require('./transport');

/** Retire la barre finale : l'URL est saisie à la main dans un .env. */
function baseUrl() {
  return String(process.env.NEXAH_BASE_URL || '').trim().replace(/\/+$/, '');
}

/**
 * Configuration manquante : message explicite, aucun plantage.
 * @returns {string|null}
 */
function configurationIncomplete() {
  const manquantes = [
    'NEXAH_BASE_URL',
    'NEXAH_UTILISATEUR',
    'NEXAH_MOT_DE_PASSE',
    'NEXAH_EXPEDITEUR',
  ].filter((variable) => !String(process.env[variable] || '').trim());
  if (manquantes.length === 0) return null;
  return `Configuration Nexah incomplète : ${manquantes.join(', ')}`;
}

/**
 * Nexah attend les numéros sans le « + » de l'indicatif international.
 * @returns {string} numéro au format 237XXXXXXXXX
 */
function numeroNexah(destinataire) {
  return String(destinataire || '').replace(/^\+/, '');
}

/** Identifiant de message, cherché dans les trois formes connues de réponse. */
function identifiantDe(texte) {
  try {
    const analyse = JSON.parse(texte);
    const premier = Array.isArray(analyse.responses) ? analyse.responses[0] : null;
    const identifiant =
      (premier && (premier.messageid || premier.messageId || premier.id)) ||
      analyse.messageid ||
      analyse.id ||
      null;
    return identifiant ? String(identifiant) : null;
  } catch (erreur) {
    console.warn(`[sms:nexah] réponse non JSON, identifiant non retenu : ${erreur.message}`);
    return null;
  }
}

/**
 * Nexah répond parfois 200 en signalant un refus dans le corps.
 * @returns {string|null} message de refus, ou null si l'envoi est accepté
 */
function refusDansLeCorps(texte) {
  try {
    const analyse = JSON.parse(texte);
    const premier = Array.isArray(analyse.responses) ? analyse.responses[0] : null;
    const etat = String((premier && (premier.status || premier.statut)) || analyse.status || '').toLowerCase();
    if (etat && !['success', 'ok', 'sent', 'queued', '0'].includes(etat)) {
      return `Nexah a refusé l'envoi (${etat})`;
    }
    if (analyse.error) return `Nexah a refusé l'envoi (${analyse.error})`;
    return null;
  } catch (erreur) {
    // Corps illisible sur un 200 : on considère l'envoi accepté, le routeur
    // ayant répondu favorablement au niveau HTTP.
    return null;
  }
}

/**
 * Envoie un SMS via Nexah. Même signature et même retour qu'Infobip.
 * @returns {Promise<{succes: boolean, identifiant: string|null, erreur: string|null}>}
 */
async function envoyer({ destinataire, message }) {
  const refus = configurationIncomplete();
  if (refus) {
    console.error(`[sms:nexah] ${refus}`);
    return { succes: false, identifiant: null, erreur: refus };
  }

  const formulaire = new URLSearchParams({
    user: String(process.env.NEXAH_UTILISATEUR).trim(),
    password: String(process.env.NEXAH_MOT_DE_PASSE),
    senderid: String(process.env.NEXAH_EXPEDITEUR).trim(),
    mobiles: numeroNexah(destinataire),
    sms: message,
  });

  const resultat = await poster({
    url: `${baseUrl()}/sendsms`,
    entetes: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    corps: formulaire.toString(),
    etiquette: 'nexah',
  });

  if (!resultat.ok) {
    return {
      succes: false,
      identifiant: null,
      erreur: resultat.erreur || 'Envoi refusé par Nexah',
    };
  }

  const refusCorps = refusDansLeCorps(resultat.texte);
  if (refusCorps) {
    console.error(`[sms:nexah] ${refusCorps}`);
    return { succes: false, identifiant: null, erreur: refusCorps };
  }

  return { succes: true, identifiant: identifiantDe(resultat.texte), erreur: null };
}

module.exports = { envoyer, configurationIncomplete, numeroNexah };
