/**
 * Arriérés, feuille de séance et mesures du mois — LOT 4.
 *
 *   npm test        (node --test "tests/**\/*.test.js")
 *
 * Le défaut corrigé ici réclamait de l'argent à des gens qui ne le devaient
 * pas : les mois dus étaient comptés depuis janvier, si bien qu'un membre entré
 * en mai se voyait attribuer huit mois d'arriérés au lieu de trois.
 *
 * Ce que ces tests tiennent :
 *   - tout calcul part de la DATE D'ADHÉSION, et la corriger recalcule aussitôt ;
 *   - un versement fait dans la fenêtre (du 25 de M-1 au 5 de M) est à l'heure ;
 *   - l'ordre des règles d'éligibilité d'une séance, suspension en tête ;
 *   - la date d'effet des mesures, et l'idempotence de leur application ;
 *   - les droits : lecture publique, écriture réservée.
 *
 * Base SQLite temporaire : DB_PATH est fixé AVANT le require de src/db.js, qui
 * lit le chemin au chargement.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');

const CHEMIN_BD = path.join(os.tmpdir(), `sde-test-lot04-${process.pid}.db`);
process.env.DB_PATH = CHEMIN_BD;

// Codes de test : aucun secret réel n'entre ici, et rien n'est écrit sur disque
// hors de la base temporaire. Chaque rôle a le sien pour éprouver les refus.
process.env.ADMIN_PASSWORD = '111111';
process.env.CENSEUR_PASSWORD = '222222';
process.env.SECRETAIRE_PASSWORD = '333333';
process.env.TRESORIER_PASSWORD = '444444';

// Les mesures ne s'appliquent qu'à partir du 6 octobre 2026. Les tests doivent
// éprouver les DEUX côtés de l'échéance : la surcharge est basculée d'un test à
// l'autre, la valeur d'assemblée restant celle du code.
const DATE_EFFET_REELLE = '2026-10-06';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { executer, lireUne, migrer, fermerBd } = require('../src/db');
const {
  DATE_EFFET_MESURES,
  COTISATION_MENSUELLE,
  fenetreVersement,
  dansLesDelais,
  moisDecale,
  construireSituation,
} = require('../src/services/arrieres');
const { construireArrieres } = require('../src/routes/arrieres');
const { construireMesures } = require('../src/routes/mesures');

/** Ouvre la fenêtre d'application des mesures pour le test en cours. */
function autoriserLesMesures() {
  process.env.DATE_EFFET_MESURES = '2000-01-01';
}

/** Rétablit la date d'effet réelle : les POST doivent repartir en 409. */
function bloquerLesMesures() {
  process.env.DATE_EFFET_MESURES = '2999-01-01';
}

// --- Jeu d'essai ------------------------------------------------------------
//
// Un calendrier fixe plutôt que « maintenant » : les mois dus se comptent au
// mois près, et un test qui bascule le 1ᵉʳ du mois ne prouve plus rien.
const MOIS_REFERENCE = '2026-09';

/** Crée un membre avec son mois d'adhésion. */
function ajouterMembre(id, nom, moisAdhesion, statut = 'actif') {
  return executer(
    'INSERT INTO members (id, name, date_adhesion, statut, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, nom, `${moisAdhesion}-01`, statut, `${moisAdhesion}-01T08:00:00Z`]
  );
}

/**
 * Cotisation d'un membre pour un mois donné.
 * @param {string} statut 'validee' ou 'en_attente'
 */
function cotiser(idMembre, mois, { versement = null, statut = 'validee' } = {}) {
  return executer(
    `INSERT INTO cotisations
       (member_id, montant, moyen, date_paiement, date_versement, statut, date_validation, valide_par)
     VALUES (?, ?, 'Espèce', ?, ?, ?, ?, 'Junior Mbarga')`,
    [
      idMembre,
      COTISATION_MENSUELLE,
      `${mois}-05T12:00:00Z`,
      versement ? `${versement}T12:00:00Z` : `${mois}-03T12:00:00Z`,
      statut,
      statut === 'validee' ? `${mois}-05T13:00:00Z` : null,
    ]
  );
}

/** Suspension en cours jusqu'à la date indiquée. */
function suspendre(idMembre, dateFin) {
  return executer(
    `INSERT INTO sanctions (member_id, type, motif, date_fin, statut, date_sanction)
     VALUES (?, 'suspension', 'Comportement', ?, 'due', '2026-09-01T10:00:00Z')`,
    [idMembre, dateFin]
  );
}

// --- Serveur de test : les routes telles que src/index.js les monte ---------
let serveur;
let base;

/** Appel JSON, avec ou sans code de rôle. */
async function appeler(chemin, { methode = 'GET', code = null, corps = null } = {}) {
  const reponse = await fetch(`${base}${chemin}`, {
    method: methode,
    headers: {
      Accept: 'application/json',
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
      ...(code ? { Authorization: `Bearer ${code}` } : {}),
    },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });

  return { code: reponse.status, corps: await reponse.json() };
}

test.before(async () => {
  fs.rmSync(CHEMIN_BD, { force: true });
  await migrer();

  const application = express();
  application.use(express.json());
  application.use('/api/admin', require('../src/routes/admin'));
  application.use('/api/arrieres', require('../src/routes/arrieres'));
  application.use('/api/seance', require('../src/routes/seance'));
  application.use('/api/mesures', require('../src/routes/mesures'));
  application.use('/api/stats', require('../src/routes/stats'));
  application.use('/api/historique', require('../src/routes/historique'));
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
  delete process.env.DATE_EFFET_MESURES;
  await executer('DELETE FROM cotisations');
  await executer('DELETE FROM sanctions');
  await executer('DELETE FROM evenements_membres');
  await executer('DELETE FROM members');
});

// ---------------------------------------------------------------------------
// Date d'adhésion
// ---------------------------------------------------------------------------

test('un membre adhérent en mai, à jour de mai et juin, doit trois mois — pas huit', async () => {
  await ajouterMembre(1, 'Adama Begam', '2026-05');
  await cotiser(1, '2026-05');
  await cotiser(1, '2026-06');

  const situation = await construireSituation(MOIS_REFERENCE);
  const membre = situation.find((ligne) => ligne.id === 1);

  assert.equal(membre.adhesion, '2026-05');
  assert.equal(membre.nb_mois, 3);
  assert.deepEqual(membre.mois_dus, ['2026-07', '2026-08', '2026-09']);
  assert.equal(membre.montant_du, 3 * COTISATION_MENSUELLE);
});

test('corriger la date d’adhésion recalcule immédiatement les arriérés', async () => {
  await ajouterMembre(1, 'Adama Begam', '2026-01');

  const avant = await construireArrieres(MOIS_REFERENCE);
  assert.equal(avant.membres[0].nb_mois, 9); // janvier à septembre

  const correction = await appeler('/api/admin/members/1', {
    methode: 'PATCH',
    code: '333333',
    corps: { date_adhesion: '2026-05' },
  });
  assert.equal(correction.code, 200);
  assert.equal(correction.corps.date_adhesion, '2026-05-01');

  const apres = await construireArrieres(MOIS_REFERENCE);
  assert.equal(apres.membres[0].nb_mois, 5); // mai à septembre
});

test('la migration renseigne l’adhésion depuis la première cotisation validée', async () => {
  // Fiche créée sans date d'adhésion, comme avant le LOT 4.
  await executer(
    "INSERT INTO members (id, name, created_at) VALUES (1, 'Ancien Membre', '2026-01-10T08:00:00Z')"
  );
  await executer('UPDATE members SET date_adhesion = NULL WHERE id = 1');
  await cotiser(1, '2026-06');

  // Le remplissage de la migration, rejoué tel quel sur cette ligne.
  await executer(`UPDATE members SET date_adhesion = COALESCE(
      (SELECT substr(MIN(c.date_paiement), 1, 7) || '-01'
         FROM cotisations c
        WHERE c.member_id = members.id AND c.statut = 'validee'),
      substr(created_at, 1, 7) || '-01'
    ) WHERE date_adhesion IS NULL`);

  const membre = await lireUne('SELECT date_adhesion FROM members WHERE id = 1');
  assert.equal(membre.date_adhesion, '2026-06-01');
});

test('sans cotisation, l’adhésion retombe sur le mois de création de la fiche', async () => {
  await executer(
    "INSERT INTO members (id, name, created_at) VALUES (1, 'Nouveau', '2026-08-14T08:00:00Z')"
  );
  await executer('UPDATE members SET date_adhesion = NULL WHERE id = 1');

  const situation = await construireSituation(MOIS_REFERENCE);
  assert.equal(situation[0].adhesion, '2026-08');
  assert.equal(situation[0].nb_mois, 2); // août et septembre
});

test('POST /api/admin/members accepte une date d’adhésion, le mois courant par défaut', async () => {
  const avecDate = await appeler('/api/admin/members', {
    methode: 'POST',
    code: '333333',
    corps: { name: 'Entré En Mai', date_adhesion: '2026-05' },
  });
  assert.equal(avecDate.code, 201);
  assert.equal(avecDate.corps.date_adhesion, '2026-05-01');
  assert.equal(avecDate.corps.statut, 'actif');

  const sansDate = await appeler('/api/admin/members', {
    methode: 'POST',
    code: '333333',
    corps: { name: 'Entré Ce Mois' },
  });
  assert.equal(sansDate.code, 201);
  assert.equal(sansDate.corps.date_adhesion.slice(0, 7), new Date().toISOString().slice(0, 7));
});

test('une date d’adhésion future est refusée', async () => {
  const futur = moisDecale(new Date().toISOString().slice(0, 7), 2);
  const reponse = await appeler('/api/admin/members', {
    methode: 'POST',
    code: '333333',
    corps: { name: 'Venu Du Futur', date_adhesion: futur },
  });

  assert.equal(reponse.code, 400);
  assert.match(reponse.corps.error, /futur/);
});

// ---------------------------------------------------------------------------
// Arriérés
// ---------------------------------------------------------------------------

test('le total des arriérés est la somme des montants dus des membres en retard', async () => {
  await ajouterMembre(1, 'Un Mois', '2026-09');
  await ajouterMembre(2, 'Deux Mois', '2026-08');
  await ajouterMembre(3, 'A Jour', '2026-09');
  await cotiser(3, '2026-09');

  const arrieres = await construireArrieres(MOIS_REFERENCE);

  assert.equal(arrieres.resume.membres_en_retard, 2);
  assert.equal(arrieres.resume.membres_a_jour, 1);
  assert.equal(arrieres.resume.total_arrieres, 3 * COTISATION_MENSUELLE);
  assert.equal(
    arrieres.resume.total_arrieres,
    arrieres.membres.reduce((somme, membre) => somme + membre.montant_du, 0)
  );
});

test('les membres à jour ne figurent que dans le résumé, le tri est décroissant', async () => {
  await ajouterMembre(1, 'Un Mois', '2026-09');
  await ajouterMembre(2, 'Trois Mois', '2026-07');
  await ajouterMembre(3, 'A Jour', '2026-09');
  await cotiser(3, '2026-09');

  const arrieres = await construireArrieres(MOIS_REFERENCE);

  assert.deepEqual(
    arrieres.membres.map((membre) => membre.name),
    ['Trois Mois', 'Un Mois']
  );
  assert.equal(arrieres.membres.find((membre) => membre.name === 'A Jour'), undefined);
  assert.deepEqual(arrieres.resume.par_anciennete, {
    '1_mois': 1,
    '2_mois': 0,
    '3_mois_et_plus': 1,
  });
});

test('GET /api/arrieres répond sans code et refuse un mois mal formé', async () => {
  await ajouterMembre(1, 'Un Mois', '2026-09');

  const publique = await appeler('/api/arrieres?mois=2026-09');
  assert.equal(publique.code, 200);
  assert.equal(publique.corps.mois, '2026-09');
  assert.equal(publique.corps.membres[0].nb_mois, 1);
  assert.equal(publique.corps.membres[0].adhesion, '2026-09');

  const invalide = await appeler('/api/arrieres?mois=septembre');
  assert.equal(invalide.code, 400);
});

test('les pénalités dues sont annoncées à part du montant de cotisation', async () => {
  await ajouterMembre(1, 'Un Mois', '2026-09');
  await executer(
    `INSERT INTO sanctions (member_id, type, motif, montant, statut, date_sanction)
     VALUES (1, 'penalite', 'Retard', 1000, 'due', '2026-09-10T10:00:00Z')`
  );

  const arrieres = await construireArrieres(MOIS_REFERENCE);
  const membre = arrieres.membres[0];

  assert.equal(membre.montant_du, COTISATION_MENSUELLE);
  assert.equal(membre.penalites_dues, 1000);
  assert.equal(membre.total_du, COTISATION_MENSUELLE + 1000);
  // Le total des arriérés ne mêle pas les deux comptabilités.
  assert.equal(arrieres.resume.total_arrieres, COTISATION_MENSUELLE);
});

// ---------------------------------------------------------------------------
// Fenêtre de versement
// ---------------------------------------------------------------------------

test('un versement du 28 septembre pour octobre est dans les délais', async () => {
  assert.equal(dansLesDelais('2026-10', '2026-09-28'), true);
  assert.equal(dansLesDelais('2026-10', '2026-10-05'), true);
  assert.equal(dansLesDelais('2026-10', '2026-10-06'), false);
  assert.equal(dansLesDelais('2026-10', '2026-09-24'), false);
});

test('la fenêtre propose le mois suivant à partir du 25, le mois courant ensuite', () => {
  assert.deepEqual(
    { ...fenetreVersement('2026-09-28') },
    {
      jour: '2026-09-28',
      ouverte: true,
      depassee: false,
      mois_concerne: '2026-10',
      echeance: '2026-10-05',
      mois_libelle: 'octobre',
    }
  );

  const premier = fenetreVersement('2026-10-01');
  assert.equal(premier.mois_concerne, '2026-10');
  assert.equal(premier.ouverte, true);

  const depassee = fenetreVersement('2026-10-12');
  assert.equal(depassee.mois_concerne, '2026-10');
  assert.equal(depassee.ouverte, false);
  assert.equal(depassee.depassee, true);
});

test('un versement en avance met le membre à jour et le sort des mesures', async () => {
  await ajouterMembre(1, 'En Avance', '2026-10');
  await cotiser(1, '2026-10', { versement: '2026-09-28' });

  const seance = await appeler('/api/seance?date=2026-10-03');
  assert.equal(seance.code, 200);
  assert.equal(seance.corps.eligibles.length, 1);
  assert.equal(seance.corps.eligibles[0].date_versement, '2026-09-28');

  const mesures = await construireMesures('2026-10', '2026-10-06');
  assert.equal(mesures.a_penaliser.length, 0);
  assert.equal(mesures.a_ecarter.length, 0);
  assert.equal(mesures.peuvent_jouer.length, 1);
});

// ---------------------------------------------------------------------------
// Feuille de séance
// ---------------------------------------------------------------------------

test('l’ordre des règles d’éligibilité est respecté', async () => {
  await ajouterMembre(1, 'A Jour', '2026-10');
  await cotiser(1, '2026-10');

  await ajouterMembre(2, 'Suspendu Mais A Jour', '2026-10');
  await cotiser(2, '2026-10');
  await suspendre(2, '2026-10-20');

  await ajouterMembre(3, 'Ecarte', '2026-08', 'ecarte');

  await ajouterMembre(4, 'Declaration En Attente', '2026-10');
  await cotiser(4, '2026-10', { statut: 'en_attente' });

  await ajouterMembre(5, 'Rien Verse', '2026-08');

  const { corps } = await appeler('/api/seance?date=2026-10-03');
  const motifDe = (nom) => corps.non_eligibles.find((ligne) => ligne.name === nom);

  assert.deepEqual(corps.eligibles.map((ligne) => ligne.name), ['A Jour']);
  // Une suspension prime sur une cotisation à jour.
  assert.equal(motifDe('Suspendu Mais A Jour').motif, 'suspendu jusqu’au 20/10');
  assert.equal(motifDe('Ecarte').motif, 'mis à l’écart');
  assert.equal(motifDe('Declaration En Attente').motif, 'déclaration en attente de validation');
  assert.equal(motifDe('Rien Verse').motif, 'cotisation de octobre non versée');
  assert.equal(motifDe('Rien Verse').mois_dus, 3); // août, septembre, octobre
  assert.equal(motifDe('Rien Verse').montant_du, 3 * COTISATION_MENSUELLE);

  assert.deepEqual(corps.resume, { total_membres: 5, eligibles: 1, non_eligibles: 4 });
});

test('une pénalité due n’empêche pas de jouer', async () => {
  await ajouterMembre(1, 'A Jour Avec Penalite', '2026-10');
  await cotiser(1, '2026-10');
  await executer(
    `INSERT INTO sanctions (member_id, type, motif, montant, statut, date_sanction)
     VALUES (1, 'penalite', 'Retard', 1000, 'due', '2026-09-10T10:00:00Z')`
  );

  const { corps } = await appeler('/api/seance?date=2026-10-03');
  assert.equal(corps.eligibles.length, 1);
  assert.equal(corps.eligibles[0].penalite_due, 1000);
});

test('une suspension échue ne bloque plus', async () => {
  await ajouterMembre(1, 'Suspension Echue', '2026-10');
  await cotiser(1, '2026-10');
  await suspendre(1, '2026-10-02');

  // Le terme inclut le jour même : ce jour-là, le membre ne joue pas.
  const dernierJour = await appeler('/api/seance?date=2026-10-02');
  assert.equal(dernierJour.corps.eligibles.length, 0);
  assert.equal(dernierJour.corps.non_eligibles[0].motif, 'suspendu jusqu’au 02/10');

  const lendemain = await appeler('/api/seance?date=2026-10-03');
  assert.equal(lendemain.corps.eligibles.length, 1);
});

test('GET /api/seance refuse une date inexistante', async () => {
  const reponse = await appeler('/api/seance?date=2026-02-31');
  assert.equal(reponse.code, 400);
});

// ---------------------------------------------------------------------------
// Mesures du mois
// ---------------------------------------------------------------------------

test('avant le 6 octobre 2026, les listes sont calculées et les POST refusés', async () => {
  assert.equal(DATE_EFFET_MESURES, DATE_EFFET_REELLE);

  await ajouterMembre(1, 'Un Mois', '2026-10');
  bloquerLesMesures();

  const lecture = await appeler('/api/mesures?mois=2026-10');
  assert.equal(lecture.code, 200);
  assert.equal(lecture.corps.applicable, false);
  assert.equal(lecture.corps.a_penaliser.length, 1); // calculée malgré tout

  const penalites = await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '222222',
    corps: { mois: '2026-10', member_ids: [1] },
  });
  assert.equal(penalites.code, 409);
  assert.match(penalites.corps.error, /Mesures applicables à partir du/);

  const ecarts = await appeler('/api/mesures/ecarts', {
    methode: 'POST',
    code: '333333',
    corps: { mois: '2026-10', member_ids: [1], motif: 'Retard' },
  });
  assert.equal(ecarts.code, 409);
});

test('le barème : un mois → 1 000, deux mois → 2 000, trois mois → mise à l’écart', async () => {
  await ajouterMembre(1, 'Un Mois', '2026-10');
  await ajouterMembre(2, 'Deux Mois', '2026-09');
  await ajouterMembre(3, 'Trois Mois', '2026-08');

  const mesures = await construireMesures('2026-10', '2026-10-06');

  assert.equal(mesures.applicable, true);
  assert.deepEqual(
    mesures.a_penaliser.map((ligne) => [ligne.name, ligne.mois_de_retard, ligne.penalite_proposee]),
    [['Deux Mois', 2, 2000], ['Un Mois', 1, 1000]]
  );
  // Trois mois : proposé à l'écart, et absent de « à pénaliser ».
  assert.deepEqual(mesures.a_ecarter.map((ligne) => ligne.name), ['Trois Mois']);
  assert.equal(mesures.a_penaliser.find((ligne) => ligne.name === 'Trois Mois'), undefined);
});

test('appliquer deux fois la même liste n’inflige rien en double', async () => {
  autoriserLesMesures();
  await ajouterMembre(1, 'Un Mois', '2026-10');
  await ajouterMembre(2, 'Deux Mois', '2026-09');

  const premier = await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '222222',
    corps: { mois: '2026-10', member_ids: [1, 2] },
  });
  assert.equal(premier.code, 200);
  assert.equal(premier.corps.applique, 2);
  assert.equal(premier.corps.ignore, 0);
  assert.equal(premier.corps.montant_total, 3000);

  const second = await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '222222',
    corps: { mois: '2026-10', member_ids: [1, 2] },
  });
  assert.equal(second.code, 200);
  assert.equal(second.corps.applique, 0);
  assert.equal(second.corps.ignore, 2);

  const compte = await lireUne("SELECT COUNT(*) AS nombre FROM sanctions WHERE type = 'penalite'");
  assert.equal(compte.nombre, 2);
});

test('un membre déjà pénalisé pour ce mois n’est plus proposé', async () => {
  autoriserLesMesures();
  await ajouterMembre(1, 'Un Mois', '2026-10');

  await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '222222',
    corps: { mois: '2026-10', member_ids: [1] },
  });

  const mesures = await construireMesures('2026-10', '2026-10-06');
  assert.equal(mesures.a_penaliser.length, 0);
  assert.equal(mesures.resume.penalises_deja, 1);

  // Le mois suivant, il est de nouveau proposable : la pénalité porte un mois.
  const suivant = await construireMesures('2026-11', '2026-11-06');
  assert.equal(suivant.a_penaliser.length, 1);
});

test('le barème vient du serveur, jamais du client', async () => {
  autoriserLesMesures();
  await ajouterMembre(1, 'Deux Mois', '2026-09');

  await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '222222',
    // Aucun montant n'est transmis : le serveur le recalcule seul.
    corps: { mois: '2026-10', member_ids: [1], montant: 50000 },
  });

  const sanction = await lireUne("SELECT montant, mois_concerne, inflige_par FROM sanctions");
  assert.equal(sanction.montant, 2000);
  assert.equal(sanction.mois_concerne, '2026-10');
  assert.equal(sanction.inflige_par, 'censeur');
});

test('la mise à l’écart conserve le membre et consigne l’événement', async () => {
  autoriserLesMesures();
  // Adhérent en juillet, un seul mois réglé : il doit août, septembre et octobre.
  await ajouterMembre(1, 'Trois Mois', '2026-07');
  await cotiser(1, '2026-07');

  const ecarts = await appeler('/api/mesures/ecarts', {
    methode: 'POST',
    code: '333333',
    corps: { mois: '2026-10', member_ids: [1], motif: 'Trois mois de retard' },
  });

  assert.equal(ecarts.code, 200);
  assert.equal(ecarts.corps.applique, 1);

  const membre = await lireUne('SELECT statut, motif_statut, date_statut FROM members WHERE id = 1');
  assert.equal(membre.statut, 'ecarte');
  assert.equal(membre.motif_statut, 'Trois mois de retard');
  assert.ok(membre.date_statut);

  const evenement = await lireUne('SELECT type, acteur, mois FROM evenements_membres');
  assert.equal(evenement.type, 'mise_a_l_ecart');
  assert.equal(evenement.acteur, 'secretaire');
  assert.equal(evenement.mois, '2026-10');

  // Rejouer : ignoré, sans erreur ni second événement.
  const second = await appeler('/api/mesures/ecarts', {
    methode: 'POST',
    code: '333333',
    corps: { mois: '2026-10', member_ids: [1], motif: 'Trois mois de retard' },
  });
  assert.equal(second.corps.applique, 0);
  assert.equal(second.corps.ignore, 1);
});

test('on n’écarte pas quelqu’un qui n’atteint pas le seuil, même si le client le demande', async () => {
  autoriserLesMesures();
  await ajouterMembre(1, 'Un Mois', '2026-10');

  const reponse = await appeler('/api/mesures/ecarts', {
    methode: 'POST',
    code: '333333',
    corps: { mois: '2026-10', member_ids: [1], motif: 'Au hasard' },
  });

  assert.equal(reponse.corps.applique, 0);
  assert.equal(reponse.corps.ignore, 1);
  assert.match(reponse.corps.ignores[0].motif, /seuil/);

  const membre = await lireUne('SELECT statut FROM members WHERE id = 1');
  assert.equal(membre.statut, 'actif');
});

// ---------------------------------------------------------------------------
// Statut du membre : ce qu'une mise à l'écart change, et ce qu'elle ne change pas
// ---------------------------------------------------------------------------

test('un membre écarté sort du total « à jour » mais reste dans l’historique', async () => {
  await ajouterMembre(1, 'Actif', '2026-09');
  await ajouterMembre(2, 'Ecarte', '2026-09', 'ecarte');
  await cotiser(2, '2026-09');

  const stats = await appeler('/api/stats');
  assert.equal(stats.corps.summary.total_members, 1);
  assert.equal(stats.corps.summary.membres_ecartes, 1);
  assert.equal(stats.corps.members.find((membre) => membre.name === 'Ecarte'), undefined);

  const historique = await appeler('/api/historique?annee=2026');
  assert.ok(historique.corps.members.some((membre) => membre.name === 'Ecarte'));

  const exportation = await fetch(`${base}/api/export/historique.xlsx?annee=2026`);
  assert.equal(exportation.status, 200);
  assert.ok(Number(exportation.headers.get('content-length')) > 0);
});

test('POST /statut bascule, journalise, et refuse une bascule sans changement', async () => {
  await ajouterMembre(1, 'Membre', '2026-09');

  const sansMotif = await appeler('/api/admin/members/1/statut', {
    methode: 'POST',
    code: '333333',
    corps: { statut: 'ecarte' },
  });
  assert.equal(sansMotif.code, 400);

  const ecart = await appeler('/api/admin/members/1/statut', {
    methode: 'POST',
    code: '333333',
    corps: { statut: 'ecarte', motif: 'Absences répétées' },
  });
  assert.equal(ecart.code, 200);
  assert.equal(ecart.corps.statut, 'ecarte');

  const deuxieme = await appeler('/api/admin/members/1/statut', {
    methode: 'POST',
    code: '333333',
    corps: { statut: 'ecarte', motif: 'Absences répétées' },
  });
  assert.equal(deuxieme.code, 409);

  const retour = await appeler('/api/admin/members/1/statut', {
    methode: 'POST',
    code: '333333',
    corps: { statut: 'actif' },
  });
  assert.equal(retour.code, 200);
  assert.equal(retour.corps.statut, 'actif');

  // Les deux événements coexistent : une réintégration n'efface pas l'écart.
  const journal = await appeler('/api/journal?annee=' + new Date().getFullYear());
  const types = journal.corps.evenements.map((evenement) => evenement.type);
  assert.ok(types.includes('membre_ecarte'));
  assert.ok(types.includes('membre_reintegre'));
});

// ---------------------------------------------------------------------------
// Droits
// ---------------------------------------------------------------------------

test('les lectures sont publiques, les écritures réservées', async () => {
  autoriserLesMesures();
  await ajouterMembre(1, 'Trois Mois', '2026-07');

  for (const chemin of ['/api/seance', '/api/arrieres', '/api/mesures']) {
    const reponse = await appeler(chemin);
    assert.equal(reponse.code, 200, `${chemin} doit répondre sans code`);
  }

  // Trésorier sur les mesures : refusé.
  const tresorier = await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '444444',
    corps: { mois: '2026-10', member_ids: [1] },
  });
  assert.equal(tresorier.code, 401);

  // Censeur sur les pénalités, secrétaire sur les écarts : acceptés.
  const censeur = await appeler('/api/mesures/penalites', {
    methode: 'POST',
    code: '222222',
    corps: { mois: '2026-10', member_ids: [1] },
  });
  assert.equal(censeur.code, 200);

  const secretaire = await appeler('/api/mesures/ecarts', {
    methode: 'POST',
    code: '333333',
    corps: { mois: '2026-10', member_ids: [1], motif: 'Retard' },
  });
  assert.equal(secretaire.code, 200);

  // Le secrétaire ne prononce pas les pénalités, le censeur n'écarte pas.
  const censeurSurEcarts = await appeler('/api/mesures/ecarts', {
    methode: 'POST',
    code: '222222',
    corps: { mois: '2026-10', member_ids: [1], motif: 'Retard' },
  });
  assert.equal(censeurSurEcarts.code, 401);

  // Changement de statut sans code : refusé.
  const sansCode = await appeler('/api/admin/members/1/statut', {
    methode: 'POST',
    corps: { statut: 'ecarte', motif: 'Retard' },
  });
  assert.equal(sansCode.code, 401);
});
