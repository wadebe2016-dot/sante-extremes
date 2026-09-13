/**
 * Règlement des pénalités — Santé des extrêmes (LOT 3).
 *   POST /api/penalites/:id/regler  (trésorier — multipart/form-data)
 *   champs : moyen, fichier (facultatif)
 *
 * L'encaissement suit la même mécanique qu'une cotisation (justificatif
 * déposé sur S3), mais il est écrit dans la table « sanctions » : une pénalité
 * réglée n'entre JAMAIS dans le total des cotisations ni dans l'historique.
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
 * Ramène le moyen de règlement à sa valeur canonique, en tolérant la casse et
 * l'absence d'accent — même tolérance que pour les cotisations.
 * @returns {string|null} valeur canonique ou null si le moyen est inconnu
 */
function normaliserMoyen(valeur) {
  const brut = String(valeur || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();

  if (brut === 'mobile money') return 'Mobile Money';
  if (brut === 'espece' || brut === 'especes') return 'Espèce';
  return null;
}

routeur.post(
  '/:id/regler',
  exigerRole('tresorier'),
  (requete, reponse, suite) => recevoirJustificatif(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  async (requete, reponse) => {
    const identifiant = Number.parseInt(requete.params.id, 10);
    const moyen = normaliserMoyen(requete.body?.moyen);

    if (!Number.isInteger(identifiant) || identifiant <= 0) {
      return reponse.status(400).json({ error: 'Identifiant de pénalité invalide' });
    }

    if (!moyen) {
      console.warn(`[penalites] refus : moyen de règlement inconnu « ${requete.body?.moyen} »`);
      return reponse
        .status(400)
        .json({ error: `Moyen de règlement invalide (attendu : ${MOYENS_AUTORISES.join(' ou ')})` });
    }

    try {
      const sanction = await lireUne(
        `SELECT s.*, m.name AS member_name
           FROM sanctions s JOIN members m ON m.id = s.member_id
          WHERE s.id = ?`,
        [identifiant]
      );

      if (!sanction) {
        return reponse.status(404).json({ error: 'Pénalité introuvable' });
      }

      if (sanction.type !== 'penalite') {
        return reponse.status(400).json({ error: 'Seule une pénalité peut être encaissée' });
      }

      if (sanction.statut !== 'due') {
        return reponse.status(409).json({ error: `Cette pénalité est déjà « ${sanction.statut} »` });
      }

      // Justificatif facultatif, comme pour une cotisation en espèce.
      let urlJustificatif = null;
      if (requete.file) {
        urlJustificatif = await televerserJustificatif(requete.file, sanction.member_id);
      } else {
        console.log(`[penalites] règlement sans justificatif pour la pénalité #${identifiant}`);
      }

      await executer(
        `UPDATE sanctions
            SET statut = 'reglee',
                date_reglement = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                moyen_reglement = ?,
                fichier_s3_url = ?
          WHERE id = ?`,
        [moyen, urlJustificatif, identifiant]
      );

      const ligne = await lireUne(
        `SELECT s.*, m.name AS member_name
           FROM sanctions s JOIN members m ON m.id = s.member_id
          WHERE s.id = ?`,
        [identifiant]
      );

      console.log(
        `[penalites] pénalité réglée : #${identifiant} — ${ligne.member_name} — ${ligne.montant} XAF (${moyen})`
      );

      return reponse.status(200).json({
        id: ligne.id,
        member_id: ligne.member_id,
        member_name: ligne.member_name,
        type: ligne.type,
        motif: ligne.motif,
        montant: Number(ligne.montant),
        statut: ligne.statut,
        date_sanction: ligne.date_sanction,
        date_reglement: ligne.date_reglement,
        moyen_reglement: ligne.moyen_reglement,
        fichier_s3_url: ligne.fichier_s3_url || null,
      });
    } catch (erreur) {
      console.error(`[penalites] échec du règlement #${identifiant} : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || "Impossible d'encaisser la pénalité" });
    }
  }
);

module.exports = routeur;
