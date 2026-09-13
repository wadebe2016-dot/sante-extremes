/**
 * Route publique du tableau d'affichage (aucune authentification).
 *   GET /api/stats → synthèse du mois + liste des membres avec leur statut
 *
 * Règle métier retenue : un membre est « à jour » (paid = true) s'il a réglé
 * au moins une cotisation pendant le mois calendaire en cours. Le champ
 * `montant_total` suit la même fenêtre : il cumule les cotisations du mois
 * courant. Le tableau repasse donc tout le monde à « impayé » au premier
 * jour du mois suivant.
 *
 * LOT 3 : chaque membre porte en plus `penalite_due` et `suspendu`. Ces deux
 * champs viennent de la table « sanctions » et n'influencent NI le statut
 * payé/impayé, NI les montants de cotisation : les deux comptabilités restent
 * séparées.
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

    // Détail du dernier versement de chaque membre, pour la sous-ligne de
    // l'écran État (« 3 sept · 10 000 · Mobile Money »).
    const derniers = await lireToutes(`
      SELECT c.member_id, c.montant, c.moyen, c.date_paiement
        FROM cotisations c
        JOIN (
          SELECT member_id, MAX(date_paiement) AS date_max
            FROM cotisations
           GROUP BY member_id
        ) dernier
          ON dernier.member_id = c.member_id
         AND dernier.date_max = c.date_paiement
      GROUP BY c.member_id
    `);

    const detailParMembre = new Map(derniers.map((ligne) => [ligne.member_id, ligne]));

    // Sanctions en cours : pénalités non réglées et suspensions non échues.
    const sanctions = await lireToutes(`
      SELECT member_id,
             COALESCE(SUM(CASE WHEN type = 'penalite' AND statut = 'due' THEN montant ELSE 0 END), 0) AS penalite_due,
             MAX(CASE
                   WHEN type = 'suspension' AND statut = 'due' AND date_fin >= date('now') THEN 1
                   ELSE 0
                 END) AS suspendu,
             MAX(CASE
                   WHEN type = 'suspension' AND statut = 'due' AND date_fin >= date('now') THEN date_fin
                   ELSE NULL
                 END) AS date_fin_suspension
        FROM sanctions
       WHERE statut = 'due'
       GROUP BY member_id
    `);

    const sanctionsParMembre = new Map(sanctions.map((ligne) => [ligne.member_id, ligne]));

    const membres = lignes.map((ligne) => {
      const dernier = detailParMembre.get(ligne.id);
      const sanction = sanctionsParMembre.get(ligne.id);

      return {
        id: ligne.id,
        name: ligne.name,
        paid: ligne.paye_ce_mois === 1,
        last_paiement: ligne.last_paiement || null,
        montant_total: Number(ligne.montant_mois) || 0,
        dernier_montant: dernier ? Number(dernier.montant) || 0 : null,
        dernier_moyen: dernier ? dernier.moyen : null,
        penalite_due: sanction ? Number(sanction.penalite_due) || 0 : 0,
        suspendu: sanction ? sanction.suspendu === 1 : false,
        date_fin_suspension: sanction ? sanction.date_fin_suspension || null : null,
      };
    });

    const nombreAJour = membres.filter((membre) => membre.paid).length;
    const moisCourant = new Date().toISOString().slice(0, 7); // format AAAA-MM
    const montantEncaisse = membres.reduce((somme, membre) => somme + membre.montant_total, 0);

    const synthese = {
      total_members: membres.length,
      paid: nombreAJour,
      unpaid: membres.length - nombreAJour,
      percentage_paid: membres.length === 0 ? 0 : Math.round((nombreAJour / membres.length) * 100),
      current_month: moisCourant,
      montant_encaisse: montantEncaisse,
      penalites_dues: membres.reduce((somme, membre) => somme + membre.penalite_due, 0),
      suspensions_actives: membres.filter((membre) => membre.suspendu).length,
    };

    console.log(
      `[stats] tableau public servi : ${synthese.paid}/${synthese.total_members} à jour ` +
        `(${synthese.percentage_paid} %) pour ${moisCourant}, ${montantEncaisse} XAF encaissés`
    );
    return reponse.status(200).json({ summary: synthese, members: membres });
  } catch (erreur) {
    console.error(`[stats] échec de la lecture du tableau : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger le tableau des cotisations' });
  }
});

module.exports = routeur;
