/**
 * Demandes à plusieurs postes — LOT 5.
 *
 *   npm test        (node --test "tests/**\/*.test.js")
 *
 * Le geste que ces tests protègent : un samedi, l'intendant engage l'eau, le
 * kiné, la location du stade et le lavage des chasubles. Il exprime UN besoin ;
 * le trésorier tranche POSTE PAR POSTE — il approuve l'eau et refuse le kiné.
 *
 * Ce qu'ils tiennent :
 *   - le statut d'une demande est CALCULÉ à partir de ses postes, jamais saisi ;
 *   - on décaisse un poste, jamais une demande, et jamais deux fois ;
 *   - « tout approuver » ne revient pas sur un refus déjà prononcé ;
 *   - l'ancienne forme plate crée toujours une demande à un poste ;
 *   - les règles de séparation des pouvoirs sont intactes.
 *
 * Base SQLite temporaire : DB_PATH est fixé AVANT le require de src/db.js, qui
 * lit le chemin au chargement.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');

const CHEMIN_BD = path.join(os.tmpdir(), `sde-test-lot05-${process.pid}.db`);
process.env.DB_PATH = CHEMIN_BD;

// Codes de test : aucun secret réel n'entre ici. Les trésoriers sont nominatifs,
// c'est ce qui permet d'éprouver le refus « bénéficiaire = soi-même ».
process.env.ADMIN_PASSWORD = '111111';
process.env.INTENDANT_PASSWORD = '222222';
process.env.SECRETAIRE_PASSWORD = '333333';
process.env.TRESORIERS = 'Junior Mbarga:444444,Paul Essomba:555555';

const CODE_ADMIN = '111111';
const CODE_INTENDANT = '222222';
const CODE_TRESORIER = '444444'; // Junior Mbarga

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { executer, lireUne, lireToutes, migrer, fermerBd } = require('../src/db');

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

/** Les quatre postes d'un samedi chargé, dont trois retenus par les tests. */
const POSTES = [
  { categorie: 'eau_collation', libelle: 'Eau du samedi', montant_estime: 6000 },
  { categorie: 'kine_medical', libelle: 'Séance de kiné', montant_estime: 10000 },
  { categorie: 'location_stade', libelle: 'Location du stade', montant_estime: 2000 },
];

/** Exprime un besoin à plusieurs postes et renvoie la demande créée. */
async function exprimerBesoin(lignes = POSTES, code = CODE_INTENDANT) {
  const reponse = await appeler('/api/demandes', {
    methode: 'POST',
    code,
    corps: { lignes },
  });
  assert.equal(reponse.code, 201, JSON.stringify(reponse.corps));
  return reponse.corps;
}

/** Décaisse un poste approuvé. */
function decaisser(demande, poste, champs = {}) {
  return appeler(`/api/demandes/${demande.id}/lignes/${poste.id}/decaisser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { montant: poste.montant_estime, moyen: 'Espèce', paye_par: 'caisse', ...champs },
  });
}

test.before(async () => {
  fs.rmSync(CHEMIN_BD, { force: true });
  await migrer();

  const application = express();
  application.use(express.json());
  application.use('/api/demandes', require('../src/routes/demandes'));
  application.use('/api/decaissements', require('../src/routes/decaissements'));
  application.use('/api/tresorerie', require('../src/routes/tresorerie'));
  application.use('/api/journal', require('../src/routes/journal'));

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
  await executer('DELETE FROM decaissements');
  await executer('DELETE FROM demande_lignes');
  await executer('DELETE FROM demandes');
});

// ---------------------------------------------------------------------------
// Expression du besoin
// ---------------------------------------------------------------------------

test('un besoin à trois postes est créé en une seule saisie', async () => {
  const demande = await exprimerBesoin();

  assert.equal(demande.statut, 'en_attente');
  assert.equal(demande.nb_lignes, 3);
  assert.equal(demande.lignes.length, 3);
  assert.equal(demande.total_estime, 18000);
  assert.equal(demande.total_decaisse, 0);

  // Chaque poste naît en attente, avec sa propre catégorie.
  assert.deepEqual(
    demande.lignes.map((ligne) => [ligne.categorie, ligne.montant_estime, ligne.statut]),
    [
      ['eau_collation', 6000, 'en_attente'],
      ['kine_medical', 10000, 'en_attente'],
      ['location_stade', 2000, 'en_attente'],
    ]
  );

  const enBase = await lireToutes('SELECT * FROM demande_lignes WHERE demande_id = ?', [demande.id]);
  assert.equal(enBase.length, 3);
});

test('l’ancienne forme plate crée une demande à un poste', async () => {
  const reponse = await appeler('/api/demandes', {
    methode: 'POST',
    code: CODE_INTENDANT,
    corps: { categorie: 'transport', libelle: 'Bus pour le déplacement', montant_estime: 25000 },
  });

  assert.equal(reponse.code, 201, JSON.stringify(reponse.corps));
  assert.equal(reponse.corps.nb_lignes, 1);
  assert.equal(reponse.corps.lignes[0].libelle, 'Bus pour le déplacement');
  assert.equal(reponse.corps.lignes[0].montant_estime, 25000);
  assert.equal(reponse.corps.total_estime, 25000);
  // Les champs plats restent servis : une application non mise à jour continue
  // d'afficher la demande.
  assert.equal(reponse.corps.categorie, 'transport');
  assert.equal(reponse.corps.montant_estime, 25000);
});

test('un poste incomplet ou un montant nul ferme la porte', async () => {
  const sansLibelle = await appeler('/api/demandes', {
    methode: 'POST',
    code: CODE_INTENDANT,
    corps: { lignes: [{ categorie: 'eau_collation', libelle: '  ', montant_estime: 5000 }] },
  });
  assert.equal(sansLibelle.code, 400);

  const montantNul = await appeler('/api/demandes', {
    methode: 'POST',
    code: CODE_INTENDANT,
    corps: {
      lignes: [
        { categorie: 'eau_collation', libelle: 'Eau', montant_estime: 5000 },
        { categorie: 'arbitrage', libelle: 'Arbitre', montant_estime: 0 },
      ],
    },
  });
  assert.equal(montantNul.code, 400);
  assert.match(montantNul.corps.error, /Poste 2/);

  // Rien n'a été écrit : un poste invalide annule toute la saisie.
  const compte = await lireUne('SELECT COUNT(*) AS nombre FROM demandes');
  assert.equal(Number(compte.nombre), 0);
});

test('au-delà de dix postes, la saisie est refusée', async () => {
  const onze = Array.from({ length: 11 }, (_, index) => ({
    categorie: 'autre',
    libelle: `Poste ${index + 1}`,
    montant_estime: 1000,
  }));

  const reponse = await appeler('/api/demandes', {
    methode: 'POST',
    code: CODE_INTENDANT,
    corps: { lignes: onze },
  });

  assert.equal(reponse.code, 400);
  assert.match(reponse.corps.error, /10 postes/);
});

// ---------------------------------------------------------------------------
// Décisions poste par poste
// ---------------------------------------------------------------------------

test('approuver un poste et en refuser un autre laisse la demande en attente', async () => {
  const demande = await exprimerBesoin();
  const [eau, kine, stade] = demande.lignes;

  const approuve = await appeler(`/api/demandes/${demande.id}/lignes/${eau.id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });
  assert.equal(approuve.code, 200);
  assert.equal(approuve.corps.statut, 'en_attente'); // le kiné et le stade attendent

  const refuse = await appeler(`/api/demandes/${demande.id}/lignes/${kine.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Pas ce mois-ci' },
  });
  assert.equal(refuse.code, 200);
  // Le poste 3 attend encore : l'agrégat aussi.
  assert.equal(refuse.corps.statut, 'en_attente');

  const postes = refuse.corps.lignes;
  assert.equal(postes[0].statut, 'approuvee');
  assert.equal(postes[0].approuve_par, 'Junior Mbarga');
  assert.equal(postes[1].statut, 'refusee');
  assert.equal(postes[1].motif_refus, 'Pas ce mois-ci');
  assert.equal(postes[2].statut, 'en_attente');

  // Décision sur le dernier poste : plus rien n'attend, au moins un poste est
  // approuvé — la demande passe « approuvée ».
  const dernier = await appeler(`/api/demandes/${demande.id}/lignes/${stade.id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });
  assert.equal(dernier.corps.statut, 'approuvee');
});

test('tous les postes refusés font une demande refusée', async () => {
  const demande = await exprimerBesoin();

  for (const poste of demande.lignes) {
    const reponse = await appeler(`/api/demandes/${demande.id}/lignes/${poste.id}/refuser`, {
      methode: 'POST',
      code: CODE_TRESORIER,
      corps: { motif: 'Caisse trop basse' },
    });
    assert.equal(reponse.code, 200);
  }

  const liste = await appeler('/api/demandes');
  assert.equal(liste.corps.demandes[0].statut, 'refusee');
  assert.equal(liste.corps.demandes[0].motif_refus, 'Caisse trop basse');
});

test('tous les postes retenus payés font une demande payée', async () => {
  const demande = await exprimerBesoin();
  const [eau, kine, stade] = demande.lignes;

  await appeler(`/api/demandes/${demande.id}/lignes/${kine.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Reporté' },
  });
  await appeler(`/api/demandes/${demande.id}/approuver`, { methode: 'POST', code: CODE_TRESORIER });

  const premier = await decaisser(demande, eau);
  assert.equal(premier.code, 201);
  // Le stade reste approuvé sans être payé : la demande ne peut pas être payée.
  assert.equal(premier.corps.statut, 'approuvee');

  const second = await decaisser(demande, stade);
  assert.equal(second.code, 201);
  // Le poste refusé ne s'oppose pas au statut « payée » : il ne sera jamais payé.
  assert.equal(second.corps.statut, 'payee');
  assert.equal(second.corps.total_decaisse, 8000);
});

test('« tout approuver » ne revient pas sur un refus déjà prononcé', async () => {
  const demande = await exprimerBesoin();
  const [, kine] = demande.lignes;

  await appeler(`/api/demandes/${demande.id}/lignes/${kine.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Pas ce mois-ci' },
  });

  const tout = await appeler(`/api/demandes/${demande.id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });

  assert.equal(tout.code, 200);
  assert.deepEqual(
    tout.corps.lignes.map((ligne) => ligne.statut),
    ['approuvee', 'refusee', 'approuvee']
  );
  assert.equal(tout.corps.lignes[1].motif_refus, 'Pas ce mois-ci');
  assert.equal(tout.corps.statut, 'approuvee');

  // Plus rien n'attend : rejouer le geste n'a plus d'objet.
  const rejoue = await appeler(`/api/demandes/${demande.id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });
  assert.equal(rejoue.code, 409);
});

test('un poste refusé en bloc porte le motif du refus', async () => {
  const demande = await exprimerBesoin();

  const reponse = await appeler(`/api/demandes/${demande.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Budget épuisé' },
  });

  assert.equal(reponse.code, 200);
  assert.equal(reponse.corps.statut, 'refusee');
  assert.ok(reponse.corps.lignes.every((ligne) => ligne.motif_refus === 'Budget épuisé'));
});

// ---------------------------------------------------------------------------
// Décaissement : l'invariant
// ---------------------------------------------------------------------------

test('décaisser un poste en attente est refusé en 409', async () => {
  const demande = await exprimerBesoin();

  const reponse = await decaisser(demande, demande.lignes[0]);

  assert.equal(reponse.code, 409);
  assert.match(reponse.corps.error, /approuv/);

  const compte = await lireUne('SELECT COUNT(*) AS nombre FROM decaissements');
  assert.equal(Number(compte.nombre), 0);
});

test('décaisser deux fois le même poste est refusé en 409', async () => {
  const demande = await exprimerBesoin();
  await appeler(`/api/demandes/${demande.id}/approuver`, { methode: 'POST', code: CODE_TRESORIER });

  const premier = await decaisser(demande, demande.lignes[0]);
  assert.equal(premier.code, 201);

  const second = await decaisser(demande, demande.lignes[0]);
  assert.equal(second.code, 409);

  const compte = await lireUne('SELECT COUNT(*) AS nombre FROM decaissements');
  assert.equal(Number(compte.nombre), 1);
});

test('un poste refusé ne peut plus être décaissé', async () => {
  const demande = await exprimerBesoin();
  const poste = demande.lignes[0];

  await appeler(`/api/demandes/${demande.id}/lignes/${poste.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Non justifié' },
  });

  const reponse = await decaisser(demande, poste);
  assert.equal(reponse.code, 409);
});

test('on ne décaisse plus une demande entière', async () => {
  const demande = await exprimerBesoin();
  await appeler(`/api/demandes/${demande.id}/approuver`, { methode: 'POST', code: CODE_TRESORIER });

  // La route a disparu : Express répond son 404 par défaut, en HTML. On lit
  // donc le statut sans décoder le corps.
  const reponse = await fetch(`${base}/api/demandes/${demande.id}/decaisser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CODE_TRESORIER}` },
    body: JSON.stringify({ montant: 6000, moyen: 'Espèce', paye_par: 'caisse' }),
  });

  assert.equal(reponse.status, 404);
});

test('un poste emprunté à une autre demande ne passe pas', async () => {
  const premiere = await exprimerBesoin();
  const seconde = await exprimerBesoin([POSTES[0]]);

  const reponse = await appeler(
    `/api/demandes/${seconde.id}/lignes/${premiere.lignes[0].id}/approuver`,
    { methode: 'POST', code: CODE_TRESORIER }
  );

  assert.equal(reponse.code, 404);
});

// ---------------------------------------------------------------------------
// Séparation des pouvoirs
// ---------------------------------------------------------------------------

test('un trésorier ne peut pas exprimer de besoin', async () => {
  const reponse = await appeler('/api/demandes', {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { lignes: POSTES },
  });

  assert.equal(reponse.code, 401);

  // L'admin, lui, cumule les fonctions.
  const parAdmin = await appeler('/api/demandes', {
    methode: 'POST',
    code: CODE_ADMIN,
    corps: { lignes: [POSTES[0]] },
  });
  assert.equal(parAdmin.code, 201);
  assert.equal(parAdmin.corps.role_demandeur, 'admin');
});

test('un trésorier ne peut pas se désigner bénéficiaire du décaissement', async () => {
  const demande = await exprimerBesoin();
  await appeler(`/api/demandes/${demande.id}/approuver`, { methode: 'POST', code: CODE_TRESORIER });

  const reponse = await decaisser(demande, demande.lignes[0], {
    paye_par: 'avance_rembourse',
    beneficiaire: 'junior mbarga', // même personne, casse différente
  });

  assert.equal(reponse.code, 403);

  // Au bénéfice d'un autre, le décaissement passe.
  const autre = await decaisser(demande, demande.lignes[0], {
    paye_par: 'avance_rembourse',
    beneficiaire: 'Paul Essomba',
  });
  assert.equal(autre.code, 201);
});

// ---------------------------------------------------------------------------
// Lectures : liste, trésorerie, journal
// ---------------------------------------------------------------------------

test('la liste filtre sur le statut agrégé et compte poste par poste', async () => {
  const demande = await exprimerBesoin();
  await appeler(`/api/demandes/${demande.id}/lignes/${demande.lignes[0].id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });

  const enAttente = await appeler('/api/demandes?statut=en_attente');
  assert.equal(enAttente.corps.demandes.length, 1); // un poste attend encore

  const approuvees = await appeler('/api/demandes?statut=approuvee');
  assert.equal(approuvees.corps.demandes.length, 0);

  const toutes = await appeler('/api/demandes');
  assert.equal(toutes.corps.totaux.en_attente, 2);
  assert.equal(toutes.corps.totaux.approuvee, 1);
  assert.equal(toutes.corps.montants.approuvee, 6000);
  assert.equal(toutes.corps.montants.en_attente, 12000);
});

test('la trésorerie n’engage que les postes approuvés et non payés', async () => {
  const demande = await exprimerBesoin();
  const [eau, kine, stade] = demande.lignes;

  await appeler(`/api/demandes/${demande.id}/lignes/${kine.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Reporté' },
  });
  await appeler(`/api/demandes/${demande.id}/approuver`, { methode: 'POST', code: CODE_TRESORIER });

  const avant = await appeler('/api/tresorerie');
  assert.equal(avant.corps.engage.total, 8000); // eau + stade, le kiné est écarté
  assert.equal(avant.corps.engage.demandes_en_attente, 0);

  await decaisser(demande, eau);

  const apres = await appeler('/api/tresorerie');
  // L'eau quitte l'engagement pour la dépense.
  assert.equal(apres.corps.engage.total, 2000);
  assert.equal(apres.corps.depense.total, 6000);
  assert.deepEqual(apres.corps.depense.par_categorie, [
    { categorie: 'eau_collation', montant: 6000, nombre: 1 },
  ]);

  // Le relevé de caisse porte le libellé du POSTE, pas celui de la demande.
  const mouvement = apres.corps.derniers_mouvements.find((ligne) => ligne.nature === 'depense');
  assert.equal(mouvement.membre, 'Eau du samedi');
  assert.equal(mouvement.montant, -6000);

  // La liste publique des décaissements rattache la sortie à sa demande.
  const sorties = await appeler('/api/decaissements');
  assert.equal(sorties.corps.decaissements[0].demande_id, demande.id);
  assert.equal(sorties.corps.decaissements[0].ligne_id, eau.id);
  assert.equal(sorties.corps.decaissements[0].libelle, 'Eau du samedi');
  assert.equal(stade.statut, 'en_attente'); // la réponse de création, inchangée
});

test('le journal annonce le besoin puis chaque décision de poste', async () => {
  const demande = await exprimerBesoin();
  const [eau, kine] = demande.lignes;

  await appeler(`/api/demandes/${demande.id}/lignes/${eau.id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });
  await appeler(`/api/demandes/${demande.id}/lignes/${kine.id}/refuser`, {
    methode: 'POST',
    code: CODE_TRESORIER,
    corps: { motif: 'Reporté' },
  });
  await decaisser(demande, eau);

  const journal = await appeler('/api/journal');
  const evenements = journal.corps.evenements;

  const besoin = evenements.filter((evenement) => evenement.type === 'demande_exprimee');
  assert.equal(besoin.length, 1);
  assert.equal(besoin[0].sujet, '3 postes');
  assert.equal(besoin[0].montant, 18000);
  assert.equal(besoin[0].acteur, 'Intendance');

  const approuvees = evenements.filter((evenement) => evenement.type === 'demande_approuvee');
  assert.equal(approuvees.length, 1);
  assert.equal(approuvees[0].sujet, 'Eau du samedi');
  assert.equal(approuvees[0].montant, 6000);

  const refusees = evenements.filter((evenement) => evenement.type === 'demande_refusee');
  assert.equal(refusees.length, 1);
  assert.equal(refusees[0].sujet, 'Séance de kiné');

  const sorties = evenements.filter((evenement) => evenement.type === 'decaissement');
  assert.equal(sorties.length, 1);
  assert.equal(sorties[0].sujet, 'Eau du samedi');
  assert.equal(sorties[0].acteur, 'Junior Mbarga');
});

test('une demande intacte se retire, une demande déjà tranchée ne se retire plus', async () => {
  const intacte = await exprimerBesoin();
  const retrait = await appeler(`/api/demandes/${intacte.id}`, {
    methode: 'DELETE',
    code: CODE_INTENDANT,
  });
  assert.equal(retrait.code, 200);

  // Les postes partent avec la demande : rien ne reste orphelin.
  const restes = await lireToutes('SELECT id FROM demande_lignes WHERE demande_id = ?', [intacte.id]);
  assert.equal(restes.length, 0);

  const tranchee = await exprimerBesoin();
  await appeler(`/api/demandes/${tranchee.id}/lignes/${tranchee.lignes[0].id}/approuver`, {
    methode: 'POST',
    code: CODE_TRESORIER,
  });

  const refuse = await appeler(`/api/demandes/${tranchee.id}`, {
    methode: 'DELETE',
    code: CODE_INTENDANT,
  });
  assert.equal(refuse.code, 409);
});
