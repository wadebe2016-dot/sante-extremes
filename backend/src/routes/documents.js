/**
 * Documents déposés sur S3 — Santé des extrêmes (LOT 3).
 *
 *   POST   /api/documents/reglement               (secrétaire)  publier une version
 *   GET    /api/documents/reglement               (public)      version courante
 *   POST   /api/documents/fiche-sante/:member_id  (secrétaire)  déposer / remplacer
 *   GET    /api/documents/fiche-sante/:member_id  (secrétaire)  consulter
 *   DELETE /api/documents/fiche-sante/:member_id  (secrétaire)  retirer
 *
 * Aucun fichier n'est servi par une URL publique : le backend renvoie une URL
 * pré-signée valable 10 minutes. Le bucket reste privé.
 *
 * Les fiches santé contiennent des données de santé. Elles ne sont accessibles
 * qu'au secrétariat et à l'administration, n'apparaissent dans aucun export ni
 * dans /api/stats, et chaque consultation est tracée dans le journal serveur
 * (rôle, membre, date) — jamais l'URL signée, qui vaut droit de lecture.
 */
'use strict';

const express = require('express');
const { executer, lireUne } = require('../db');
const { exigerRole } = require('../middleware/auth');
const {
  recevoirDocument,
  televerserDocument,
  urlPresignee,
  gererErreursUpload,
} = require('../middleware/s3upload');

const routeur = express.Router();

/** Middleware de réception d'un document, erreurs multer traduites. */
function recevoirFichier(requete, reponse, suite) {
  return recevoirDocument(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  );
}

/** Horodatage lisible pour le journal de consultation. */
function maintenant() {
  return new Date().toISOString();
}

/**
 * Marque les versions précédentes comme archivées, puis enregistre la nouvelle.
 * Les anciennes lignes — et les objets S3 correspondants — sont conservées.
 */
async function enregistrerVersion({ type, idMembre, depot }) {
  if (type === 'reglement') {
    await executer("UPDATE documents SET courant = 0 WHERE type = 'reglement' AND courant = 1");
  } else {
    await executer(
      "UPDATE documents SET courant = 0 WHERE type = 'fiche_sante' AND member_id = ? AND courant = 1",
      [idMembre]
    );
  }

  const resultat = await executer(
    'INSERT INTO documents (type, member_id, cle_s3, nom_fichier, taille) VALUES (?, ?, ?, ?, ?)',
    [type, idMembre, depot.cle, depot.nom, depot.taille]
  );

  return lireUne(
    'SELECT id, type, member_id, nom_fichier, taille, date_depot FROM documents WHERE id = ?',
    [resultat.id]
  );
}

// ---------------------------------------------------------------------------
// Règlement intérieur
// ---------------------------------------------------------------------------

/** POST /api/documents/reglement — publier une nouvelle version (secrétaire). */
routeur.post(
  '/reglement',
  exigerRole('secretaire'),
  recevoirFichier,
  async (requete, reponse) => {
    if (!requete.file) {
      return reponse.status(400).json({ error: 'Aucun fichier reçu (champ « fichier » attendu)' });
    }

    try {
      const depot = await televerserDocument(requete.file, 'reglement', null);
      const document = await enregistrerVersion({ type: 'reglement', idMembre: null, depot });

      console.log(
        `[documents] règlement intérieur publié : « ${document.nom_fichier} » ` +
          `(${document.taille} octets) le ${document.date_depot}`
      );

      return reponse.status(201).json({
        nom_fichier: document.nom_fichier,
        taille: document.taille,
        date_depot: document.date_depot,
      });
    } catch (erreur) {
      console.error(`[documents] échec de la publication du règlement : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || 'Impossible de publier le règlement' });
    }
  }
);

/** GET /api/documents/reglement — version courante (public). */
routeur.get('/reglement', async (requete, reponse) => {
  try {
    const document = await lireUne(
      "SELECT * FROM documents WHERE type = 'reglement' AND courant = 1 ORDER BY id DESC LIMIT 1"
    );

    if (!document) {
      console.log('[documents] aucun règlement intérieur publié');
      return reponse.status(404).json({ error: 'Aucun règlement publié' });
    }

    const url = await urlPresignee(document.cle_s3);

    console.log(`[documents] règlement consulté (public) le ${maintenant()}`);
    return reponse.status(200).json({
      nom_fichier: document.nom_fichier,
      date_depot: document.date_depot,
      taille: document.taille,
      url,
    });
  } catch (erreur) {
    console.error(`[documents] échec de la lecture du règlement : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger le règlement' });
  }
});

// ---------------------------------------------------------------------------
// Fiches santé individuelles — données sensibles
// ---------------------------------------------------------------------------

/** Valide et renvoie l'identifiant de membre de l'URL, ou null. */
function identifiantMembre(requete) {
  const identifiant = Number.parseInt(requete.params.member_id, 10);
  return Number.isInteger(identifiant) && identifiant > 0 ? identifiant : null;
}

/** POST /api/documents/fiche-sante/:member_id — déposer ou remplacer (secrétaire). */
routeur.post(
  '/fiche-sante/:member_id',
  exigerRole('secretaire'),
  recevoirFichier,
  async (requete, reponse) => {
    const idMembre = identifiantMembre(requete);
    if (idMembre === null) {
      return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
    }

    if (!requete.file) {
      return reponse.status(400).json({ error: 'Aucun fichier reçu (champ « fichier » attendu)' });
    }

    try {
      const membre = await lireUne('SELECT id, name FROM members WHERE id = ?', [idMembre]);
      if (!membre) {
        return reponse.status(404).json({ error: 'Membre introuvable' });
      }

      const depot = await televerserDocument(requete.file, 'fiche_sante', idMembre);
      const document = await enregistrerVersion({ type: 'fiche_sante', idMembre, depot });

      console.log(
        `[documents] fiche santé déposée — membre #${idMembre} — rôles ${(requete.roles || []).join(',')} — ${maintenant()}`
      );

      return reponse.status(201).json({
        member_id: idMembre,
        nom_fichier: document.nom_fichier,
        taille: document.taille,
        date_depot: document.date_depot,
      });
    } catch (erreur) {
      console.error(`[documents] échec du dépôt de la fiche santé #${idMembre} : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || 'Impossible de déposer la fiche santé' });
    }
  }
);

/** GET /api/documents/fiche-sante/:member_id — consulter (secrétaire). */
routeur.get('/fiche-sante/:member_id', exigerRole('secretaire'), async (requete, reponse) => {
  const idMembre = identifiantMembre(requete);
  if (idMembre === null) {
    return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
  }

  try {
    const document = await lireUne(
      "SELECT * FROM documents WHERE type = 'fiche_sante' AND member_id = ? AND courant = 1 ORDER BY id DESC LIMIT 1",
      [idMembre]
    );

    if (!document) {
      // Traçage de la tentative également : savoir qui a cherché à consulter
      // quelle fiche fait partie de la piste d'audit.
      console.log(
        `[documents] consultation fiche santé — membre #${idMembre} — aucune fiche — ` +
          `rôles ${(requete.roles || []).join(',')} — ${maintenant()}`
      );
      return reponse.status(404).json({ error: 'Aucune fiche santé pour ce membre' });
    }

    const url = await urlPresignee(document.cle_s3);

    console.log(
      `[documents] consultation fiche santé — membre #${idMembre} — ` +
        `rôles ${(requete.roles || []).join(',')} — ${maintenant()}`
    );

    return reponse.status(200).json({
      member_id: idMembre,
      nom_fichier: document.nom_fichier,
      date_depot: document.date_depot,
      taille: document.taille,
      url,
    });
  } catch (erreur) {
    console.error(`[documents] échec de la consultation #${idMembre} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger la fiche santé' });
  }
});

/**
 * DELETE /api/documents/fiche-sante/:member_id — retirer la fiche (secrétaire).
 *
 * La ligne est retirée de la base et l'objet S3 supprimé : sur une donnée de
 * santé, la conservation par défaut ne se justifie pas.
 */
routeur.delete('/fiche-sante/:member_id', exigerRole('secretaire'), async (requete, reponse) => {
  const idMembre = identifiantMembre(requete);
  if (idMembre === null) {
    return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
  }

  try {
    const document = await lireUne(
      "SELECT * FROM documents WHERE type = 'fiche_sante' AND member_id = ? AND courant = 1 ORDER BY id DESC LIMIT 1",
      [idMembre]
    );

    if (!document) {
      return reponse.status(404).json({ error: 'Aucune fiche santé pour ce membre' });
    }

    await executer("DELETE FROM documents WHERE type = 'fiche_sante' AND member_id = ?", [idMembre]);

    // Import tardif : la suppression S3 est facultative, une erreur ici ne doit
    // pas empêcher le retrait de la fiche côté base.
    const { supprimerObjet } = require('../middleware/s3upload');
    await supprimerObjet(document.cle_s3);

    console.log(
      `[documents] fiche santé supprimée — membre #${idMembre} — ` +
        `rôles ${(requete.roles || []).join(',')} — ${maintenant()}`
    );

    return reponse.status(200).json({ message: 'Fiche santé supprimée' });
  } catch (erreur) {
    console.error(`[documents] échec de la suppression #${idMembre} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de supprimer la fiche santé' });
  }
});

module.exports = routeur;
