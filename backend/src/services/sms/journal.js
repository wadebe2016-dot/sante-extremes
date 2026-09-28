/**
 * Routeur SMS « journal » — recette et tests, LOT 7 « DeuxZero ».
 *
 * N'envoie rien : écrit le SMS dans les logs et renvoie un succès simulé. C'est
 * le mode dans lequel tout le parcours de réinitialisation est éprouvé — quotas,
 * expirations, contre-seing du président — sans dépenser un franc de SMS ni
 * dépendre d'une passerelle joignable.
 *
 * Contrairement aux routeurs réels, le TEXTE COMPLET est écrit, code SMS
 * compris : c'est tout l'intérêt en recette, et c'est aussi la raison pour
 * laquelle ce mode ne doit JAMAIS être actif en production. Le démarrage du
 * serveur le rappelle en clair quand NODE_ENV vaut « production ».
 */
'use strict';

/** Compteur d'envois, qui tient lieu d'identifiant de message. */
let compteur = 0;

/**
 * Simule un envoi.
 * @returns {Promise<{succes: boolean, identifiant: string, erreur: null}>}
 */
async function envoyer({ destinataire, message }) {
  compteur += 1;
  const identifiant = `journal-${compteur}`;
  console.log(`[sms:journal] SIMULATION vers ${destinataire} — ${identifiant}\n${message}`);
  return { succes: true, identifiant, erreur: null };
}

/** Nombre d'envois simulés depuis le démarrage (tests). */
function envoisSimules() {
  return compteur;
}

module.exports = { envoyer, envoisSimules, configurationIncomplete: () => null };
