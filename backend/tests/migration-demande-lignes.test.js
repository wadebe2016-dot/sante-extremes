/**
 * Migration des demandes vers les postes — LOT 5.
 *
 * La production n'est pas une base neuve : elle porte des demandes approuvées,
 * refusées, payées, et des décaissements rattachés à ces demandes. La bascule
 * vers « demande_lignes » ne doit rien perdre, et surtout rien changer aux
 * chiffres affichés — un solde de caisse qui bouge le jour d'une migration
 * serait impossible à justifier en assemblée.
 *
 * Le test part donc d'une base au format d'avant (aucune table
 * « demande_lignes », « decaissements.demande_id » en clé étrangère), joue la
 * vraie migration, et vérifie que /api/tresorerie sert exactement ce qu'il
 * servait — le calcul de référence étant fait en SQL sur la base d'AVANT.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');

const CHEMIN_BD = path.join(os.tmpdir(), `sde-test-migration-lot05-${process.pid}.db`);
process.env.DB_PATH = CHEMIN_BD;

process.env.ADMIN_PASSWORD = '111111';
process.env.TRESORIERS = 'Junior Mbarga:444444';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { executer, lireUne, lireToutes, migrer, fermerBd } = require('../src/db');

let serveur;
let base;

/** Chiffres de trésorerie calculés sur la base d'AVANT, en SQL d'avant. */
let reference;

/**
 * Recrée les tables des dépenses telles qu'elles étaient avant le LOT 5.
 *
 * Volontairement à l'identique de l'ancien schema.sql, contrainte UNIQUE
 * comprise : une migration éprouvée sur une copie approximative ne prouve rien.
 */
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
      statut          TEXT NOT NULL DEFAULT 'validee',
      motif_refus     TEXT,
      date_validation TEXT,
      valide_par      TEXT,
      date_paiement   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    )
  `);

  await executer(`
    CREATE TABLE demandes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      categorie            TEXT NOT NULL,
      libelle              TEXT NOT NULL,
      montant_estime       REAL NOT NULL CHECK (montant_estime > 0),
      urgence              TEXT NOT NULL DEFAULT 'normale',
      justificatif_cle_s3  TEXT,
      role_demandeur       TEXT NOT NULL,
      statut               TEXT NOT NULL DEFAULT 'en_attente',
      motif_refus          TEXT,
      approuve_par         TEXT,
      date_demande         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      date_decision        TEXT
    )
  `);

  await executer(`
    CREATE TABLE decaissements (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      demande_id          INTEGER NOT NULL UNIQUE,
      montant             REAL NOT NULL CHECK (montant > 0),
      date_paiement       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      moyen               TEXT NOT NULL,
      paye_par            TEXT NOT NULL,
      beneficiaire        TEXT,
      decaisse_par        TEXT,
      justificatif_cle_s3 TEXT,
      commentaire         TEXT,
      FOREIGN KEY (demande_id) REFERENCES demandes (id) ON DELETE CASCADE
    )
  `);

  await executer("INSERT INTO members (id, name) VALUES (1, 'Adama Begam')");
  await executer(
    `INSERT INTO cotisations (id, member_id, montant, moyen, statut, date_validation, date_paiement)
     VALUES (1, 1, 10000, 'Espèce', 'validee', '2026-09-19T09:00:00Z', '2026-09-05T12:00:00Z')`
  );

  // Les quatre états d'une demande, tels qu'ils existent en production.
  await executer(
    `INSERT INTO demandes
       (id, categorie, libelle, montant_estime, role_demandeur, statut, approuve_par, date_demande, date_decision)
     VALUES (1, 'eau_collation', 'Eau du samedi', 6000, 'intendant', 'payee',
             'Junior Mbarga', '2026-09-12T08:00:00Z', '2026-09-12T09:00:00Z')`
  );
  await executer(
    `INSERT INTO demandes
       (id, categorie, libelle, montant_estime, role_demandeur, statut, approuve_par, date_demande, date_decision)
     VALUES (2, 'location_stade', 'Location du stade', 8000, 'intendant', 'approuvee',
             'Junior Mbarga', '2026-09-12T08:05:00Z', '2026-09-12T09:05:00Z')`
  );
  await executer(
    `INSERT INTO demandes (id, categorie, libelle, montant_estime, role_demandeur, statut, date_demande)
     VALUES (3, 'kine_medical', 'Séance de kiné', 5000, 'secretaire', 'en_attente', '2026-09-13T08:00:00Z')`
  );
  await executer(
    `INSERT INTO demandes
       (id, categorie, libelle, montant_estime, role_demandeur, statut, motif_refus, approuve_par, date_demande, date_decision)
     VALUES (4, 'autre', 'Maillots supplémentaires', 40000, 'competitions', 'refusee',
             'Trop cher', 'Junior Mbarga', '2026-09-10T08:00:00Z', '2026-09-11T08:00:00Z')`
  );

  await executer(
    `INSERT INTO decaissements
       (id, demande_id, montant, date_paiement, moyen, paye_par, beneficiaire, decaisse_par, justificatif_cle_s3)
     VALUES (7, 1, 6500, '2026-09-12T10:00:00Z', 'Espèce', 'caisse', 'Vendeur du coin',
             'Junior Mbarga', 'depenses/justificatifs/recu.jpg')`
  );
}

/** Chiffres de trésorerie, calculés comme le faisait le code d'avant. */
async function chiffresDAvant() {
  const cotisations = await lireUne(
    "SELECT COALESCE(SUM(montant), 0) AS somme FROM cotisations WHERE statut = 'validee'"
  );
  const decaissements = await lireUne(
    'SELECT COALESCE(SUM(montant), 0) AS somme, COUNT(*) AS nombre FROM decaissements'
  );
  const engage = await lireUne(
    "SELECT COALESCE(SUM(montant_estime), 0) AS somme FROM demandes WHERE statut = 'approuvee'"
  );
  const enAttente = await lireUne(
    "SELECT COALESCE(SUM(montant_estime), 0) AS somme FROM demandes WHERE statut = 'en_attente'"
  );
  const parCategorie = await lireToutes(
    `SELECT d.categorie, COALESCE(SUM(x.montant), 0) AS somme, COUNT(*) AS nombre
       FROM decaissements x JOIN demandes d ON d.id = x.demande_id
      GROUP BY d.categorie ORDER BY somme DESC`
  );

  return {
    solde: Number(cotisations.somme) - Number(decaissements.somme),
    depense: Number(decaissements.somme),
    nbDepenses: Number(decaissements.nombre),
    engage: Number(engage.somme),
    enAttente: Number(enAttente.somme),
    parCategorie: parCategorie.map((ligne) => ({
      categorie: ligne.categorie,
      montant: Number(ligne.somme),
      nombre: Number(ligne.nombre),
    })),
  };
}

test.before(async () => {
  fs.rmSync(CHEMIN_BD, { force: true });
  await poserBaseDAvant();
  reference = await chiffresDAvant();
  await migrer();

  const application = express();
  application.use(express.json());
  application.use('/api/demandes', require('../src/routes/demandes'));
  application.use('/api/decaissements', require('../src/routes/decaissements'));
  application.use('/api/tresorerie', require('../src/routes/tresorerie'));

  serveur = application.listen(0);
  await once(serveur, 'listening');
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  await new Promise((resoudre) => serveur.close(resoudre));
  await fermerBd();
  fs.rmSync(CHEMIN_BD, { force: true });
});

test('chaque demande existante reçoit une ligne, copie de ses colonnes', async () => {
  const lignes = await lireToutes('SELECT * FROM demande_lignes ORDER BY demande_id');
  assert.equal(lignes.length, 4);

  assert.deepEqual(
    lignes.map((ligne) => [ligne.demande_id, ligne.categorie, ligne.montant_estime, ligne.statut]),
    [
      [1, 'eau_collation', 6000, 'payee'],
      [2, 'location_stade', 8000, 'approuvee'],
      [3, 'kine_medical', 5000, 'en_attente'],
      [4, 'autre', 40000, 'refusee'],
    ]
  );

  // Le motif et le décideur suivent la décision, ils vivent désormais sur la ligne.
  assert.equal(lignes[3].motif_refus, 'Trop cher');
  assert.equal(lignes[3].approuve_par, 'Junior Mbarga');
  assert.equal(lignes[3].date_decision, '2026-09-11T08:00:00Z');

  // Aucune demande n'a été perdue ni retouchée.
  const demandes = await lireToutes('SELECT id, libelle, statut FROM demandes ORDER BY id');
  assert.equal(demandes.length, 4);
  assert.equal(demandes[0].libelle, 'Eau du samedi');
});

test('les décaissements existants gardent leur identifiant et suivent leur ligne', async () => {
  const colonnes = (await lireToutes('PRAGMA table_info(decaissements)')).map((c) => c.name);
  assert.ok(colonnes.includes('ligne_id'));
  assert.ok(!colonnes.includes('demande_id'));

  const sorties = await lireToutes('SELECT * FROM decaissements');
  assert.equal(sorties.length, 1);
  assert.equal(sorties[0].id, 7); // identifiant préservé : le justificatif garde son adresse
  assert.equal(sorties[0].montant, 6500);
  assert.equal(sorties[0].beneficiaire, 'Vendeur du coin');
  assert.equal(sorties[0].justificatif_cle_s3, 'depenses/justificatifs/recu.jpg');

  const ligne = await lireUne('SELECT demande_id FROM demande_lignes WHERE id = ?', [
    sorties[0].ligne_id,
  ]);
  assert.equal(ligne.demande_id, 1);

  // L'invariant a suivi : un poste ne peut être payé qu'une fois.
  await assert.rejects(
    executer('INSERT INTO decaissements (ligne_id, montant, moyen, paye_par) VALUES (?, 1, ?, ?)', [
      sorties[0].ligne_id,
      'Espèce',
      'caisse',
    ]),
    /UNIQUE/
  );
});

test('la trésorerie sert exactement les chiffres d’avant la migration', async () => {
  const reponse = await fetch(`${base}/api/tresorerie`, { headers: { Accept: 'application/json' } });
  const corps = await reponse.json();

  assert.equal(corps.solde_reel, reference.solde);
  assert.equal(corps.depense.total, reference.depense);
  assert.equal(corps.depense.nombre, reference.nbDepenses);
  assert.equal(corps.engage.total, reference.engage);
  assert.equal(corps.engage.demandes_en_attente, reference.enAttente);
  assert.deepEqual(corps.depense.par_categorie, reference.parCategorie);
});

test('la liste des demandes reste lisible, chacune à un poste', async () => {
  const reponse = await fetch(`${base}/api/demandes`, { headers: { Accept: 'application/json' } });
  const corps = await reponse.json();

  assert.equal(corps.demandes.length, 4);
  assert.ok(corps.demandes.every((demande) => demande.nb_lignes === 1));

  const payee = corps.demandes.find((demande) => demande.id === 1);
  assert.equal(payee.statut, 'payee');
  assert.equal(payee.total_decaisse, 6500);
  // Le champ plat d'avant est toujours servi : une application non mise à jour
  // affiche la demande sans rien savoir des postes.
  assert.equal(payee.decaissement.montant, 6500);
  assert.equal(payee.montant_estime, 6000);

  const refusee = corps.demandes.find((demande) => demande.id === 4);
  assert.equal(refusee.statut, 'refusee');
  assert.equal(refusee.motif_refus, 'Trop cher');
});

test('rejouer la migration ne duplique aucune ligne', async () => {
  await migrer();

  const lignes = await lireToutes('SELECT id FROM demande_lignes');
  assert.equal(lignes.length, 4);

  const sorties = await lireToutes('SELECT id, ligne_id FROM decaissements');
  assert.equal(sorties.length, 1);
  assert.equal(sorties[0].id, 7);
});
