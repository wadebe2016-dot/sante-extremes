/**
 * Envoi de SMS — interface unique, LOT 7 « DeuxZero ».
 *
 * Tout le reste du backend passe par ici et ne sait RIEN du routeur employé.
 * C'est la condition d'une exigence du produit : basculer d'Infobip à Nexah, ou
 * à un opérateur local moins cher, doit coûter une ligne de .env et un
 * redémarrage — pas une reprise de code au moment où la facture explose.
 *
 *   SMS_FOURNISSEUR=infobip   routeur par défaut, actif en production
 *   SMS_FOURNISSEUR=nexah     implémentation prête, non activée
 *   SMS_FOURNISSEUR=journal   n'envoie rien, écrit le SMS dans les logs
 *
 * Les trois implémentations partagent la MÊME signature et le MÊME format de
 * retour. Aucune ne lève : un routeur injoignable, une clé absente, un numéro
 * refusé — tout revient en { succes: false, erreur }. Une réinitialisation de
 * code qui échoue doit répondre poliment à son demandeur, pas faire tomber le
 * service pour les trente-huit autres membres.
 */
'use strict';

const annuaire = require('../../bd/annuaire');
const { masquerTelephone } = require('../codes');

const IMPLEMENTATIONS = {
  infobip: () => require('./infobip'),
  nexah: () => require('./nexah'),
  journal: () => require('./journal'),
};

/** Fournisseur retenu, lu à chaque envoi : un redémarrage suffit à basculer. */
function fournisseurActif() {
  const demande = String(process.env.SMS_FOURNISSEUR || 'infobip').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(IMPLEMENTATIONS, demande)) return demande;

  // Un nom inconnu ne doit pas faire silencieusement retomber sur un envoi
  // réel : on écrit dans les logs, ce qui coûte zéro franc et se voit.
  console.error(`[sms] SMS_FOURNISSEUR inconnu « ${demande} » : repli sur « journal », aucun envoi réel`);
  return 'journal';
}

/**
 * Envoie un SMS.
 *
 * @param {object} envoi
 * @param {string} envoi.destinataire numéro au format +237XXXXXXXXX
 * @param {string} envoi.message texte du SMS, en français
 * @param {string} [envoi.association] code de l'association, pour la facture
 * @param {string} [envoi.motif] raison de l'envoi, pour le suivi de consommation
 * @returns {Promise<{succes: boolean, identifiant: string|null, erreur: string|null}>}
 */
async function envoyerSms({ destinataire, message, association = null, motif = 'non precise' }) {
  const nom = fournisseurActif();
  const masque = masquerTelephone(destinataire);

  if (!destinataire || !message) {
    console.error(`[sms] envoi refusé : destinataire ou message manquant (${motif})`);
    return { succes: false, identifiant: null, erreur: 'Destinataire ou message manquant' };
  }

  let resultat;
  try {
    const implementation = IMPLEMENTATIONS[nom]();
    resultat = await implementation.envoyer({ destinataire, message });
  } catch (erreur) {
    // Filet de sécurité : même un module cassé ne doit pas remonter en 500.
    console.error(`[sms] ${nom} a échoué hors protocole : ${erreur.message}`);
    resultat = { succes: false, identifiant: null, erreur: erreur.message };
  }

  console.log(
    `[sms] ${nom} → ${masque} — ${motif} — ${resultat.succes ? 'envoyé' : `échec : ${resultat.erreur}`}` +
      `${resultat.identifiant ? ` — id ${resultat.identifiant}` : ''}`
  );

  await annuaire.journaliserSms({
    association,
    destinataire: masque,
    motif,
    fournisseur: nom,
    identifiant: resultat.identifiant,
    succes: resultat.succes,
    erreur: resultat.erreur,
  });

  return resultat;
}

module.exports = { envoyerSms, fournisseurActif, FOURNISSEURS: Object.keys(IMPLEMENTATIONS) };
