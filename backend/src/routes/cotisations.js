/**
 * Route d'enregistrement des paiements de cotisation.
 *   POST /api/cotisations  (trésorier — multipart/form-data)
 *   champs : member_id, montant, moyen, mois (facultatif), fichier (facultatif)
 *
 * Le justificatif est déposé sur S3, puis la cotisation est écrite en base.
 *
 * LOT 3 : la route passe sous le code trésorier, et accepte un mois de
 * rattrapage (saisie d'un paiement reçu au titre d'un mois antérieur).
 */
'use strict';

const express = require('express');
const { executer, lireUne } = require('../db');
const { exigerRole } = require('../middleware/auth');
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

/**
 * Convertit un mois de rattrapage « AAAA-MM » en date de paiement.
 *
 * On retient le 5 du mois à 12:00Z : une date en milieu de journée et de
 * première semaine reste dans le bon mois quel que soit le fuseau de lecture,
 * là où le 1ᵉʳ à minuit basculerait sur le mois précédent à l'ouest de Greenwich.
 *
 * @param {string} valeur mois demandé, au format AAAA-MM
 * @returns {{date: string}|{erreur: string}} date ISO à enregistrer, ou motif de refus
 */
function convertirMoisEnDate(valeur) {
  const mois = String(valeur || '').trim();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mois)) {
    return { erreur: 'Mois invalide (format attendu : AAAA-MM)' };
  }

  const moisCourant = new Date().toISOString().slice(0, 7);
  if (mois > moisCourant) {
    // Comparaison lexicographique : le format AAAA-MM la rend équivalente à une
    // comparaison chronologique.
    return { erreur: 'Impossible d’enregistrer un paiement pour un mois à venir' };
  }

  return { date: `${mois}-05T12:00:00Z` };
}

routeur.post(
  '/',
  // 1. Contrôle du code trésorier AVANT de lire le fichier : inutile de
  //    téléverser quoi que ce soit si l'appelant n'est pas autorisé.
  exigerRole('tresorier'),
  // 2. Réception du fichier en mémoire (images, 5 Mo max)
  (requete, reponse, suite) => recevoirJustificatif(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  // 3. Validation, dépôt S3 puis écriture en base
  async (requete, reponse) => {
    const idMembre = Number.parseInt(requete.body?.member_id, 10);
    const montant = Number.parseFloat(requete.body?.montant);
    const moyen = normaliserMoyen(requete.body?.moyen);
    const moisDemande = requete.body?.mois;

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

    // Mois facultatif : absent, la cotisation est datée de maintenant (défaut SQL).
    let datePaiement = null;
    if (moisDemande !== undefined && moisDemande !== null && String(moisDemande).trim() !== '') {
      const conversion = convertirMoisEnDate(moisDemande);
      if (conversion.erreur) {
        console.warn(`[cotisations] refus : mois « ${moisDemande} » — ${conversion.erreur}`);
        return reponse.status(400).json({ error: conversion.erreur });
      }
      datePaiement = conversion.date;
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

      const resultat = datePaiement
        ? await executer(
            'INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url, date_paiement) VALUES (?, ?, ?, ?, ?)',
            [idMembre, montant, moyen, urlJustificatif, datePaiement]
          )
        : await executer(
            'INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url) VALUES (?, ?, ?, ?)',
            [idMembre, montant, moyen, urlJustificatif]
          );

      const cotisation = await lireUne(
        'SELECT id, member_id, montant, moyen, fichier_s3_url, date_paiement FROM cotisations WHERE id = ?',
        [resultat.id]
      );

      const mention = datePaiement ? ` — rattrapage ${String(moisDemande).trim()}` : '';
      console.log(
        `[cotisations] paiement enregistré : #${cotisation.id} — ${membre.name} — ${montant} (${moyen})${mention}`
      );
      return reponse.status(201).json(cotisation);
    } catch (erreur) {
      console.error(`[cotisations] échec de l'enregistrement : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || "Impossible d'enregistrer le paiement" });
    }
  }
);

module.exports = routeur;
