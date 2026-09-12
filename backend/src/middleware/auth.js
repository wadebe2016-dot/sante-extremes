/**
 * Middleware d'authentification administrateur.
 * Vérifie l'en-tête : Authorization: Bearer <ADMIN_PASSWORD>
 * Le mot de passe n'est jamais écrit en dur : il vient de .env (ADMIN_PASSWORD).
 */
'use strict';

const crypto = require('crypto');

/**
 * Comparaison à temps constant pour éviter les attaques temporelles.
 */
function comparerSecrets(recu, attendu) {
  const tamponRecu = Buffer.from(String(recu), 'utf8');
  const tamponAttendu = Buffer.from(String(attendu), 'utf8');
  if (tamponRecu.length !== tamponAttendu.length) return false;
  return crypto.timingSafeEqual(tamponRecu, tamponAttendu);
}

function verifierAdmin(requete, reponse, suite) {
  const motDePasseAttendu = process.env.ADMIN_PASSWORD;

  if (!motDePasseAttendu) {
    console.error('[auth] ADMIN_PASSWORD absent de la configuration : accès admin refusé');
    return reponse.status(500).json({ error: 'Configuration serveur incomplète' });
  }

  const entete = requete.headers.authorization || '';
  const [schema, jeton] = entete.split(' ');

  if (schema !== 'Bearer' || !jeton) {
    console.warn(`[auth] en-tête Authorization manquant ou mal formé sur ${requete.method} ${requete.originalUrl}`);
    return reponse.status(401).json({ error: 'Authentification requise' });
  }

  if (!comparerSecrets(jeton, motDePasseAttendu)) {
    console.warn(`[auth] jeton invalide sur ${requete.method} ${requete.originalUrl}`);
    return reponse.status(401).json({ error: 'Jeton invalide' });
  }

  console.log(`[auth] accès admin accordé sur ${requete.method} ${requete.originalUrl}`);
  return suite();
}

module.exports = { verifierAdmin };
