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
 *
 * Le statut du mois se lit sur `date_paiement`, le MOIS DÛ — inchangé. La date de
 * remise de l'argent (`date_versement`) n'est ici qu'un détail d'affichage de la
 * sous-ligne : elle ne décide que de la trésorerie.
 *
 * LOT 4 : les membres MIS À L'ÉCART sortent de ce tableau. Le total « X/38 à
 * jour » compte ceux qui sont tenus de cotiser ; y laisser un membre écarté
 * ferait baisser le pourcentage pour une dette qu'il n'a plus à honorer le mois
 * courant. Ils restent intégralement dans /api/historique, /api/arrieres et les
 * exports : rien n'est perdu, la vue est seulement cadrée sur les actifs.
 */
'use strict';

const express = require('express');
const { lireToutes } = require('../db');
const { calculerSoldeReel } = require('./tresorerie');
const { estRegularisation } = require('./cotisations');

const routeur = express.Router();

/** GET /api/stats — état des cotisations de tous les membres */
routeur.get('/', async (requete, reponse) => {
  try {
    // Seules les cotisations VALIDÉES comptent : une déclaration en attente ne
    // met pas un membre à jour et n'entre dans aucun total.
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
      LEFT JOIN cotisations c
        ON c.member_id = m.id AND c.statut = 'validee'
      -- COALESCE : une fiche antérieure au LOT 4 n'a pas encore de statut au
      -- moment où la migration tourne ; elle est réputée active.
      WHERE COALESCE(m.statut, 'actif') <> 'ecarte'
      GROUP BY m.id, m.name
      ORDER BY m.name COLLATE NOCASE ASC
    `);

    // Détail du dernier versement de chaque membre, pour la sous-ligne de
    // l'écran État (« 3 sept · 10 000 · Mobile Money »).
    const derniers = await lireToutes(`
      SELECT c.member_id, c.montant, c.moyen, c.date_paiement, c.date_versement
        FROM cotisations c
        JOIN (
          SELECT member_id, MAX(date_paiement) AS date_max
            FROM cotisations
           WHERE statut = 'validee'
           GROUP BY member_id
        ) dernier
          ON dernier.member_id = c.member_id
         AND dernier.date_max = c.date_paiement
       WHERE c.statut = 'validee'
      GROUP BY c.member_id
    `);

    const detailParMembre = new Map(derniers.map((ligne) => [ligne.member_id, ligne]));

    // Déclarations du mois courant encore en attente du trésorier.
    const enAttente = await lireToutes(`
      SELECT member_id, COUNT(*) AS nombre
        FROM cotisations
       WHERE statut = 'en_attente'
         AND strftime('%Y-%m', date_paiement) = strftime('%Y-%m', 'now')
       GROUP BY member_id
    `);

    const attenteParMembre = new Set(enAttente.map((ligne) => ligne.member_id));

    // Dernier refus du mois : le membre doit savoir pourquoi sa déclaration a
    // été écartée, sans quoi il la renverra à l'identique.
    const refus = await lireToutes(`
      SELECT member_id, motif_refus
        FROM cotisations
       WHERE statut = 'refusee'
         AND strftime('%Y-%m', date_paiement) = strftime('%Y-%m', 'now')
         AND id IN (
           SELECT MAX(id) FROM cotisations
            WHERE statut = 'refusee'
              AND strftime('%Y-%m', date_paiement) = strftime('%Y-%m', 'now')
            GROUP BY member_id
         )
    `);

    const refusParMembre = new Map(refus.map((ligne) => [ligne.member_id, ligne.motif_refus]));

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

      // Trois états distincts pour le mois en cours. « en_attente » n'est pas
      // « payé » : le trésorier n'a encore rien confirmé.
      const paye = ligne.paye_ce_mois === 1;
      const statutMois = paye ? 'paye' : (attenteParMembre.has(ligne.id) ? 'en_attente' : 'impaye');

      return {
        id: ligne.id,
        name: ligne.name,
        paid: paye,
        statut_mois: statutMois,
        motif_refus: statutMois === 'impaye' ? refusParMembre.get(ligne.id) || null : null,
        last_paiement: ligne.last_paiement || null,
        montant_total: Number(ligne.montant_mois) || 0,
        dernier_montant: dernier ? Number(dernier.montant) || 0 : null,
        dernier_moyen: dernier ? dernier.moyen : null,
        // Jour de remise du dernier versement, et régularisation le cas échéant :
        // l'écran État affiche « Septembre · versé le 12 sept ». Le statut du
        // mois, lui, ne bouge pas d'un iota — il reste assis sur le mois dû.
        dernier_versement: dernier ? dernier.date_versement || null : null,
        dernier_regularisation: dernier
          ? estRegularisation(dernier.date_paiement, dernier.date_versement)
          : false,
        penalite_due: sanction ? Number(sanction.penalite_due) || 0 : 0,
        suspendu: sanction ? sanction.suspendu === 1 : false,
        date_fin_suspension: sanction ? sanction.date_fin_suspension || null : null,
      };
    });

    // Les écartés ne sont pas dans la liste, mais l'application doit pouvoir
    // dire « 38 actifs · 3 mis à l'écart » plutôt que de laisser croire à une
    // disparition.
    const comptes = await lireToutes(
      `SELECT COUNT(*) AS ecartes FROM members WHERE COALESCE(statut, 'actif') = 'ecarte'`
    );
    const nombreEcartes = Number(comptes[0] ? comptes[0].ecartes : 0) || 0;

    const situation = await calculerSoldeReel();
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
      // Solde de caisse, calculé par le même code que /api/tresorerie : l'écran
      // État l'affiche sans avoir à lancer un second appel.
      solde_reel: situation.solde,
      solde_ouverture: situation.ouverture,
      en_attente: membres.filter((membre) => membre.statut_mois === 'en_attente').length,
      penalites_dues: membres.reduce((somme, membre) => somme + membre.penalite_due, 0),
      suspensions_actives: membres.filter((membre) => membre.suspendu).length,
      // LOT 4 — hors du total ci-dessus, mais annoncés.
      membres_ecartes: nombreEcartes,
    };

    console.log(
      `[stats] tableau public servi : ${synthese.paid}/${synthese.total_members} à jour ` +
        `(${synthese.percentage_paid} %) pour ${moisCourant}, ${montantEncaisse} XAF encaissés, ` +
        `${situation.solde} XAF en caisse`
    );
    return reponse.status(200).json({ summary: synthese, members: membres });
  } catch (erreur) {
    console.error(`[stats] échec de la lecture du tableau : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger le tableau des cotisations' });
  }
});

module.exports = routeur;
