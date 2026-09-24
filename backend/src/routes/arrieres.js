/**
 * État des arriérés — Santé des extrêmes (LOT 4).
 *   GET /api/arrieres?mois=AAAA-MM   (PUBLIC, mois en cours par défaut)
 *
 * Répond à une seule question : qui doit combien, et depuis quand ? La réponse
 * est publique et sans code — c'est un document d'assemblée, pas une pièce
 * confidentielle.
 *
 * DEUX PRÉCAUTIONS DE LECTURE
 *
 *   1. Les mois dus partent de la DATE D'ADHÉSION, jamais de janvier. Un membre
 *      entré en mai et à jour de mai et juin doit juillet, août et septembre :
 *      trois mois, pas huit.
 *   2. Les membres à jour ne figurent QUE dans le résumé. La liste est faite
 *      pour être lue à voix haute : y mettre vingt-et-une lignes vides la
 *      rendrait inutilisable.
 *
 * LE MONTANT ATTENDU N'EST PAS UNIFORME : il est propre à chaque membre
 * (« members.contribution »), 5 000 pour les uns, 10 000 pour les autres. Un
 * barème unique surestimait les arriérés de la moitié de l'effectif — c'est le
 * second défaut corrigé par ce lot.
 *
 * Les membres mis à l'écart restent dans la liste s'ils doivent quelque chose :
 * une mise à l'écart interdit de jouer, elle n'efface pas la dette. Leur statut
 * les distingue, et l'application les grise.
 *
 * Cette route est disponible dès le déploiement : elle ne dépend d'aucune date
 * d'effet, contrairement aux mesures.
 */
'use strict';

const express = require('express');
const {
  COTISATION_MENSUELLE,
  SEUIL_ECART,
  moisCourant,
  moisValide,
  construireSituation,
} = require('../services/arrieres');

const routeur = express.Router();

/**
 * Construit la charge utile de GET /api/arrieres.
 *
 * Extraite de la route pour être réutilisée par la feuille « Arriérés » de
 * l'export Excel : le fichier téléchargé doit afficher exactement les mêmes
 * chiffres que l'écran.
 *
 * @param {string} mois mois de référence, AAAA-MM
 */
async function construireArrieres(mois) {
  const situation = await construireSituation(mois);

  const enRetard = situation
    .filter((membre) => membre.nb_mois > 0)
    .map((membre) => ({
      id: membre.id,
      name: membre.name,
      adhesion: membre.adhesion,
      // Le montant attendu de CE membre : 5 000 pour les uns, 10 000 pour les
      // autres. Sans lui, un arriéré de 15 000 reste inexplicable à la lecture.
      contribution: membre.contribution,
      mois_dus: membre.mois_dus,
      nb_mois: membre.nb_mois,
      montant_du: membre.montant_du,
      penalites_dues: membre.penalites_dues,
      total_du: membre.total_du,
      dernier_versement: membre.dernier_versement,
      statut: membre.statut,
    }))
    // Le plus en retard en tête : c'est l'ordre dans lequel le bureau traite
    // les situations. À nombre de mois égal, l'ordre alphabétique départage.
    .sort((a, b) => b.nb_mois - a.nb_mois || a.name.localeCompare(b.name, 'fr'));

  const resume = {
    membres_a_jour: situation.filter((membre) => membre.nb_mois === 0).length,
    membres_en_retard: enRetard.length,
    // Somme des montants dus au titre des cotisations : les pénalités sont une
    // comptabilité distincte, et les mêler fausserait le total attendu.
    total_arrieres: enRetard.reduce((somme, membre) => somme + membre.montant_du, 0),
    total_penalites: enRetard.reduce((somme, membre) => somme + membre.penalites_dues, 0),
    par_anciennete: {
      '1_mois': enRetard.filter((membre) => membre.nb_mois === 1).length,
      '2_mois': enRetard.filter((membre) => membre.nb_mois === 2).length,
      '3_mois_et_plus': enRetard.filter((membre) => membre.nb_mois >= SEUIL_ECART).length,
    },
    nb_membres: situation.length,
    ecartes: situation.filter((membre) => membre.statut === 'ecarte').length,
  };

  // « cotisation_mensuelle » n'est plus qu'une valeur de repli : le montant
  // attendu est propre à chaque membre et figure sur sa ligne.
  return {
    mois,
    cotisation_mensuelle: COTISATION_MENSUELLE,
    membres: enRetard,
    resume,
  };
}

/** GET /api/arrieres — mois dus et montants, par membre. */
routeur.get('/', async (requete, reponse) => {
  const demande = String(requete.query.mois || '').trim();
  const mois = demande === '' ? moisCourant() : demande;

  if (!moisValide(mois)) {
    console.warn(`[arrieres] refus : mois invalide « ${demande} »`);
    return reponse.status(400).json({ error: 'Mois invalide (format attendu : AAAA-MM)' });
  }

  try {
    const charge = await construireArrieres(mois);

    console.log(
      `[arrieres] ${mois} servi : ${charge.resume.membres_en_retard} en retard, ` +
        `${charge.resume.membres_a_jour} à jour, ${charge.resume.total_arrieres} XAF d'arriérés`
    );
    return reponse.status(200).json(charge);
  } catch (erreur) {
    console.error(`[arrieres] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible de charger l'état des arriérés" });
  }
});

module.exports = routeur;
module.exports.construireArrieres = construireArrieres;
