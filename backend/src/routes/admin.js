/**
 * Gestion des membres — Santé des extrêmes.
 *   GET    /api/admin/members         liste des membres (nom, adhésion, statut)
 *   POST   /api/admin/members         création d'un membre
 *   PATCH  /api/admin/members/:id     correction de la date d'adhésion
 *   POST   /api/admin/members/:id/statut  mise à l'écart ou réintégration
 *   DELETE /api/admin/members/:id     suppression d'un membre
 *
 * LOT 3 : ces routes relèvent du secrétariat. Le code secrétaire y donne accès,
 * le code admin également (tous les droits).
 *
 * LOT 4 — deux notions nouvelles, et une distinction qui compte :
 *
 *   date_adhesion  mois d'entrée dans l'association. TOUT calcul d'arriéré en
 *                  part. Un membre entré en mai ne doit rien pour janvier : le
 *                  corriger ici recalcule aussitôt ses arriérés, ses mesures et
 *                  son éligibilité aux séances.
 *   statut         « actif » ou « ecarte ». MIS À L'ÉCART, JAMAIS RADIÉ : le
 *                  membre reste en base, dans l'historique et dans les exports.
 *                  Il disparaît seulement des éligibles d'une séance et du
 *                  total « X/38 à jour ».
 *
 * La SUPPRESSION, elle, efface tout en cascade. C'est une opération d'erreur de
 * saisie, pas une décision disciplinaire — d'où la mise à l'écart, qui conserve.
 */
'use strict';

const express = require('express');
const { executer, lireUne, lireToutes } = require('../db');
const { exigerRole } = require('../middleware/auth');
const { moisCourant, moisValide } = require('../services/arrieres');

const routeur = express.Router();

/** Statuts reconnus. La liste fermée est tenue ici, pas par un CHECK SQLite. */
const STATUTS = Object.freeze(['actif', 'ecarte']);

/** Longueur maximale d'un motif de changement de statut. */
const MOTIF_MAX = 200;

// Toutes les routes de ce routeur sont réservées au secrétariat.
routeur.use(exigerRole('secretaire'));

/**
 * Convertit un mois d'adhésion « AAAA-MM » en date stockable.
 *
 * Le 1ᵉʳ du mois : seule la granularité du mois a un sens ici, un membre
 * n'adhère pas « le 17 ». Un mois à venir est refusé — on n'inscrit pas
 * quelqu'un pour plus tard, et cela produirait des arriérés négatifs.
 *
 * @param {*} valeur mois demandé, AAAA-MM (ou AAAA-MM-JJ, dont on ne garde que
 *                   le mois)
 * @returns {{date: string}|{erreur: string}}
 */
function convertirAdhesion(valeur) {
  const mois = String(valeur || '').trim().slice(0, 7);

  if (!moisValide(mois)) {
    return { erreur: 'Date d’adhésion invalide (format attendu : AAAA-MM)' };
  }

  if (mois > moisCourant()) {
    return { erreur: 'La date d’adhésion ne peut pas être dans le futur' };
  }

  return { date: `${mois}-01` };
}

/** Met en forme une ligne de « members » pour l'API. */
function formaterMembre(ligne) {
  return {
    id: ligne.id,
    name: ligne.name,
    // Le repli sur le mois de création évite qu'une fiche antérieure au LOT 4,
    // dont la migration n'aurait rien trouvé, n'apparaisse sans adhésion.
    date_adhesion: ligne.date_adhesion || `${String(ligne.created_at || '').slice(0, 7)}-01`,
    statut: ligne.statut === 'ecarte' ? 'ecarte' : 'actif',
    date_statut: ligne.date_statut || null,
    motif_statut: ligne.motif_statut || null,
    created_at: ligne.created_at,
  };
}

/** GET /api/admin/members — liste des membres, triée par nom */
routeur.get('/members', async (requete, reponse) => {
  try {
    const lignes = await lireToutes(
      `SELECT id, name, date_adhesion, statut, date_statut, motif_statut, created_at
         FROM members
        ORDER BY name COLLATE NOCASE ASC`
    );

    const membres = lignes.map(formaterMembre);
    const ecartes = membres.filter((membre) => membre.statut === 'ecarte').length;

    console.log(
      `[admin] liste des membres servie : ${membres.length} membre(s), ${ecartes} mis à l'écart`
    );
    return reponse.status(200).json({ members: membres });
  } catch (erreur) {
    console.error(`[admin] erreur à la lecture des membres : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger la liste des membres' });
  }
});

/**
 * POST /api/admin/members — création d'un membre
 * @body name, date_adhesion (facultative, mois en cours par défaut)
 */
routeur.post('/members', async (requete, reponse) => {
  const nom = typeof requete.body?.name === 'string' ? requete.body.name.trim() : '';

  if (!nom) {
    console.warn('[admin] création refusée : champ « name » manquant ou vide');
    return reponse.status(400).json({ error: 'Le nom du membre est obligatoire' });
  }

  if (nom.length > 100) {
    console.warn('[admin] création refusée : nom trop long');
    return reponse.status(400).json({ error: 'Le nom ne peut dépasser 100 caractères' });
  }

  // Sans date d'adhésion, le membre entre ce mois-ci : c'est le cas courant, et
  // c'est la valeur qui ne lui invente aucun arriéré.
  let adhesion = `${moisCourant()}-01`;
  const demandee = requete.body?.date_adhesion;
  if (demandee !== undefined && demandee !== null && String(demandee).trim() !== '') {
    const conversion = convertirAdhesion(demandee);
    if (conversion.erreur) {
      console.warn(`[admin] création refusée : ${conversion.erreur}`);
      return reponse.status(400).json({ error: conversion.erreur });
    }
    adhesion = conversion.date;
  }

  try {
    const resultat = await executer(
      "INSERT INTO members (name, date_adhesion, statut) VALUES (?, ?, 'actif')",
      [nom, adhesion]
    );
    const ligne = await lireUne(
      `SELECT id, name, date_adhesion, statut, date_statut, motif_statut, created_at
         FROM members WHERE id = ?`,
      [resultat.id]
    );

    console.log(`[admin] membre créé : #${ligne.id} ${ligne.name} — adhésion ${adhesion.slice(0, 7)}`);
    return reponse.status(201).json(formaterMembre(ligne));
  } catch (erreur) {
    if (String(erreur.message).includes('UNIQUE')) {
      console.warn(`[admin] membre déjà existant : ${nom}`);
      return reponse.status(409).json({ error: 'Ce membre existe déjà' });
    }
    console.error(`[admin] erreur à la création du membre : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de créer le membre' });
  }
});

/**
 * PATCH /api/admin/members/:id — correction de la date d'adhésion.
 * @body date_adhesion (AAAA-MM)
 *
 * C'est la correction qui compte le plus du LOT 4 : une adhésion mal renseignée
 * fabrique des arriérés imaginaires. La modifier ici les efface aussitôt —
 * aucun recalcul différé, les arriérés se déduisent à chaque lecture.
 */
routeur.patch('/members/:id', async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);

  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
  }

  const demandee = requete.body?.date_adhesion;
  if (demandee === undefined || demandee === null || String(demandee).trim() === '') {
    return reponse.status(400).json({ error: 'La date d’adhésion est obligatoire' });
  }

  const conversion = convertirAdhesion(demandee);
  if (conversion.erreur) {
    console.warn(`[admin] correction refusée : ${conversion.erreur}`);
    return reponse.status(400).json({ error: conversion.erreur });
  }

  try {
    const resultat = await executer('UPDATE members SET date_adhesion = ? WHERE id = ?', [
      conversion.date,
      identifiant,
    ]);

    if (resultat.changements === 0) {
      return reponse.status(404).json({ error: 'Membre introuvable' });
    }

    const ligne = await lireUne(
      `SELECT id, name, date_adhesion, statut, date_statut, motif_statut, created_at
         FROM members WHERE id = ?`,
      [identifiant]
    );

    console.log(
      `[admin] adhésion corrigée : #${identifiant} ${ligne.name} → ${conversion.date.slice(0, 7)}`
    );
    return reponse.status(200).json(formaterMembre(ligne));
  } catch (erreur) {
    console.error(`[admin] erreur à la correction de l'adhésion #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de corriger la date d’adhésion' });
  }
});

/**
 * POST /api/admin/members/:id/statut — mise à l'écart ou réintégration.
 * @body statut ('actif'|'ecarte'), motif (obligatoire pour une mise à l'écart)
 *
 * L'événement est consigné dans « evenements_membres » avec le nom de l'acteur :
 * « members.statut » dit l'état courant, pas l'histoire, et une décision
 * disciplinaire doit pouvoir se justifier en assemblée.
 */
routeur.post('/members/:id/statut', async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);
  const statut = String(requete.body?.statut || '').trim().toLowerCase();
  const motifSaisi = typeof requete.body?.motif === 'string' ? requete.body.motif.trim() : '';

  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
  }

  if (!STATUTS.includes(statut)) {
    return reponse.status(400).json({ error: `Statut invalide (attendu : ${STATUTS.join(' ou ')})` });
  }

  // Une mise à l'écart sans motif est incompréhensible pour l'intéressé comme
  // pour l'assemblée. Une réintégration, elle, se passe d'explication.
  if (statut === 'ecarte' && !motifSaisi) {
    return reponse.status(400).json({ error: 'Le motif de la mise à l’écart est obligatoire' });
  }

  try {
    const membre = await lireUne('SELECT id, name, statut FROM members WHERE id = ?', [identifiant]);
    if (!membre) {
      return reponse.status(404).json({ error: 'Membre introuvable' });
    }

    const statutActuel = membre.statut === 'ecarte' ? 'ecarte' : 'actif';
    if (statutActuel === statut) {
      const deja = statut === 'ecarte' ? 'déjà mis à l’écart' : 'déjà actif';
      console.warn(`[admin] statut inchangé : #${identifiant} ${membre.name} est ${deja}`);
      return reponse.status(409).json({ error: `Ce membre est ${deja}` });
    }

    const motif = motifSaisi.slice(0, MOTIF_MAX) || null;

    await executer(
      `UPDATE members
          SET statut = ?,
              date_statut = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              motif_statut = ?
        WHERE id = ?`,
      [statut, motif, identifiant]
    );

    await executer(
      `INSERT INTO evenements_membres (member_id, type, motif, acteur)
       VALUES (?, ?, ?, ?)`,
      [
        identifiant,
        statut === 'ecarte' ? 'mise_a_l_ecart' : 'reintegration',
        motif,
        requete.agent,
      ]
    );

    const ligne = await lireUne(
      `SELECT id, name, date_adhesion, statut, date_statut, motif_statut, created_at
         FROM members WHERE id = ?`,
      [identifiant]
    );

    console.log(
      `[admin] ${statut === 'ecarte' ? 'mis à l’écart' : 'réintégré'} : ` +
        `#${identifiant} ${membre.name} par ${requete.agent}${motif ? ` — ${motif}` : ''}`
    );
    return reponse.status(200).json(formaterMembre(ligne));
  } catch (erreur) {
    console.error(`[admin] erreur au changement de statut #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de changer le statut du membre' });
  }
});

/**
 * DELETE /api/admin/members/:id — suppression d'un membre
 *
 * Les cotisations, sanctions et fiches santé du membre partent en cascade
 * (ON DELETE CASCADE) : le retrait d'un membre efface tout son historique.
 * Pour écarter quelqu'un sans rien perdre, passer par /statut.
 */
routeur.delete('/members/:id', async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);

  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    console.warn(`[admin] suppression refusée : identifiant invalide « ${requete.params.id} »`);
    return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
  }

  try {
    const resultat = await executer('DELETE FROM members WHERE id = ?', [identifiant]);

    if (resultat.changements === 0) {
      console.warn(`[admin] suppression sans effet : membre #${identifiant} introuvable`);
      return reponse.status(404).json({ error: 'Membre introuvable' });
    }

    console.log(`[admin] membre supprimé : #${identifiant}`);
    return reponse.status(200).json({ message: 'Membre supprimé' });
  } catch (erreur) {
    console.error(`[admin] erreur à la suppression du membre #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de supprimer le membre' });
  }
});

module.exports = routeur;
