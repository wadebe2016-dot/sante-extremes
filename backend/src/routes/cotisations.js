/**
 * Route d'enregistrement des paiements de cotisation.
 *   POST /api/cotisations  (multipart/form-data : member_id, montant, moyen, fichier)
 * Le justificatif est déposé sur S3, puis la cotisation est écrite en base.
 */
'use strict';

const express = require('express');
const { executer, lireUne } = require('../db');
const {
  recevoirJustificatif,
  televerserJustificatif,
  gererErreursUpload,
} = require('../middleware/s3upload');

const routeur = express.Router();
const MOYENS_AUTORISES = ['Mobile Money', 'Espèce'];

/**
 * Ramène le moyen de paiement reçu à sa valeur canonique, en tolérant la casse
 * et l'absence d'accent (certains clients envoient « Espece »).
 * @returns {string|null} valeur canonique ou null si le moyen est inconnu
 */
function normaliserMoyen(valeur) {
  const brut = String(valeur || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // retire les accents
    .trim()
    .toLowerCase();

  if (brut === 'mobile money') return 'Mobile Money';
  if (brut === 'espece' || brut === 'especes') return 'Espèce';
  return null;
}

routeur.post(
  '/',
  // 1. Réception du fichier en mémoire (images, 5 Mo max)
  (requete, reponse, suite) => recevoirJustificatif(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  // 2. Validation, dépôt S3 puis écriture en base
  async (requete, reponse) => {
    const idMembre = Number.parseInt(requete.body?.member_id, 10);
    const montant = Number.parseFloat(requete.body?.montant);
    const moyen = normaliserMoyen(requete.body?.moyen);

    if (!Number.isInteger(idMembre) || idMembre <= 0) {
      console.warn(`[cotisations] refus : member_id invalide « ${requete.body?.member_id} »`);
      return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      console.warn(`[cotisations] refus : montant invalide « ${requete.body?.montant} »`);
      return reponse.status(400).json({ error: 'Le montant doit être un nombre strictement positif' });
    }

    if (!moyen) {
      console.warn(`[cotisations] refus : moyen de paiement inconnu « ${requete.body?.moyen} »`);
      return reponse
        .status(400)
        .json({ error: `Moyen de paiement invalide (attendu : ${MOYENS_AUTORISES.join(' ou ')})` });
    }

    try {
      const membre = await lireUne('SELECT id, name FROM members WHERE id = ?', [idMembre]);
      if (!membre) {
        console.warn(`[cotisations] refus : membre #${idMembre} introuvable`);
        return reponse.status(404).json({ error: 'Membre introuvable' });
      }

      // Le justificatif est facultatif : un paiement en espèce peut être saisi sans photo
      let urlJustificatif = null;
      if (requete.file) {
        urlJustificatif = await televerserJustificatif(requete.file, idMembre);
      } else {
        console.log(`[cotisations] paiement sans justificatif pour le membre #${idMembre}`);
      }

      const resultat = await executer(
        'INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url) VALUES (?, ?, ?, ?)',
        [idMembre, montant, moyen, urlJustificatif]
      );

      const cotisation = await lireUne(
        'SELECT id, member_id, montant, moyen, fichier_s3_url, date_paiement FROM cotisations WHERE id = ?',
        [resultat.id]
      );

      console.log(
        `[cotisations] paiement enregistré : #${cotisation.id} — ${membre.name} — ${montant} (${moyen})`
      );
      return reponse.status(201).json(cotisation);
    } catch (erreur) {
      console.error(`[cotisations] échec de l'enregistrement : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || "Impossible d'enregistrer le paiement" });
    }
  }
);

module.exports = routeur;
