/**
 * Date de versement — « trois dates, trois usages ».
 *
 *   npm test        (node --test "tests/**\/*.test.js")
 *
 * Le défaut corrigé ici faisait disparaître de l'argent du solde : une
 * cotisation de septembre porte la date du 5 septembre (« date_paiement », le
 * mois dû) alors que l'argent peut avoir été remis le 18. Avec un solde
 * d'ouverture au 18, comparer la date d'ouverture au mois dû écartait le
 * versement ; s'en remettre à la seule date de validation aurait compté deux
 * fois une déclaration tardive. D'où une troisième date, celle de la remise.
 *
 * Ce que ces tests tiennent :
 *   - la caisse se compte sur « date_versement », avec repli sur les dates
 *     connues des lignes anciennes ;
 *   - le mois dû ne bouge pas : historique, exports et statut du mois ;
 *   - la date de versement est obligatoire et bornée à la saisie.
 *
 * Base SQLite temporaire : DB_PATH est fixé AVANT le require de src/db.js, qui
 * lit le chemin au chargement.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');

const CHEMIN_BD = path.join(os.tmpdir(), `sde-test-versement-${process.pid}.db`);
process.env.DB_PATH = CHEMIN_BD;
// Code admin de test : les routes de saisie passent sous « exigerRole ». Aucun
// secret réel n'entre ici, et rien n'est écrit sur disque hors de la base.
process.env.ADMIN_PASSWORD = '111111';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');

const { executer, lireUne, migrer, fermerBd } = require('../src/db');
const { calculerSoldeReel } = require('../src/routes/tresorerie');
const { construireHistorique } = require('../src/routes/historique');

const OUVERTURE = 150000;

/** Mois en cours, pour les cas qui dépendent de « maintenant » côté serveur. */
const MOIS_COURANT = new Date().toISOString().slice(0, 7);

/** Jour décalé de N jours par rapport à aujourd'hui, au format AAAA-MM-JJ. */
function jourDecale(jours) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + jours);
  return date.toISOString().slice(0, 10);
}

/** Jour décalé de N mois par rapport à aujourd'hui, au format AAAA-MM-JJ. */
function moisDecale(mois) {
  const maintenant = new Date();
  return new Date(
    Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() + mois, maintenant.getUTCDate())
  )
    .toISOString()
    .slice(0, 10);
}

/** Fixe le solde d'ouverture, comme le fait PUT /api/tresorerie/solde-ouverture. */
function poserOuverture(date, montant = OUVERTURE) {
  return executer(
    `INSERT INTO parametres (cle, valeur, definit_par)
     VALUES ('solde_ouverture', ?, 'Junior Mbarga')
     ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur`,
    [JSON.stringify({ montant, date, commentaire: null })]
  );
}

/**
 * Cotisation validée écrite directement en base.
 * @param {{montant: number, moisDu: string, versement: string|null,
 *          validation: string|null}} champs
 */
function ajouterCotisation({ montant, moisDu, versement = null, validation = null }) {
  return executer(
    `INSERT INTO cotisations
       (member_id, montant, moyen, date_paiement, date_versement, statut, date_validation, valide_par)
     VALUES (1, ?, 'Espèce', ?, ?, 'validee', ?, 'Junior Mbarga')`,
    [montant, moisDu, versement, validation]
  );
}

/** Pénalité encaissée. */
function ajouterPenalite({ montant, dateSanction, dateReglement }) {
  return executer(
    `INSERT INTO sanctions (member_id, type, motif, montant, statut, date_sanction, date_reglement, moyen_reglement)
     VALUES (1, 'penalite', 'Retard', ?, 'reglee', ?, ?, 'Espèce')`,
    [montant, dateSanction, dateReglement]
  );
}

// --- Serveur de test : les routes telles que src/index.js les monte ---------
let serveur;
let base;

/** POST /api/cotisations en multipart, avec le code admin. */
async function saisirCotisation(champs) {
  const corps = new FormData();
  for (const [cle, valeur] of Object.entries(champs)) {
    if (valeur !== undefined && valeur !== null) corps.set(cle, String(valeur));
  }

  const reponse = await fetch(`${base}/api/cotisations`, {
    method: 'POST',
    headers: { Authorization: 'Bearer 111111' },
    body: corps,
  });

  return { code: reponse.status, corps: await reponse.json() };
}

test.before(async () => {
  fs.rmSync(CHEMIN_BD, { force: true });
  await migrer();

  const application = express();
  application.use('/api/cotisations', require('../src/routes/cotisations'));
  application.use('/api/historique', require('../src/routes/historique'));
  application.use('/api/stats', require('../src/routes/stats'));
  application.use('/api/journal', require('../src/routes/journal'));
  application.use('/api/export', require('../src/routes/export'));

  serveur = application.listen(0);
  await once(serveur, 'listening');
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  await new Promise((resoudre) => serveur.close(resoudre));
  await fermerBd();
  fs.rmSync(CHEMIN_BD, { force: true });
});

test.beforeEach(async () => {
  await executer('DELETE FROM cotisations');
  await executer('DELETE FROM sanctions');
  await executer('DELETE FROM parametres');
  await executer('DELETE FROM members');
  await executer("INSERT INTO members (id, name) VALUES (1, 'Membre Test')");
});

// ---------------------------------------------------------------------------
// Solde de caisse
// ---------------------------------------------------------------------------

test('versement du 12 avec une ouverture au 18 : hors caisse', async () => {
  await poserOuverture('2026-09-18');
  await ajouterCotisation({
    montant: 10000,
    moisDu: '2026-09-05T12:00:00Z', // mois dû : septembre
    versement: '2026-09-12T12:00:00Z', // argent remis avant la reprise de caisse
    validation: '2026-09-19T09:00:00Z', // validé après, sans que cela compte
  });

  const situation = await calculerSoldeReel();

  assert.equal(Number(situation.cotisations.nombre), 0);
  assert.equal(situation.solde, OUVERTURE);
});

test('versement du 18 avec une ouverture au 18 : compté', async () => {
  await poserOuverture('2026-09-18');
  await ajouterCotisation({
    montant: 10000,
    moisDu: '2026-09-05T12:00:00Z',
    versement: '2026-09-18T12:00:00Z', // remis le jour même de l'ouverture
    validation: '2026-09-19T09:00:00Z',
  });

  const situation = await calculerSoldeReel();

  assert.equal(Number(situation.cotisations.nombre), 1);
  assert.equal(Number(situation.cotisations.somme), 10000);
  assert.equal(situation.solde, OUVERTURE + 10000);
});

test('ligne ancienne sans date_versement : repli sur la validation, puis sur le mois dû', async () => {
  await poserOuverture('2026-09-18');
  // Écrites avant la colonne « date_versement » : seule leur validation est connue.
  await ajouterCotisation({ montant: 7000, moisDu: '2026-09-05T12:00:00Z', validation: '2026-09-19T08:00:00Z' });
  await ajouterCotisation({ montant: 4000, moisDu: '2026-09-05T12:00:00Z', validation: '2026-09-13T08:00:00Z' });
  // Plus ancienne encore : ni versement, ni validation — il reste le mois dû.
  await ajouterCotisation({ montant: 3000, moisDu: '2026-09-25T12:00:00Z' });

  const situation = await calculerSoldeReel();

  assert.equal(Number(situation.cotisations.nombre), 2);
  assert.equal(situation.solde, OUVERTURE + 7000 + 3000);
});

test('sans solde d’ouverture, tout l’historique est compté', async () => {
  await ajouterCotisation({
    montant: 10000,
    moisDu: '2020-01-05T12:00:00Z',
    versement: '2020-01-06T12:00:00Z',
  });

  const situation = await calculerSoldeReel();

  assert.equal(situation.ouverture, null);
  assert.equal(situation.solde, 10000);
});

test('pénalité : la date de règlement fait foi, la date de sanction sert de repli', async () => {
  await poserOuverture('2026-09-18');
  await ajouterPenalite({ montant: 2000, dateSanction: '2026-08-02T10:00:00Z', dateReglement: '2026-09-18T11:00:00Z' });
  await ajouterPenalite({ montant: 5000, dateSanction: '2026-08-02T10:00:00Z', dateReglement: '2026-09-13T11:00:00Z' });
  // Réglée sans date connue : retombe sur la date de sanction plutôt que de
  // disparaître dans le néant d'une comparaison sur NULL.
  await ajouterPenalite({ montant: 3000, dateSanction: '2026-08-02T10:00:00Z', dateReglement: null });

  const situation = await calculerSoldeReel();

  assert.equal(Number(situation.penalites.nombre), 1);
  assert.equal(situation.solde, OUVERTURE + 2000);
});

// ---------------------------------------------------------------------------
// Le mois dû ne bouge pas
// ---------------------------------------------------------------------------

test('GET /api/historique reste rangé sur le mois dû, quel que soit le versement', async () => {
  await poserOuverture('2026-09-18');
  await ajouterCotisation({
    montant: 10000,
    moisDu: '2026-09-05T12:00:00Z',
    versement: '2026-09-12T12:00:00Z', // hors caisse, mais bien dû pour septembre
    validation: '2026-09-19T09:00:00Z',
  });
  await ajouterCotisation({
    montant: 4000,
    moisDu: '2026-03-05T12:00:00Z', // régularisation de mars
    versement: '2026-09-18T12:00:00Z',
    validation: '2026-09-19T09:00:00Z',
  });

  const direct = await construireHistorique(2026);
  const reponse = await fetch(`${base}/api/historique?annee=2026`);
  const servi = await reponse.json();

  assert.equal(reponse.status, 200);
  for (const historique of [direct, servi]) {
    assert.equal(historique.total_annee, 14000);
    assert.equal(historique.nb_paiements, 2);
    assert.equal(historique.totaux_mois[2], 4000); // mars
    assert.equal(historique.totaux_mois[8], 10000); // septembre

    const ligne = historique.members.find((membre) => membre.id === 1);
    assert.equal(ligne.montants[2], 4000);
    assert.equal(ligne.montants[8], 10000);
    assert.equal(ligne.total, 14000);
  }
});

test('GET /api/stats : le mois est payé même quand le versement reste hors caisse', async () => {
  // Le statut du mois se lit sur « maintenant » côté serveur : le mois dû est
  // donc celui du jour, pour que le test ne dépende pas de la saison.
  await poserOuverture(`${MOIS_COURANT}-18`);
  await ajouterCotisation({
    montant: 10000,
    moisDu: `${MOIS_COURANT}-05T12:00:00Z`,
    versement: `${MOIS_COURANT}-12T12:00:00Z`,
    validation: `${MOIS_COURANT}-19T09:00:00Z`,
  });

  const reponse = await fetch(`${base}/api/stats`);
  const corps = await reponse.json();
  const membre = corps.members.find((ligne) => ligne.id === 1);

  assert.equal(reponse.status, 200);
  assert.equal(membre.paid, true);
  assert.equal(membre.statut_mois, 'paye');
  assert.equal(membre.dernier_versement, `${MOIS_COURANT}-12T12:00:00Z`);
  assert.equal(membre.dernier_regularisation, false);
  // La caisse, elle, ignore ce versement antérieur à l'ouverture.
  assert.equal(corps.summary.solde_reel, OUVERTURE);
});

test('GET /api/journal : une régularisation est nommée comme telle', async () => {
  await ajouterCotisation({
    montant: 4000,
    moisDu: '2026-05-05T12:00:00Z',
    versement: '2026-09-18T12:00:00Z',
    validation: '2026-09-19T09:00:00Z',
  });
  await ajouterCotisation({
    montant: 10000,
    moisDu: '2026-09-05T12:00:00Z',
    versement: '2026-09-12T12:00:00Z',
    validation: '2026-09-19T09:10:00Z',
  });

  const reponse = await fetch(`${base}/api/journal?annee=2026`);
  const corps = await reponse.json();
  const libelles = corps.evenements.map((evenement) => evenement.type_libelle);

  assert.equal(reponse.status, 200);
  assert.ok(libelles.includes('Cotisation de mai versée le 18 sept'), libelles.join(' | '));
  assert.ok(libelles.includes('Cotisation de septembre'), libelles.join(' | '));
  assert.equal(corps.evenements.filter((evenement) => evenement.regularisation).length, 1);
});

test('les exports restent servis, feuille des versements comprise', async () => {
  await ajouterCotisation({
    montant: 10000,
    moisDu: '2026-09-05T12:00:00Z',
    versement: '2026-09-12T12:00:00Z',
    validation: '2026-09-19T09:00:00Z',
  });

  const reponse = await fetch(`${base}/api/export/historique.xlsx?annee=2026`);
  const tampon = Buffer.from(await reponse.arrayBuffer());
  const pdf = await fetch(`${base}/api/export/historique.pdf?annee=2026`);

  assert.equal(reponse.status, 200);
  assert.equal(pdf.status, 200);

  // Le classeur est relu : c'est la seule façon d'affirmer que la feuille des
  // versements existe vraiment et porte la date de remise, et non le mois dû.
  const classeur = new ExcelJS.Workbook();
  await classeur.xlsx.load(tampon);

  const feuille = classeur.getWorksheet('Versements 2026');
  assert.ok(feuille, 'feuille « Versements » absente');
  assert.equal(feuille.getRow(2).getCell(1).text, 'Membre Test');
  assert.equal(feuille.getRow(2).getCell(2).text, 'sept 2026'); // mois dû
  assert.equal(feuille.getRow(2).getCell(3).text, '12/09/2026'); // date de remise
  assert.equal(Number(feuille.getRow(2).getCell(4).value), 10000);

  // Le tableau croisé, lui, n'a pas bougé d'une ligne.
  const croise = classeur.getWorksheet('Cotisations 2026');
  assert.ok(croise, 'feuille « Cotisations » absente');
});

// ---------------------------------------------------------------------------
// Saisie : la date de versement est obligatoire et bornée
// ---------------------------------------------------------------------------

test('POST /api/cotisations sans date de versement : refus', async () => {
  const { code, corps } = await saisirCotisation({ member_id: 1, montant: 10000, moyen: 'Espèce' });

  assert.equal(code, 400);
  assert.equal(corps.error, 'La date du versement est obligatoire');
  assert.equal(await compterCotisations(), 0);
});

test('POST /api/cotisations avec une date vide : refus', async () => {
  const { code, corps } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    date_versement: '   ',
  });

  assert.equal(code, 400);
  assert.equal(corps.error, 'La date du versement est obligatoire');
});

test('POST /api/cotisations avec une date à venir : refus', async () => {
  const { code, corps } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    date_versement: jourDecale(1),
  });

  assert.equal(code, 400);
  assert.match(corps.error, /futur/);
  assert.equal(await compterCotisations(), 0);
});

test('POST /api/cotisations treize mois en arrière : refus', async () => {
  const { code, corps } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    date_versement: moisDecale(-13),
  });

  assert.equal(code, 400);
  assert.match(corps.error, /12 mois/);
});

test('POST /api/cotisations douze mois en arrière : accepté', async () => {
  const { code } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    date_versement: moisDecale(-12),
  });

  assert.equal(code, 201);
});

test('POST /api/cotisations avec un jour inexistant : refus', async () => {
  const { code, corps } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    date_versement: '2026-02-31',
  });

  assert.equal(code, 400);
  assert.match(corps.error, /inexistant/);
});

test('POST /api/cotisations d’un rattrapage : régularisation signalée', async () => {
  const aujourdhui = jourDecale(0);
  // Mois dû : trois mois en arrière ; argent remis aujourd'hui.
  const moisDu = moisDecale(-3).slice(0, 7);

  const { code, corps } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    mois: moisDu,
    date_versement: aujourdhui,
  });

  assert.equal(code, 201);
  assert.equal(corps.date_versement, `${aujourdhui}T12:00:00Z`);
  assert.equal(corps.regularisation, true);
  assert.equal(String(corps.date_paiement).slice(0, 7), moisDu);
});

test('POST /api/cotisations du mois courant : pas une régularisation', async () => {
  const { code, corps } = await saisirCotisation({
    member_id: 1,
    montant: 10000,
    moyen: 'Espèce',
    date_versement: jourDecale(0),
  });

  assert.equal(code, 201);
  assert.equal(corps.regularisation, false);
});

/** Nombre de cotisations en base — un refus ne doit rien écrire. */
async function compterCotisations() {
  const ligne = await lireUne('SELECT COUNT(*) AS nombre FROM cotisations');
  return Number(ligne.nombre);
}
