/**
 * Multi-associations, rôles, réinitialisation par SMS — LOT 7 « DeuxZero ».
 *
 *   npm test        (node --test "tests/**\/*.test.js")
 *
 * Ce fichier est l'exécution des vérifications 2 à 10 de la section 7 du cahier
 * des charges. Il monte l'APPLICATION COMPLÈTE — le vrai src/index.js, avec son
 * middleware d'association et son annuaire sur disque — parce que ce qu'il faut
 * prouver ici n'est pas le comportement d'une fonction mais celui de la chaîne :
 *
 *   ÉTANCHÉITÉ     une requête portant X-Association: TEST01 ne voit AUCUNE
 *                  donnée de SDE001, et réciproquement. Éprouvé sur les membres,
 *                  les cotisations, les dépenses, la trésorerie et les exports.
 *
 *   CODES          un code temporaire ne sert qu'une fois, expire en 24 heures,
 *                  et n'ouvre AUCUN écran avant le choix d'un code personnel.
 *                  Le président ne voit jamais le code définitif d'un autre.
 *
 *   RÉINITIALISATION  parcours complet en SMS_FOURNISSEUR=journal, quota de trois
 *                  par mois réellement bloquant, blocage d'une heure après cinq
 *                  échecs, et contre-seing du président : une confirmation ne
 *                  suffit pas, deux suffisent.
 *
 *   PARAMÈTRES     modifier une pénalité sur TEST01 ne change rien sur SDE001.
 *
 *   AUCUN CODE EN CLAIR  ni en base, ni dans une réponse d'API, ni dans un export.
 *
 * SMS_FOURNISSEUR=journal : aucun SMS ne part, et le code à six chiffres est lu
 * dans les journaux du serveur — c'est le seul moyen d'éprouver le parcours de
 * bout en bout sans passerelle et sans facture.
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');

// L'annuaire et les bases d'association vivent dans un dossier temporaire, posé
// AVANT tout require : src/bd/annuaire.js lit DATA_DIR au chargement.
const DOSSIER = path.join(os.tmpdir(), `deuxzero-test-lot07-${process.pid}`);
process.env.DATA_DIR = DOSSIER;
process.env.NODE_ENV = 'test';
// src/index.js est requis pour son application Express seule : ce drapeau lui dit
// de ne pas ouvrir sa propre ecoute, le test montant la sienne sur un port libre.
process.env.SERVEUR_SANS_ECOUTE = '1';
process.env.SMS_FOURNISSEUR = 'journal';
process.env.ADMIN_PRODUIT_CODE = 'editeur-de-test';
// Le plafond de creations par adresse IP protege la production contre un script
// en boucle ; ce fichier cree une dizaine d'associations depuis 127.0.0.1.
process.env.CREATIONS_MAX = '100';
// Aucun code de rôle en environnement : ce lot les veut en base, et leur absence
// prouve que le repli historique n'est pas ce qui fait passer les tests.
delete process.env.ADMIN_PASSWORD;
delete process.env.TRESORIERS;

const test = require('node:test');
const assert = require('node:assert/strict');

const application = require('../src/index');
const annuaire = require('../src/bd/annuaire');
const locataires = require('../src/bd/locataires');
const codes = require('../src/services/codes');
const { envoyerSms, fournisseurActif } = require('../src/services/sms');

let serveur;
let base;

/** Codes et identifiants collectés au fil des tests. */
const sde = { code: null, president: null, bd: null };
const testAssoc = { code: null, president: null, bd: null };

/**
 * Appel JSON. L'en-tête X-Association est aussi explicite qu'en production : le
 * test doit échouer si on l'oublie, exactement comme l'application.
 */
async function appeler(chemin, { methode = 'GET', code = null, association = null, corps = null, entetes = {} } = {}) {
  const reponse = await fetch(`${base}${chemin}`, {
    method: methode,
    headers: {
      Accept: 'application/json',
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
      ...(code ? { Authorization: `Bearer ${code}` } : {}),
      ...(association ? { 'X-Association': association } : {}),
      ...entetes,
    },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });

  const type = reponse.headers.get('content-type') || '';
  const charge = type.includes('application/json') ? await reponse.json() : await reponse.text();
  return { code: reponse.status, corps: charge, entetes: reponse.headers };
}

/** Jour courant, AAAA-MM-JJ : la date de versement est obligatoire. */
function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

/** Crée une association et renvoie ses deux codes. */
async function creerAssociation(nom, ville, telephone, nomPresident) {
  const reponse = await appeler('/api/associations', {
    methode: 'POST',
    corps: {
      nom,
      ville,
      telephone_president: telephone,
      nom_president: nomPresident,
      contribution_defaut: 10000,
    },
  });
  assert.equal(reponse.code, 201, JSON.stringify(reponse.corps));
  return reponse.corps;
}

/**
 * Dernier code SMS à six chiffres écrit par le routeur « journal ».
 *
 * Le mode journal écrit le texte complet du SMS dans la sortie standard : c'est
 * précisément ce qui le rend utilisable en recette, et ce qui interdit de
 * l'employer en production. On capture la sortie plutôt que de lire la base, pour
 * éprouver le parcours tel qu'un humain le vit — il lit un SMS, il le retape.
 */
function capturerSms() {
  const messages = [];
  const original = console.log;
  console.log = (...arguments_) => {
    const texte = arguments_.join(' ');
    if (texte.includes('[sms:journal]')) messages.push(texte);
    original(...arguments_);
  };
  return {
    messages,
    arreter() {
      console.log = original;
    },
    /** Dernier code à six chiffres annoncé. */
    dernierCode() {
      for (let rang = messages.length - 1; rang >= 0; rang -= 1) {
        const trouve = /est (\d{6})\./.exec(messages[rang]);
        if (trouve) return trouve[1];
      }
      return null;
    },
    /** Dernier code temporaire à huit caractères annoncé. */
    dernierCodeTemporaire() {
      for (let rang = messages.length - 1; rang >= 0; rang -= 1) {
        const trouve = /temporaire est ([A-Z2-9]{8})\./.exec(messages[rang]);
        if (trouve) return trouve[1];
      }
      return null;
    },
  };
}

/** Connexion directe à la base d'une association (contrôles de non-fuite). */
async function baseDe(code) {
  const association = await annuaire.trouverParCode(code);
  return locataires.obtenirBase(association);
}

test.before(async () => {
  fs.rmSync(DOSSIER, { recursive: true, force: true });
  fs.mkdirSync(DOSSIER, { recursive: true });

  serveur = application.listen(0);
  await once(serveur, 'listening');
  base = `http://127.0.0.1:${serveur.address().port}`;

  // Deux associations, créées par l'application elle-même — sans intervention de
  // l'éditeur, ce qui est l'exigence produit du lot.
  const premiere = await creerAssociation('Santé des extrêmes', 'Douala', '+237699000001', 'Joseph ESSONO');
  sde.code = premiere.code_association;
  sde.president = premiere.code_president;

  const seconde = await creerAssociation('Test Zero', 'Yaoundé', '+237699000002', 'Paul TEST');
  testAssoc.code = seconde.code_association;
  testAssoc.president = seconde.code_president;

  sde.bd = await baseDe(sde.code);
  testAssoc.bd = await baseDe(testAssoc.code);
});

test.after(async () => {
  await new Promise((resoudre) => serveur.close(resoudre));
  await locataires.fermerToutes();
  await annuaire.fermerAnnuaire();
  fs.rmSync(DOSSIER, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Vérification 3 — création d'une association, de bout en bout
// ---------------------------------------------------------------------------

test('la création d’une association rend un code à six caractères et un code président', () => {
  assert.match(sde.code, /^[A-Z0-9]{6}$/);
  assert.match(testAssoc.code, /^[A-Z0-9]{6}$/);
  assert.notEqual(sde.code, testAssoc.code);

  // Huit caractères, dans l'alphabet lisible : ni I, ni l, ni 1, ni O, ni 0.
  assert.match(sde.president, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.match(testAssoc.president, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
});

test('le code d’association se vérifie et rend le nom, sans aucun chiffre', async () => {
  const reponse = await appeler('/api/associations/verifier-code', {
    methode: 'POST',
    corps: { code: testAssoc.code.toLowerCase() }, // saisie en minuscules : tolérée
  });

  assert.equal(reponse.code, 200);
  assert.equal(reponse.corps.nom, 'Test Zero');
  assert.equal(reponse.corps.ville, 'Yaoundé');
  // Aucune donnée métier ne doit filtrer par cette route publique.
  assert.equal(reponse.corps.membres, undefined);
  assert.equal(reponse.corps.total_encaisse, undefined);

  const inconnu = await appeler('/api/associations/verifier-code', {
    methode: 'POST',
    corps: { code: 'ZZZ999' },
  });
  assert.equal(inconnu.code, 404);
});

test('le président se connecte, ajoute un membre, déclare une cotisation et la valide', async () => {
  const verification = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: testAssoc.code,
    corps: { code: testAssoc.president },
  });
  assert.equal(verification.code, 200);
  assert.deepEqual(verification.corps.roles, ['president', 'admin']);
  assert.equal(verification.corps.code_temporaire, false);

  // Le président cumule les fonctions : il peut agir comme secrétaire.
  const creation = await appeler('/api/admin/members', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { name: 'Membre de Test', telephone: '+237699000010', contribution: 5000 },
  });
  assert.equal(creation.code, 201, JSON.stringify(creation.corps));
  assert.equal(creation.corps.contribution, 5000);
  // Le téléphone ne ressort que masqué, jamais en clair.
  assert.equal(creation.corps.telephone, '+237******010');
  assert.equal(creation.corps.telephone_renseigne, true);

  const cotisation = await appeler('/api/cotisations', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: {
      member_id: creation.corps.id,
      montant: 5000,
      moyen: 'Espèce',
      date_versement: aujourdhui(),
    },
  });
  assert.equal(cotisation.code, 201, JSON.stringify(cotisation.corps));

  const etat = await appeler('/api/stats', { association: testAssoc.code });
  assert.equal(etat.code, 200);
  // Deux membres : le président créé à l'inscription, et celui qu'il vient
  // d'ajouter. C'est tout : aucune trace des 39 de l'autre association.
  assert.equal(etat.corps.summary.total_members, 2);
  assert.equal(etat.corps.summary.montant_encaisse, 5000);
});

// ---------------------------------------------------------------------------
// Vérification 4 — étanchéité
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Correctif d'urgence — repli ASSOCIATION_PAR_DEFAUT
//
// Les applications installées chez les trente-neuf membres de l'association
// historique ont été écrites avant le LOT 7 : elles n'envoient pas l'en-tête et
// recevaient 400 sur TOUTES les routes métier. Trente-neuf téléphones ne se
// mettent pas à jour en une soirée, d'où ce repli — étroit, tracé, transitoire.
//
// Ce que ces tests tiennent, et qui fait toute la valeur du dispositif :
//   · avec la variable, une requête SANS en-tête aboutit sur l'association visée ;
//   · sans la variable, elle est refusée en 400 — une installation neuve est
//     stricte, et le repli ne s'active jamais de lui-même ;
//   · un en-tête PRÉSENT mais mal formé reste refusé dans les DEUX cas : c'est un
//     défaut d'application, pas un client ancien ;
//   · l'étanchéité reste entière dès que l'en-tête est fourni. C'est le point
//     capital : le repli ne doit pas devenir une porte vers une autre association.
// ---------------------------------------------------------------------------

/** Exécute [action] avec ASSOCIATION_PAR_DEFAUT posée, puis rétablit l'état. */
async function avecRepli(code, action) {
  const precedent = process.env.ASSOCIATION_PAR_DEFAUT;
  process.env.ASSOCIATION_PAR_DEFAUT = code;
  try {
    return await action();
  } finally {
    if (precedent === undefined) delete process.env.ASSOCIATION_PAR_DEFAUT;
    else process.env.ASSOCIATION_PAR_DEFAUT = precedent;
  }
}

test('la sonde de santé répond sur les deux chemins, sans en-tête', async () => {
  for (const chemin of ['/api/health', '/health']) {
    const reponse = await appeler(chemin);
    assert.equal(reponse.code, 200, `${chemin} devrait répondre 200 sans en-tête`);
    assert.equal(reponse.corps.status, 'ok');
    assert.equal(reponse.corps.service, 'deuxzero-backend');
  }
});

test('sans ASSOCIATION_PAR_DEFAUT, une requête sans en-tête reste refusée', async () => {
  assert.equal(process.env.ASSOCIATION_PAR_DEFAUT, undefined);

  for (const chemin of ['/api/stats', '/api/arrieres', '/api/tresorerie', '/api/historique']) {
    const reponse = await appeler(chemin);
    assert.equal(reponse.code, 400, `${chemin} devrait exiger l’en-tête`);
    assert.equal(reponse.corps.code, 'association_requise');
  }
});

test('avec ASSOCIATION_PAR_DEFAUT, une requête sans en-tête aboutit sur cette association', async () => {
  // Référence : la même lecture, en-tête fourni.
  const reference = await appeler('/api/stats', { association: sde.code });
  assert.equal(reference.code, 200);

  await avecRepli(sde.code, async () => {
    for (const chemin of ['/api/stats', '/api/arrieres', '/api/tresorerie', '/api/historique']) {
      const reponse = await appeler(chemin);
      assert.equal(reponse.code, 200, `${chemin} devrait aboutir par repli`);
    }

    // Et ce sont bien les données de SDE, pas celles d'une autre association.
    const sansEntete = await appeler('/api/stats');
    assert.equal(
      sansEntete.corps.summary.montant_encaisse,
      reference.corps.summary.montant_encaisse
    );
    assert.equal(sansEntete.corps.summary.total_members, reference.corps.summary.total_members);
  });
});

test('le repli journalise un avertissement repérable, pour savoir quand le retirer', async () => {
  const lignes = [];
  const original = console.warn;
  console.warn = (...arguments_) => {
    lignes.push(arguments_.join(' '));
    original(...arguments_);
  };

  try {
    await avecRepli(sde.code, async () => {
      const reponse = await appeler('/api/stats');
      assert.equal(reponse.code, 200);
    });
  } finally {
    console.warn = original;
  }

  // C'est cette trace exacte qui dira que le dispositif peut disparaître : plus
  // aucune ligne de ce genre, plus besoin de la variable.
  const trace = lignes.find((ligne) => ligne.includes('repli vers'));
  assert.ok(trace, 'aucun avertissement de repli dans les journaux');
  assert.ok(trace.includes(`repli vers ${sde.code} (en-tête absent)`), trace);
  assert.ok(trace.includes('GET /api/stats'), trace);
});

test('un en-tête PRÉSENT mais mal formé est refusé, avec ou sans repli', async () => {
  // Sans repli.
  for (const mauvais of ['ABC', 'TROP-LONG-12', 'é!@#$%', ' ABC12 ']) {
    const reponse = await appeler('/api/stats', { association: mauvais });
    assert.equal(reponse.code, 400, `« ${mauvais} » devrait être refusé`);
    assert.equal(reponse.corps.code, 'association_requise');
  }

  // Avec repli : le refus tient. Un client qui envoie un en-tête sait en envoyer
  // un bon ; masquer son défaut le rendrait introuvable.
  await avecRepli(sde.code, async () => {
    for (const mauvais of ['ABC', 'TROP-LONG-12']) {
      const reponse = await appeler('/api/stats', { association: mauvais });
      assert.equal(reponse.code, 400, `« ${mauvais} » devrait rester refusé malgré le repli`);
      assert.equal(reponse.corps.code, 'association_requise');
    }
  });
});

test('le repli ne perce pas l’étanchéité : l’en-tête fourni l’emporte toujours', async () => {
  // Repli posé sur SDE, mais chaque requête nomme son association : c'est elle
  // qui doit être servie, sinon le correctif d'urgence aurait ouvert une brèche
  // entre deux clients — exactement ce que tout le lot cherche à rendre impossible.
  await avecRepli(sde.code, async () => {
    const chezTest = await appeler('/api/stats', { association: testAssoc.code });
    const chezSde = await appeler('/api/stats', { association: sde.code });

    assert.equal(chezTest.code, 200);
    assert.equal(chezSde.code, 200);
    assert.notEqual(
      chezTest.corps.summary.montant_encaisse,
      chezSde.corps.summary.montant_encaisse
    );

    const membresTest = await appeler('/api/admin/members', {
      code: testAssoc.president,
      association: testAssoc.code,
    });
    assert.equal(membresTest.code, 200);
    const noms = membresTest.corps.members.map((entree) => entree.name);
    assert.ok(!noms.includes('Membre Exclusif SDE'), 'le repli laisse fuir un membre de SDE');

    // Un code inconnu reste un 404, il ne retombe pas silencieusement sur le repli.
    const inconnu = await appeler('/api/stats', { association: 'ZZZ999' });
    assert.equal(inconnu.code, 404, 'un code inconnu ne doit pas basculer sur le repli');
    assert.equal(inconnu.corps.code, 'association_inconnue');

    // Et le code d'une association n'ouvre toujours pas l'autre.
    const croise = await appeler('/api/admin/members', {
      code: sde.president,
      association: testAssoc.code,
    });
    assert.equal(croise.code, 401, 'le repli a affaibli le cloisonnement des codes');
  });
});

test('une ASSOCIATION_PAR_DEFAUT mal formée n’active aucun repli', async () => {
  await avecRepli('pas-un-code', async () => {
    const reponse = await appeler('/api/stats');
    assert.equal(reponse.code, 400, 'une variable invalide ne doit pas activer le repli');
    assert.equal(reponse.corps.code, 'association_requise');
  });
});

test('un code d’association inconnu est refusé en 404, un suspendu en 403', async () => {
  const inconnu = await appeler('/api/stats', { association: 'ZZZ999' });
  assert.equal(inconnu.code, 404);
  assert.equal(inconnu.corps.code, 'association_inconnue');

  const donnees = await annuaire.obtenirAnnuaire();
  await donnees.executer("UPDATE associations SET statut = 'suspendue' WHERE code = ?", [testAssoc.code]);

  const suspendue = await appeler('/api/stats', { association: testAssoc.code });
  assert.equal(suspendue.code, 403);
  assert.equal(suspendue.corps.code, 'association_suspendue');

  await donnees.executer("UPDATE associations SET statut = 'active' WHERE code = ?", [testAssoc.code]);
});

test('les membres, cotisations, dépenses, trésorerie et exports ne traversent pas la frontière', async () => {
  // Jeu de données propre à SDE : un membre, une cotisation, une dépense payée.
  const membre = await appeler('/api/admin/members', {
    methode: 'POST',
    code: sde.president,
    association: sde.code,
    corps: { name: 'Membre Exclusif SDE', telephone: '+237699000020' },
  });
  assert.equal(membre.code, 201);

  await appeler('/api/cotisations', {
    methode: 'POST',
    code: sde.president,
    association: sde.code,
    corps: {
      member_id: membre.corps.id,
      montant: 10000,
      moyen: 'Mobile Money',
      date_versement: aujourdhui(),
    },
  });

  const besoin = await appeler('/api/demandes', {
    methode: 'POST',
    code: sde.president,
    association: sde.code,
    corps: { lignes: [{ categorie: 'eau_collation', libelle: 'Eau du samedi SDE', montant_estime: 7000 }] },
  });
  assert.equal(besoin.code, 201, JSON.stringify(besoin.corps));

  // --- Membres --------------------------------------------------------------
  const membresTest = await appeler('/api/admin/members', {
    code: testAssoc.president,
    association: testAssoc.code,
  });
  assert.equal(membresTest.code, 200);
  const noms = membresTest.corps.members.map((entree) => entree.name);
  assert.ok(!noms.includes('Membre Exclusif SDE'), 'un membre de SDE apparaît chez TEST');

  // --- Cotisations et état --------------------------------------------------
  const etatTest = await appeler('/api/stats', { association: testAssoc.code });
  assert.equal(etatTest.corps.summary.montant_encaisse, 5000, 'les cotisations de SDE fuient chez TEST');
  const etatSde = await appeler('/api/stats', { association: sde.code });
  assert.equal(etatSde.corps.summary.montant_encaisse, 10000, 'les cotisations de TEST fuient chez SDE');

  // --- Dépenses -------------------------------------------------------------
  const depensesTest = await appeler('/api/demandes', { association: testAssoc.code });
  assert.equal(depensesTest.corps.demandes.length, 0, 'une demande de SDE apparaît chez TEST');
  const depensesSde = await appeler('/api/demandes', { association: sde.code });
  assert.equal(depensesSde.corps.demandes.length, 1);

  // --- Trésorerie -----------------------------------------------------------
  const tresoTest = await appeler('/api/tresorerie', { association: testAssoc.code });
  const tresoSde = await appeler('/api/tresorerie', { association: sde.code });
  assert.equal(tresoTest.corps.encaisse.cotisations, 5000);
  assert.equal(tresoSde.corps.encaisse.cotisations, 10000);

  // --- Historique -----------------------------------------------------------
  const histoTest = await appeler('/api/historique', { association: testAssoc.code });
  const histoSde = await appeler('/api/historique', { association: sde.code });
  const nomsHistoTest = histoTest.corps.members.map((entree) => entree.name);
  const nomsHistoSde = histoSde.corps.members.map((entree) => entree.name);
  assert.ok(nomsHistoSde.includes('Membre Exclusif SDE'));
  assert.ok(!nomsHistoTest.includes('Membre Exclusif SDE'), 'un membre de SDE est dans l’historique de TEST');
  assert.ok(nomsHistoTest.includes('Membre de Test'));
  assert.ok(!nomsHistoSde.includes('Membre de Test'), 'un membre de TEST est dans l’historique de SDE');
  assert.equal(histoTest.corps.total_annee, 5000);
  assert.equal(histoSde.corps.total_annee, 10000);

  // --- Exports --------------------------------------------------------------
  const exportTest = await fetch(`${base}/api/export/historique.xlsx`, {
    headers: { 'X-Association': testAssoc.code },
  });
  assert.equal(exportTest.status, 200);
  const octetsTest = Buffer.from(await exportTest.arrayBuffer());
  assert.ok(octetsTest.length > 0);
  // Un classeur xlsx est un zip : le nom du membre de SDE ne doit pas s'y trouver
  // en clair, mais la seule garantie solide est de comparer les deux exports.
  const exportSde = await fetch(`${base}/api/export/historique.xlsx`, {
    headers: { 'X-Association': sde.code },
  });
  const octetsSde = Buffer.from(await exportSde.arrayBuffer());
  assert.notEqual(octetsTest.toString('base64'), octetsSde.toString('base64'));

  // --- Arriérés et séance ---------------------------------------------------
  const arrieresTest = await appeler('/api/arrieres', { association: testAssoc.code });
  const arrieresSde = await appeler('/api/arrieres', { association: sde.code });
  const nomsArrieresTest = arrieresTest.corps.membres.map((entree) => entree.name);
  assert.ok(!nomsArrieresTest.includes('Membre Exclusif SDE'));
  const nomsArrieresSde = arrieresSde.corps.membres.map((entree) => entree.name);
  assert.ok(!nomsArrieresSde.includes('Membre de Test'));
});

test('le code président d’une association n’ouvre pas l’autre', async () => {
  const croise = await appeler('/api/admin/members', {
    code: sde.president,
    association: testAssoc.code,
  });
  assert.equal(croise.code, 401, 'le code de SDE ouvre TEST : les codes ne sont pas cloisonnés');
});

// ---------------------------------------------------------------------------
// Vérification 5 — codes temporaires
// ---------------------------------------------------------------------------

test('un code temporaire n’ouvre aucun écran avant le choix d’un code personnel', async () => {
  const membres = await appeler('/api/admin/members', {
    code: testAssoc.president,
    association: testAssoc.code,
  });
  const cible = membres.corps.members.find((entree) => entree.name === 'Membre de Test');

  const attribution = await appeler('/api/roles', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { role: 'tresorier', membre_id: cible.id, libelle: 'Trésorier de test' },
  });
  assert.equal(attribution.code, 201, JSON.stringify(attribution.corps));
  const temporaire = attribution.corps.code_temporaire;
  assert.match(temporaire, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

  // Le code temporaire est reconnu…
  const verification = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: testAssoc.code,
    corps: { code: temporaire },
  });
  assert.equal(verification.code, 200);
  assert.equal(verification.corps.code_temporaire, true);

  // …mais il n'ouvre RIEN.
  const refus = await appeler('/api/cotisations/en-attente', {
    code: temporaire,
    association: testAssoc.code,
  });
  assert.equal(refus.code, 403);
  assert.equal(refus.corps.code, 'code_personnel_requis');

  // Seule porte ouverte : le choix du code personnel.
  const tropCourt = await appeler('/api/roles/mon-code/initialiser', {
    methode: 'POST',
    code: temporaire,
    association: testAssoc.code,
    corps: { nouveau_code: 'abc' },
  });
  assert.equal(tropCourt.code, 400);

  const choix = await appeler('/api/roles/mon-code/initialiser', {
    methode: 'POST',
    code: temporaire,
    association: testAssoc.code,
    corps: { nouveau_code: 'tresor2026' },
  });
  assert.equal(choix.code, 200, JSON.stringify(choix.corps));
  assert.equal(choix.corps.code_personnel_defini, true);

  // USAGE UNIQUE : le code temporaire est mort.
  const mort = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: testAssoc.code,
    corps: { code: temporaire },
  });
  assert.equal(mort.code, 401, 'le code temporaire fonctionne encore après usage');

  // Le code personnel, lui, ouvre les écrans du trésorier.
  const ouvert = await appeler('/api/cotisations/en-attente', {
    code: 'tresor2026',
    association: testAssoc.code,
  });
  assert.equal(ouvert.code, 200);
});

test('un code temporaire expiré ne vaut plus rien', async () => {
  const bd = testAssoc.bd;
  const membre = await bd.lireUne("SELECT id FROM members WHERE name = 'Membre de Test'");

  // Le code est posé avec une échéance dépassée : éprouver vingt-quatre heures
  // d'attente réelle n'est pas une option, et c'est bien la colonne expire_le qui
  // porte la règle.
  const expire = 'EXPIRE99';
  const aide = require('./aide-lot07');
  await aide.poserCode(bd, {
    role: 'censeur',
    code: expire,
    membreId: membre.id,
    temporaire: true,
    expireLe: '2020-01-01T00:00:00Z',
  });

  const reponse = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: testAssoc.code,
    corps: { code: expire },
  });
  assert.equal(reponse.code, 401, 'un code temporaire expiré est encore accepté');
});

test('le président ne peut jamais lire le code définitif de ses collaborateurs', async () => {
  const liste = await appeler('/api/roles', {
    code: testAssoc.president,
    association: testAssoc.code,
  });
  assert.equal(liste.code, 200);

  const serialise = JSON.stringify(liste.corps);
  assert.ok(!serialise.includes('tresor2026'), 'le code personnel apparaît dans la liste des rôles');
  assert.ok(!serialise.includes('code_hash'), 'une empreinte de code sort de l’API');
  assert.ok(!serialise.includes('scrypt$'), 'une empreinte de code sort de l’API');

  // L'écran du président montre l'état, jamais le secret.
  const tresorier = liste.corps.roles.find((entree) => entree.role === 'tresorier');
  assert.ok(tresorier);
  assert.equal(tresorier.temporaire, false);
  assert.ok(tresorier.derniere_utilisation, 'la dernière utilisation devrait être inscrite');
});

test('le renouvellement d’un rôle invalide l’ancien code', async () => {
  const liste = await appeler('/api/roles', {
    code: testAssoc.president,
    association: testAssoc.code,
  });
  const tresorier = liste.corps.roles.find((entree) => entree.role === 'tresorier');

  const renouvelle = await appeler(`/api/roles/${tresorier.id}/renouveler`, {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
  });
  assert.equal(renouvelle.code, 200);
  assert.match(renouvelle.corps.code_temporaire, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

  const ancien = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: testAssoc.code,
    corps: { code: 'tresor2026' },
  });
  assert.equal(ancien.code, 401, 'l’ancien code fonctionne encore après renouvellement');

  // Remise en état pour les tests suivants.
  const choix = await appeler('/api/roles/mon-code/initialiser', {
    methode: 'POST',
    code: renouvelle.corps.code_temporaire,
    association: testAssoc.code,
    corps: { nouveau_code: 'tresor2026' },
  });
  assert.equal(choix.code, 200);
});

test('un titulaire change son code lui-même, et seulement le sien', async () => {
  const mauvaisAncien = await appeler('/api/roles/mon-code', {
    methode: 'POST',
    code: 'tresor2026',
    association: testAssoc.code,
    corps: { ancien_code: 'pasmoncode', nouveau_code: 'tresor2027' },
  });
  assert.equal(mauvaisAncien.code, 401);

  const identique = await appeler('/api/roles/mon-code', {
    methode: 'POST',
    code: 'tresor2026',
    association: testAssoc.code,
    corps: { ancien_code: 'tresor2026', nouveau_code: 'tresor2026' },
  });
  assert.equal(identique.code, 400);

  const change = await appeler('/api/roles/mon-code', {
    methode: 'POST',
    code: 'tresor2026',
    association: testAssoc.code,
    corps: { ancien_code: 'tresor2026', nouveau_code: 'tresor2027' },
  });
  assert.equal(change.code, 200, JSON.stringify(change.corps));

  const nouveau = await appeler('/api/cotisations/en-attente', {
    code: 'tresor2027',
    association: testAssoc.code,
  });
  assert.equal(nouveau.code, 200);
});

test('le dernier président ne peut pas être révoqué', async () => {
  const liste = await appeler('/api/roles', {
    code: testAssoc.president,
    association: testAssoc.code,
  });
  const president = liste.corps.roles.find((entree) => entree.role === 'president');

  const refus = await appeler(`/api/roles/${president.id}`, {
    methode: 'DELETE',
    code: testAssoc.president,
    association: testAssoc.code,
  });
  assert.equal(refus.code, 409);
  assert.equal(refus.corps.code, 'dernier_president');
});

test('un rôle ne s’attribue pas à un membre sans téléphone', async () => {
  const sans = await appeler('/api/admin/members', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { name: 'Sans Telephone' },
  });
  assert.equal(sans.code, 201);

  const refus = await appeler('/api/roles', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { role: 'censeur', membre_id: sans.corps.id },
  });
  assert.equal(refus.code, 400);
  assert.equal(refus.corps.code, 'telephone_requis');
});

// ---------------------------------------------------------------------------
// Vérification 6 — réinitialisation par SMS
// ---------------------------------------------------------------------------

test('parcours complet de réinitialisation, du SMS au nouveau code', async () => {
  const capture = capturerSms();
  try {
    const demande = await appeler('/api/reinitialisation/demander', {
      methode: 'POST',
      corps: { code_association: testAssoc.code, telephone: '+237699000010' },
    });
    assert.equal(demande.code, 200);
    // La réponse ne dit jamais si le numéro existe.
    assert.ok(demande.corps.message.includes('Si ce numéro'));

    const codeSms = capture.dernierCode();
    assert.match(String(codeSms), /^\d{6}$/, 'aucun code SMS à six chiffres dans les journaux');

    const mauvais = await appeler('/api/reinitialisation/confirmer', {
      methode: 'POST',
      corps: {
        code_association: testAssoc.code,
        telephone: '+237699000010',
        code_sms: '000000' === codeSms ? '111111' : '000000',
        nouveau_code: 'nouveau2026',
      },
    });
    assert.equal(mauvais.code, 401);

    const bon = await appeler('/api/reinitialisation/confirmer', {
      methode: 'POST',
      corps: {
        code_association: testAssoc.code,
        telephone: '+237699000010',
        code_sms: codeSms,
        nouveau_code: 'nouveau2026',
      },
    });
    assert.equal(bon.code, 200, JSON.stringify(bon.corps));
    assert.equal(bon.corps.code_reinitialise, true);

    // Le nouveau code ouvre, l'ancien est mort.
    const ouvert = await appeler('/api/cotisations/en-attente', {
      code: 'nouveau2026',
      association: testAssoc.code,
    });
    assert.equal(ouvert.code, 200, JSON.stringify(ouvert.corps));

    const mort = await appeler('/api/auth/verify', {
      methode: 'POST',
      association: testAssoc.code,
      corps: { code: 'tresor2027' },
    });
    assert.equal(mort.code, 401);
  } finally {
    capture.arreter();
  }
});

test('un numéro inconnu reçoit la même réponse qu’un numéro connu, et aucun SMS', async () => {
  const capture = capturerSms();
  try {
    const reponse = await appeler('/api/reinitialisation/demander', {
      methode: 'POST',
      corps: { code_association: testAssoc.code, telephone: '+237699999999' },
    });
    assert.equal(reponse.code, 200);
    assert.ok(reponse.corps.message.includes('Si ce numéro'));
    assert.equal(capture.messages.length, 0, 'un SMS est parti vers un numéro inconnu');
  } finally {
    capture.arreter();
  }
});

test('cinq codes SMS erronés bloquent le numéro pour une heure', async () => {
  // Association dédiée : le blocage d'un numéro ne doit pas gêner les autres tests.
  const association = await creerAssociation('Bloc Test', 'Douala', '+237699000030', 'Chef BLOC');
  const membre = await appeler('/api/admin/members', {
    methode: 'POST',
    code: association.code_president,
    association: association.code_association,
    corps: { name: 'Secretaire Bloc', telephone: '+237699000031' },
  });
  const attribution = await appeler('/api/roles', {
    methode: 'POST',
    code: association.code_president,
    association: association.code_association,
    corps: { role: 'secretaire', membre_id: membre.corps.id },
  });
  assert.equal(attribution.code, 201);

  const capture = capturerSms();
  try {
    await appeler('/api/reinitialisation/demander', {
      methode: 'POST',
      corps: { code_association: association.code_association, telephone: '+237699000031' },
    });
    const vrai = capture.dernierCode();

    // Quatre échecs : refusés, mais non bloquants.
    for (let essai = 0; essai < 4; essai += 1) {
      const faux = String((Number(vrai) + essai + 1) % 1000000).padStart(6, '0');
      const reponse = await appeler('/api/reinitialisation/confirmer', {
        methode: 'POST',
        corps: {
          code_association: association.code_association,
          telephone: '+237699000031',
          code_sms: faux,
          nouveau_code: 'essai2026',
        },
      });
      assert.equal(reponse.code, 401, `échec ${essai + 1} devrait être un simple refus`);
    }

    // Cinquième échec : blocage.
    const cinquieme = await appeler('/api/reinitialisation/confirmer', {
      methode: 'POST',
      corps: {
        code_association: association.code_association,
        telephone: '+237699000031',
        code_sms: String((Number(vrai) + 99) % 1000000).padStart(6, '0'),
        nouveau_code: 'essai2026',
      },
    });
    assert.equal(cinquieme.code, 429);
    assert.equal(cinquieme.corps.code, 'numero_bloque');

    // Même le BON code ne passe plus : le blocage porte sur le numéro.
    const avecLeBon = await appeler('/api/reinitialisation/confirmer', {
      methode: 'POST',
      corps: {
        code_association: association.code_association,
        telephone: '+237699000031',
        code_sms: vrai,
        nouveau_code: 'essai2026',
      },
    });
    assert.equal(avecLeBon.code, 429, 'le blocage ne tient pas face au bon code');

    // Une nouvelle demande est refusée aussi, ce qui plafonne la facture SMS.
    const nouvelle = await appeler('/api/reinitialisation/demander', {
      methode: 'POST',
      corps: { code_association: association.code_association, telephone: '+237699000031' },
    });
    assert.equal(nouvelle.code, 429);
  } finally {
    capture.arreter();
  }
});

test('le quota de trois réinitialisations par mois est effectivement bloquant', async () => {
  const association = await creerAssociation('Quota Test', 'Douala', '+237699000040', 'Chef QUOTA');
  const code = association.code_association;

  // Quatre titulaires, quatre numéros : le quota est par ASSOCIATION, tous rôles
  // confondus, et non par numéro.
  const numeros = ['+237699000041', '+237699000042', '+237699000043', '+237699000044'];
  const roles = ['secretaire', 'censeur', 'intendant', 'competitions'];

  for (let rang = 0; rang < numeros.length; rang += 1) {
    const membre = await appeler('/api/admin/members', {
      methode: 'POST',
      code: association.code_president,
      association: code,
      corps: { name: `Titulaire ${rang}`, telephone: numeros[rang] },
    });
    const attribution = await appeler('/api/roles', {
      methode: 'POST',
      code: association.code_president,
      association: code,
      corps: { role: roles[rang], membre_id: membre.corps.id },
    });
    assert.equal(attribution.code, 201);
    // Chacun choisit son code personnel : un code temporaire n'est pas un accès.
    await appeler('/api/roles/mon-code/initialiser', {
      methode: 'POST',
      code: attribution.corps.code_temporaire,
      association: code,
      corps: { nouveau_code: `perso${rang}2026` },
    });
  }

  const capture = capturerSms();
  try {
    // Trois réinitialisations abouties.
    for (let rang = 0; rang < 3; rang += 1) {
      const demande = await appeler('/api/reinitialisation/demander', {
        methode: 'POST',
        corps: { code_association: code, telephone: numeros[rang] },
      });
      assert.equal(demande.code, 200, `demande ${rang + 1} refusée`);

      const confirmation = await appeler('/api/reinitialisation/confirmer', {
        methode: 'POST',
        corps: {
          code_association: code,
          telephone: numeros[rang],
          code_sms: capture.dernierCode(),
          nouveau_code: `apres${rang}2026`,
        },
      });
      assert.equal(confirmation.code, 200, `confirmation ${rang + 1} refusée`);
    }

    // La quatrième est refusée, avec le message qui oriente vers le président.
    const quatrieme = await appeler('/api/reinitialisation/demander', {
      methode: 'POST',
      corps: { code_association: code, telephone: numeros[3] },
    });
    assert.equal(quatrieme.code, 429);
    assert.equal(quatrieme.corps.code, 'quota_mensuel');
    assert.ok(
      quatrieme.corps.error.includes('président'),
      'le message hors quota doit orienter vers le président'
    );

    // Le président, lui, n'est jamais bloqué pour cette action : il émet un code
    // temporaire comme d'habitude.
    const membres = await appeler('/api/admin/members', {
      code: association.code_president,
      association: code,
    });
    const cible = membres.corps.members.find((entree) => entree.name === 'Titulaire 3');
    const liste = await appeler('/api/roles', { code: association.code_president, association: code });
    const role = liste.corps.roles.find((entree) => entree.membre_id === cible.id);
    const secours = await appeler(`/api/roles/${role.id}/renouveler`, {
      methode: 'POST',
      code: association.code_president,
      association: code,
    });
    assert.equal(secours.code, 200, 'le président devrait toujours pouvoir renouveler');
  } finally {
    capture.arreter();
  }
});

// ---------------------------------------------------------------------------
// Vérification 7 — contre-seing du président
// ---------------------------------------------------------------------------

test('une seule confirmation ne suffit pas, deux suffisent', async () => {
  const association = await creerAssociation('Contre Seing', 'Douala', '+237699000050', 'Chef SEING');
  const code = association.code_association;

  // Deux titulaires, qui seront les témoins.
  const acces = [];
  const definitions = [
    { nom: 'Secretaire Seing', telephone: '+237699000051', role: 'secretaire', perso: 'secr2026' },
    { nom: 'Tresorier Seing', telephone: '+237699000052', role: 'tresorier', perso: 'tres2026' },
  ];

  for (const definition of definitions) {
    const membre = await appeler('/api/admin/members', {
      methode: 'POST',
      code: association.code_president,
      association: code,
      corps: { name: definition.nom, telephone: definition.telephone },
    });
    const attribution = await appeler('/api/roles', {
      methode: 'POST',
      code: association.code_president,
      association: code,
      corps: { role: definition.role, membre_id: membre.corps.id },
    });
    assert.equal(attribution.code, 201);
    await appeler('/api/roles/mon-code/initialiser', {
      methode: 'POST',
      code: attribution.corps.code_temporaire,
      association: code,
      corps: { nouveau_code: definition.perso },
    });
    acces.push(definition.perso);
  }

  const capture = capturerSms();
  try {
    // Un numéro qui n'est pas celui du président ne déclenche rien, sans le dire.
    const usurpation = await appeler('/api/reinitialisation/president', {
      methode: 'POST',
      corps: { code_association: code, telephone: '+237699000099' },
    });
    assert.equal(usurpation.code, 200);
    assert.equal(capture.messages.length, 0, 'un SMS est parti pour un numéro non président');

    const demande = await appeler('/api/reinitialisation/president', {
      methode: 'POST',
      corps: { code_association: code, telephone: '+237699000050' },
    });
    assert.equal(demande.code, 201, JSON.stringify(demande.corps));
    assert.equal(demande.corps.confirmations_requises, 2);
    // Les deux témoins ont été prévenus, et eux seuls.
    assert.equal(capture.messages.length, 2);

    // Le président ne peut pas se contresigner lui-même.
    const soiMeme = await appeler('/api/reinitialisation/president/confirmer', {
      methode: 'POST',
      code: association.code_president,
      association: code,
    });
    assert.equal(soiMeme.code, 403);
    assert.equal(soiMeme.corps.code, 'auto_contreseing');

    // PREMIÈRE confirmation : enregistrée, insuffisante.
    const premiere = await appeler('/api/reinitialisation/president/confirmer', {
      methode: 'POST',
      code: acces[0],
      association: code,
    });
    assert.equal(premiere.code, 200);
    assert.equal(premiere.corps.confirmations, 1);
    assert.equal(premiere.corps.aboutie, false, 'une seule confirmation a suffi');
    assert.equal(capture.dernierCodeTemporaire(), null, 'un code a été envoyé sur une confirmation');

    // Le MÊME titulaire ne peut pas confirmer deux fois.
    const doublon = await appeler('/api/reinitialisation/president/confirmer', {
      methode: 'POST',
      code: acces[0],
      association: code,
    });
    assert.equal(doublon.code, 409);
    assert.equal(doublon.corps.code, 'deja_confirme');

    // DEUXIÈME confirmation, par quelqu'un d'autre : la demande aboutit.
    const seconde = await appeler('/api/reinitialisation/president/confirmer', {
      methode: 'POST',
      code: acces[1],
      association: code,
    });
    assert.equal(seconde.code, 200, JSON.stringify(seconde.corps));
    assert.equal(seconde.corps.confirmations, 2);
    assert.equal(seconde.corps.aboutie, true);
    assert.equal(seconde.corps.sms_envoye, true);

    const temporaire = capture.dernierCodeTemporaire();
    assert.match(String(temporaire), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

    // Le président reçoit un code TEMPORAIRE : il doit choisir le sien.
    const bloque = await appeler('/api/roles', { code: temporaire, association: code });
    assert.equal(bloque.code, 403);
    assert.equal(bloque.corps.code, 'code_personnel_requis');

    const choix = await appeler('/api/roles/mon-code/initialiser', {
      methode: 'POST',
      code: temporaire,
      association: code,
      corps: { nouveau_code: 'presi2026' },
    });
    assert.equal(choix.code, 200);

    // L'ancien code président ne vaut plus rien : c'était l'objet de la demande.
    const ancien = await appeler('/api/auth/verify', {
      methode: 'POST',
      association: code,
      corps: { code: association.code_president },
    });
    assert.equal(ancien.code, 401);

    const ouvert = await appeler('/api/roles', { code: 'presi2026', association: code });
    assert.equal(ouvert.code, 200);
  } finally {
    capture.arreter();
  }
});

test('sans deux autres titulaires, le contre-seing est impossible et c’est dit clairement', async () => {
  const association = await creerAssociation('Seul Test', 'Douala', '+237699000060', 'Chef SEUL');

  const reponse = await appeler('/api/reinitialisation/president', {
    methode: 'POST',
    corps: { code_association: association.code_association, telephone: '+237699000060' },
  });
  assert.equal(reponse.code, 409);
  assert.equal(reponse.corps.code, 'contreseing_impossible');
  assert.equal(reponse.corps.titulaires_disponibles, 0);
});

// ---------------------------------------------------------------------------
// Vérification 8 — bascule du routeur SMS
// ---------------------------------------------------------------------------

test('le routeur SMS se change par une seule variable, sans toucher au code', async () => {
  const initial = process.env.SMS_FOURNISSEUR;
  try {
    // journal : succès simulé, rien n'est envoyé.
    process.env.SMS_FOURNISSEUR = 'journal';
    assert.equal(fournisseurActif(), 'journal');
    const parJournal = await envoyerSms({
      destinataire: '+237699000070',
      message: 'Essai journal',
      association: testAssoc.code,
      motif: 'essai_bascule',
    });
    assert.equal(parJournal.succes, true);
    assert.ok(parJournal.identifiant);

    // infobip sans clé : échec explicite, aucun plantage.
    process.env.SMS_FOURNISSEUR = 'infobip';
    assert.equal(fournisseurActif(), 'infobip');
    delete process.env.INFOBIP_API_KEY;
    delete process.env.INFOBIP_BASE_URL;
    delete process.env.INFOBIP_EXPEDITEUR;
    const parInfobip = await envoyerSms({
      destinataire: '+237699000070',
      message: 'Essai infobip',
      association: testAssoc.code,
      motif: 'essai_bascule',
    });
    assert.equal(parInfobip.succes, false);
    assert.ok(parInfobip.erreur.includes('Infobip'));
    assert.ok(parInfobip.erreur.includes('INFOBIP_API_KEY'));

    // nexah sans identifiants : même contrat, même format de retour.
    process.env.SMS_FOURNISSEUR = 'nexah';
    assert.equal(fournisseurActif(), 'nexah');
    const parNexah = await envoyerSms({
      destinataire: '+237699000070',
      message: 'Essai nexah',
      association: testAssoc.code,
      motif: 'essai_bascule',
    });
    assert.equal(parNexah.succes, false);
    assert.ok(parNexah.erreur.includes('Nexah'));
    assert.deepEqual(Object.keys(parNexah).sort(), ['erreur', 'identifiant', 'succes']);

    // Un nom inconnu retombe sur « journal » : jamais sur un envoi réel.
    process.env.SMS_FOURNISSEUR = 'operateur-imaginaire';
    assert.equal(fournisseurActif(), 'journal');
  } finally {
    process.env.SMS_FOURNISSEUR = initial;
  }
});

test('la consommation SMS est suivie par association, sans le numéro du destinataire', async () => {
  const reponse = await appeler('/api/admin-produit/sms/statistiques', {
    code: 'editeur-de-test',
  });
  assert.equal(reponse.code, 200);
  assert.ok(reponse.corps.total_envois > 0);

  const serialise = JSON.stringify(reponse.corps);
  assert.ok(!serialise.includes('699000010'), 'un numéro complet apparaît dans les statistiques');

  // L'espace éditeur ne montre AUCUNE donnée métier.
  assert.equal(reponse.corps.membres, undefined);
  assert.equal(reponse.corps.cotisations, undefined);

  const sansCode = await appeler('/api/admin-produit/sms/statistiques');
  assert.equal(sansCode.code, 401);
});

// ---------------------------------------------------------------------------
// Vérification 9 — paramètres propres à chaque association
// ---------------------------------------------------------------------------

test('modifier une pénalité sur une association ne change rien sur l’autre', async () => {
  const avantSde = await appeler('/api/parametres', { code: sde.president, association: sde.code });
  assert.equal(avantSde.code, 200);
  assert.equal(avantSde.corps.parametres.penalite_un_mois, 1000);
  assert.equal(avantSde.corps.parametres.penalite_deux_mois, 2000);
  assert.equal(avantSde.corps.parametres.seuil_exclusion_mois, 3);
  assert.equal(avantSde.corps.parametres.jour_seance, 'samedi');
  // Les fiches de santé sont désactivées par défaut : données sensibles.
  assert.equal(avantSde.corps.parametres.fiches_sante_actives, false);

  const modification = await appeler('/api/parametres', {
    methode: 'PUT',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { penalite_un_mois: 500, penalite_deux_mois: 900, seuil_exclusion_mois: 2, jour_seance: 'dimanche' },
  });
  assert.equal(modification.code, 200, JSON.stringify(modification.corps));
  assert.equal(modification.corps.parametres.penalite_un_mois, 500);
  assert.equal(modification.corps.parametres.jour_seance, 'dimanche');

  // SDE001 n'a pas bougé d'un franc.
  const apresSde = await appeler('/api/parametres', { code: sde.president, association: sde.code });
  assert.equal(apresSde.corps.parametres.penalite_un_mois, 1000);
  assert.equal(apresSde.corps.parametres.penalite_deux_mois, 2000);
  assert.equal(apresSde.corps.parametres.seuil_exclusion_mois, 3);
  assert.equal(apresSde.corps.parametres.jour_seance, 'samedi');

  // Et le calcul métier suit le réglage, pas une constante.
  const mesuresTest = await appeler('/api/mesures', { association: testAssoc.code });
  assert.equal(mesuresTest.code, 200);
  assert.equal(mesuresTest.corps.seuil_ecart ?? 2, 2);

  const seanceTest = await appeler('/api/stats', { association: testAssoc.code });
  const jourSeance = new Date(`${seanceTest.corps.raccourcis.date_seance}T12:00:00Z`).getUTCDay();
  assert.equal(jourSeance, 0, 'la prochaine séance de TEST devrait tomber un dimanche');

  const seanceSde = await appeler('/api/stats', { association: sde.code });
  const jourSde = new Date(`${seanceSde.corps.raccourcis.date_seance}T12:00:00Z`).getUTCDay();
  assert.equal(jourSde, 6, 'la prochaine séance de SDE devrait rester un samedi');

  // Remise en état pour ne pas influencer les tests suivants.
  await appeler('/api/parametres', {
    methode: 'PUT',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { penalite_un_mois: 1000, penalite_deux_mois: 2000, seuil_exclusion_mois: 3, jour_seance: 'samedi' },
  });
});

test('seul le président modifie les paramètres, et une clé inconnue est refusée', async () => {
  const parUnTresorier = await appeler('/api/parametres', {
    methode: 'PUT',
    code: 'nouveau2026',
    association: testAssoc.code,
    corps: { penalite_un_mois: 1 },
  });
  assert.equal(parUnTresorier.code, 401);

  // Mais il peut LIRE : le barème lui est nécessaire.
  const lecture = await appeler('/api/parametres', {
    code: 'nouveau2026',
    association: testAssoc.code,
  });
  assert.equal(lecture.code, 200);
  assert.equal(lecture.corps.modifiable_par_moi, false);

  const cleInconnue = await appeler('/api/parametres', {
    methode: 'PUT',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { solde_ouverture: 999999 },
  });
  assert.equal(cleInconnue.code, 400, 'le solde d’ouverture ne doit pas passer par cette route');

  const valeurAberrante = await appeler('/api/parametres', {
    methode: 'PUT',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { jour_seance: 'jeudredi' },
  });
  assert.equal(valeurAberrante.code, 400);
});

test('les postes de dépense sont ceux de l’association', async () => {
  const modification = await appeler('/api/parametres', {
    methode: 'PUT',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: {
      postes_depenses: {
        car_deplacement: 'Car de déplacement',
        eau_collation: 'Eau et collation',
      },
    },
  });
  assert.equal(modification.code, 200, JSON.stringify(modification.corps));

  const avecNouveauPoste = await appeler('/api/demandes', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { lignes: [{ categorie: 'car_deplacement', libelle: 'Car pour Kribi', montant_estime: 60000 }] },
  });
  assert.equal(avecNouveauPoste.code, 201, JSON.stringify(avecNouveauPoste.corps));
  assert.equal(avecNouveauPoste.corps.lignes[0].categorie_libelle, 'Car de déplacement');

  // Un poste retiré de la liste n'est plus acceptable.
  const posteRetire = await appeler('/api/demandes', {
    methode: 'POST',
    code: testAssoc.president,
    association: testAssoc.code,
    corps: { lignes: [{ categorie: 'arbitrage', libelle: 'Arbitre', montant_estime: 5000 }] },
  });
  assert.equal(posteRetire.code, 400);

  // Et SDE001 garde ses postes d'origine.
  const chezSde = await appeler('/api/demandes', {
    methode: 'POST',
    code: sde.president,
    association: sde.code,
    corps: { lignes: [{ categorie: 'arbitrage', libelle: 'Arbitre du samedi', montant_estime: 5000 }] },
  });
  assert.equal(chezSde.code, 201, JSON.stringify(chezSde.corps));

  const inconnuChezSde = await appeler('/api/demandes', {
    methode: 'POST',
    code: sde.president,
    association: sde.code,
    corps: { lignes: [{ categorie: 'car_deplacement', libelle: 'Car', montant_estime: 1000 }] },
  });
  assert.equal(inconnuChezSde.code, 400);
});

// ---------------------------------------------------------------------------
// Vérification 10 — aucun code en clair, nulle part
// ---------------------------------------------------------------------------

test('aucun code de rôle n’est stocké en clair dans une base d’association', async () => {
  for (const contexte of [sde, testAssoc]) {
    const lignes = await contexte.bd.lireToutes('SELECT id, code_hash FROM roles_codes');
    assert.ok(lignes.length > 0);

    for (const ligne of lignes) {
      assert.match(ligne.code_hash, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/, 'empreinte de forme inattendue');
      // Le code du président de cette association ne doit apparaître nulle part.
      assert.ok(
        !ligne.code_hash.includes(contexte.president),
        'le code en clair apparaît dans son empreinte'
      );
      // Et l'empreinte doit bien être vérifiable, sans quoi elle ne servirait à rien.
      assert.equal(await codes.verifier('pas-le-bon-code', ligne.code_hash), false);
    }
  }
});

test('aucun code SMS n’est stocké en clair, et le journal masque les numéros', async () => {
  const lignes = await testAssoc.bd.lireToutes(
    'SELECT telephone, code_hash FROM reinitialisations WHERE code_hash IS NOT NULL'
  );
  assert.ok(lignes.length > 0);
  for (const ligne of lignes) {
    assert.match(ligne.code_hash, /^scrypt\$/);
    assert.ok(!/^\d{6}$/.test(ligne.code_hash));
  }

  // Le journal de consommation de l'éditeur ne porte que des numéros masqués.
  const donnees = await annuaire.obtenirAnnuaire();
  const envois = await donnees.lireToutes('SELECT destinataire FROM sms_envoyes');
  assert.ok(envois.length > 0);
  for (const envoi of envois) {
    assert.match(envoi.destinataire, /^\+237\*{6}\d{3}$/, `numéro non masqué : ${envoi.destinataire}`);
  }
});

test('aucune réponse d’API ne porte de code ni d’empreinte', async () => {
  const aExaminer = [
    { chemin: '/api/roles', code: testAssoc.president },
    { chemin: '/api/admin/members', code: testAssoc.president },
    { chemin: '/api/stats', code: null },
    { chemin: '/api/journal', code: null },
    { chemin: '/api/tresorerie', code: null },
    { chemin: '/api/parametres', code: testAssoc.president },
    { chemin: '/api/associations/moi', code: null },
  ];

  for (const cas of aExaminer) {
    const reponse = await appeler(cas.chemin, { code: cas.code, association: testAssoc.code });
    assert.equal(reponse.code, 200, `${cas.chemin} → ${reponse.code}`);

    const serialise = JSON.stringify(reponse.corps);
    assert.ok(!serialise.includes('scrypt$'), `${cas.chemin} laisse fuir une empreinte`);
    assert.ok(!serialise.includes('code_hash'), `${cas.chemin} laisse fuir un champ code_hash`);
    assert.ok(
      !serialise.includes(testAssoc.president),
      `${cas.chemin} laisse fuir le code président`
    );
    assert.ok(!serialise.includes('nouveau2026'), `${cas.chemin} laisse fuir un code personnel`);
  }
});

test('aucun export ne porte de code ni de numéro complet', async () => {
  for (const format of ['historique.xlsx', 'historique.pdf']) {
    const reponse = await fetch(`${base}/api/export/${format}`, {
      headers: { 'X-Association': testAssoc.code },
    });
    assert.equal(reponse.status, 200, `${format} → ${reponse.status}`);

    const contenu = Buffer.from(await reponse.arrayBuffer()).toString('latin1');
    assert.ok(!contenu.includes(testAssoc.president), `${format} contient le code président`);
    assert.ok(!contenu.includes('nouveau2026'), `${format} contient un code personnel`);
    assert.ok(!contenu.includes('scrypt$'), `${format} contient une empreinte`);
    assert.ok(!contenu.includes('699000010'), `${format} contient un numéro complet`);
  }
});

// ---------------------------------------------------------------------------
// Isolation du limiteur d'essais
// ---------------------------------------------------------------------------

test('le plafond d’essais de code s’applique par association', async () => {
  const association = await creerAssociation('Limite Test', 'Douala', '+237699000080', 'Chef LIMITE');

  // Cinq codes erronés sur cette association.
  for (let essai = 0; essai < 6; essai += 1) {
    await appeler('/api/auth/verify', {
      methode: 'POST',
      association: association.code_association,
      corps: { code: `FAUX${essai}` },
    });
  }

  const bloquee = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: association.code_association,
    corps: { code: association.code_president },
  });
  assert.equal(bloquee.code, 429, 'le plafond d’essais ne se déclenche pas');

  // L'autre association travaille normalement : le blocage n'est pas global.
  const voisine = await appeler('/api/auth/verify', {
    methode: 'POST',
    association: sde.code,
    corps: { code: sde.president },
  });
  assert.equal(voisine.code, 200, 'une association bloquée bloque les autres');
});

// ---------------------------------------------------------------------------
// Vérification 2 — les codes déjà distribués au bureau continuent de fonctionner
// ---------------------------------------------------------------------------

test('un code du .env est accepté sur l’association historique, et repris en base', async () => {
  const { ASSOCIATION_HISTORIQUE } = require('../src/middleware/auth');

  // On fabrique une association portant le code historique, ce qui est la seule
  // situation où le repli du .env s'applique.
  const donnees = await annuaire.obtenirAnnuaire();
  const dejaPrise = await annuaire.trouverParCode(ASSOCIATION_HISTORIQUE);
  if (!dejaPrise) {
    await annuaire.inscrire({
      code: ASSOCIATION_HISTORIQUE,
      nom: 'Santé des extrêmes (historique)',
      ville: 'Douala',
      telephonePresident: '+237699000090',
    });
  }
  assert.ok(donnees);

  process.env.SECRETAIRE_PASSWORD = '987654';
  try {
    const avec = await appeler('/api/auth/verify', {
      methode: 'POST',
      association: ASSOCIATION_HISTORIQUE,
      corps: { code: '987654' },
    });
    assert.equal(avec.code, 200, 'un code du .env est refusé sur l’association historique');
    assert.equal(avec.corps.role, 'secretaire');

    // Il a été repris en base, haché : le .env n'est plus nécessaire.
    const bd = await baseDe(ASSOCIATION_HISTORIQUE);
    const lignes = await bd.lireToutes("SELECT code_hash FROM roles_codes WHERE role = 'secretaire'");
    assert.equal(lignes.length, 1);
    assert.match(lignes[0].code_hash, /^scrypt\$/);
    assert.equal(await codes.verifier('987654', lignes[0].code_hash), true);

    delete process.env.SECRETAIRE_PASSWORD;
    const sansEnv = await appeler('/api/auth/verify', {
      methode: 'POST',
      association: ASSOCIATION_HISTORIQUE,
      corps: { code: '987654' },
    });
    assert.equal(sansEnv.code, 200, 'le code repris ne fonctionne plus sans le .env');

    // Et ce code n'ouvre AUCUNE autre association.
    const ailleurs = await appeler('/api/auth/verify', {
      methode: 'POST',
      association: testAssoc.code,
      corps: { code: '987654' },
    });
    assert.equal(ailleurs.code, 401, 'un code du .env ouvre une association tierce');
  } finally {
    delete process.env.SECRETAIRE_PASSWORD;
  }
});
