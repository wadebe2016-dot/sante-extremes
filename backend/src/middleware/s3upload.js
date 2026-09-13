/**
 * Dépôt de fichiers sur AWS S3 — Santé des extrêmes.
 *
 * Deux usages distincts :
 *   1. Justificatifs de paiement (LOT 1) : images, 5 Mo, préfixe « cotisations/ ».
 *      L'URL renvoyée est stockée telle quelle avec la cotisation.
 *   2. Documents (LOT 3) : règlement intérieur et fiches santé, PDF ou image,
 *      10 Mo, préfixes « documents/… ». Ces fichiers ne sont JAMAIS exposés par
 *      une URL publique : seule une URL pré-signée de 10 minutes est produite,
 *      à la demande et pour un appelant déjà authentifié.
 *
 * Aucune clé n'est écrite en dur : si AWS_ACCESS_KEY_ID n'est pas fourni, le
 * SDK suit sa chaîne d'identifiants habituelle (rôle IAM de l'instance, profil
 * local…).
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const TAILLE_MAX = Number(process.env.S3_MAX_FILE_SIZE || 5 * 1024 * 1024);
const TAILLE_MAX_DOCUMENT = Number(process.env.S3_MAX_DOCUMENT_SIZE || 10 * 1024 * 1024);
const DUREE_URL_SIGNEE = Number(process.env.S3_URL_DUREE_SECONDES || 600); // 10 minutes

const TYPES_AUTORISES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const TYPES_DOCUMENT_AUTORISES = ['application/pdf', 'image/jpeg', 'image/png'];

let clientS3 = null;

/**
 * Client S3 construit à la demande, à partir des variables d'environnement.
 * Si AWS_ACCESS_KEY_ID n'est pas fourni, le SDK utilise la chaîne de credentials
 * par défaut (rôle IAM, profil local, etc.).
 */
function obtenirClientS3() {
  if (clientS3) return clientS3;

  const region = process.env.AWS_REGION || 'eu-west-3';
  const configuration = { region };

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    configuration.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }

  clientS3 = new S3Client(configuration);
  console.log(`[s3] client initialisé sur la région ${region}`);
  return clientS3;
}

/** @returns {string} nom du bucket configuré */
function exigerBucket() {
  const bucket = process.env.AWS_BUCKET;
  if (!bucket) {
    throw new Error('AWS_BUCKET non configuré : dépôt de fichier impossible');
  }
  return bucket;
}

/**
 * Filtre multer : seules les images sont acceptées.
 */
function filtrerImages(requete, fichier, rappel) {
  if (!TYPES_AUTORISES.includes(fichier.mimetype)) {
    console.warn(`[upload] type de fichier refusé : ${fichier.mimetype}`);
    return rappel(new Error('Seules les images sont acceptées (JPEG, PNG, WEBP, HEIC)'));
  }
  return rappel(null, true);
}

/** Filtre multer des documents : PDF ou image. */
function filtrerDocuments(requete, fichier, rappel) {
  if (!TYPES_DOCUMENT_AUTORISES.includes(fichier.mimetype)) {
    console.warn(`[upload] document refusé : ${fichier.mimetype}`);
    return rappel(new Error('Seuls les fichiers PDF, JPEG et PNG sont acceptés'));
  }
  return rappel(null, true);
}

const uploadMemoire = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX, files: 1 },
  fileFilter: filtrerImages,
});

const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_DOCUMENT, files: 1 },
  fileFilter: filtrerDocuments,
});

/** Middleware prêt à l'emploi : un seul fichier, champ « fichier ». */
const recevoirJustificatif = uploadMemoire.single('fichier');

/** Idem pour les documents (règlement intérieur, fiche santé). */
const recevoirDocument = uploadDocument.single('fichier');

/**
 * Construit une clé S3 unique et non devinable pour le justificatif.
 */
function construireCleS3(idMembre, nomOriginal) {
  const extension = (path.extname(nomOriginal || '') || '.jpg').toLowerCase();
  const empreinte = crypto.randomBytes(8).toString('hex');
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
  return `cotisations/membre-${idMembre}/${horodatage}-${empreinte}${extension}`;
}

/**
 * Construit la clé S3 d'un document.
 *
 * L'horodatage dans la clé garantit qu'un nouveau dépôt n'écrase jamais le
 * précédent : les versions antérieures du règlement restent consultables.
 *
 * @param {'reglement'|'fiche_sante'} type nature du document
 * @param {number|null} idMembre membre concerné (fiches santé uniquement)
 * @param {string} nomOriginal nom du fichier téléversé
 */
function construireCleDocument(type, idMembre, nomOriginal) {
  const extension = (path.extname(nomOriginal || '') || '.pdf').toLowerCase();
  const empreinte = crypto.randomBytes(8).toString('hex');
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-');

  const prefixe =
    type === 'reglement' ? 'documents/reglement' : `documents/fiches-sante/membre-${idMembre}`;

  return `${prefixe}/${horodatage}-${empreinte}${extension}`;
}

/**
 * Téléverse le justificatif sur S3 et renvoie son URL publique.
 * @returns {Promise<string>} URL https du fichier déposé
 */
async function televerserJustificatif(fichier, idMembre) {
  const bucket = exigerBucket();
  const region = process.env.AWS_REGION || 'eu-west-3';
  const cle = construireCleS3(idMembre, fichier.originalname);

  try {
    await obtenirClientS3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: cle,
        Body: fichier.buffer,
        ContentType: fichier.mimetype,
        ContentLength: fichier.size,
      })
    );
  } catch (erreur) {
    console.error(`[s3] échec du téléversement de ${cle} : ${erreur.message}`);
    throw new Error("Le justificatif n'a pas pu être enregistré sur S3");
  }

  // En production le bucket est privé et diffusé par CloudFront : l'URL publique
  // passe par PUBLIC_MEDIA_BASE_URL (https://sde-cdn.atlastech.cm). Sans cette
  // variable, on retombe sur l'URL S3 directe (développement local).
  const baseMedia = (process.env.PUBLIC_MEDIA_BASE_URL || '').trim().replace(/\/+$/, '');
  const url = baseMedia
    ? `${baseMedia}/${cle}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${cle}`;

  console.log(`[s3] justificatif déposé : ${url} (${fichier.size} octets)`);
  return url;
}

/**
 * Téléverse un document (règlement, fiche santé) et renvoie sa clé S3.
 *
 * On ne renvoie PAS d'URL : ces fichiers restent privés, l'accès se fait par
 * URL pré-signée (cf. urlPresignee).
 *
 * @returns {Promise<{cle: string, taille: number, nom: string}>}
 */
async function televerserDocument(fichier, type, idMembre = null) {
  const bucket = exigerBucket();
  const cle = construireCleDocument(type, idMembre, fichier.originalname);

  try {
    await obtenirClientS3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: cle,
        Body: fichier.buffer,
        ContentType: fichier.mimetype,
        ContentLength: fichier.size,
      })
    );
  } catch (erreur) {
    console.error(`[s3] échec du dépôt du document ${cle} : ${erreur.message}`);
    throw new Error("Le document n'a pas pu être enregistré sur S3");
  }

  console.log(`[s3] document déposé : ${cle} (${fichier.size} octets, ${fichier.mimetype})`);
  return {
    cle,
    taille: fichier.size,
    nom: path.basename(fichier.originalname || 'document'),
  };
}

/**
 * Produit une URL pré-signée de courte durée pour lire un objet privé.
 *
 * L'URL porte les droits de lecture : elle ne doit jamais être journalisée ni
 * stockée. Sa durée de vie volontairement courte limite la casse en cas de
 * partage accidentel.
 *
 * @param {string} cle clé S3 de l'objet
 * @param {number} dureeSecondes validité de l'URL
 * @returns {Promise<string>}
 */
async function urlPresignee(cle, dureeSecondes = DUREE_URL_SIGNEE) {
  const bucket = exigerBucket();

  try {
    const commande = new GetObjectCommand({ Bucket: bucket, Key: cle });
    const url = await getSignedUrl(obtenirClientS3(), commande, { expiresIn: dureeSecondes });
    // Volontairement : on journalise la clé, jamais l'URL signée.
    console.log(`[s3] URL pré-signée émise pour ${cle} (${dureeSecondes} s)`);
    return url;
  } catch (erreur) {
    console.error(`[s3] échec de la signature de ${cle} : ${erreur.message}`);
    throw new Error("Le document n'a pas pu être mis à disposition");
  }
}

/**
 * Supprime un objet S3. L'échec n'est pas fatal : la ligne en base a déjà été
 * retirée, un objet orphelin est moins grave qu'une suppression bloquée.
 */
async function supprimerObjet(cle) {
  const bucket = exigerBucket();

  try {
    await obtenirClientS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: cle }));
    console.log(`[s3] objet supprimé : ${cle}`);
    return true;
  } catch (erreur) {
    console.warn(`[s3] suppression impossible pour ${cle} : ${erreur.message}`);
    return false;
  }
}

/**
 * Traduit les erreurs multer en réponses HTTP lisibles.
 */
function gererErreursUpload(erreur, requete, reponse, suite) {
  if (erreur instanceof multer.MulterError) {
    if (erreur.code === 'LIMIT_FILE_SIZE') {
      console.warn('[upload] fichier trop volumineux');
      return reponse.status(413).json({ error: 'Fichier trop volumineux' });
    }
    console.warn(`[upload] erreur multer : ${erreur.code}`);
    return reponse.status(400).json({ error: `Envoi du fichier refusé : ${erreur.code}` });
  }

  if (erreur) {
    console.warn(`[upload] envoi rejeté : ${erreur.message}`);
    return reponse.status(400).json({ error: erreur.message });
  }

  return suite();
}

module.exports = {
  recevoirJustificatif,
  televerserJustificatif,
  recevoirDocument,
  televerserDocument,
  urlPresignee,
  supprimerObjet,
  gererErreursUpload,
  TAILLE_MAX,
  TAILLE_MAX_DOCUMENT,
  DUREE_URL_SIGNEE,
};
