/**
 * Journal d'activité — Santé des extrêmes (LOT 3 ter).
 *   GET /api/journal?annee=2026&limite=100   (PUBLIC)
 *
 * Reconstitue, en un seul fil chronologique, ce qui s'est passé dans
 * l'association : cotisations tranchées, sanctions, demandes de dépense,
 * décaissements, publication du règlement, solde d'ouverture.
 *
 * C'est une vue de REDEVABILITÉ : elle dit qui a fait quoi, et quand. D'où la
 * colonne « acteur », alimentée par les colonnes de traçabilité posées au
 * LOT 3 ter (valide_par, encaisse_par, approuve_par, decaisse_par) et par
 * parametres.definit_par pour le solde d'ouverture.
 *
 * Ce que le journal ne contient JAMAIS :
 *   - les fiches santé, ni leur existence — ce sont des données de santé ;
 *   - la moindre clé S3 ou URL de justificatif — le fil est public, les pièces
 *     ne le sont pas ;
 *   - les déclarations en attente : tant que rien n'est tranché, il n'y a pas
 *     d'événement à consigner.
 */
'use strict';

const express = require('express');
const { lireUne, lireToutes } = require('../db');
const { lireAnnee } = require('./historique');
const { CATEGORIES } = require('./demandes');

const routeur = express.Router();

const LIMITE_DEFAUT = 100;
const LIMITE_MAX = 500;

/**
 * Types d'événement et leur libellé, pour que l'application n'ait pas à les
 * deviner ni à les traduire de son côté.
 */
const TYPES = Object.freeze({
  cotisation_validee: 'Cotisation validée',
  cotisation_refusee: 'Déclaration refusée',
  penalite_infligee: 'Pénalité infligée',
  penalite_reglee: 'Pénalité encaissée',
  suspension_infligee: 'Suspension prononcée',
  suspension_levee: 'Suspension levée',
  demande_exprimee: 'Besoin exprimé',
  demande_approuvee: 'Demande approuvée',
  demande_refusee: 'Demande refusée',
  decaissement: 'Décaissement',
  reglement_publie: 'Règlement intérieur publié',
  solde_ouverture: 'Solde d’ouverture défini',
});

/** Libellé lisible d'un rôle, quand l'acteur n'est pas un trésorier nommé. */
const LIBELLE_ROLE = Object.freeze({
  admin: 'Administration',
  tresorier: 'Trésorier',
  secretaire: 'Secrétariat',
  censeur: 'Censeur',
  intendant: 'Intendance',
  competitions: 'Compétitions',
});

function acteurLisible(valeur) {
  if (!valeur) return null;
  return LIBELLE_ROLE[valeur] || valeur;
}

/** GET /api/journal — fil chronologique des décisions et mouvements */
routeur.get('/', async (requete, reponse) => {
  const lecture = lireAnnee(requete.query.annee);
  if (lecture.erreur) {
    return reponse.status(400).json({ error: lecture.erreur });
  }

  // Une année explicite restreint le fil ; sans paramètre, on prend l'année en
  // cours — un journal sans borne deviendrait illisible au fil des saisons.
  const annee = lecture.annee;
  const anneeTexte = String(annee);

  let limite = Number.parseInt(requete.query.limite, 10);
  if (!Number.isInteger(limite) || limite <= 0) limite = LIMITE_DEFAUT;
  limite = Math.min(limite, LIMITE_MAX);

  try {
    // Une seule union : les événements doivent être triés ensemble, pas
    // concaténés par table puis retriés à la main.
    const lignes = await lireToutes(
      `
      SELECT * FROM (
        -- Cotisations tranchées par le trésorier
        SELECT c.date_validation AS date,
               CASE WHEN c.statut = 'validee' THEN 'cotisation_validee' ELSE 'cotisation_refusee' END AS type,
               m.name AS membre,
               c.montant AS montant,
               c.motif_refus AS detail,
               c.valide_par AS acteur
          FROM cotisations c
          JOIN members m ON m.id = c.member_id
         WHERE c.statut IN ('validee', 'refusee')
           AND c.date_validation IS NOT NULL
           AND strftime('%Y', c.date_validation) = ?

        UNION ALL

        -- Sanctions prononcées
        SELECT s.date_sanction AS date,
               CASE WHEN s.type = 'penalite' THEN 'penalite_infligee' ELSE 'suspension_infligee' END AS type,
               m.name AS membre,
               s.montant AS montant,
               s.motif AS detail,
               'censeur' AS acteur
          FROM sanctions s
          JOIN members m ON m.id = s.member_id
         WHERE s.statut <> 'annulee'
           AND strftime('%Y', s.date_sanction) = ?

        UNION ALL

        -- Pénalités encaissées
        SELECT s.date_reglement AS date,
               'penalite_reglee' AS type,
               m.name AS membre,
               s.montant AS montant,
               s.moyen_reglement AS detail,
               s.encaisse_par AS acteur
          FROM sanctions s
          JOIN members m ON m.id = s.member_id
         WHERE s.type = 'penalite' AND s.statut = 'reglee'
           AND s.date_reglement IS NOT NULL
           AND strftime('%Y', s.date_reglement) = ?

        UNION ALL

        -- Suspensions levées avant terme
        SELECT s.date_sanction AS date,
               'suspension_levee' AS type,
               m.name AS membre,
               NULL AS montant,
               s.motif AS detail,
               'censeur' AS acteur
          FROM sanctions s
          JOIN members m ON m.id = s.member_id
         WHERE s.type = 'suspension' AND s.statut = 'levee'
           AND strftime('%Y', s.date_sanction) = ?

        UNION ALL

        -- Besoins exprimés
        SELECT d.date_demande AS date,
               'demande_exprimee' AS type,
               d.libelle AS membre,
               d.montant_estime AS montant,
               d.categorie AS detail,
               d.role_demandeur AS acteur
          FROM demandes d
         WHERE strftime('%Y', d.date_demande) = ?

        UNION ALL

        -- Décisions du trésorier sur les demandes
        SELECT d.date_decision AS date,
               CASE WHEN d.statut = 'refusee' THEN 'demande_refusee' ELSE 'demande_approuvee' END AS type,
               d.libelle AS membre,
               d.montant_estime AS montant,
               COALESCE(d.motif_refus, d.categorie) AS detail,
               d.approuve_par AS acteur
          FROM demandes d
         WHERE d.date_decision IS NOT NULL
           AND d.statut IN ('approuvee', 'refusee', 'payee')
           AND strftime('%Y', d.date_decision) = ?

        UNION ALL

        -- Sorties de caisse
        SELECT x.date_paiement AS date,
               'decaissement' AS type,
               d.libelle AS membre,
               x.montant AS montant,
               d.categorie AS detail,
               x.decaisse_par AS acteur
          FROM decaissements x
          JOIN demandes d ON d.id = x.demande_id
         WHERE strftime('%Y', x.date_paiement) = ?

        UNION ALL

        -- Publication du règlement intérieur (jamais les fiches santé)
        SELECT o.date_depot AS date,
               'reglement_publie' AS type,
               o.nom_fichier AS membre,
               NULL AS montant,
               NULL AS detail,
               'secretaire' AS acteur
          FROM documents o
         WHERE o.type = 'reglement'
           AND strftime('%Y', o.date_depot) = ?
      )
      ORDER BY date DESC
      LIMIT ?
      `,
      [anneeTexte, anneeTexte, anneeTexte, anneeTexte, anneeTexte, anneeTexte, anneeTexte, anneeTexte, limite]
    );

    const evenements = lignes.map((ligne) => ({
      date: ligne.date,
      type: ligne.type,
      type_libelle: TYPES[ligne.type] || ligne.type,
      // « sujet » plutôt que « membre » : selon l'événement, c'est un membre,
      // un libellé de dépense ou un nom de fichier.
      sujet: ligne.membre,
      montant: ligne.montant === null ? null : Number(ligne.montant),
      detail: CATEGORIES[ligne.detail] || ligne.detail || null,
      acteur: acteurLisible(ligne.acteur),
    }));

    // Le solde d'ouverture ne vit pas dans une table d'événements : on l'ajoute
    // à sa place chronologique s'il tombe dans l'année demandée.
    const ouverture = await lireUne(
      "SELECT valeur, definit_par, date_maj FROM parametres WHERE cle = 'solde_ouverture'"
    );
    if (ouverture && ouverture.valeur) {
      try {
        const valeur = JSON.parse(ouverture.valeur);
        if (String(valeur.date || '').startsWith(anneeTexte)) {
          evenements.push({
            date: `${valeur.date}T00:00:00Z`,
            type: 'solde_ouverture',
            type_libelle: TYPES.solde_ouverture,
            sujet: valeur.commentaire || 'Point de départ de la trésorerie',
            montant: Number(valeur.montant),
            detail: null,
            // Le solde d'ouverture est ouvert aux trésoriers : l'acteur est le
            // nom de celui qui l'a fixé. Les soldes posés avant cette ouverture
            // n'ont pas de nom enregistré — ils venaient forcément de l'admin.
            acteur: acteurLisible(ouverture.definit_par) || LIBELLE_ROLE.admin,
          });
          evenements.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        }
      } catch (erreur) {
        console.warn(`[journal] solde d'ouverture illisible : ${erreur.message}`);
      }
    }

    console.log(`[journal] année ${annee} servie : ${evenements.length} événement(s)`);
    return reponse.status(200).json({
      annee,
      limite,
      nombre: evenements.length,
      types: TYPES,
      evenements: evenements.slice(0, limite),
    });
  } catch (erreur) {
    console.error(`[journal] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger le journal' });
  }
});

module.exports = routeur;
module.exports.TYPES = TYPES;
