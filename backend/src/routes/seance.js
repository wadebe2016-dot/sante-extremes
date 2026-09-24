/**
 * Feuille de séance — qui peut jouer aujourd'hui (LOT 4).
 *   GET /api/seance?date=AAAA-MM-JJ   (PUBLIC, aujourd'hui par défaut)
 *
 * On ne joue plus à crédit : pour fouler le terrain, la cotisation du mois doit
 * être VERSÉE ET VALIDÉE avant le coup d'envoi. Les censeurs contrôlent à
 * l'entrée, d'où une route publique, sans code : il faut qu'elle s'ouvre en
 * deux secondes sur un téléphone, au bord du terrain.
 *
 * RÈGLES D'ÉLIGIBILITÉ, DANS CET ORDRE — le premier motif rencontré l'emporte :
 *
 *   a. suspension active (sanction, terme non échu) → « suspendu jusqu’au JJ/MM »
 *   b. membre mis à l'écart                          → « mis à l'écart »
 *   c. cotisation du mois validée                    → ÉLIGIBLE
 *   d. déclaration en attente de validation          → « déclaration en attente
 *                                                        de validation »
 *   e. adhésion postérieure au mois de la séance     → « adhésion à partir de … »
 *   f. sinon                                         → « cotisation de <mois>
 *                                                        non versée »
 *
 * L'ordre n'est pas indifférent : une suspension prime sur une cotisation à
 * jour — un membre suspendu qui a payé ne joue pas pour autant. À l'inverse,
 * les PÉNALITÉS DUES N'EMPÊCHENT PAS DE JOUER : elles sont signalées sur la
 * ligne, jamais bloquantes. Le bureau sanctionne le retard de cotisation, pas
 * le retard de règlement d'une pénalité.
 *
 * Le cas (e) n'était pas au cahier des charges : sans lui, un membre inscrit en
 * novembre apparaissait « cotisation d'octobre non versée » pour une séance
 * d'octobre, alors qu'il n'était pas encore là.
 */
'use strict';

const express = require('express');
const {
  aujourdhui,
  jourValide,
  jourCourt,
  moisEnLettres,
  moisAnneeEnLettres,
  construireSituation,
} = require('../services/arrieres');

const routeur = express.Router();

/**
 * Motif d'inéligibilité d'un membre, ou null s'il peut jouer.
 * @param {object} membre état issu de construireSituation
 * @param {string} mois mois de la séance, AAAA-MM
 */
function motifInegibilite(membre, mois) {
  if (membre.suspendu) {
    const terme = jourCourt(membre.date_fin_suspension);
    return terme ? `suspendu jusqu’au ${terme}` : 'suspendu';
  }

  if (membre.statut === 'ecarte') return 'mis à l’écart';
  if (membre.cotisation_mois_validee) return null;
  if (membre.declaration_en_attente) return 'déclaration en attente de validation';
  if (membre.pas_encore_adherent) return `adhésion à partir de ${moisAnneeEnLettres(membre.adhesion)}`;

  return `cotisation de ${moisEnLettres(mois)} non versée`;
}

/** GET /api/seance — éligibles et non éligibles de la séance du jour. */
routeur.get('/', async (requete, reponse) => {
  const demande = String(requete.query.date || '').trim();
  const date = demande === '' ? aujourdhui() : demande;

  if (!jourValide(date)) {
    console.warn(`[seance] refus : date invalide « ${demande} »`);
    return reponse.status(400).json({ error: 'Date invalide (format attendu : AAAA-MM-JJ)' });
  }

  const mois = date.slice(0, 7);

  try {
    // Le jour de la séance sert de référence aux suspensions : une séance
    // consultée pour demain doit tenir compte d'un terme qui tombe ce soir.
    const situation = await construireSituation(mois, date);

    const eligibles = [];
    const nonEligibles = [];

    for (const membre of situation) {
      const motif = motifInegibilite(membre, mois);

      if (motif === null) {
        eligibles.push({
          id: membre.id,
          name: membre.name,
          montant_verse: membre.montant_verse_mois,
          date_versement: membre.date_versement_mois,
          // Signalée, jamais bloquante : le censeur la rappelle au membre sans
          // lui interdire le terrain.
          penalite_due: membre.penalites_dues,
        });
        continue;
      }

      nonEligibles.push({
        id: membre.id,
        name: membre.name,
        motif,
        mois_dus: membre.nb_mois,
        montant_du: membre.montant_du,
        suspendu: membre.suspendu,
        date_fin_suspension: membre.date_fin_suspension,
        ecarte: membre.statut === 'ecarte',
        penalite_due: membre.penalites_dues,
      });
    }

    // Les deux listes restent en ordre alphabétique : le censeur cherche un nom,
    // il ne parcourt pas un classement.
    const parNom = (a, b) => a.name.localeCompare(b.name, 'fr');
    eligibles.sort(parNom);
    nonEligibles.sort(parNom);

    const charge = {
      date,
      mois,
      mois_libelle: moisEnLettres(mois),
      eligibles,
      non_eligibles: nonEligibles,
      resume: {
        total_membres: situation.length,
        eligibles: eligibles.length,
        non_eligibles: nonEligibles.length,
      },
    };

    console.log(
      `[seance] ${date} servie : ${eligibles.length} peuvent jouer, ` +
        `${nonEligibles.length} non éligibles sur ${situation.length} membre(s)`
    );
    return reponse.status(200).json(charge);
  } catch (erreur) {
    console.error(`[seance] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger la feuille de séance' });
  }
});

module.exports = routeur;
module.exports.motifInegibilite = motifInegibilite;
