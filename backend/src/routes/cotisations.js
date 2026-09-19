/**
 * Route d'enregistrement des paiements de cotisation.
 *   POST /api/cotisations  (trésorier — multipart/form-data)
 *   champs : member_id, montant, moyen, date_versement, mois (facultatif),
 *            fichier (facultatif)
 *
 * Le justificatif est déposé sur S3, puis la cotisation est écrite en base.
 *
 * LOT 3 : la route passe sous le code trésorier, et accepte un mois de
 * rattrapage (saisie d'un paiement reçu au titre d'un mois antérieur).
 *
 * TROIS DATES, TROIS USAGES — la confusion entre les deux premières faisait
 * disparaître de l'argent du solde de caisse :
 *
 *   date_paiement    MOIS DÛ. Le 5 du mois concerné, par convention du champ
 *                    « mois ». Sert à la répartition mensuelle : statut
 *                    payé/impayé, historique annuel, exports.
 *   date_versement   ENTRÉE EN CAISSE. Le jour où l'argent a été remis, saisi
 *                    par le membre ou le trésorier. OBLIGATOIRE. Sert à la
 *                    trésorerie, et à elle seule.
 *   date_validation  CONTRÔLE DU TRÉSORIER. Posée à la validation. Sert à la
 *                    traçabilité et au journal.
 *
 * Une cotisation dont le mois dû précède le mois du versement est une
 * « régularisation » : le drapeau est calculé, jamais stocké.
 */
'use strict';

const express = require('express');
const { executer, lireUne, lireToutes } = require('../db');
const { exigerRole, memeMembre } = require('../middleware/auth');
const {
  recevoirJustificatif,
  recevoirRecu,
  televerserJustificatif,
  televerserJustificatifDetaille,
  urlPresignee,
  gererErreursUpload,
} = require('../middleware/s3upload');

const routeur = express.Router();
const MOYENS_AUTORISES = ['Mobile Money', 'Espèce'];

/**
 * Ramène le moyen de paiement reçu à sa valeur canonique, en tolérant la casse
 * et l'absence d'accent (certains clients envoient « Espece »).
 * @returns {string|null} valeur canonique ou null si le moyen est inconnu
 */
function normaliserMoyen(valeur) {
  const brut = String(valeur || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // retire les accents
    .trim()
    .toLowerCase();

  if (brut === 'mobile money') return 'Mobile Money';
  if (brut === 'espece' || brut === 'especes') return 'Espèce';
  return null;
}

/**
 * Convertit un mois de rattrapage « AAAA-MM » en date de paiement.
 *
 * On retient le 5 du mois à 12:00Z : une date en milieu de journée et de
 * première semaine reste dans le bon mois quel que soit le fuseau de lecture,
 * là où le 1ᵉʳ à minuit basculerait sur le mois précédent à l'ouest de Greenwich.
 *
 * @param {string} valeur mois demandé, au format AAAA-MM
 * @returns {{date: string}|{erreur: string}} date ISO à enregistrer, ou motif de refus
 */
function convertirMoisEnDate(valeur) {
  const mois = String(valeur || '').trim();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mois)) {
    return { erreur: 'Mois invalide (format attendu : AAAA-MM)' };
  }

  const moisCourant = new Date().toISOString().slice(0, 7);
  if (mois > moisCourant) {
    // Comparaison lexicographique : le format AAAA-MM la rend équivalente à une
    // comparaison chronologique.
    return { erreur: 'Impossible d’enregistrer un paiement pour un mois à venir' };
  }

  return { date: `${mois}-05T12:00:00Z` };
}

/** Ancienneté maximale acceptée pour une date de versement, en mois. */
const VERSEMENT_ANTERIORITE_MOIS = 12;

/** Jour courant au format AAAA-MM-JJ, en temps universel. */
function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Valide la date de versement — le jour où l'argent a été remis.
 *
 * C'est la date qui fait entrer la somme en caisse, donc la seule que le
 * trésorier ne peut pas laisser deviner : elle est OBLIGATOIRE. Le serveur ne
 * lui substitue aucune valeur par défaut, faute de quoi une saisie de rattrapage
 * faite un mois plus tard serait comptée au mauvais moment sans que personne
 * ne s'en aperçoive.
 *
 * Deux bornes, pour les mêmes raisons :
 *   - pas de date à venir : on ne constate pas un versement qui n'a pas eu lieu ;
 *   - pas plus de douze mois en arrière : au-delà, c'est une erreur de frappe
 *     bien plus souvent qu'un versement oublié, et la somme retomberait avant
 *     tout solde d'ouverture raisonnable.
 *
 * @param {*} valeur date reçue, au format AAAA-MM-JJ
 * @returns {{date: string}|{erreur: string}} date ISO à enregistrer, ou motif de refus
 */
function lireDateVersement(valeur) {
  const brut = String(valeur === undefined || valeur === null ? '' : valeur).trim();

  if (brut === '') {
    return { erreur: 'La date du versement est obligatoire' };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) {
    return { erreur: 'Date de versement invalide (format attendu : AAAA-MM-JJ)' };
  }

  // La forme ne suffit pas : « 2026-02-31 » passe l'expression régulière. Un
  // aller-retour par Date le démasque, le 31 février devenant le 3 mars.
  const horodatage = Date.parse(`${brut}T12:00:00Z`);
  if (Number.isNaN(horodatage) || new Date(horodatage).toISOString().slice(0, 10) !== brut) {
    return { erreur: 'Date de versement invalide (jour inexistant)' };
  }

  const jour = aujourdhui();
  if (brut > jour) {
    return { erreur: 'La date du versement ne peut pas être dans le futur' };
  }

  // Comparaison lexicographique : le format AAAA-MM-JJ la rend chronologique.
  const maintenant = new Date();
  const borne = new Date(
    Date.UTC(
      maintenant.getUTCFullYear(),
      maintenant.getUTCMonth() - VERSEMENT_ANTERIORITE_MOIS,
      maintenant.getUTCDate()
    )
  )
    .toISOString()
    .slice(0, 10);

  if (brut < borne) {
    return {
      erreur: `La date du versement ne peut pas être antérieure de plus de ${VERSEMENT_ANTERIORITE_MOIS} mois`,
    };
  }

  // Midi en temps universel, comme la date de mois dû : la journée reste la même
  // quel que soit le fuseau de lecture.
  return { date: `${brut}T12:00:00Z` };
}

/**
 * Une cotisation est-elle une régularisation ?
 *
 * Vrai lorsque le mois dû précède le mois du versement : l'argent a été remis
 * après le mois qu'il couvre. C'est ce qui distingue « Cotisation de septembre »
 * de « Cotisation de mai versée le 18 sept ».
 *
 * @param {string} moisDu date de mois dû (date_paiement)
 * @param {string} versement date de versement
 * @returns {boolean}
 */
function estRegularisation(moisDu, versement) {
  const du = String(moisDu || '').slice(0, 7);
  const remis = String(versement || '').slice(0, 7);
  if (du.length !== 7 || remis.length !== 7) return false;
  return du < remis;
}

routeur.post(
  '/',
  // 1. Contrôle du code trésorier AVANT de lire le fichier : inutile de
  //    téléverser quoi que ce soit si l'appelant n'est pas autorisé.
  exigerRole('tresorier'),
  // 2. Réception du fichier en mémoire (images, 5 Mo max)
  (requete, reponse, suite) => recevoirJustificatif(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  // 3. Validation, dépôt S3 puis écriture en base
  async (requete, reponse) => {
    const idMembre = Number.parseInt(requete.body?.member_id, 10);
    const montant = Number.parseFloat(requete.body?.montant);
    const moyen = normaliserMoyen(requete.body?.moyen);
    const moisDemande = requete.body?.mois;

    if (!Number.isInteger(idMembre) || idMembre <= 0) {
      console.warn(`[cotisations] refus : member_id invalide « ${requete.body?.member_id} »`);
      return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      console.warn(`[cotisations] refus : montant invalide « ${requete.body?.montant} »`);
      return reponse.status(400).json({ error: 'Le montant doit être un nombre strictement positif' });
    }

    if (!moyen) {
      console.warn(`[cotisations] refus : moyen de paiement inconnu « ${requete.body?.moyen} »`);
      return reponse
        .status(400)
        .json({ error: `Moyen de paiement invalide (attendu : ${MOYENS_AUTORISES.join(' ou ')})` });
    }

    // Mois facultatif : absent, la cotisation est datée de maintenant (défaut SQL).
    let datePaiement = null;
    if (moisDemande !== undefined && moisDemande !== null && String(moisDemande).trim() !== '') {
      const conversion = convertirMoisEnDate(moisDemande);
      if (conversion.erreur) {
        console.warn(`[cotisations] refus : mois « ${moisDemande} » — ${conversion.erreur}`);
        return reponse.status(400).json({ error: conversion.erreur });
      }
      datePaiement = conversion.date;
    }

    // Date de remise de l'argent : obligatoire, c'est elle qui fait la caisse.
    const versement = lireDateVersement(requete.body?.date_versement);
    if (versement.erreur) {
      console.warn(`[cotisations] refus : date de versement — ${versement.erreur}`);
      return reponse.status(400).json({ error: versement.erreur });
    }

    try {
      const membre = await lireUne('SELECT id, name FROM members WHERE id = ?', [idMembre]);
      if (!membre) {
        console.warn(`[cotisations] refus : membre #${idMembre} introuvable`);
        return reponse.status(404).json({ error: 'Membre introuvable' });
      }

      // Séparation des pouvoirs (LOT 3 ter) : un trésorier ne constate pas son
      // propre versement. L'autre trésorier, ou l'admin, le fait.
      if (requete.tresorier && memeMembre(membre.name, requete.tresorier)) {
        console.warn(`[cotisations] refus : ${requete.tresorier} saisit sa propre cotisation`);
        return reponse.status(403).json({
          error: 'Un trésorier ne peut pas traiter sa propre cotisation',
        });
      }

      // Le justificatif est facultatif : un paiement en espèce peut être saisi sans photo
      let urlJustificatif = null;
      if (requete.file) {
        urlJustificatif = await televerserJustificatif(requete.file, idMembre);
      } else {
        console.log(`[cotisations] paiement sans justificatif pour le membre #${idMembre}`);
      }

      // Saisie par le trésorier : la cotisation est validée d'emblée.
      const resultat = datePaiement
        ? await executer(
            `INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url, date_paiement, date_versement, statut, date_validation, valide_par)
             VALUES (?, ?, ?, ?, ?, ?, 'validee', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)`,
            [idMembre, montant, moyen, urlJustificatif, datePaiement, versement.date, requete.agent]
          )
        : await executer(
            `INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url, date_versement, statut, date_validation, valide_par)
             VALUES (?, ?, ?, ?, ?, 'validee', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)`,
            [idMembre, montant, moyen, urlJustificatif, versement.date, requete.agent]
          );

      const cotisation = await lireUne(
        `SELECT id, member_id, montant, moyen, fichier_s3_url, date_paiement, date_versement, valide_par
           FROM cotisations WHERE id = ?`,
        [resultat.id]
      );
      cotisation.regularisation = estRegularisation(
        cotisation.date_paiement,
        cotisation.date_versement
      );

      const mention = datePaiement ? ` — rattrapage ${String(moisDemande).trim()}` : '';
      console.log(
        `[cotisations] paiement enregistré : #${cotisation.id} — ${membre.name} — ${montant} (${moyen})` +
          `${mention} — versé le ${versement.date.slice(0, 10)}`
      );
      return reponse.status(201).json(cotisation);
    } catch (erreur) {
      console.error(`[cotisations] échec de l'enregistrement : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || "Impossible d'enregistrer le paiement" });
    }
  }
);

// ---------------------------------------------------------------------------
// Déclaration de paiement par le membre
//
// Le membre déclare lui-même son versement, reçu à l'appui ; la cotisation naît
// « en_attente » et ne compte nulle part tant que le trésorier ne l'a pas
// validée. Aucun code n'est requis : c'est le service ouvert à tous les membres.
// ---------------------------------------------------------------------------

// Garde-fou : la route est publique et écrit en base. Sans plafond, un robot
// remplirait la file d'attente du trésorier. Compteur en mémoire, remis à zéro
// au redémarrage — suffisant pour une instance unique.
const FENETRE_DECLARATIONS_MS = 60 * 60 * 1000;
const DECLARATIONS_MAX = 10;
const declarationsParSource = new Map();

/** @returns {boolean} true si la source a dépassé son quota horaire */
function quotaDeclarationsDepasse(source) {
  const maintenant = Date.now();

  for (const [cle, suivi] of declarationsParSource) {
    if (maintenant - suivi.debut > FENETRE_DECLARATIONS_MS) declarationsParSource.delete(cle);
  }

  const suivi = declarationsParSource.get(source);
  if (!suivi || maintenant - suivi.debut > FENETRE_DECLARATIONS_MS) {
    declarationsParSource.set(source, { debut: maintenant, nombre: 1 });
    return false;
  }

  suivi.nombre += 1;
  return suivi.nombre > DECLARATIONS_MAX;
}

/**
 * POST /api/cotisations/declarer — déclaration par le membre (PUBLIQUE).
 * multipart : member_id, mois (AAAA-MM), date_versement (AAAA-MM-JJ), montant,
 * moyen, fichier (obligatoire en Mobile Money).
 *
 * Le membre déclare deux choses distinctes : le mois qu'il règle, et le jour où
 * il a remis l'argent. La seconde est celle qui comptera en caisse.
 */
routeur.post(
  '/declarer',
  (requete, reponse, suite) => recevoirRecu(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  async (requete, reponse) => {
    const source = requete.ip || 'inconnue';
    const idMembre = Number.parseInt(requete.body?.member_id, 10);
    const montant = Number.parseFloat(requete.body?.montant);
    const moyen = normaliserMoyen(requete.body?.moyen);
    const moisDemande = String(requete.body?.mois || '').trim();

    if (!Number.isInteger(idMembre) || idMembre <= 0) {
      return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      return reponse.status(400).json({ error: 'Le montant doit être un nombre strictement positif' });
    }

    if (!moyen) {
      return reponse
        .status(400)
        .json({ error: `Moyen de paiement invalide (attendu : ${MOYENS_AUTORISES.join(' ou ')})` });
    }

    const conversion = convertirMoisEnDate(moisDemande);
    if (conversion.erreur) {
      return reponse.status(400).json({ error: conversion.erreur });
    }

    const versement = lireDateVersement(requete.body?.date_versement);
    if (versement.erreur) {
      console.warn(`[declaration] refus : date de versement — ${versement.erreur}`);
      return reponse.status(400).json({ error: versement.erreur });
    }

    // Reçu obligatoire en Mobile Money, facultatif en espèces (LOT 3 bis) :
    // un transfert laisse toujours une trace consultable, une remise de billets
    // de la main à la main n'en laisse aucune. Exiger une pièce impossible à
    // fournir reviendrait à fermer la déclaration aux paiements en espèces.
    if (!requete.file && moyen === 'Mobile Money') {
      console.warn(`[declaration] refus : aucun reçu joint en Mobile Money (membre #${idMembre})`);
      return reponse
        .status(400)
        .json({ error: 'Le reçu est obligatoire pour un paiement Mobile Money' });
    }

    if (quotaDeclarationsDepasse(source)) {
      console.warn(`[declaration] quota horaire dépassé depuis ${source}`);
      return reponse
        .status(429)
        .json({ error: 'Trop de déclarations envoyées, réessayez dans une heure' });
    }

    try {
      const membre = await lireUne('SELECT id, name FROM members WHERE id = ?', [idMembre]);
      if (!membre) {
        return reponse.status(404).json({ error: 'Membre introuvable' });
      }

      // Un mois déjà réglé — ou déjà déclaré — ne se déclare pas deux fois.
      const existante = await lireUne(
        `SELECT id, statut FROM cotisations
          WHERE member_id = ?
            AND strftime('%Y-%m', date_paiement) = ?
            AND statut IN ('validee', 'en_attente')
          LIMIT 1`,
        [idMembre, moisDemande]
      );

      if (existante) {
        const message = existante.statut === 'validee'
          ? 'Ce mois est déjà réglé pour ce membre'
          : 'Une déclaration est déjà en attente pour ce mois';
        console.warn(`[declaration] doublon refusé : membre #${idMembre}, mois ${moisDemande}`);
        return reponse.status(409).json({ error: message });
      }

      // Sans reçu (espèces), la déclaration part quand même : le trésorier
      // tranchera sur sa seule connaissance de la remise.
      const depot = requete.file
        ? await televerserJustificatifDetaille(requete.file, idMembre)
        : { url: null, cle: null };

      const resultat = await executer(
        `INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url, cle_s3, statut, date_paiement, date_versement)
         VALUES (?, ?, ?, ?, ?, 'en_attente', ?, ?)`,
        [idMembre, montant, moyen, depot.url, depot.cle, conversion.date, versement.date]
      );

      console.log(
        `[declaration] déclaration reçue : #${resultat.id} — ${membre.name} — ` +
          `${montant} (${moyen}) pour ${moisDemande}, versé le ${versement.date.slice(0, 10)}`
      );

      return reponse.status(201).json({
        id: resultat.id,
        member_id: idMembre,
        montant,
        moyen,
        mois: moisDemande,
        date_versement: versement.date,
        regularisation: estRegularisation(conversion.date, versement.date),
        statut: 'en_attente',
        message: 'Déclaration envoyée, en attente de validation par le trésorier',
      });
    } catch (erreur) {
      console.error(`[declaration] échec : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || "Impossible d'envoyer la déclaration" });
    }
  }
);

/** GET /api/cotisations/en-attente — file de validation du trésorier. */
routeur.get('/en-attente', exigerRole('tresorier'), async (requete, reponse) => {
  try {
    const lignes = await lireToutes(
      `SELECT c.id, c.member_id, m.name AS member_name, c.montant, c.moyen,
              c.date_paiement, c.date_versement, c.cle_s3, c.fichier_s3_url
         FROM cotisations c
         JOIN members m ON m.id = c.member_id
        WHERE c.statut = 'en_attente'
        ORDER BY c.date_paiement ASC, c.id ASC`
    );

    // Une URL pré-signée par déclaration : le justificatif reste privé et ne
    // sort jamais de l'écran du trésorier.
    const declarations = await Promise.all(
      lignes.map(async (ligne) => {
        let url = null;
        if (ligne.cle_s3) {
          try {
            url = await urlPresignee(ligne.cle_s3);
          } catch (erreur) {
            console.warn(`[declaration] justificatif #${ligne.id} indisponible : ${erreur.message}`);
          }
        }

        return {
          id: ligne.id,
          member_id: ligne.member_id,
          member_name: ligne.member_name,
          montant: Number(ligne.montant),
          moyen: ligne.moyen,
          mois: String(ligne.date_paiement).slice(0, 7),
          date_paiement: ligne.date_paiement,
          // Le trésorier doit voir la date de remise avant de valider : c'est
          // elle qui décidera du solde, et lui seul peut la contester.
          date_versement: ligne.date_versement || null,
          regularisation: estRegularisation(ligne.date_paiement, ligne.date_versement),
          justificatif_url: url,
        };
      })
    );

    console.log(`[declaration] file de validation servie : ${declarations.length} en attente`);
    return reponse.status(200).json({ declarations, total: declarations.length });
  } catch (erreur) {
    console.error(`[declaration] lecture de la file impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les déclarations' });
  }
});

/** GET /api/cotisations/:id/justificatif — URL pré-signée (trésorier). */
routeur.get('/:id/justificatif', exigerRole('tresorier'), async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);
  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de cotisation invalide' });
  }

  try {
    const cotisation = await lireUne('SELECT id, cle_s3 FROM cotisations WHERE id = ?', [identifiant]);
    if (!cotisation) {
      return reponse.status(404).json({ error: 'Cotisation introuvable' });
    }

    if (!cotisation.cle_s3) {
      return reponse.status(404).json({ error: 'Aucun justificatif pour cette cotisation' });
    }

    const url = await urlPresignee(cotisation.cle_s3);
    console.log(`[declaration] justificatif consulté : cotisation #${identifiant}`);
    return reponse.status(200).json({ url });
  } catch (erreur) {
    console.error(`[declaration] justificatif #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger le justificatif' });
  }
});

/** POST /api/cotisations/:id/valider — le trésorier confirme la déclaration. */
routeur.post('/:id/valider', exigerRole('tresorier'), async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);
  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de cotisation invalide' });
  }

  try {
    const cotisation = await lireUne(
      `SELECT c.*, m.name AS member_name
         FROM cotisations c JOIN members m ON m.id = c.member_id
        WHERE c.id = ?`,
      [identifiant]
    );

    if (!cotisation) {
      return reponse.status(404).json({ error: 'Cotisation introuvable' });
    }

    if (cotisation.statut === 'validee') {
      return reponse.status(409).json({ error: 'Cette cotisation est déjà validée' });
    }

    if (requete.tresorier && memeMembre(cotisation.member_name, requete.tresorier)) {
      console.warn(`[declaration] refus : ${requete.tresorier} valide sa propre cotisation`);
      return reponse.status(403).json({
        error: 'Un trésorier ne peut pas traiter sa propre cotisation',
      });
    }

    await executer(
      `UPDATE cotisations
          SET statut = 'validee',
              motif_refus = NULL,
              valide_par = ?,
              date_validation = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
      [requete.agent, identifiant]
    );

    console.log(
      `[declaration] validée : #${identifiant} — ${cotisation.member_name} — ${cotisation.montant}`
    );

    return reponse.status(200).json({
      id: identifiant,
      member_id: cotisation.member_id,
      member_name: cotisation.member_name,
      montant: Number(cotisation.montant),
      statut: 'validee',
      valide_par: requete.agent,
    });
  } catch (erreur) {
    console.error(`[declaration] validation #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de valider la cotisation' });
  }
});

/** POST /api/cotisations/:id/refuser — le trésorier écarte la déclaration. */
routeur.post('/:id/refuser', exigerRole('tresorier'), async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);
  const motif = typeof requete.body?.motif === 'string' ? requete.body.motif.trim() : '';

  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de cotisation invalide' });
  }

  // Un refus sans motif est incompréhensible pour le membre qui le reçoit.
  if (!motif) {
    return reponse.status(400).json({ error: 'Le motif du refus est obligatoire' });
  }

  try {
    const cotisation = await lireUne(
      `SELECT c.*, m.name AS member_name
         FROM cotisations c JOIN members m ON m.id = c.member_id
        WHERE c.id = ?`,
      [identifiant]
    );

    if (!cotisation) {
      return reponse.status(404).json({ error: 'Cotisation introuvable' });
    }

    if (cotisation.statut === 'refusee') {
      return reponse.status(409).json({ error: 'Cette déclaration est déjà refusée' });
    }

    if (requete.tresorier && memeMembre(cotisation.member_name, requete.tresorier)) {
      console.warn(`[declaration] refus : ${requete.tresorier} refuse sa propre cotisation`);
      return reponse.status(403).json({
        error: 'Un trésorier ne peut pas traiter sa propre cotisation',
      });
    }

    await executer(
      `UPDATE cotisations
          SET statut = 'refusee', motif_refus = ?, valide_par = ?, date_validation = NULL
        WHERE id = ?`,
      [motif.slice(0, 200), requete.agent, identifiant]
    );

    console.log(`[declaration] refusée : #${identifiant} — ${cotisation.member_name} — ${motif}`);

    return reponse.status(200).json({
      id: identifiant,
      member_id: cotisation.member_id,
      member_name: cotisation.member_name,
      statut: 'refusee',
      motif_refus: motif,
      valide_par: requete.agent,
    });
  } catch (erreur) {
    console.error(`[declaration] refus #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de refuser la déclaration' });
  }
});

module.exports = routeur;
// Partagés avec /api/stats, /api/journal et les exports : la règle de la
// régularisation doit être la même partout, et la validation de la date de
// versement ne doit exister qu'en un seul endroit.
module.exports.estRegularisation = estRegularisation;
module.exports.lireDateVersement = lireDateVersement;
