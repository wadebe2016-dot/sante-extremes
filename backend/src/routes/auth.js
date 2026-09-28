/**
 * Vérification d'un code de rôle — LOT 7 « DeuxZero ».
 *
 *   POST /api/auth/verify  { code }
 *     200 { roles: ["tresorier"], membre, code_temporaire }
 *     401 code invalide
 *     429 trop d'essais
 *
 * Permet à l'application de savoir quels onglets déverrouiller sans exécuter la
 * moindre action métier. Le code lui-même n'est jamais renvoyé ni journalisé.
 *
 * LOT 7 — deux changements :
 *   · les codes sont cherchés dans la base de l'association portée par l'en-tête
 *     X-Association, plus dans le .env du serveur ;
 *   · un CODE TEMPORAIRE est reconnu et signalé comme tel. L'application doit
 *     alors imposer l'écran « Choisissez votre code personnel » et n'ouvrir
 *     aucun autre écran avant ce choix — c'est ce qui garantit que le président
 *     ne connaît jamais le code définitif de ses collaborateurs.
 *
 * Le plafond d'essais est partagé avec les routes protégées
 * (middleware/limiteur.js) et compte PAR ASSOCIATION : sinon il suffirait de
 * changer de route pour repartir de zéro, ou de marteler une association pour
 * bloquer les autres.
 */
'use strict';

const express = require('express');
const { identifierCode } = require('../middleware/auth');
const limiteur = require('../middleware/limiteur');
const { LIBELLES_ROLES } = require('../services/roles');

const routeur = express.Router();

/** POST /api/auth/verify — le code est-il valide, et pour quels rôles ? */
routeur.post('/verify', async (requete, reponse) => {
  const codeAssociation = requete.association ? requete.association.code : 'sans';
  const source = `${codeAssociation}|${limiteur.sourceDe(requete)}`;
  const code = typeof requete.body?.code === 'string' ? requete.body.code.trim() : '';

  if (limiteur.estBloquee(source)) {
    return limiteur.repondreBloque(reponse, source);
  }

  if (!code) {
    console.warn('[auth] vérification refusée : champ « code » manquant');
    return reponse.status(400).json({ error: 'Le code est obligatoire' });
  }

  let identite;
  try {
    identite = await identifierCode(requete.db, code, codeAssociation);
  } catch (erreur) {
    console.error(`[auth] vérification impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Erreur interne du serveur' });
  }

  if (!identite) {
    limiteur.enregistrerEchec(source, 'vérification de code');
    return reponse.status(401).json({ error: 'Code invalide' });
  }

  limiteur.reinitialiser(source);
  console.log(
    `[auth] code validé (${identite.role}${identite.membre ? ` — ${identite.membre}` : ''}) ` +
      `[${codeAssociation}]${identite.temporaire ? ' — code temporaire' : ''}`
  );

  return reponse.status(200).json({
    roles: identite.roles,
    role: identite.role,
    role_libelle: LIBELLES_ROLES[identite.role] || identite.role,
    // Le nom permet à l'application d'afficher « Trésorier · Junior » et de
    // griser sa propre cotisation dans la file de validation.
    membre: identite.membre || null,
    libelle: identite.libelle || null,
    // L'application doit imposer le choix d'un code personnel avant tout écran.
    code_temporaire: identite.temporaire,
    role_id: identite.id,
    association: requete.association
      ? { code: requete.association.code, nom: requete.association.nom }
      : null,
  });
});

module.exports = routeur;
