/**
 * Historique annuel des cotisations — Santé des extrêmes (LOT 3).
 *   GET /api/historique?annee=2026   (public)
 *
 * Tableau croisé membres × mois pour une année civile. Le mois retenu est
 * celui de la date de paiement : un rattrapage saisi en septembre au titre de
 * mars apparaît donc en mars (cf. le champ « mois » de POST /api/cotisations).
 *
 * Les pénalités n'y figurent PAS : seules les cotisations sont comptées.
 */
'use strict';

const express = require('express');
const { lireToutes } = require('../db');

const routeur = express.Router();

/** Abréviations attendues par l'application mobile, dans l'ordre calendaire. */
const MOIS = Object.freeze([
  'janv', 'févr', 'mars', 'avr', 'mai', 'juin',
  'juil', 'août', 'sept', 'oct', 'nov', 'déc',
]);

/**
 * Valide le paramètre « annee » d'une requête.
 * @returns {{annee: number}|{erreur: string}} année retenue, ou motif de refus
 */
function lireAnnee(valeur) {
  if (valeur === undefined || String(valeur).trim() === '') {
    return { annee: new Date().getFullYear() };
  }

  const annee = Number.parseInt(valeur, 10);
  if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
    return { erreur: 'Paramètre « annee » invalide' };
  }
  return { annee };
}

/**
 * Construit le tableau croisé membres × mois d'une année.
 *
 * Extrait de la route pour être réutilisé par les exports Excel et PDF :
 * le fichier téléchargé doit afficher exactement les mêmes chiffres que l'écran.
 *
 * @param {number} annee année civile
 * @returns {Promise<object>} charge utile de GET /api/historique
 */
async function construireHistorique(annee) {
  const membres = await lireToutes(
    'SELECT id, name FROM members ORDER BY name COLLATE NOCASE ASC'
  );

  // Une seule requête agrégée plutôt qu'une par membre : la base est petite,
  // mais le tableau se recharge à chaque tirer-pour-rafraîchir.
  const cumuls = await lireToutes(
    `SELECT member_id,
              CAST(strftime('%m', date_paiement) AS INTEGER) AS mois,
              SUM(montant) AS total,
              COUNT(*)     AS nombre
       FROM cotisations
      WHERE strftime('%Y', date_paiement) = ?
        AND statut = 'validee'
      GROUP BY member_id, mois`,
    [String(annee)]
  );

  const parMembre = new Map(
    membres.map((membre) => [
      membre.id,
      { id: membre.id, name: membre.name, montants: new Array(12).fill(0), total: 0 },
    ])
  );

  const totauxMois = new Array(12).fill(0);
  let totalAnnee = 0;
  let nombrePaiements = 0;

  for (const cumul of cumuls) {
    const indexMois = Number(cumul.mois) - 1; // strftime('%m') renvoie 01 à 12
    if (indexMois < 0 || indexMois > 11) continue;

    const montant = Number(cumul.total) || 0;
    totauxMois[indexMois] += montant;
    totalAnnee += montant;
    nombrePaiements += Number(cumul.nombre) || 0;

    // Une cotisation dont le membre a été supprimé depuis n'a plus de ligne :
    // elle compte dans les totaux, sans ligne nominative à afficher.
    const ligne = parMembre.get(cumul.member_id);
    if (!ligne) continue;

    ligne.montants[indexMois] += montant;
    ligne.total += montant;
  }

  return {
    annee,
    mois: MOIS,
    members: [...parMembre.values()],
    totaux_mois: totauxMois,
    total_annee: totalAnnee,
    nb_paiements: nombrePaiements,
    nb_membres: membres.length,
  };
}

/** GET /api/historique — cotisations de l'année, par membre et par mois */
routeur.get('/', async (requete, reponse) => {
  const lecture = lireAnnee(requete.query.annee);
  if (lecture.erreur) {
    console.warn(`[historique] refus : année invalide « ${requete.query.annee} »`);
    return reponse.status(400).json({ error: lecture.erreur });
  }

  try {
    const historique = await construireHistorique(lecture.annee);

    console.log(
      `[historique] année ${historique.annee} servie : ${historique.nb_paiements} paiement(s), ` +
        `${historique.total_annee} XAF, ${historique.nb_membres} membre(s)`
    );

    return reponse.status(200).json(historique);
  } catch (erreur) {
    console.error(`[historique] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible de charger l'historique" });
  }
});

module.exports = routeur;
module.exports.MOIS = MOIS;
module.exports.construireHistorique = construireHistorique;
module.exports.lireAnnee = lireAnnee;
