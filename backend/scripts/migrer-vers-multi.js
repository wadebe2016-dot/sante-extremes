#!/usr/bin/env node
/**
 * Reprise de la base historique vers le multi-associations — LOT 7 « DeuxZero ».
 *
 *   node scripts/migrer-vers-multi.js            reprise complète
 *   node scripts/migrer-vers-multi.js --verifier  contrôle seul, aucune écriture
 *   node scripts/migrer-vers-multi.js --garder-env  ne pas retirer les codes du .env
 *
 * CE QUE FAIT CE SCRIPT, DANS CET ORDRE :
 *
 *   1. crée data/annuaire.db si elle manque ;
 *   2. inscrit SDE001 « Santé des extrêmes », Douala, téléphone du président ;
 *   3. COPIE data/sde.db vers data/associations/SDE001.db — une copie, pas un
 *      déplacement : l'original reste en place, intact, comme sauvegarde ;
 *   4. applique le schéma du LOT 7 sur la copie ;
 *   5. reprend les codes de rôle du .env dans roles_codes, hachés, avec leur rôle
 *      et leur titulaire, puis les retire du .env ;
 *   6. COMPTE ET AFFICHE, avant et après : membres, cotisations, total encaissé,
 *      total des impayés. Les quatre chiffres doivent être STRICTEMENT identiques.
 *
 * IDEMPOTENT : rejouable sans danger et sans rien dupliquer. Chaque étape vérifie
 * d'abord ce qui est déjà fait. Une deuxième exécution ne recopie pas la base —
 * ce qui écraserait les écritures faites depuis la première.
 *
 * SI LES CHIFFRES DIFFÈRENT, le script sort en erreur et le dit en clair. Vingt et
 * un mois de cotisations de trente-neuf personnes ne se reconstituent pas : mieux
 * vaut un déploiement interrompu qu'une base à moitié reprise.
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const annuaire = require('../src/bd/annuaire');
const { ouvrir } = require('../src/bd/connexion');
const { migrer } = require('../src/bd/migration');
const codes = require('../src/services/codes');
const { construireSituation } = require('../src/services/arrieres');
const parametres = require('../src/services/parametres');

const CODE_SDE = String(process.env.ASSOCIATION_HISTORIQUE || 'SDE001').toUpperCase();
const NOM_SDE = 'Santé des extrêmes';
const VILLE_SDE = 'Douala';

const DOSSIER_DONNEES = process.env.DATA_DIR || './data';
const CHEMIN_ORIGINE = process.env.DB_PATH || path.join(DOSSIER_DONNEES, 'sde.db');
const CHEMIN_CIBLE = path.join(DOSSIER_DONNEES, 'associations', `${CODE_SDE}.db`);
// ENV_PATH n'existe que pour éprouver le nettoyage du .env sur un bac à sable :
// écrire dans le vrai fichier de configuration pendant une recette serait une
// façon originale de couper l'accès au bureau.
const CHEMIN_ENV = process.env.ENV_PATH || path.join(__dirname, '..', '.env');

/**
 * Codes du .env à reprendre en base, par rôle.
 *
 * TRESORIERS est traité à part : il porte plusieurs codes nominatifs, sous la
 * forme « Nom du membre:code,Autre nom:code ».
 */
const CODES_PAR_ROLE = Object.freeze({
  president: 'ADMIN_PASSWORD',
  tresorier: 'TRESORIER_PASSWORD',
  secretaire: 'SECRETAIRE_PASSWORD',
  censeur: 'CENSEUR_PASSWORD',
  intendant: 'INTENDANT_PASSWORD',
  competitions: 'COMPETITIONS_PASSWORD',
});

const options = {
  verifierSeulement: process.argv.includes('--verifier'),
  garderEnv: process.argv.includes('--garder-env'),
};

/** Affichage aligné d'un chiffre de contrôle. */
function ligneChiffre(etiquette, valeur) {
  return `  ${etiquette.padEnd(24, '.')} ${String(valeur).padStart(12)}`;
}

/**
 * Les quatre chiffres de contrôle d'une base.
 *
 * Ce sont ceux que le bureau connaît par cœur, et le seul moyen d'affirmer qu'une
 * reprise n'a rien perdu. Le total des impayés passe par le MÊME calcul que
 * l'application (src/services/arrieres.js) : recompter autrement prouverait que
 * deux calculs concordent, pas que les données sont intactes.
 *
 * @param {object} bd connexion à mesurer
 * @returns {Promise<{membres: number, cotisations: number, encaisse: number, impayes: number}>}
 */
async function chiffres(bd) {
  const membres = await bd.lireUne('SELECT COUNT(*) AS nombre FROM members');
  const cotisations = await bd.lireUne(
    "SELECT COUNT(*) AS nombre, COALESCE(SUM(montant), 0) AS total FROM cotisations WHERE statut = 'validee'"
  );

  await parametres.charger(bd);
  const moisCourant = new Date().toISOString().slice(0, 7);
  const situation = await construireSituation(bd, moisCourant);
  const impayes = situation
    .filter((membre) => membre.statut === 'actif')
    .reduce((somme, membre) => somme + membre.montant_du, 0);

  return {
    membres: Number(membres ? membres.nombre : 0),
    cotisations: Number(cotisations ? cotisations.nombre : 0),
    encaisse: Math.round(Number(cotisations ? cotisations.total : 0)),
    impayes: Math.round(impayes),
  };
}

/** Affiche un jeu de chiffres sous un titre. */
function afficherChiffres(titre, mesure) {
  console.log(`\n${titre}`);
  console.log(ligneChiffre('membres', mesure.membres));
  console.log(ligneChiffre('cotisations validées', mesure.cotisations));
  console.log(ligneChiffre('total encaissé (XAF)', mesure.encaisse));
  console.log(ligneChiffre('total impayés (XAF)', mesure.impayes));
}

/**
 * Inscrit SDE001 dans l'annuaire, si elle n'y est pas déjà.
 *
 * Le téléphone du président vient de la configuration (PRESIDENT_TELEPHONE, à
 * défaut ADMIN_TELEPHONE). Il n'est pas décoratif : c'est lui qui autorise la
 * réinitialisation à contre-seing du code président. Sans lui, la reprise se fait
 * quand même, avec un numéro de remplacement et un avertissement — mais le
 * président devra le corriger avant de pouvoir se dépanner un jour.
 *
 * @returns {Promise<{association: object, creee: boolean}>}
 */
async function inscrireAssociation() {
  const existante = await annuaire.trouverParCode(CODE_SDE);
  if (existante) {
    console.log(`[reprise] ${CODE_SDE} déjà inscrite à l'annuaire : rien à faire`);
    return { association: existante, creee: false };
  }

  const brut = process.env.PRESIDENT_TELEPHONE || process.env.ADMIN_TELEPHONE || '';
  const telephone = codes.normaliserTelephone(brut);

  if (!telephone) {
    console.warn(
      '[reprise] ATTENTION : PRESIDENT_TELEPHONE absent ou invalide dans la configuration.\n' +
        "           Un numéro de remplacement est inscrit. La réinitialisation du code\n" +
        '           président restera IMPOSSIBLE tant qu\'il ne sera pas corrigé\n' +
        '           (UPDATE associations SET telephone_president = ... dans annuaire.db).'
    );
  }

  const association = await annuaire.inscrire({
    code: CODE_SDE,
    nom: NOM_SDE,
    ville: VILLE_SDE,
    telephonePresident: telephone || '+237000000000',
  });

  console.log(`[reprise] ${CODE_SDE} inscrite : « ${NOM_SDE} », ${VILLE_SDE}`);
  return { association, creee: true };
}

/**
 * Copie la base historique vers son emplacement d'association.
 *
 * Une COPIE, jamais un déplacement : data/sde.db reste sur le disque, intacte.
 * C'est la sauvegarde la moins coûteuse et la plus sûre — si quoi que ce soit
 * tourne mal, le fichier d'origine est encore là, tel qu'il était.
 *
 * Si la cible existe déjà, on ne recopie PAS : le service a pu écrire dessus
 * depuis la première exécution, et l'écraser perdrait ces écritures.
 *
 * @returns {{copiee: boolean, raison: string}}
 */
function copierBase() {
  const dossier = path.dirname(CHEMIN_CIBLE);
  if (!fs.existsSync(dossier)) fs.mkdirSync(dossier, { recursive: true });

  if (fs.existsSync(CHEMIN_CIBLE)) {
    return { copiee: false, raison: 'la base de destination existe déjà (reprise déjà faite)' };
  }

  if (!fs.existsSync(CHEMIN_ORIGINE)) {
    // Cas d'une installation neuve : il n'y a rien à reprendre, et c'est normal.
    return { copiee: false, raison: `aucune base historique à ${CHEMIN_ORIGINE}` };
  }

  fs.copyFileSync(CHEMIN_ORIGINE, CHEMIN_CIBLE);
  console.log(`[reprise] base copiée : ${CHEMIN_ORIGINE} → ${CHEMIN_CIBLE}`);
  console.log(`[reprise] l'original reste en place, intact, comme sauvegarde`);
  return { copiee: true, raison: '' };
}

/**
 * Analyse TRESORIERS : « Nom du membre:code,Autre nom:code ».
 * @returns {Array<{nom: string, code: string}>}
 */
function tresoriersDuEnv() {
  const brut = process.env.TRESORIERS || '';
  if (!brut.trim()) return [];

  return brut
    .split(',')
    .map((entree) => entree.trim())
    .filter(Boolean)
    .map((entree) => {
      const separateur = entree.lastIndexOf(':');
      if (separateur <= 0) return null;
      return { nom: entree.slice(0, separateur).trim(), code: entree.slice(separateur + 1).trim() };
    })
    .filter((tresorier) => tresorier && tresorier.nom && tresorier.code);
}

/**
 * Reprend les codes du .env dans roles_codes, hachés.
 *
 * LES CODES DÉJÀ DISTRIBUÉS AU BUREAU CONTINUENT DE FONCTIONNER À L'IDENTIQUE :
 * c'est tout l'enjeu de cette étape. Aucun membre du bureau n'a à être prévenu, à
 * changer de code, ni même à s'apercevoir de quoi que ce soit.
 *
 * Ils entrent NON TEMPORAIRES : ce sont des codes en service, pas des codes de
 * passation. Obliger le bureau à en choisir de nouveaux un lundi matin, sans
 * préavis, aurait été le moyen le plus sûr de bloquer l'association.
 *
 * @returns {Promise<{reprises: Array<string>, variables: Array<string>}>}
 */
async function reprendreCodes(bd) {
  const reprises = [];
  const variables = [];

  const dejaPresents = await bd.lireUne('SELECT COUNT(*) AS nombre FROM roles_codes WHERE actif = 1');
  const codesEnBase = Number(dejaPresents ? dejaPresents.nombre : 0);

  for (const [role, variable] of Object.entries(CODES_PAR_ROLE)) {
    const code = String(process.env[variable] || '').trim();
    if (!code) continue;

    variables.push(variable);

    // Idempotence : un code déjà repris ne l'est pas deux fois. La comparaison
    // passe par le hachage, seule façon de reconnaître un code sans le stocker.
    const actifs = await bd.lireToutes('SELECT id, code_hash FROM roles_codes WHERE role = ? AND actif = 1', [
      role,
    ]);
    let deja = false;
    for (const ligne of actifs) {
      if (await codes.verifier(code, ligne.code_hash)) deja = true;
    }
    if (deja) {
      console.log(`[reprise] code ${role} déjà en base : ignoré`);
      continue;
    }

    const empreinte = await codes.hacher(code);
    await bd.executer(
      `INSERT INTO roles_codes (role, membre_id, libelle, code_hash, temporaire, actif)
       VALUES (?, NULL, ?, ?, 0, 1)`,
      [role, `Code ${role} repris du .env`, empreinte]
    );
    reprises.push(role);
    console.log(`[reprise] code ${role} repris en base (haché)`);
  }

  for (const tresorier of tresoriersDuEnv()) {
    if (!variables.includes('TRESORIERS')) variables.push('TRESORIERS');

    // Le titulaire est rattaché à sa fiche de membre : c'est cette liaison qui
    // fait fonctionner les refus « sa propre cotisation » du LOT 3 ter.
    const membre = await bd.lireUne('SELECT id, name FROM members WHERE name = ? COLLATE NOCASE', [
      tresorier.nom,
    ]);
    if (!membre) {
      console.warn(
        `[reprise] ATTENTION : trésorier « ${tresorier.nom} » sans fiche de membre correspondante. ` +
          'Son code est repris, mais le refus « sa propre cotisation » ne pourra pas jouer.'
      );
    }

    const actifs = await bd.lireToutes(
      "SELECT id, code_hash FROM roles_codes WHERE role = 'tresorier' AND actif = 1"
    );
    let deja = false;
    for (const ligne of actifs) {
      if (await codes.verifier(tresorier.code, ligne.code_hash)) deja = true;
    }
    if (deja) {
      console.log(`[reprise] code trésorier de ${tresorier.nom} déjà en base : ignoré`);
      continue;
    }

    const empreinte = await codes.hacher(tresorier.code);
    await bd.executer(
      `INSERT INTO roles_codes (role, membre_id, libelle, code_hash, temporaire, actif)
       VALUES ('tresorier', ?, ?, ?, 0, 1)`,
      [membre ? membre.id : null, tresorier.nom, empreinte]
    );
    reprises.push(`tresorier (${tresorier.nom})`);
    console.log(`[reprise] code trésorier de ${tresorier.nom} repris en base (haché)`);
  }

  // Aucun code nulle part : l'association serait inaccessible. On le dit fort.
  const apres = await bd.lireUne('SELECT COUNT(*) AS nombre FROM roles_codes WHERE actif = 1');
  if (Number(apres ? apres.nombre : 0) === 0) {
    console.error(
      '[reprise] ATTENTION : AUCUN code de rôle en base et aucun dans le .env.\n' +
        `           ${CODE_SDE} est inaccessible. Posez un code président avant de déployer :\n` +
        '           node scripts/migrer-vers-multi.js après avoir renseigné ADMIN_PASSWORD.'
    );
  } else if (codesEnBase === 0 && reprises.length > 0) {
    console.log(`[reprise] ${reprises.length} code(s) repris : le bureau garde ses codes actuels`);
  }

  return { reprises, variables };
}

/**
 * Retire du .env les variables de code reprises en base.
 *
 * Les lignes sont SUPPRIMÉES, non commentées : un secret en commentaire reste un
 * secret sur le disque, et le seul intérêt de cette étape est qu'il n'y soit plus.
 * Les codes continuent de fonctionner — ils sont en base, hachés.
 *
 * @param {Array<string>} variables noms des variables à retirer
 * @returns {number} nombre de lignes retirées
 */
function nettoyerEnv(variables) {
  if (variables.length === 0) return 0;
  if (!fs.existsSync(CHEMIN_ENV)) {
    console.log(`[reprise] pas de fichier ${CHEMIN_ENV} : rien à nettoyer`);
    return 0;
  }

  const lignes = fs.readFileSync(CHEMIN_ENV, 'utf8').split(/\r?\n/);
  const gardees = [];
  let retirees = 0;

  for (const ligne of lignes) {
    const correspondance = /^\s*([A-Z0-9_]+)\s*=/.exec(ligne);
    if (correspondance && variables.includes(correspondance[1])) {
      retirees += 1;
      continue;
    }
    gardees.push(ligne);
  }

  if (retirees === 0) {
    console.log('[reprise] aucune variable de code à retirer du .env');
    return 0;
  }

  const entete =
    '# LOT 7 — les codes de rôle ont été repris dans la base de chaque association\n' +
    '# (table roles_codes, hachés). Ils ne sont plus lus ici. Le président les\n' +
    '# distribue depuis l\'application : écran « Rôles et accès ».\n';

  fs.writeFileSync(CHEMIN_ENV, entete + gardees.join('\n'), { mode: 0o600 });
  console.log(`[reprise] ${retirees} variable(s) de code retirée(s) du .env : ${variables.join(', ')}`);
  return retirees;
}

/** Reprise complète. */
async function executer() {
  console.log('=== Reprise vers le multi-associations — LOT 7 « DeuxZero » ===');
  console.log(`  base historique : ${CHEMIN_ORIGINE}`);
  console.log(`  base cible      : ${CHEMIN_CIBLE}`);
  console.log(`  annuaire        : ${annuaire.CHEMIN_ANNUAIRE}`);
  if (options.verifierSeulement) console.log('  MODE VÉRIFICATION : aucune écriture');

  // --- 1. Chiffres d'AVANT, lus sur la base historique -----------------------
  let avant = null;
  if (fs.existsSync(CHEMIN_ORIGINE)) {
    const origine = ouvrir(CHEMIN_ORIGINE, 'sde.db (origine)');
    try {
      avant = await chiffres(origine);
      afficherChiffres('AVANT — base historique data/sde.db', avant);
    } finally {
      await origine.fermer();
    }
  } else {
    console.log(`\nAucune base historique à ${CHEMIN_ORIGINE} : installation neuve.`);
  }

  if (options.verifierSeulement && !fs.existsSync(CHEMIN_CIBLE)) {
    console.log('\nReprise non encore faite. Relancez sans --verifier.');
    return 0;
  }

  // --- 2. Annuaire et inscription ------------------------------------------
  if (!options.verifierSeulement) {
    await annuaire.obtenirAnnuaire();
    await inscrireAssociation();

    // --- 3. Copie de la base ------------------------------------------------
    const copie = copierBase();
    if (!copie.copiee) console.log(`[reprise] copie non effectuée : ${copie.raison}`);
  }

  // --- 4. Schéma du LOT 7 sur la copie -------------------------------------
  const cible = ouvrir(CHEMIN_CIBLE, CODE_SDE);
  let apres;
  try {
    if (!options.verifierSeulement) {
      await migrer(cible);

      // --- 5. Reprise des codes du .env -------------------------------------
      const { variables } = await reprendreCodes(cible);

      // Les fiches de santé existent déjà chez SDE001 : le réglage est activé
      // pour elle, alors que les associations neuves naissent avec 0.
      await cible.executer(
        "INSERT OR REPLACE INTO parametres (cle, valeur, definit_par, date_maj)" +
          " VALUES ('fiches_sante_actives', '1', 'reprise LOT 7'," +
          " strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
      );
      parametres.invalider(cible);

      if (options.garderEnv) {
        console.log('[reprise] --garder-env : les codes restent dans le .env');
      } else {
        nettoyerEnv(variables);
      }
    }

    // --- 6. Chiffres d'APRÈS -----------------------------------------------
    apres = await chiffres(cible);
    afficherChiffres(`APRÈS — base de ${CODE_SDE}`, apres);

    const roles = await cible.lireToutes(
      'SELECT role, COUNT(*) AS nombre FROM roles_codes WHERE actif = 1 GROUP BY role ORDER BY role'
    );
    console.log('\nCodes de rôle en base (aucun en clair) :');
    if (roles.length === 0) console.log('  aucun');
    for (const ligne of roles) console.log(ligneChiffre(ligne.role, ligne.nombre));
  } finally {
    await cible.fermer();
  }

  // --- 7. Verdict ----------------------------------------------------------
  if (!avant) {
    console.log('\nAucune base historique : rien à comparer. Reprise terminée.');
    return 0;
  }

  const ecarts = Object.keys(avant).filter((cle) => avant[cle] !== apres[cle]);

  if (ecarts.length > 0) {
    console.error('\n*** ÉCART DÉTECTÉ — LA REPRISE N\'EST PAS FIDÈLE ***');
    for (const cle of ecarts) {
      console.error(`  ${cle} : ${avant[cle]} avant, ${apres[cle]} après`);
    }
    console.error(
      '\nLa base historique data/sde.db est INTACTE. Ne déployez pas : corrigez la cause,\n' +
        `supprimez ${CHEMIN_CIBLE}, et rejouez ce script.`
    );
    return 1;
  }

  console.log('\nLes quatre chiffres sont identiques : la reprise est fidèle.');
  console.log(`  ${apres.membres} membres, ${apres.cotisations} cotisations validées,`);
  console.log(`  ${apres.encaisse} XAF encaissés, ${apres.impayes} XAF d'impayés.`);
  console.log('\nReprise terminée. data/sde.db reste en place, inchangée.');
  return 0;
}

executer()
  .then(async (sortie) => {
    await annuaire.fermerAnnuaire().catch(() => {});
    process.exit(sortie);
  })
  .catch(async (erreur) => {
    console.error(`\n[reprise] INTERROMPUE : ${erreur.message}`);
    console.error(erreur.stack);
    console.error('\nAucune donnée historique n\'a été déplacée : data/sde.db est intacte.');
    await annuaire.fermerAnnuaire().catch(() => {});
    process.exit(1);
  });
