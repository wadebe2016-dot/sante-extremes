/**
 * Rôles et accès — LOT 7 « DeuxZero ».
 *
 *   GET    /api/roles                     (président) liste des rôles et de leur état
 *   POST   /api/roles                     (président) attribuer un rôle → code temporaire
 *   POST   /api/roles/:id/renouveler      (président) nouveau code temporaire
 *   DELETE /api/roles/:id                 (président) révoquer un rôle
 *   POST   /api/roles/mon-code/initialiser (code temporaire) choisir son code personnel
 *   POST   /api/roles/mon-code            (titulaire) changer son code
 *
 * LA PROMESSE DE CE FICHIER : le président ne connaît JAMAIS le code définitif de
 * ses collaborateurs. Il remet un code temporaire, valable vingt-quatre heures et
 * à usage unique ; son porteur choisit son code personnel à la première
 * connexion, et le temporaire meurt à cet instant.
 *
 * Aucune route d'ici ne renvoie de code en clair, à une exception près et
 * volontaire : le code temporaire qu'on vient de tirer, renvoyé une seule fois à
 * celui qui l'a demandé. Le code DÉFINITIF, lui, n'existe en clair qu'entre le
 * clavier de son porteur et la fonction de hachage.
 */
'use strict';

const express = require('express');

const { exigerRole, exigerTitulaire, exigerTitulaireMemeTemporaire } = require('../middleware/auth');
const roles = require('../services/roles');
const codes = require('../services/codes');
const limiteur = require('../middleware/limiteur');

const routeur = express.Router();

/** Longueur maximale d'un libellé de rôle (« Trésorier Junior »). */
const LIBELLE_MAX = 60;

/** Identifiant de rôle porté par l'URL, ou null. */
function identifiantRole(requete) {
  const identifiant = Number.parseInt(requete.params.id, 10);
  return Number.isInteger(identifiant) && identifiant > 0 ? identifiant : null;
}

/**
 * GET /api/roles — état des rôles de l'association.
 *
 * Titulaire, libellé, date de dernière utilisation, état. JAMAIS de code, pas
 * même haché : la requête de src/services/roles.js ne sélectionne pas la
 * colonne, ce qui rend l'oubli impossible.
 */
routeur.get('/', exigerRole('president'), async (requete, reponse) => {
  try {
    const liste = await roles.lister(requete.db);
    const membres = await requete.db.lireToutes(
      `SELECT id, name, telephone
         FROM members
        WHERE COALESCE(statut, 'actif') <> 'ecarte'
        ORDER BY name COLLATE NOCASE ASC`
    );

    console.log(`[roles] liste servie : ${liste.length} rôle(s) [${requete.association.code}]`);
    return reponse.status(200).json({
      roles: liste,
      roles_possibles: roles.ROLES.map((role) => ({
        role,
        libelle: roles.LIBELLES_ROLES[role],
      })),
      // Seuls les membres pourvus d'un téléphone peuvent recevoir un rôle : sans
      // numéro, ils n'auraient aucun moyen de récupérer un code perdu.
      membres_eligibles: membres
        .filter((membre) => membre.telephone)
        .map((membre) => ({
          id: membre.id,
          name: membre.name,
          telephone: codes.masquerTelephone(membre.telephone),
        })),
      membres_sans_telephone: membres
        .filter((membre) => !membre.telephone)
        .map((membre) => ({ id: membre.id, name: membre.name })),
      heures_validite_code: roles.HEURES_CODE_TEMPORAIRE,
    });
  } catch (erreur) {
    console.error(`[roles] lecture impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les rôles' });
  }
});

/**
 * POST /api/roles — attribuer un rôle.
 *
 * Corps : { role, membre_id, libelle }
 * Réponse 201 : { id, role, code_temporaire, expire_le }
 *
 * Le code temporaire est renvoyé UNE FOIS. Le président le transmet comme il veut
 * — WhatsApp, de vive voix — et son porteur choisira son code personnel à la
 * première connexion.
 */
routeur.post('/', exigerRole('president'), async (requete, reponse) => {
  const role = roles.normaliserRole(requete.body?.role);
  if (!roles.ROLES.includes(role)) {
    return reponse.status(400).json({
      error: `Rôle invalide (attendu : ${roles.ROLES.join(', ')})`,
    });
  }

  const membreId = Number.parseInt(requete.body?.membre_id, 10);
  if (!Number.isInteger(membreId) || membreId <= 0) {
    return reponse.status(400).json({ error: 'Indiquez le membre titulaire du rôle' });
  }

  const libelle = String(requete.body?.libelle || '').trim().slice(0, LIBELLE_MAX) || null;

  try {
    const membre = await requete.db.lireUne('SELECT id, name, telephone, statut FROM members WHERE id = ?', [
      membreId,
    ]);
    if (!membre) return reponse.status(404).json({ error: 'Membre introuvable' });

    // Un rôle sans téléphone est un rôle qu'on ne pourra jamais dépanner : le
    // jour où le code est perdu, il n'y a plus personne à joindre, et l'éditeur
    // n'intervient pas. Le refus est donc au moment de l'attribution.
    if (!membre.telephone) {
      return reponse.status(400).json({
        error: `Renseignez d’abord le téléphone de ${membre.name} : un rôle sans numéro ne peut pas être dépanné.`,
        code: 'telephone_requis',
      });
    }

    if (membre.statut === 'ecarte') {
      return reponse.status(409).json({
        error: `${membre.name} est mis à l’écart : réintégrez-le avant de lui confier un rôle.`,
      });
    }

    const emission = await roles.attribuer(requete.db, { role, membreId, libelle });

    console.log(
      `[roles] ${roles.LIBELLES_ROLES[role]} attribué à ${membre.name} ` +
        `[${requete.association.code}] par ${requete.agent}`
    );

    return reponse.status(201).json({
      id: emission.id,
      role,
      role_libelle: roles.LIBELLES_ROLES[role],
      membre: membre.name,
      libelle,
      // Affiché une seule fois. Il n'est pas stocké en clair et ne peut pas être
      // réaffiché : le président devra renouveler s'il l'égare.
      code_temporaire: emission.code,
      expire_le: emission.expire_le,
      avertissement:
        `Ce code n’est valable que ${roles.HEURES_CODE_TEMPORAIRE} heures et ne sera plus affiché. ` +
        `${membre.name} choisira son propre code à la première connexion.`,
    });
  } catch (erreur) {
    console.error(`[roles] attribution impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible d’attribuer ce rôle' });
  }
});

/**
 * POST /api/roles/:id/renouveler — nouveau code temporaire sur un rôle existant.
 *
 * L'ancien code cesse aussitôt de fonctionner : c'est l'intérêt de l'opération —
 * le collaborateur a changé de téléphone, oublié son code, ou celui-ci a fuité.
 */
routeur.post('/:id/renouveler', exigerRole('president'), async (requete, reponse) => {
  const identifiant = identifiantRole(requete);
  if (identifiant === null) return reponse.status(400).json({ error: 'Identifiant de rôle invalide' });

  try {
    const emission = await roles.renouveler(requete.db, identifiant);

    console.log(
      `[roles] code renouvelé — rôle #${identifiant} [${requete.association.code}] par ${requete.agent}`
    );
    return reponse.status(200).json({
      id: emission.id,
      role: emission.role,
      role_libelle: roles.LIBELLES_ROLES[emission.role] || emission.role,
      code_temporaire: emission.code,
      expire_le: emission.expire_le,
      avertissement: `Ce code n’est valable que ${roles.HEURES_CODE_TEMPORAIRE} heures et ne sera plus affiché.`,
    });
  } catch (erreur) {
    if (erreur.refusUtilisateur) return reponse.status(404).json({ error: erreur.message });
    console.error(`[roles] renouvellement impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de renouveler ce code' });
  }
});

/**
 * DELETE /api/roles/:id — révoquer un rôle.
 *
 * La ligne reste en base avec « actif = 0 » : une révocation doit se voir, et un
 * rôle effacé rendrait incompréhensible l'historique des validations portant le
 * nom de son titulaire.
 *
 * Le DERNIER président ne peut pas être révoqué. Sans lui, personne ne peut plus
 * attribuer de rôle, et l'éditeur n'intervient jamais : l'association serait
 * définitivement murée.
 */
routeur.delete('/:id', exigerRole('president'), async (requete, reponse) => {
  const identifiant = identifiantRole(requete);
  if (identifiant === null) return reponse.status(400).json({ error: 'Identifiant de rôle invalide' });

  try {
    const cible = await requete.db.lireUne('SELECT id, role, actif FROM roles_codes WHERE id = ?', [
      identifiant,
    ]);
    if (!cible) return reponse.status(404).json({ error: 'Rôle introuvable' });

    if (cible.role === 'president' && (await roles.nombrePresidentsActifs(requete.db, identifiant)) === 0) {
      console.warn(`[roles] révocation du dernier président refusée [${requete.association.code}]`);
      return reponse.status(409).json({
        error:
          'Impossible de révoquer le dernier président : plus personne ne pourrait attribuer de rôle. ' +
          'Attribuez d’abord le rôle de président à un autre membre.',
        code: 'dernier_president',
      });
    }

    await roles.revoquer(requete.db, identifiant);
    console.log(
      `[roles] rôle #${identifiant} (${cible.role}) révoqué [${requete.association.code}] par ${requete.agent}`
    );
    return reponse.status(200).json({ id: identifiant, role: cible.role, revoque: true });
  } catch (erreur) {
    if (erreur.refusUtilisateur) return reponse.status(404).json({ error: erreur.message });
    console.error(`[roles] révocation impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de révoquer ce rôle' });
  }
});

/**
 * POST /api/roles/mon-code/initialiser — choisir son code personnel.
 *
 * Corps : { nouveau_code }
 *
 * SEULE route accessible avec un code temporaire, et c'est tout le mécanisme :
 * partout ailleurs, un code temporaire reçoit un 403 « code_personnel_requis ».
 * Le collaborateur ne peut donc rien faire d'autre que choisir son code, et à
 * cet instant le code que le président lui a remis cesse d'exister.
 */
routeur.post('/mon-code/initialiser', exigerTitulaireMemeTemporaire(), async (requete, reponse) => {
  if (!requete.roleId) {
    // Repli historique (.env) : il n'y a pas de ligne à mettre à jour.
    return reponse.status(409).json({
      error: 'Ce code ne peut pas être personnalisé depuis l’application.',
    });
  }

  const nouveau = requete.body?.nouveau_code;
  const refus = codes.refusCodePersonnel(nouveau);
  if (refus) return reponse.status(400).json({ error: refus });

  try {
    // Un code déjà définitif ne se réinitialise pas par cette route : son
    // porteur doit passer par « mon-code » et présenter son ancien code.
    if (!requete.codeTemporaire) {
      return reponse.status(409).json({
        error: 'Votre code est déjà personnel. Utilisez « changer mon code ».',
        code: 'code_deja_personnel',
      });
    }

    await roles.definirCodePersonnel(requete.db, requete.roleId, nouveau);

    console.log(
      `[roles] code personnel choisi — rôle #${requete.roleId} (${requete.roleCourant}) ` +
        `[${requete.association.code}]`
    );
    return reponse.status(200).json({
      role: requete.roleCourant,
      role_libelle: roles.LIBELLES_ROLES[requete.roleCourant] || requete.roleCourant,
      code_personnel_defini: true,
      message: 'Votre code personnel est enregistré. Personne d’autre ne le connaît.',
    });
  } catch (erreur) {
    if (erreur.refusUtilisateur) return reponse.status(400).json({ error: erreur.message });
    console.error(`[roles] initialisation de code impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible d’enregistrer votre code' });
  }
});

/**
 * POST /api/roles/mon-code — changer volontairement son code.
 *
 * Corps : { ancien_code, nouveau_code }
 *
 * Accessible à tout titulaire, POUR LUI-MÊME UNIQUEMENT : l'ancien code doit
 * être présenté, et c'est lui qui désigne la ligne à modifier. Aucun paramètre
 * ne permet de viser le rôle d'un autre.
 */
routeur.post('/mon-code', exigerTitulaire(), async (requete, reponse) => {
  const source = `${requete.association.code}|${limiteur.sourceDe(requete)}`;
  const ancien = String(requete.body?.ancien_code || '');
  const nouveau = requete.body?.nouveau_code;

  if (!requete.roleId) {
    return reponse.status(409).json({
      error: 'Ce code ne peut pas être changé depuis l’application.',
    });
  }

  const refus = codes.refusCodePersonnel(nouveau);
  if (refus) return reponse.status(400).json({ error: refus });

  try {
    const ligne = await requete.db.lireUne('SELECT id, code_hash FROM roles_codes WHERE id = ?', [
      requete.roleId,
    ]);
    if (!ligne) return reponse.status(404).json({ error: 'Rôle introuvable' });

    // L'ancien code est exigé même si l'appelant est déjà authentifié : sans
    // cela, un téléphone laissé déverrouillé permettrait de changer le code et
    // d'exclure son propriétaire de son propre rôle.
    const correspond = await codes.verifier(ancien, ligne.code_hash);
    if (!correspond) {
      limiteur.enregistrerEchec(source, 'changement de code');
      return reponse.status(401).json({ error: 'Ancien code incorrect' });
    }

    if (await codes.verifier(nouveau, ligne.code_hash)) {
      return reponse.status(400).json({ error: 'Le nouveau code doit être différent de l’ancien.' });
    }

    await roles.definirCodePersonnel(requete.db, requete.roleId, nouveau);
    limiteur.reinitialiser(source);

    console.log(
      `[roles] code changé par son porteur — rôle #${requete.roleId} (${requete.roleCourant}) ` +
        `[${requete.association.code}]`
    );
    return reponse.status(200).json({ code_change: true, message: 'Votre code est modifié.' });
  } catch (erreur) {
    if (erreur.refusUtilisateur) return reponse.status(400).json({ error: erreur.message });
    console.error(`[roles] changement de code impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de changer votre code' });
  }
});

module.exports = routeur;
