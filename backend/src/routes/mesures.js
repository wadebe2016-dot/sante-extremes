/**
 * Mesures du mois — pénalités de retard et mises à l'écart (LOT 4).
 *
 *   GET  /api/mesures?mois=AAAA-MM   (PUBLIC en lecture)
 *   POST /api/mesures/penalites      (censeur ou admin)
 *   POST /api/mesures/ecarts         (secrétaire ou admin)
 *
 * L'APPLICATION PROPOSE, UN RESPONSABLE CONFIRME. Il n'y a ici aucune tâche
 * planifiée, aucune application silencieuse : les listes sont calculées, un
 * humain coche, un humain valide. C'est la règle qui justifie deux routes POST
 * distinctes plutôt qu'un traitement nocturne.
 *
 * BARÈME — 1 mois de retard : 1 000 ; 2 mois : 2 000 ; 3 mois ou plus : mise à
 * l'écart proposée, SANS pénalité en plus. Un membre à trois mois n'apparaît
 * donc jamais dans « à pénaliser ».
 *
 * DATE D'EFFET — avant le 6 octobre 2026, les listes sont calculées et
 * consultables, mais les POST sont refusés en 409. Le bureau voulait voir venir
 * sans pouvoir frapper.
 *
 * IDEMPOTENCE — rejouer la même liste n'inflige rien deux fois : un membre déjà
 * pénalisé pour ce mois, ou déjà écarté, est ignoré sans erreur. La réponse dit
 * combien ont été appliqués et combien ignorés. C'est indispensable sur une
 * connexion mobile, où un envoi peut partir deux fois.
 *
 * Le barème n'est JAMAIS repris du client : le serveur recalcule le nombre de
 * mois dus et le montant. Une application qui se tromperait — ou qu'on aurait
 * bricolée — ne peut pas infliger 50 000 à la place de 1 000.
 */
'use strict';

const express = require('express');
const { executer } = require('../db');
const { exigerRole, estMembreProtege } = require('../middleware/auth');
const {
  SEUIL_ECART,
  dateEffetMesures,
  aujourdhui,
  moisCourant,
  moisValide,
  moisAnneeEnLettres,
  penaliteProposee,
  mesuresApplicables,
  construireSituation,
  classerMesures,
} = require('../services/arrieres');

const routeur = express.Router();

/** Longueur maximale d'un motif de mise à l'écart, comme pour les sanctions. */
const MOTIF_MAX = 200;

/**
 * Lit et valide le mois d'une requête ; le mois courant à défaut.
 * @returns {{mois: string}|{erreur: string}}
 */
function lireMois(valeur) {
  const demande = String(valeur === undefined || valeur === null ? '' : valeur).trim();
  const mois = demande === '' ? moisCourant() : demande;
  if (!moisValide(mois)) return { erreur: 'Mois invalide (format attendu : AAAA-MM)' };
  return { mois };
}

/**
 * Lit une liste d'identifiants de membres.
 *
 * Le plafond protège d'un envoi aberrant : l'association compte une quarantaine
 * de membres, une liste de mille identifiants n'est pas une mesure du mois.
 *
 * @returns {{ids: number[]}|{erreur: string}}
 */
function lireIdentifiants(valeur) {
  if (!Array.isArray(valeur)) {
    return { erreur: 'La liste des membres est obligatoire (member_ids)' };
  }

  if (valeur.length === 0) {
    return { erreur: 'Aucun membre sélectionné' };
  }

  if (valeur.length > 500) {
    return { erreur: 'Liste de membres trop longue' };
  }

  const ids = [];
  for (const brut of valeur) {
    const identifiant = Number.parseInt(brut, 10);
    if (!Number.isInteger(identifiant) || identifiant <= 0) {
      return { erreur: `Identifiant de membre invalide « ${brut} »` };
    }
    // Doublons silencieux : cocher deux fois la même ligne n'est pas une erreur.
    if (!ids.includes(identifiant)) ids.push(identifiant);
  }

  return { ids };
}

/**
 * Construit les trois listes de mesures proposées pour un mois.
 *
 * @param {string} mois mois de référence, AAAA-MM
 * @param {string} [jour] jour de référence ; aujourd'hui par défaut
 */
async function construireMesures(mois, jour = aujourdhui()) {
  const situation = await construireSituation(mois, jour);

  // Le classement vit dans le service : /api/stats en compte les longueurs pour
  // le raccourci de l'écran d'accueil, et deux copies de ces filtres auraient
  // fini par ne plus dire la même chose.
  const classement = classerMesures(situation);

  const aPenaliser = classement.a_penaliser
    .map((membre) => ({
      id: membre.id,
      name: membre.name,
      mois_de_retard: membre.nb_mois,
      mois_dus: membre.mois_dus,
      penalite_proposee: penaliteProposee(membre.nb_mois),
      montant_du: membre.montant_du,
      deja_penalise: false,
    }))
    .sort((a, b) => b.mois_de_retard - a.mois_de_retard || a.name.localeCompare(b.name, 'fr'));

  const aEcarter = classement.a_ecarter
    .map((membre) => ({
      id: membre.id,
      name: membre.name,
      mois_de_retard: membre.nb_mois,
      mois_dus: membre.mois_dus,
      montant_du: membre.montant_du,
    }))
    .sort((a, b) => b.mois_de_retard - a.mois_de_retard || a.name.localeCompare(b.name, 'fr'));

  const peuventJouer = classement.peuvent_jouer
    .map((membre) => ({
      id: membre.id,
      name: membre.name,
      date_versement: membre.date_versement_mois || membre.dernier_versement,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  return {
    mois,
    mois_libelle: moisAnneeEnLettres(mois),
    date_effet: dateEffetMesures(),
    applicable: mesuresApplicables(jour),
    a_penaliser: aPenaliser,
    a_ecarter: aEcarter,
    peuvent_jouer: peuventJouer,
    resume: {
      a_jour: peuventJouer.length,
      a_penaliser: aPenaliser.length,
      a_ecarter: aEcarter.length,
      ecartes_deja: classement.ecartes_deja,
      penalises_deja: classement.penalises_deja,
    },
  };
}

/** GET /api/mesures — ce que le bureau pourrait décider ce mois-ci. */
routeur.get('/', async (requete, reponse) => {
  const lecture = lireMois(requete.query.mois);
  if (lecture.erreur) {
    console.warn(`[mesures] refus : ${lecture.erreur}`);
    return reponse.status(400).json({ error: lecture.erreur });
  }

  try {
    const charge = await construireMesures(lecture.mois);

    console.log(
      `[mesures] ${lecture.mois} servi : ${charge.resume.a_penaliser} à pénaliser, ` +
        `${charge.resume.a_ecarter} à écarter, ${charge.resume.a_jour} à jour ` +
        `(applicable : ${charge.applicable ? 'oui' : `non, à partir du ${dateEffetMesures()}`})`
    );
    return reponse.status(200).json(charge);
  } catch (erreur) {
    console.error(`[mesures] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les mesures du mois' });
  }
});

/**
 * Refus commun aux deux POST tant que la date d'effet n'est pas atteinte.
 * @returns {boolean} true si la requête a été refusée
 */
function refuserAvantDateEffet(reponse, action) {
  if (mesuresApplicables()) return false;

  console.warn(`[mesures] ${action} refusée : applicable à partir du ${dateEffetMesures()}`);
  reponse.status(409).json({
    error: `Mesures applicables à partir du ${dateEffetMesures()}`,
    date_effet: dateEffetMesures(),
    applicable: false,
  });
  return true;
}

/**
 * POST /api/mesures/penalites — inflige les pénalités de retard (censeur).
 * @body mois (AAAA-MM), member_ids (tableau d'entiers)
 */
routeur.post('/penalites', exigerRole('censeur'), async (requete, reponse) => {
  if (refuserAvantDateEffet(reponse, 'application des pénalités')) return;

  const lecture = lireMois(requete.body?.mois);
  if (lecture.erreur) return reponse.status(400).json({ error: lecture.erreur });

  const liste = lireIdentifiants(requete.body?.member_ids);
  if (liste.erreur) return reponse.status(400).json({ error: liste.erreur });

  try {
    const situation = await construireSituation(lecture.mois);
    const parIdentifiant = new Map(situation.map((membre) => [membre.id, membre]));
    const estAdmin = (requete.roles || []).includes('admin');

    const appliques = [];
    const ignores = [];

    for (const identifiant of liste.ids) {
      const membre = parIdentifiant.get(identifiant);

      if (!membre) {
        ignores.push({ id: identifiant, motif: 'membre introuvable' });
        continue;
      }

      if (membre.statut === 'ecarte') {
        ignores.push({ id: identifiant, name: membre.name, motif: 'déjà mis à l’écart' });
        continue;
      }

      if (membre.deja_penalise) {
        ignores.push({ id: identifiant, name: membre.name, motif: 'déjà pénalisé pour ce mois' });
        continue;
      }

      // Le barème vient du serveur, jamais du client.
      const montant = penaliteProposee(membre.nb_mois);
      if (montant <= 0) {
        ignores.push({
          id: identifiant,
          name: membre.name,
          motif: membre.nb_mois >= SEUIL_ECART
            ? 'mise à l’écart proposée, pas de pénalité'
            : 'aucun retard à sanctionner',
        });
        continue;
      }

      // Même protection que POST /api/sanctions : un censeur ne sanctionne pas
      // un censeur. Les mesures du mois ne doivent pas ouvrir une porte dérobée.
      if (estMembreProtege(membre.name) && !estAdmin) {
        ignores.push({
          id: identifiant,
          name: membre.name,
          motif: 'membre protégé, code administrateur requis',
        });
        continue;
      }

      const motif = `Retard de cotisation — ${moisAnneeEnLettres(lecture.mois)} ` +
        `(${membre.nb_mois} mois)`;

      await executer(
        `INSERT INTO sanctions (member_id, type, motif, montant, mois_concerne, inflige_par)
         VALUES (?, 'penalite', ?, ?, ?, ?)`,
        [membre.id, motif.slice(0, MOTIF_MAX), montant, lecture.mois, requete.agent]
      );

      appliques.push({
        id: membre.id,
        name: membre.name,
        mois_de_retard: membre.nb_mois,
        montant,
      });
    }

    console.log(
      `[mesures] pénalités ${lecture.mois} par ${requete.agent} : ` +
        `${appliques.length} appliquée(s), ${ignores.length} ignorée(s)`
    );

    return reponse.status(200).json({
      mois: lecture.mois,
      applique: appliques.length,
      ignore: ignores.length,
      montant_total: appliques.reduce((somme, ligne) => somme + ligne.montant, 0),
      appliques,
      ignores,
      acteur: requete.agent,
    });
  } catch (erreur) {
    console.error(`[mesures] échec de l'application des pénalités : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'appliquer les pénalités" });
  }
});

/**
 * POST /api/mesures/ecarts — met des membres à l'écart (secrétaire).
 * @body mois (AAAA-MM), member_ids (tableau d'entiers), motif (facultatif)
 *
 * « Mis à l'écart », jamais « radié » : le membre reste en base, dans
 * l'historique et dans les exports. Seuls les éligibles d'une séance et le
 * total « X/38 à jour » l'ignorent désormais.
 */
routeur.post('/ecarts', exigerRole('secretaire'), async (requete, reponse) => {
  if (refuserAvantDateEffet(reponse, 'mise à l’écart')) return;

  const lecture = lireMois(requete.body?.mois);
  if (lecture.erreur) return reponse.status(400).json({ error: lecture.erreur });

  const liste = lireIdentifiants(requete.body?.member_ids);
  if (liste.erreur) return reponse.status(400).json({ error: liste.erreur });

  const motifSaisi = typeof requete.body?.motif === 'string' ? requete.body.motif.trim() : '';

  try {
    const situation = await construireSituation(lecture.mois);
    const parIdentifiant = new Map(situation.map((membre) => [membre.id, membre]));

    const appliques = [];
    const ignores = [];

    for (const identifiant of liste.ids) {
      const membre = parIdentifiant.get(identifiant);

      if (!membre) {
        ignores.push({ id: identifiant, motif: 'membre introuvable' });
        continue;
      }

      if (membre.statut === 'ecarte') {
        ignores.push({ id: identifiant, name: membre.name, motif: 'déjà mis à l’écart' });
        continue;
      }

      // Le seuil est recalculé côté serveur : on n'écarte pas quelqu'un qui
      // doit un mois parce que l'application l'aurait mal classé.
      if (membre.nb_mois < SEUIL_ECART) {
        ignores.push({
          id: identifiant,
          name: membre.name,
          motif: `${membre.nb_mois} mois de retard, seuil de ${SEUIL_ECART} non atteint`,
        });
        continue;
      }

      const motif = (motifSaisi ||
        `Retard de cotisation — ${membre.nb_mois} mois dus au ${moisAnneeEnLettres(lecture.mois)}`)
        .slice(0, MOTIF_MAX);

      await executer(
        `UPDATE members
            SET statut = 'ecarte',
                date_statut = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                motif_statut = ?
          WHERE id = ?`,
        [motif, membre.id]
      );

      await executer(
        `INSERT INTO evenements_membres (member_id, type, motif, acteur, mois)
         VALUES (?, 'mise_a_l_ecart', ?, ?, ?)`,
        [membre.id, motif, requete.agent, lecture.mois]
      );

      appliques.push({
        id: membre.id,
        name: membre.name,
        mois_de_retard: membre.nb_mois,
        montant_du: membre.montant_du,
        motif,
      });
    }

    console.log(
      `[mesures] mises à l'écart ${lecture.mois} par ${requete.agent} : ` +
        `${appliques.length} appliquée(s), ${ignores.length} ignorée(s)`
    );

    return reponse.status(200).json({
      mois: lecture.mois,
      applique: appliques.length,
      ignore: ignores.length,
      appliques,
      ignores,
      acteur: requete.agent,
    });
  } catch (erreur) {
    console.error(`[mesures] échec des mises à l'écart : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'appliquer les mises à l'écart" });
  }
});

module.exports = routeur;
module.exports.construireMesures = construireMesures;
