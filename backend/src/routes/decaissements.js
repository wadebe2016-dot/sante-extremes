/**
 * Décaissements — Santé des extrêmes (LOT 3 bis).
 *
 *   GET /api/decaissements?annee=              (public)
 *   GET /api/decaissements/:id/justificatif    (trésorier | intendant | secretaire | competitions)
 *
 * La liste est publique : les membres financent l'association, ils doivent
 * pouvoir constater ce qui en sort. Le justificatif, lui, reste réservé aux
 * rôles qui ont à en connaître, et n'est servi que par URL pré-signée.
 *
 * Aucune route de création ici : un décaissement naît uniquement de
 * POST /api/demandes/:id/lignes/:ligneId/decaisser, sur un POSTE approuvé.
 * Depuis le LOT 5, une sortie de caisse se rattache à un poste, pas à une
 * demande : elle porte donc la catégorie et le libellé de ce poste, et rappelle
 * le numéro de la demande d'origine.
 */
'use strict';

const express = require('express');
const { lireUne, lireToutes } = require('../db');
const { exigerRole } = require('../middleware/auth');
const { urlPresignee } = require('../middleware/s3upload');
const { CATEGORIES } = require('./demandes');

const routeur = express.Router();

/** GET /api/decaissements — sorties de caisse, de la plus récente à la plus ancienne. */
routeur.get('/', async (requete, reponse) => {
  const anneeBrute = requete.query.annee;

  let annee = null;
  if (anneeBrute !== undefined && String(anneeBrute).trim() !== '') {
    annee = Number.parseInt(anneeBrute, 10);
    if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
      return reponse.status(400).json({ error: 'Paramètre « annee » invalide' });
    }
  }

  try {
    const lignes = await lireToutes(
      `SELECT x.*, l.categorie, l.libelle, l.montant_estime, l.demande_id,
              d.role_demandeur
         FROM decaissements x
         JOIN demande_lignes l ON l.id = x.ligne_id
         JOIN demandes d ON d.id = l.demande_id
        ${annee === null ? '' : "WHERE strftime('%Y', x.date_paiement) = ?"}
        ORDER BY x.date_paiement DESC, x.id DESC`,
      annee === null ? [] : [String(annee)]
    );

    const decaissements = lignes.map((ligne) => ({
      id: ligne.id,
      demande_id: ligne.demande_id,
      ligne_id: ligne.ligne_id,
      categorie: ligne.categorie,
      categorie_libelle: CATEGORIES[ligne.categorie] || ligne.categorie,
      libelle: ligne.libelle,
      montant: Number(ligne.montant),
      montant_estime: Number(ligne.montant_estime),
      date_paiement: ligne.date_paiement,
      moyen: ligne.moyen,
      paye_par: ligne.paye_par,
      beneficiaire: ligne.beneficiaire || null,
      commentaire: ligne.commentaire || null,
      role_demandeur: ligne.role_demandeur,
      a_un_justificatif: Boolean(ligne.justificatif_cle_s3),
    }));

    // Répartition par catégorie : c'est la lecture qui intéresse l'assemblée.
    const parCategorie = {};
    for (const decaissement of decaissements) {
      parCategorie[decaissement.categorie] =
        (parCategorie[decaissement.categorie] || 0) + decaissement.montant;
    }

    const total = decaissements.reduce((somme, ligne) => somme + ligne.montant, 0);

    console.log(`[decaissements] liste servie : ${decaissements.length} sortie(s), ${total} XAF`);
    return reponse.status(200).json({
      annee,
      decaissements,
      total,
      nombre: decaissements.length,
      par_categorie: parCategorie,
      categories: CATEGORIES,
    });
  } catch (erreur) {
    console.error(`[decaissements] lecture impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les décaissements' });
  }
});

/** GET /api/decaissements/:id/justificatif — pièce du décaissement. */
routeur.get(
  '/:id/justificatif',
  exigerRole('tresorier', 'intendant', 'secretaire', 'competitions'),
  async (requete, reponse) => {
    const identifiant = Number.parseInt(requete.params.id, 10);
    if (!Number.isInteger(identifiant) || identifiant <= 0) {
      return reponse.status(400).json({ error: 'Identifiant de décaissement invalide' });
    }

    try {
      const decaissement = await lireUne(
        'SELECT id, justificatif_cle_s3 FROM decaissements WHERE id = ?',
        [identifiant]
      );

      if (!decaissement) {
        return reponse.status(404).json({ error: 'Décaissement introuvable' });
      }

      if (!decaissement.justificatif_cle_s3) {
        return reponse.status(404).json({ error: 'Aucun justificatif pour ce décaissement' });
      }

      const url = await urlPresignee(decaissement.justificatif_cle_s3);
      console.log(
        `[decaissements] justificatif consulté : #${identifiant} — ` +
          `rôles ${(requete.roles || []).join(',')}`
      );
      return reponse.status(200).json({ url });
    } catch (erreur) {
      console.error(`[decaissements] justificatif #${identifiant} : ${erreur.message}`);
      return reponse.status(500).json({ error: 'Impossible de charger le justificatif' });
    }
  }
);

module.exports = routeur;
