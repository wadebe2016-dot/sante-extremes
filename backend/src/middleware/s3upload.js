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
const TYPES_RECU_AUTORISES = [...TYPES_AUTORISES, 'application/pdf'];

/**
 * Detecte le type reel d'un fichier a partir de ses premiers octets.
 *
 * Le Content-Type annonce par le client N'EST PAS fiable : un envoi multipart
 * sans type explicite arrive en « application/octet-stream », et une capture
 * d'ecran parfaitement valide se voyait refusee. A l'inverse, un .txt renomme
 * .jpg s'annoncerait « image/jpeg » sans en etre une. Les octets d'en-tete,
 * eux, ne mentent pas.
 *
 * @param {Buffer} tampon contenu du fichier
 * @returns {string} type MIME detecte, « application/octet-stream » a defaut
 */
function detecterType(tampon) {
  if (!Buffer.isBuffer(tampon) || tampon.length < 4) return 'application/octet-stream';

  // JPEG : FF D8 FF
  if (tampon[0] === 0xff && tampon[1] === 0xd8 && tampon[2] === 0xff) return 'image/jpeg';

  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (tampon.length >= 8 &&
      tampon.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  // WEBP : « RIFF » .... « WEBP »
  if (tampon.length >= 12 &&
      tampon.slice(0, 4).toString('ascii') === 'RIFF' &&
      tampon.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  // HEIC / HEIF : boite « ftyp » suivie d'une marque connue
  if (tampon.length >= 12 && tampon.slice(4, 8).toString('ascii') === 'ftyp') {
    const marque = tampon.slice(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(marque)) {
      return 'image/heic';
    }
    if (['mif1', 'msf1'].includes(marque)) return 'image/heif';
  }

  // PDF : « %PDF »
  if (tampon.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';

  // GIF : detecte pour pouvoir le nommer dans le message de refus
  if (tampon.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';

  // Faute de signature, on distingue au moins le texte du binaire :
  // « text/plain » est un refus bien plus parlant que « octet-stream ».
  const echantillon = tampon.slice(0, Math.min(512, tampon.length));
  const lisible = echantillon.every(
    (octet) => octet === 0x09 || octet === 0x0a || octet === 0x0d || (octet >= 0x20 && octet !== 0x7f)
  );
  return lisible ? 'text/plain' : 'application/octet-stream';
}

/**
 * Verifie le type reel du fichier recu et corrige son mimetype.
 *
 * Le type detecte remplace celui annonce : c'est lui qui part sur S3 en
 * ContentType, sans quoi un justificatif valide y serait range en
 * « octet-stream » et telecharge au lieu d'etre affiche.
 *
 * @returns {string|null} message de refus, ou null si le fichier convient
 */
function verifierTypeReel(fichier, typesAutorises, description) {
  if (!fichier || !fichier.buffer) return null; // fichier facultatif absent

  const detecte = detecterType(fichier.buffer);

  if (!typesAutorises.includes(detecte)) {
    console.warn(`[upload] refus : ${detecte} detecte (annonce ${fichier.mimetype || 'aucun'})`);
    return `Fichier non ${description} (${detecte} detecte)`;
  }

  fichier.mimetype = detecte;
  return null;
}

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

// Les filtres multer ne filtrent PLUS par type : a ce stade le contenu n'est
// pas encore lu, et le type annonce n'est pas digne de confiance. La validation
// se fait apres reception, sur les octets (verifierTypeReel).
const uploadMemoire = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX, files: 1 },
});

const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_DOCUMENT, files: 1 },
});

const uploadRecu = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX, files: 1 },
});

/**
 * Construit un middleware « recevoir puis valider ».
 *
 * Signature identique a celle d'un middleware multer, pour que les routes
 * existantes n'aient rien a changer : l'erreur eventuelle est transmise a
 * gererErreursUpload, qui la traduit en 400.
 */
function recevoirEtValider(televerseur, typesAutorises, description) {
  const recevoir = televerseur.single('fichier');

  return function middleware(requete, reponse, suite) {
    recevoir(requete, reponse, (erreur) => {
      if (erreur) return suite(erreur);

      const probleme = verifierTypeReel(requete.file, typesAutorises, description);
      if (probleme) return suite(new Error(probleme));

      return suite();
    });
  };
}

/** Justificatif de paiement : images uniquement, 5 Mo. */
const recevoirJustificatif = recevoirEtValider(uploadMemoire, TYPES_AUTORISES, 'image');

/** Recu de declaration : image ou PDF, 5 Mo. */
const recevoirRecu = recevoirEtValider(uploadRecu, TYPES_RECU_AUTORISES, 'image ou PDF');

/** Document : reglement interieur ou fiche sante, PDF ou image, 10 Mo. */
const recevoirDocument = recevoirEtValider(uploadDocument, TYPES_DOCUMENT_AUTORISES, 'PDF, JPEG ou PNG');

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
 * Téléverse le justificatif sur S3 et renvoie sa clé ET son URL publique.
 *
 * La clé sert aux justificatifs de déclaration, qui restent privés et ne sont
 * consultés que par le trésorier, via une URL pré-signée.
 *
 * @returns {Promise<{cle: string, url: string}>}
 */
async function televerserJustificatifDetaille(fichier, idMembre) {
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

  console.log(`[s3] justificatif déposé : ${cle} (${fichier.size} octets)`);
  return { cle, url };
}

/**
 * Variante historique : ne renvoie que l'URL.
 * @returns {Promise<string>} URL https du fichier déposé
 */
async function televerserJustificatif(fichier, idMembre) {
  const { url } = await televerserJustificatifDetaille(fichier, idMembre);
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
 * Téléverse un fichier sous un préfixe libre et renvoie sa clé.
 *
 * Sert aux pièces des dépenses — devis et justificatifs de décaissement — qui
 * ne se rattachent à aucun membre et n'ont donc rien à faire sous
 * « cotisations/ ». Comme les documents, elles restent privées : seule une URL
 * pré-signée permet de les lire.
 *
 * @param {object} fichier fichier multer en mémoire
 * @param {string} prefixe préfixe S3, sans barre finale
 * @returns {Promise<{cle: string, taille: number, nom: string}>}
 */
async function televerserFichierPrive(fichier, prefixe) {
  const bucket = exigerBucket();

  const extension = (path.extname(fichier.originalname || '') || '.bin').toLowerCase();
  const empreinte = crypto.randomBytes(8).toString('hex');
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
  const cle = `${prefixe.replace(/\/+$/, '')}/${horodatage}-${empreinte}${extension}`;

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
    console.error(`[s3] échec du dépôt de ${cle} : ${erreur.message}`);
    throw new Error("Le fichier n'a pas pu être enregistré sur S3");
  }

  console.log(`[s3] fichier déposé : ${cle} (${fichier.size} octets)`);
  return { cle, taille: fichier.size, nom: path.basename(fichier.originalname || 'fichier') };
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
  detecterType,
  verifierTypeReel,
  recevoirJustificatif,
  recevoirRecu,
  televerserJustificatif,
  televerserJustificatifDetaille,
  recevoirDocument,
  televerserDocument,
  televerserFichierPrive,
  urlPresignee,
  supprimerObjet,
  gererErreursUpload,
  TAILLE_MAX,
  TAILLE_MAX_DOCUMENT,
  DUREE_URL_SIGNEE,
};
