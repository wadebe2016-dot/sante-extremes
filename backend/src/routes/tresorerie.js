/**
 * État de la trésorerie — Santé des extrêmes (LOT 3 bis).
 *   GET /api/tresorerie?annee=2026   (PUBLIC)
 *
 * Tous les membres doivent pouvoir constater ce que l'association détient
 * réellement. C'est la seule vue qui RÉUNIT les deux comptabilités :
 *
 *   solde réel = cotisations validées + pénalités encaissées
 *
 * Partout ailleurs elles restent séparées — l'historique annuel et le total
 * encaissé de /api/stats ignorent les pénalités, à dessein. Ici on veut la
 * caisse, pas le suivi des cotisations : il faut donc bien additionner.
 *
 * Ne comptent QUE les mouvements effectifs : une déclaration en attente de
 * validation et une pénalité due sont annoncées à part, comme attendues.
 */
'use strict';

const express = require('express');
const { lireUne, lireToutes } = require('../db');
const { lireAnnee, MOIS } = require('./historique');

const routeur = express.Router();

/** Somme d'une requête agrégée, ramenée à un nombre sûr. */
function nombre(valeur) {
  const converti = Number(valeur);
  return Number.isFinite(converti) ? converti : 0;
}

/** GET /api/tresorerie — situation de caisse, globale et sur l'année demandée */
routeur.get('/', async (requete, reponse) => {
  const lecture = lireAnnee(requete.query.annee);
  if (lecture.erreur) {
    return reponse.status(400).json({ error: lecture.erreur });
  }
  const annee = lecture.annee;
  const anneeTexte = String(annee);

  try {
    // --- Encaissements effectifs, depuis toujours -------------------------
    const cotisationsTotal = await lireUne(
      "SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre FROM cotisations WHERE statut = 'validee'"
    );

    const penalitesTotal = await lireUne(
      `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
         FROM sanctions
        WHERE type = 'penalite' AND statut = 'reglee'`
    );

    // --- Encaissements de l'année demandée --------------------------------
    const cotisationsAnnee = await lireUne(
      `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
         FROM cotisations
        WHERE statut = 'validee' AND strftime('%Y', date_paiement) = ?`,
      [anneeTexte]
    );

    const penalitesAnnee = await lireUne(
      `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
         FROM sanctions
        WHERE type = 'penalite' AND statut = 'reglee'
          AND strftime('%Y', date_reglement) = ?`,
      [anneeTexte]
    );

    // --- Sommes attendues, pas encore en caisse ---------------------------
    const penalitesDues = await lireUne(
      `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
         FROM sanctions
        WHERE type = 'penalite' AND statut = 'due'`
    );

    const declarationsEnAttente = await lireUne(
      `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
         FROM cotisations
        WHERE statut = 'en_attente'`
    );

    // --- Répartition mensuelle de l'année ---------------------------------
    const cotisationsParMois = await lireToutes(
      `SELECT CAST(strftime('%m', date_paiement) AS INTEGER) AS mois,
              COALESCE(SUM(montant), 0) AS somme
         FROM cotisations
        WHERE statut = 'validee' AND strftime('%Y', date_paiement) = ?
        GROUP BY mois`,
      [anneeTexte]
    );

    const penalitesParMois = await lireToutes(
      `SELECT CAST(strftime('%m', date_reglement) AS INTEGER) AS mois,
              COALESCE(SUM(montant), 0) AS somme
         FROM sanctions
        WHERE type = 'penalite' AND statut = 'reglee'
          AND strftime('%Y', date_reglement) = ?
        GROUP BY mois`,
      [anneeTexte]
    );

    const parMois = MOIS.map((libelle, index) => ({
      mois: libelle,
      cotisations: 0,
      penalites: 0,
      total: 0,
    }));

    for (const ligne of cotisationsParMois) {
      const index = Number(ligne.mois) - 1;
      if (index < 0 || index > 11) continue;
      parMois[index].cotisations = nombre(ligne.somme);
    }

    for (const ligne of penalitesParMois) {
      const index = Number(ligne.mois) - 1;
      if (index < 0 || index > 11) continue;
      parMois[index].penalites = nombre(ligne.somme);
    }

    for (const entree of parMois) {
      entree.total = entree.cotisations + entree.penalites;
    }

    // --- Derniers mouvements, toutes natures confondues --------------------
    // Une union plutôt que deux listes : le lecteur veut un relevé de caisse
    // chronologique, pas deux colonnes à recouper lui-même.
    const mouvements = await lireToutes(
      `SELECT 'cotisation' AS nature, c.id, m.name AS membre, c.montant, c.moyen,
              c.date_paiement AS date, NULL AS motif
         FROM cotisations c JOIN members m ON m.id = c.member_id
        WHERE c.statut = 'validee'
       UNION ALL
       SELECT 'penalite' AS nature, s.id, m.name AS membre, s.montant, s.moyen_reglement AS moyen,
              s.date_reglement AS date, s.motif
         FROM sanctions s JOIN members m ON m.id = s.member_id
        WHERE s.type = 'penalite' AND s.statut = 'reglee'
        ORDER BY date DESC
        LIMIT 20`
    );

    const soldeReel = nombre(cotisationsTotal.somme) + nombre(penalitesTotal.somme);
    const attendu = nombre(penalitesDues.somme) + nombre(declarationsEnAttente.somme);

    const charge = {
      annee,
      mois: MOIS,

      // Ce que l'association détient, tous exercices confondus.
      solde_reel: soldeReel,

      encaisse: {
        cotisations: nombre(cotisationsTotal.somme),
        nb_cotisations: nombre(cotisationsTotal.nombre),
        penalites: nombre(penalitesTotal.somme),
        nb_penalites: nombre(penalitesTotal.nombre),
      },

      // Même décomposition, restreinte à l'année demandée.
      annee_courante: {
        cotisations: nombre(cotisationsAnnee.somme),
        nb_cotisations: nombre(cotisationsAnnee.nombre),
        penalites: nombre(penalitesAnnee.somme),
        nb_penalites: nombre(penalitesAnnee.nombre),
        total: nombre(cotisationsAnnee.somme) + nombre(penalitesAnnee.somme),
      },

      // Sommes annoncées mais pas encore en caisse.
      attendu: {
        total: attendu,
        penalites_dues: nombre(penalitesDues.somme),
        nb_penalites_dues: nombre(penalitesDues.nombre),
        declarations_en_attente: nombre(declarationsEnAttente.somme),
        nb_declarations_en_attente: nombre(declarationsEnAttente.nombre),
      },

      par_mois: parMois,

      derniers_mouvements: mouvements.map((ligne) => ({
        nature: ligne.nature,
        id: ligne.id,
        membre: ligne.membre,
        montant: nombre(ligne.montant),
        moyen: ligne.moyen || null,
        date: ligne.date,
        motif: ligne.motif || null,
      })),
    };

    console.log(
      `[tresorerie] situation servie : solde ${soldeReel} XAF ` +
        `(${charge.encaisse.cotisations} cotisations + ${charge.encaisse.penalites} pénalités), ` +
        `${attendu} XAF attendus`
    );

    return reponse.status(200).json(charge);
  } catch (erreur) {
    console.error(`[tresorerie] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger la trésorerie' });
  }
});

module.exports = routeur;
