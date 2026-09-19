/**
 * Migration de « cotisations.date_versement » sur une base existante.
 *
 * La production n'est pas une base neuve : la colonne doit s'ajouter sans rien
 * perdre, et les lignes déjà écrites doivent recevoir une date de versement
 * plausible — leur validation, à défaut leur mois dû. Sans ce remplissage, tout
 * l'historique retomberait sur le repli de calcul et la colonne resterait vide
 * pour toujours.
 *
 * Le test part donc d'une base au format d'avant (aucune colonne
 * « date_versement ») et joue la vraie migration.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const CHEMIN_BD = path.join(os.tmpdir(), `sde-test-migration-${process.pid}.db`);
process.env.DB_PATH = CHEMIN_BD;

const test = require('node:test');
const assert = require('node:assert/strict');

const { executer, lireUne, lireToutes, migrer, fermerBd } = require('../src/db');

/** Recrée la table « cotisations » telle qu'elle était avant cette évolution. */
async function poserBaseDAvant() {
  await executer(`
    CREATE TABLE members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);

  await executer(`
    CREATE TABLE cotisations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id       INTEGER NOT NULL,
      montant         REAL NOT NULL CHECK (montant > 0),
      moyen           TEXT NOT NULL,
      fichier_s3_url  TEXT,
      cle_s3          TEXT,
      statut          TEXT NOT NULL DEFAULT 'validee',
      motif_refus     TEXT,
      date_validation TEXT,
      valide_par      TEXT,
      date_paiement   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    )
  `);

  await executer("INSERT INTO members (id, name) VALUES (1, 'Membre Test')");

  // Validée : la validation est la meilleure approximation de la remise.
  await executer(
    `INSERT INTO cotisations (id, member_id, montant, moyen, statut, date_validation, date_paiement)
     VALUES (1, 1, 10000, 'Espèce', 'validee', '2026-09-19T09:00:00Z', '2026-09-05T12:00:00Z')`
  );
  // Saisie d'avant la traçabilité : il ne reste que le mois dû.
  await executer(
    `INSERT INTO cotisations (id, member_id, montant, moyen, statut, date_paiement)
     VALUES (2, 1, 5000, 'Espèce', 'validee', '2025-11-05T12:00:00Z')`
  );
  // En attente : rien n'a encore été remis au trésorier, mais la colonne se
  // remplit tout de même — la ligne ne comptera de toute façon pas en caisse.
  await executer(
    `INSERT INTO cotisations (id, member_id, montant, moyen, statut, date_paiement)
     VALUES (3, 1, 7000, 'Espèce', 'en_attente', '2026-09-05T12:00:00Z')`
  );
}

test.before(async () => {
  fs.rmSync(CHEMIN_BD, { force: true });
  await poserBaseDAvant();
  await migrer();
});

test.after(async () => {
  await fermerBd();
  fs.rmSync(CHEMIN_BD, { force: true });
});

test('la colonne date_versement est ajoutée sans perdre de ligne', async () => {
  const colonnes = await lireToutes('PRAGMA table_info(cotisations)');
  const noms = colonnes.map((colonne) => colonne.name);

  assert.ok(noms.includes('date_versement'));
  // Rien n'a été retiré au passage.
  for (const attendue of ['statut', 'motif_refus', 'date_validation', 'valide_par', 'cle_s3']) {
    assert.ok(noms.includes(attendue), `colonne perdue : ${attendue}`);
  }

  const compte = await lireUne('SELECT COUNT(*) AS nombre FROM cotisations');
  assert.equal(Number(compte.nombre), 3);
});

test('les lignes existantes reçoivent COALESCE(date_validation, date_paiement)', async () => {
  const lignes = await lireToutes('SELECT id, date_versement FROM cotisations ORDER BY id');

  assert.equal(lignes[0].date_versement, '2026-09-19T09:00:00Z'); // sa validation
  assert.equal(lignes[1].date_versement, '2025-11-05T12:00:00Z'); // son mois dû
  assert.equal(lignes[2].date_versement, '2026-09-05T12:00:00Z'); // son mois dû
});

test('rejouer la migration ne réécrit rien', async () => {
  await executer("UPDATE cotisations SET date_versement = '2026-09-12T12:00:00Z' WHERE id = 1");

  // Le service rejoue schema.sql à chaque démarrage : le remplissage, lui, est
  // attaché à l'ajout de la colonne et ne doit plus jamais repasser.
  await migrer();

  const ligne = await lireUne('SELECT date_versement FROM cotisations WHERE id = 1');
  assert.equal(ligne.date_versement, '2026-09-12T12:00:00Z');
});
