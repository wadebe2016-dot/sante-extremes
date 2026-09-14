/**
 * Vérification d'un code de rôle — Santé des extrêmes (LOT 3).
 *   POST /api/auth/verify  { code }  → 200 { roles: ["tresorier"] } | 401 | 429
 *
 * Permet à l'application mobile de savoir quels onglets déverrouiller sans
 * exécuter la moindre action métier. Le code lui-même n'est jamais renvoyé ni
 * journalisé.
 *
 * LOT 3 bis : les codes font six chiffres. Le plafond d'essais est partagé avec
 * les routes protégées (middleware/limiteur.js) — sinon il suffirait de changer
 * de route pour repartir de zéro.
 */
'use strict';

const express = require('express');
const { identifierCode } = require('../middleware/auth');
const limiteur = require('../middleware/limiteur');

const routeur = express.Router();

/** POST /api/auth/verify — le code est-il valide, et pour quels rôles ? */
routeur.post('/verify', (requete, reponse) => {
  const source = limiteur.sourceDe(requete);
  const code = typeof requete.body?.code === 'string' ? requete.body.code.trim() : '';

  if (limiteur.estBloquee(source)) {
    return limiteur.repondreBloque(reponse, source);
  }

  if (!code) {
    console.warn('[auth] vérification refusée : champ « code » manquant');
    return reponse.status(400).json({ error: 'Le code est obligatoire' });
  }

  const { roles, membre } = identifierCode(code);

  if (roles.length === 0) {
    limiteur.enregistrerEchec(source, 'vérification de code');
    return reponse.status(401).json({ error: 'Code invalide' });
  }

  limiteur.reinitialiser(source);
  console.log(
    `[auth] code validé pour les rôles : ${roles.join(', ')}${membre ? ` — ${membre}` : ''}`
  );

  // Le nom permet à l'application d'afficher « Trésorier · Junior » et de
  // griser sa propre cotisation dans la file de validation.
  return reponse.status(200).json({ roles, membre: membre || null });
});

module.exports = routeur;
