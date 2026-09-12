/**
 * Middleware d'upload : multer en mémoire (images uniquement, 5 Mo max)
 * puis téléversement du justificatif de paiement vers AWS S3 (eu-west-3).
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const TAILLE_MAX = Number(process.env.S3_MAX_FILE_SIZE || 5 * 1024 * 1024);
const TYPES_AUTORISES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

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

const uploadMemoire = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX, files: 1 },
  fileFilter: filtrerImages,
});

/** Middleware prêt à l'emploi : un seul fichier, champ « fichier ». */
const recevoirJustificatif = uploadMemoire.single('fichier');

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
 * Téléverse le justificatif sur S3 et renvoie son URL publique.
 * @returns {Promise<string>} URL https du fichier déposé
 */
async function televerserJustificatif(fichier, idMembre) {
  const bucket = process.env.AWS_BUCKET;
  const region = process.env.AWS_REGION || 'eu-west-3';

  if (!bucket) {
    throw new Error('AWS_BUCKET non configuré : impossible de téléverser le justificatif');
  }

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
 * Traduit les erreurs multer en réponses HTTP lisibles.
 */
function gererErreursUpload(erreur, requete, reponse, suite) {
  if (erreur instanceof multer.MulterError) {
    if (erreur.code === 'LIMIT_FILE_SIZE') {
      console.warn(`[upload] fichier trop volumineux (> ${TAILLE_MAX} octets)`);
      return reponse
        .status(413)
        .json({ error: `Fichier trop volumineux (maximum ${Math.round(TAILLE_MAX / 1024 / 1024)} Mo)` });
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

module.exports = { recevoirJustificatif, televerserJustificatif, gererErreursUpload, TAILLE_MAX };
