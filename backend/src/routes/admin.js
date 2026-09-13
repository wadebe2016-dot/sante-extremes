/**
 * Gestion des membres — Santé des extrêmes.
 *   GET    /api/admin/members       liste des membres (id + nom)
 *   POST   /api/admin/members       création d'un membre
 *   DELETE /api/admin/members/:id   suppression d'un membre
 *
 * LOT 3 : ces routes relèvent du secrétariat. Le code secrétaire y donne accès,
 * le code admin également (tous les droits).
 */
'use strict';

const express = require('express');
const { executer, lireUne, lireToutes } = require('../db');
const { exigerRole } = require('../middleware/auth');

const routeur = express.Router();

// Toutes les routes de ce routeur sont réservées au secrétariat.
routeur.use(exigerRole('secretaire'));

/** GET /api/admin/members — liste des membres, triée par nom */
routeur.get('/members', async (requete, reponse) => {
  try {
    const membres = await lireToutes(
      'SELECT id, name FROM members ORDER BY name COLLATE NOCASE ASC'
    );

    console.log(`[admin] liste des membres servie : ${membres.length} membre(s)`);
    return reponse.status(200).json({ members: membres });
  } catch (erreur) {
    console.error(`[admin] erreur à la lecture des membres : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger la liste des membres' });
  }
});

/** POST /api/admin/members — création d'un membre */
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

  try {
    const resultat = await executer('INSERT INTO members (name) VALUES (?)', [nom]);
    const membre = await lireUne('SELECT id, name, created_at FROM members WHERE id = ?', [resultat.id]);

    console.log(`[admin] membre créé : #${membre.id} ${membre.name}`);
    return reponse.status(201).json(membre);
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
 * DELETE /api/admin/members/:id — suppression d'un membre
 *
 * Les cotisations, sanctions et fiches santé du membre partent en cascade
 * (ON DELETE CASCADE) : le retrait d'un membre efface tout son historique.
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
