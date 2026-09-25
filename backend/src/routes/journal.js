/**
 * Journal d'activité — Santé des extrêmes (LOT 3 ter).
 *   GET /api/journal?annee=2026&limite=100   (PUBLIC)
 *
 * Reconstitue, en un seul fil chronologique, ce qui s'est passé dans
 * l'association : cotisations tranchées, sanctions, demandes de dépense,
 * décaissements, publication du règlement, solde d'ouverture, et depuis le
 * LOT 4 les mises à l'écart et les réintégrations.
 *
 * LOT 5 — une demande à plusieurs postes donne UN « Besoin exprimé », qui
 * annonce le nombre de postes et le total estimé, puis UN événement par poste
 * approuvé, refusé ou payé : c'est poste par poste que le trésorier tranche,
 * c'est poste par poste que le journal en rend compte.
 *
 * C'est une vue de REDEVABILITÉ : elle dit qui a fait quoi, et quand. D'où la
 * colonne « acteur », alimentée par les colonnes de traçabilité posées au
 * LOT 3 ter (valide_par, encaisse_par, approuve_par, decaisse_par) et par
 * parametres.definit_par pour le solde d'ouverture.
 *
 * Une cotisation y est rangée à sa date de VALIDATION — c'est la décision qui
 * fait l'événement — et porte en plus sa date de versement : « Cotisation de mai
 * versée le 18 sept » quand l'argent a été remis après le mois qu'il couvre.
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
const { lireAnnee, MOIS } = require('./historique');
const { CATEGORIES } = require('./demandes');
const { estRegularisation } = require('./cotisations');

const routeur = express.Router();

const LIMITE_DEFAUT = 100;
const LIMITE_MAX = 500;

/** Mois en toutes lettres, index 0 = janvier. MOIS, lui, porte les abréviations. */
const MOIS_LONGS = Object.freeze([
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]);

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
  membre_ecarte: 'Membre mis à l’écart',
  membre_reintegre: 'Membre réintégré',
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

/** Mois en toutes lettres d'une date ISO : « mai ». */
function moisLong(iso) {
  const numero = Number(String(iso || '').slice(5, 7));
  return numero >= 1 && numero <= 12 ? MOIS_LONGS[numero - 1] : null;
}

/** Jour abrégé d'une date ISO : « 18 sept ». */
function jourCourt(iso) {
  const texte = String(iso || '');
  const jour = Number(texte.slice(8, 10));
  const numero = Number(texte.slice(5, 7));
  if (!jour || numero < 1 || numero > 12) return null;
  return `${jour} ${MOIS[numero - 1]}`;
}

/**
 * Libellé d'une cotisation validée.
 *
 * Le journal doit répondre à la question qu'on lui pose : « qu'est-ce qui est
 * entré en caisse ce jour-là ? ». Un mois dû antérieur au mois du versement est
 * une régularisation, et le taire donnerait l'impression d'un doublon — deux
 * lignes de cotisation le même jour pour le même membre.
 *
 *   « Cotisation de mai versée le 18 sept »   régularisation
 *   « Cotisation de septembre »               versement dans son mois
 *
 * @returns {string} libellé, ou celui du type si les dates manquent
 */
function libelleCotisation(moisDu, versement, regularisation) {
  const mois = moisLong(moisDu);
  if (!mois) return TYPES.cotisation_validee;

  if (!regularisation) return `Cotisation de ${mois}`;

  const jour = jourCourt(versement);
  return jour ? `Cotisation de ${mois} versée le ${jour}` : `Cotisation de ${mois} · régularisation`;
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
               c.valide_par AS acteur,
               c.date_paiement AS mois_du,
               COALESCE(c.date_versement, c.date_validation) AS versement
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
               COALESCE(s.inflige_par, 'censeur') AS acteur,
               NULL AS mois_du,
               NULL AS versement
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
               s.encaisse_par AS acteur,
               NULL AS mois_du,
               NULL AS versement
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
               COALESCE(s.inflige_par, 'censeur') AS acteur,
               NULL AS mois_du,
               NULL AS versement
          FROM sanctions s
          JOIN members m ON m.id = s.member_id
         WHERE s.type = 'suspension' AND s.statut = 'levee'
           AND strftime('%Y', s.date_sanction) = ?

        UNION ALL

        -- Besoins exprimés. UN événement par demande, quel que soit le nombre
        -- de postes : « Besoin exprimé — 3 postes, 18 000 estimés ». Le détail
        -- poste par poste vient ensuite, à mesure des décisions.
        SELECT d.date_demande AS date,
               'demande_exprimee' AS type,
               CASE WHEN COUNT(l.id) > 1
                    THEN COUNT(l.id) || ' postes'
                    ELSE COALESCE(MIN(l.libelle), d.libelle) END AS membre,
               COALESCE(SUM(l.montant_estime), d.montant_estime) AS montant,
               CASE WHEN COUNT(l.id) > 1
                    THEN NULL
                    ELSE COALESCE(MIN(l.categorie), d.categorie) END AS detail,
               d.role_demandeur AS acteur,
               NULL AS mois_du,
               NULL AS versement
          FROM demandes d
          LEFT JOIN demande_lignes l ON l.demande_id = d.id
         WHERE strftime('%Y', d.date_demande) = ?
         GROUP BY d.id

        UNION ALL

        -- Décisions du trésorier, POSTE PAR POSTE (LOT 5) : il peut approuver
        -- l'eau et refuser le kiné le même jour, et le journal doit montrer les
        -- deux décisions, pas une moyenne des deux.
        SELECT l.date_decision AS date,
               CASE WHEN l.statut = 'refusee' THEN 'demande_refusee' ELSE 'demande_approuvee' END AS type,
               l.libelle AS membre,
               l.montant_estime AS montant,
               COALESCE(l.motif_refus, l.categorie) AS detail,
               l.approuve_par AS acteur,
               NULL AS mois_du,
               NULL AS versement
          FROM demande_lignes l
         WHERE l.date_decision IS NOT NULL
           AND l.statut IN ('approuvee', 'refusee', 'payee')
           AND strftime('%Y', l.date_decision) = ?

        UNION ALL

        -- Sorties de caisse, une par poste payé
        SELECT x.date_paiement AS date,
               'decaissement' AS type,
               l.libelle AS membre,
               x.montant AS montant,
               l.categorie AS detail,
               x.decaisse_par AS acteur,
               NULL AS mois_du,
               NULL AS versement
          FROM decaissements x
          JOIN demande_lignes l ON l.id = x.ligne_id
         WHERE strftime('%Y', x.date_paiement) = ?

        UNION ALL

        -- LOT 4 — mises à l'écart et réintégrations.
        --
        -- « members.statut » dit l'état courant, pas l'histoire : sans cette
        -- table, une réintégration effaçait toute trace de la mise à l'écart
        -- qui l'avait précédée, et la décision devenait injustifiable en
        -- assemblée.
        SELECT e.date_evenement AS date,
               CASE WHEN e.type = 'mise_a_l_ecart' THEN 'membre_ecarte' ELSE 'membre_reintegre' END AS type,
               m.name AS membre,
               NULL AS montant,
               e.motif AS detail,
               e.acteur AS acteur,
               NULL AS mois_du,
               NULL AS versement
          FROM evenements_membres e
          JOIN members m ON m.id = e.member_id
         WHERE strftime('%Y', e.date_evenement) = ?

        UNION ALL

        -- Publication du règlement intérieur (jamais les fiches santé)
        SELECT o.date_depot AS date,
               'reglement_publie' AS type,
               o.nom_fichier AS membre,
               NULL AS montant,
               NULL AS detail,
               'secretaire' AS acteur,
               NULL AS mois_du,
               NULL AS versement
          FROM documents o
         WHERE o.type = 'reglement'
           AND strftime('%Y', o.date_depot) = ?
      )
      ORDER BY date DESC
      LIMIT ?
      `,
      [
        anneeTexte, anneeTexte, anneeTexte, anneeTexte, anneeTexte,
        anneeTexte, anneeTexte, anneeTexte, anneeTexte, limite,
      ]
    );

    const evenements = lignes.map((ligne) => {
      const regularisation =
        ligne.type === 'cotisation_validee' && estRegularisation(ligne.mois_du, ligne.versement);

      return {
        date: ligne.date,
        type: ligne.type,
        // Une cotisation validée dit de quel mois elle relève, et le jour de la
        // remise quand les deux diffèrent. Les autres événements gardent le
        // libellé de leur type.
        type_libelle:
          ligne.type === 'cotisation_validee'
            ? libelleCotisation(ligne.mois_du, ligne.versement, regularisation)
            : TYPES[ligne.type] || ligne.type,
        // « sujet » plutôt que « membre » : selon l'événement, c'est un membre,
        // un libellé de dépense ou un nom de fichier.
        sujet: ligne.membre,
        montant: ligne.montant === null ? null : Number(ligne.montant),
        detail: CATEGORIES[ligne.detail] || ligne.detail || null,
        acteur: acteurLisible(ligne.acteur),
        date_versement: ligne.versement || null,
        regularisation,
      };
    });

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
            date_versement: null,
            regularisation: false,
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
