/**
 * Paramètres de l'association — LOT 7 « DeuxZero ».
 *
 *   GET /api/parametres   (tout rôle)      lire les réglages
 *   PUT /api/parametres   (président seul) les modifier
 *
 * La lecture est ouverte à tout titulaire : le trésorier a besoin du barème des
 * pénalités, l'intendant de la liste des postes de dépense, le censeur du seuil
 * de mise à l'écart. L'écriture est réservée au président — ces réglages changent
 * ce que l'association réclame à ses membres, ce n'est pas une décision
 * d'exécution.
 *
 * Aucun paramètre n'est écrit sans validation, et un lot dont une seule valeur
 * est refusée n'écrit rien : un président qui corrige trois réglages d'un coup ne
 * doit pas se retrouver avec un état à moitié appliqué.
 */
'use strict';

const express = require('express');

const { exigerRole, exigerTitulaire } = require('../middleware/auth');
const parametres = require('../services/parametres');

const routeur = express.Router();

/** GET /api/parametres — réglages en vigueur. */
routeur.get('/', exigerTitulaire(), async (requete, reponse) => {
  try {
    // Relecture depuis la base plutôt que depuis le cache : c'est l'écran de
    // réglages, celui où l'on veut être sûr de voir l'état réel.
    await parametres.charger(requete.db);
    const vue = parametres.vue(requete.db);

    console.log(`[parametres] réglages servis [${requete.association.code}]`);
    return reponse.status(200).json({
      association: { code: requete.association.code, nom: requete.association.nom },
      parametres: vue,
      cles_modifiables: Object.keys(parametres.CLES_MODIFIABLES),
      jours_semaine: Object.keys(parametres.JOURS_SEMAINE),
      modifiable_par_moi: (requete.roles || []).includes('president'),
    });
  } catch (erreur) {
    console.error(`[parametres] lecture impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les paramètres' });
  }
});

/**
 * PUT /api/parametres — modifier un ou plusieurs réglages (président seul).
 *
 * Corps : { jour_seance, penalite_un_mois, postes_depenses, … }
 *
 * Les clés absentes ne sont pas touchées. Une clé inconnue est refusée en 400 :
 * la table « parametres » porte aussi le solde d'ouverture de la trésorerie, qui
 * a sa propre route et ses propres droits, et cette route ne doit pas pouvoir le
 * réécrire au passage.
 */
routeur.put('/', exigerRole('president'), async (requete, reponse) => {
  const corps = requete.body;
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) {
    return reponse.status(400).json({ error: 'Corps de requête invalide' });
  }

  try {
    const resultat = await parametres.ecrire(requete.db, corps, requete.agent);

    console.log(
      `[parametres] ${resultat.ecrits.length} réglage(s) modifié(s) [${requete.association.code}] ` +
        `par ${requete.agent} : ${resultat.ecrits.join(', ')}`
    );

    return reponse.status(200).json({
      ecrits: resultat.ecrits,
      parametres: parametres.vue(requete.db),
    });
  } catch (erreur) {
    if (erreur.refusUtilisateur) {
      console.warn(`[parametres] modification refusée : ${erreur.message}`);
      return reponse.status(400).json({ error: erreur.message });
    }
    console.error(`[parametres] modification impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible d’enregistrer les paramètres' });
  }
});

module.exports = routeur;
