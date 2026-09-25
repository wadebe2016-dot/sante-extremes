/**
 * CORS pour la version web — LOT 6.
 *
 *   npm test        (node --test "tests/**\/*.test.js")
 *
 * L'application Android parle à l'API sans politique d'origine : elle n'en a
 * pas. La version web, servie depuis https://app.santedesextremes.com, en a
 * une — et le navigateur jette toute réponse qui ne porte pas l'en-tête
 * « Access-Control-Allow-Origin ». Une configuration oubliée donnerait une
 * application entièrement vide, sans la moindre erreur côté serveur.
 *
 * Ce que ces tests tiennent :
 *   - l'origine déclarée reçoit l'en-tête, sur une lecture comme sur une
 *     requête préalable (OPTIONS) portant un code de rôle ;
 *   - une origine tierce ne le reçoit pas ;
 *   - « * » reste le comportement par défaut, pour l'usage local.
 *
 * CORS_ORIGINS est lu à CHAQUE requête par le middleware ? Non : la liste est
 * figée au chargement de src/index.js. Chaque cas monte donc son propre
 * serveur, exactement comme le fait src/index.js.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');

const CHEMIN_BD = path.join(os.tmpdir(), `sde-test-lot06-${process.pid}.db`);
process.env.DB_PATH = CHEMIN_BD;
process.env.ADMIN_PASSWORD = '111111';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');

const { migrer, fermerBd } = require('../src/db');

const ORIGINE_WEB = 'https://app.santedesextremes.com';

/**
 * Monte un serveur avec la politique d'origine de src/index.js.
 *
 * La construction est recopiée à l'identique : si elle changeait d'un côté
 * sans l'autre, ces tests cesseraient de dire quoi que ce soit de la
 * production. C'est la seule duplication acceptée ici, et elle est courte.
 */
async function serveurAvec(corsOrigins) {
  const originesAutorisees = (corsOrigins || '*')
    .split(',')
    .map((valeur) => valeur.trim())
    .filter(Boolean);

  const application = express();
  application.use(
    cors({ origin: originesAutorisees.includes('*') ? true : originesAutorisees })
  );
  application.use(express.json());
  application.use('/api/stats', require('../src/routes/stats'));
  application.use('/api/demandes', require('../src/routes/demandes'));

  const serveur = application.listen(0);
  await once(serveur, 'listening');

  return {
    base: `http://127.0.0.1:${serveur.address().port}`,
    fermer: () => new Promise((resoudre) => serveur.close(resoudre)),
  };
}

test.before(async () => {
  fs.rmSync(CHEMIN_BD, { force: true });
  await migrer();
});

test.after(async () => {
  await fermerBd();
  fs.rmSync(CHEMIN_BD, { force: true });
});

test('l’origine de la version web reçoit l’en-tête', async () => {
  const { base, fermer } = await serveurAvec(ORIGINE_WEB);

  try {
    const reponse = await fetch(`${base}/api/stats`, {
      headers: { Accept: 'application/json', Origin: ORIGINE_WEB },
    });

    assert.equal(reponse.status, 200);
    assert.equal(reponse.headers.get('access-control-allow-origin'), ORIGINE_WEB);
  } finally {
    await fermer();
  }
});

test('une origine tierce ne reçoit pas l’en-tête', async () => {
  const { base, fermer } = await serveurAvec(ORIGINE_WEB);

  try {
    const reponse = await fetch(`${base}/api/stats`, {
      headers: { Accept: 'application/json', Origin: 'https://exemple-pirate.cm' },
    });

    // La requête aboutit côté serveur : c'est le NAVIGATEUR qui jettera la
    // réponse, faute d'en-tête. Vérifier le code de retour ne prouverait rien.
    assert.equal(reponse.status, 200);
    assert.equal(reponse.headers.get('access-control-allow-origin'), null);
  } finally {
    await fermer();
  }
});

test('la requête préalable autorise le code de rôle et les écritures', async () => {
  const { base, fermer } = await serveurAvec(ORIGINE_WEB);

  try {
    // Ce que le navigateur envoie avant un POST authentifié : sans réponse
    // favorable ici, aucune approbation de dépense ne partirait jamais.
    const reponse = await fetch(`${base}/api/demandes/1/approuver`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGINE_WEB,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });

    assert.ok(reponse.status === 204 || reponse.status === 200);
    assert.equal(reponse.headers.get('access-control-allow-origin'), ORIGINE_WEB);

    const methodes = (reponse.headers.get('access-control-allow-methods') || '').toUpperCase();
    assert.ok(methodes.includes('POST'), methodes);

    const entetes = (reponse.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert.ok(entetes.includes('authorization'), entetes);
  } finally {
    await fermer();
  }
});

test('plusieurs origines cohabitent, séparées par des virgules', async () => {
  const { base, fermer } = await serveurAvec(`https://essai.atlastech.cm,${ORIGINE_WEB}`);

  try {
    for (const origine of ['https://essai.atlastech.cm', ORIGINE_WEB]) {
      const reponse = await fetch(`${base}/api/stats`, { headers: { Origin: origine } });
      assert.equal(reponse.headers.get('access-control-allow-origin'), origine);
    }

    const tierce = await fetch(`${base}/api/stats`, { headers: { Origin: 'https://ailleurs.cm' } });
    assert.equal(tierce.headers.get('access-control-allow-origin'), null);
  } finally {
    await fermer();
  }
});

test('sans configuration, tout passe — le défaut de l’usage local', async () => {
  const { base, fermer } = await serveurAvec(undefined);

  try {
    const reponse = await fetch(`${base}/api/stats`, {
      headers: { Origin: 'http://localhost:8080' },
    });
    assert.equal(reponse.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  } finally {
    await fermer();
  }
});
