/**
 * État de la trésorerie — Santé des extrêmes (LOT 3 bis).
 *   GET /api/tresorerie?annee=2026   (PUBLIC)
 *
 * Tous les membres doivent pouvoir constater ce que l'association détient
 * réellement. C'est la seule vue qui RÉUNIT toutes les comptabilités :
 *
 *   solde réel = cotisations validées + pénalités encaissées − décaissements
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
const { executer, lireUne, lireToutes } = require('../db');
const { exigerRole } = require('../middleware/auth');
const { lireAnnee, MOIS } = require('./historique');

const routeur = express.Router();

const CLE_OUVERTURE = 'solde_ouverture';

/**
 * Lit le solde d'ouverture, ou null s'il n'a jamais été défini.
 *
 * Tant qu'il est absent, la trésorerie se calcule sur l'intégralité de
 * l'historique — c'est le comportement d'avant, conservé tel quel.
 *
 * @returns {Promise<{montant: number, date: string, commentaire: string|null,
 *                    definit_par: string|null, date_maj: string}|null>}
 */
async function lireSoldeOuverture() {
  const ligne = await lireUne('SELECT valeur, definit_par, date_maj FROM parametres WHERE cle = ?', [
    CLE_OUVERTURE,
  ]);
  if (!ligne || !ligne.valeur) return null;

  try {
    const valeur = JSON.parse(ligne.valeur);
    if (!Number.isFinite(Number(valeur.montant)) || !valeur.date) return null;
    return {
      montant: Number(valeur.montant),
      date: String(valeur.date),
      commentaire: valeur.commentaire || null,
      // Null sur un solde posé avant l'ouverture aux trésoriers : l'application
      // n'affiche alors pas de nom plutôt que d'en inventer un.
      definit_par: ligne.definit_par || null,
      date_maj: ligne.date_maj,
    };
  } catch (erreur) {
    console.warn(`[tresorerie] solde d'ouverture illisible : ${erreur.message}`);
    return null;
  }
}

/**
 * Calcule le solde reel de la caisse et sa composition.
 *
 * Extrait de la route pour etre reutilise par GET /api/stats : l'ecran Etat
 * affiche ce meme chiffre, et deux calculs paralleles finiraient par diverger
 * au premier changement de regle.
 *
 *   solde = ouverture
 *         + cotisations validees et penalites encaissees depuis la date d'ouverture
 *         - decaissements depuis cette date
 *
 * Sans solde d'ouverture, tout l'historique est compte.
 *
 * @returns {Promise<object>} solde, ouverture et detail des composantes
 */
async function calculerSoldeReel() {
  const ouverture = await lireSoldeOuverture();
  const depuis = ouverture ? ouverture.date : null;

  const cotisations = await lireUne(
    `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
       FROM cotisations
      WHERE statut = 'validee'
        ${depuis ? 'AND date_paiement >= ?' : ''}`,
    depuis ? [depuis] : []
  );

  const penalites = await lireUne(
    `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
       FROM sanctions
      WHERE type = 'penalite' AND statut = 'reglee'
        ${depuis ? 'AND date_reglement >= ?' : ''}`,
    depuis ? [depuis] : []
  );

  const decaissements = await lireUne(
    `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
       FROM decaissements
      ${depuis ? 'WHERE date_paiement >= ?' : ''}`,
    depuis ? [depuis] : []
  );

  const solde =
    (ouverture ? ouverture.montant : 0) +
    nombre(cotisations.somme) +
    nombre(penalites.somme) -
    nombre(decaissements.somme);

  return { solde, ouverture, cotisations, penalites, decaissements };
}

/** Somme d'une requête agrégée, ramenée à un nombre sûr. */
function nombre(valeur) {
  const converti = Number(valeur);
  return Number.isFinite(converti) ? converti : 0;
}

/**
 * PUT /api/tresorerie/solde-ouverture — fixer le point de départ (trésorier).
 *
 * Ouvert aux trésoriers, l'admin conservant l'accès : la reprise de caisse est
 * un geste de trésorerie, et l'exiger de l'administration bloquait l'opération
 * la plus courante derrière la personne la moins disponible.
 *
 * Le contrepoids n'est pas le verrou mais la trace : le nom de qui a fixé le
 * montant est enregistré dans « parametres.definit_par », renvoyé par les deux
 * routes de lecture et inscrit au journal. Un solde d'ouverture déplace le
 * solde affiché à toute l'association ; il ne doit jamais être anonyme.
 */
routeur.put('/solde-ouverture', exigerRole('tresorier'), async (requete, reponse) => {
  const montant = Number.parseFloat(requete.body?.montant);
  const date = String(requete.body?.date || '').trim();
  const commentaire =
    typeof requete.body?.commentaire === 'string' ? requete.body.commentaire.trim() : '';

  if (!Number.isFinite(montant) || montant < 0) {
    return reponse.status(400).json({ error: 'Le montant doit être un nombre positif ou nul' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return reponse.status(400).json({ error: 'Date invalide (format attendu : AAAA-MM-JJ)' });
  }

  try {
    const valeur = JSON.stringify({
      montant,
      date,
      commentaire: commentaire ? commentaire.slice(0, 300) : null,
    });

    // requete.agent : nom du trésorier nominatif, sinon « admin » ou le rôle.
    const acteur = requete.agent || 'admin';

    await executer(
      `INSERT INTO parametres (cle, valeur, definit_par, date_maj)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (cle) DO UPDATE
         SET valeur = excluded.valeur,
             definit_par = excluded.definit_par,
             date_maj = excluded.date_maj`,
      [CLE_OUVERTURE, valeur, acteur]
    );

    console.log(`[tresorerie] solde d'ouverture fixé par ${acteur} : ${montant} XAF au ${date}`);
    return reponse.status(200).json(await lireSoldeOuverture());
  } catch (erreur) {
    console.error(`[tresorerie] enregistrement du solde d'ouverture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible d’enregistrer le solde d’ouverture' });
  }
});

/** GET /api/tresorerie — situation de caisse, globale et sur l'année demandée */
routeur.get('/', async (requete, reponse) => {
  const lecture = lireAnnee(requete.query.annee);
  if (lecture.erreur) {
    return reponse.status(400).json({ error: lecture.erreur });
  }
  const annee = lecture.annee;
  const anneeTexte = String(annee);

  try {
    // LOT 3 ter — le solde d'ouverture fixe le point de départ : seuls les
    // mouvements postérieurs s'y ajoutent. Sans lui, on additionne tout
    // l'historique, exactement comme avant.
    const situation = await calculerSoldeReel();
    const ouverture = situation.ouverture;
    const depuis = ouverture ? ouverture.date : null;
    const cotisationsTotal = situation.cotisations;
    const penalitesTotal = situation.penalites;

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

    // --- Sorties de caisse ------------------------------------------------
    const decaissementsTotal = situation.decaissements;

    const decaissementsAnnee = await lireUne(
      `SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre
         FROM decaissements
        WHERE strftime('%Y', date_paiement) = ?`,
      [anneeTexte]
    );

    // Demandes approuvées et non encore payées : l'argent est promis, il est
    // encore en caisse mais ne doit pas être considéré comme disponible.
    const engage = await lireUne(
      `SELECT COALESCE(SUM(montant_estime), 0) AS somme, COUNT(*) AS nombre
         FROM demandes
        WHERE statut = 'approuvee'`
    );

    const demandesEnAttente = await lireUne(
      `SELECT COALESCE(SUM(montant_estime), 0) AS somme, COUNT(*) AS nombre
         FROM demandes
        WHERE statut = 'en_attente'`
    );

    const depensesParCategorie = await lireToutes(
      `SELECT d.categorie, COALESCE(SUM(x.montant), 0) AS somme, COUNT(*) AS nombre
         FROM decaissements x
         JOIN demandes d ON d.id = x.demande_id
        GROUP BY d.categorie
        ORDER BY somme DESC`
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
    const decaissementsParMois = await lireToutes(
      `SELECT CAST(strftime('%m', date_paiement) AS INTEGER) AS mois,
              COALESCE(SUM(montant), 0) AS somme
         FROM decaissements
        WHERE strftime('%Y', date_paiement) = ?
        GROUP BY mois`,
      [anneeTexte]
    );

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

    const parMois = MOIS.map((libelle) => ({
      mois: libelle,
      cotisations: 0,
      penalites: 0,
      depenses: 0,
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

    for (const ligne of decaissementsParMois) {
      const index = Number(ligne.mois) - 1;
      if (index < 0 || index > 11) continue;
      parMois[index].depenses = nombre(ligne.somme);
    }

    // Solde net du mois : ce qui est entré moins ce qui est sorti.
    for (const entree of parMois) {
      entree.total = entree.cotisations + entree.penalites - entree.depenses;
    }

    // --- Derniers mouvements, toutes natures confondues --------------------
    // Une union plutôt que deux listes : le lecteur veut un relevé de caisse
    // chronologique, pas deux colonnes à recouper lui-même.
    // Les décaissements y figurent en négatif : un relevé de caisse mêle les
    // entrées et les sorties, c'est son intérêt.
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
       UNION ALL
       SELECT 'depense' AS nature, x.id, d.libelle AS membre, -x.montant AS montant, x.moyen,
              x.date_paiement AS date, d.categorie AS motif
         FROM decaissements x JOIN demandes d ON d.id = x.demande_id
        ORDER BY date DESC
        LIMIT 20`
    );

    const soldeReel = situation.solde;

    const attendu = nombre(penalitesDues.somme) + nombre(declarationsEnAttente.somme);

    const charge = {
      annee,
      mois: MOIS,

      // Ce que l'association détient, tous exercices confondus.
      solde_reel: soldeReel,

      // Point de départ du calcul, null tant qu'il n'a pas été défini.
      solde_ouverture: ouverture,

      encaisse: {
        cotisations: nombre(cotisationsTotal.somme),
        nb_cotisations: nombre(cotisationsTotal.nombre),
        penalites: nombre(penalitesTotal.somme),
        nb_penalites: nombre(penalitesTotal.nombre),
        total: nombre(cotisationsTotal.somme) + nombre(penalitesTotal.somme),
      },

      // Ce qui est sorti de caisse, et ce qui est promis sans être sorti.
      depense: {
        total: nombre(decaissementsTotal.somme),
        nombre: nombre(decaissementsTotal.nombre),
        par_categorie: depensesParCategorie.map((ligne) => ({
          categorie: ligne.categorie,
          montant: nombre(ligne.somme),
          nombre: nombre(ligne.nombre),
        })),
      },

      engage: {
        total: nombre(engage.somme),
        nombre: nombre(engage.nombre),
        demandes_en_attente: nombre(demandesEnAttente.somme),
        nb_demandes_en_attente: nombre(demandesEnAttente.nombre),
      },

      // Même décomposition, restreinte à l'année demandée.
      annee_courante: {
        cotisations: nombre(cotisationsAnnee.somme),
        nb_cotisations: nombre(cotisationsAnnee.nombre),
        penalites: nombre(penalitesAnnee.somme),
        nb_penalites: nombre(penalitesAnnee.nombre),
        depenses: nombre(decaissementsAnnee.somme),
        nb_depenses: nombre(decaissementsAnnee.nombre),
        total:
          nombre(cotisationsAnnee.somme) +
          nombre(penalitesAnnee.somme) -
          nombre(decaissementsAnnee.somme),
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
        `(${ouverture ? `ouverture ${ouverture.montant} au ${ouverture.date} + ` : ''}` +
        `${charge.encaisse.cotisations} cotisations + ${charge.encaisse.penalites} pénalités ` +
        `− ${charge.depense.total} dépenses), ${attendu} XAF attendus, ` +
        `${charge.engage.total} XAF engagés`
    );

    return reponse.status(200).json(charge);
  } catch (erreur) {
    console.error(`[tresorerie] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger la trésorerie' });
  }
});

module.exports = routeur;
module.exports.calculerSoldeReel = calculerSoldeReel;
