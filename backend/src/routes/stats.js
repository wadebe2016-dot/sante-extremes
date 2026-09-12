/**
 * Route publique du tableau d'affichage (aucune authentification).
 *   GET /api/stats → synthèse du mois + liste des membres avec leur statut
 *
 * Règle métier retenue : un membre est « à jour » (paid = true) s'il a réglé
 * au moins une cotisation pendant le mois calendaire en cours. Le champ
 * `montant_total` suit la même fenêtre : il cumule les cotisations du mois
 * courant. Le tableau repasse donc tout le monde à « impayé » au premier
 * jour du mois suivant.
 */
'use strict';

const express = require('express');
const { lireToutes } = require('../db');

const routeur = express.Router();

/** GET /api/stats — état des cotisations de tous les membres */
routeur.get('/', async (requete, reponse) => {
  try {
    const lignes = await lireToutes(`
      SELECT
        m.id,
        m.name,
        MAX(c.date_paiement) AS last_paiement,
        MAX(CASE
              WHEN strftime('%Y-%m', c.date_paiement) = strftime('%Y-%m', 'now') THEN 1
              ELSE 0
            END) AS paye_ce_mois,
        COALESCE(SUM(CASE
                       WHEN strftime('%Y-%m', c.date_paiement) = strftime('%Y-%m', 'now') THEN c.montant
                       ELSE 0
                     END), 0) AS montant_mois
      FROM members m
      LEFT JOIN cotisations c ON c.member_id = m.id
      GROUP BY m.id, m.name
      ORDER BY m.name COLLATE NOCASE ASC
    `);

    const membres = lignes.map((ligne) => ({
      id: ligne.id,
      name: ligne.name,
      paid: ligne.paye_ce_mois === 1,
      last_paiement: ligne.last_paiement || null,
      montant_total: Number(ligne.montant_mois) || 0,
    }));

    const nombreAJour = membres.filter((membre) => membre.paid).length;
    const moisCourant = new Date().toISOString().slice(0, 7); // format AAAA-MM

    const synthese = {
      total_members: membres.length,
      paid: nombreAJour,
      unpaid: membres.length - nombreAJour,
      percentage_paid: membres.length === 0 ? 0 : Math.round((nombreAJour / membres.length) * 100),
      current_month: moisCourant,
    };

    console.log(
      `[stats] tableau public servi : ${synthese.paid}/${synthese.total_members} à jour (${synthese.percentage_paid} %) pour ${moisCourant}`
    );
    return reponse.status(200).json({ summary: synthese, members: membres });
  } catch (erreur) {
    console.error(`[stats] échec de la lecture du tableau : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger le tableau des cotisations' });
  }
});

module.exports = routeur;
