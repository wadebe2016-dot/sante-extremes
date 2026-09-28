/**
 * Aide aux tests — LOT 7 « DeuxZero ».
 *
 * Jusqu'au LOT 6, un test posait DB_PATH, appelait migrer() et montait les
 * routeurs : la base était un singleton, tout le monde tombait dessus. Depuis le
 * LOT 7, une base appartient à une association et arrive par « requete.db ».
 *
 * Ce module fournit le strict minimum pour que les tests des lots précédents
 * continuent de dire ce qu'ils disaient — c'est-à-dire pour que le LOT 7 se
 * prouve NON RÉGRESSIF, ce qui est le premier engagement du lot :
 *
 *   ouvrirBase()   ouvre une base temporaire et applique le schéma complet ;
 *   injecter()     middleware qui pose requete.db et requete.association ;
 *   poserCode()    inscrit un code de rôle haché, comme le ferait le président.
 *
 * L'association de test porte le code SDE001 : c'est celle pour laquelle le
 * repli historique de src/middleware/auth.js accepte encore les codes du .env,
 * et c'est exactement cette compatibilité que les tests des lots 4 à 6 éprouvent.
 */
'use strict';

const fs = require('node:fs');

const { ouvrir } = require('../src/bd/connexion');
const { migrer } = require('../src/bd/migration');
const parametres = require('../src/services/parametres');
const codes = require('../src/services/codes');

/** Association de test, volontairement identique à l'association historique. */
const ASSOCIATION = Object.freeze({
  id: 1,
  code: 'SDE001',
  nom: 'Santé des extrêmes',
  ville: 'Douala',
  telephone_president: '+237699000001',
  statut: 'active',
  fichier_db: 'associations/SDE001.db',
});

/**
 * Ouvre une base de test neuve et applique le schéma complet.
 *
 * Le fichier est supprimé d'abord : un test doit partir d'une base vide, sans
 * quoi l'ordre d'exécution changerait ses résultats. Les fichiers annexes du
 * mode WAL (-wal, -shm) sont retirés aussi — un journal WAL survivant à son
 * fichier principal fait échouer l'ouverture suivante.
 *
 * @param {string} chemin chemin du fichier SQLite
 * @returns {Promise<object>} connexion de src/bd/connexion.js, migrée
 */
async function ouvrirBase(chemin) {
  for (const suffixe of ['', '-wal', '-shm']) {
    fs.rmSync(`${chemin}${suffixe}`, { force: true });
  }

  const bd = ouvrir(chemin, 'test');
  await migrer(bd);
  await parametres.charger(bd);
  return bd;
}

/**
 * Ouvre une base de test SANS appliquer le schéma.
 *
 * Réservé aux tests de migration : ils posent eux-mêmes une base « d'avant »,
 * telle qu'elle existait avant l'évolution éprouvée, puis appellent migrer().
 * Ouvrir déjà migré leur ôterait tout objet.
 *
 * @param {string} chemin chemin du fichier SQLite
 * @returns {object} connexion de src/bd/connexion.js, non migrée
 */
function ouvrirBrute(chemin) {
  for (const suffixe of ['', '-wal', '-shm']) {
    fs.rmSync(`${chemin}${suffixe}`, { force: true });
  }
  return ouvrir(chemin, 'test-migration');
}

/**
 * Middleware de test : pose la base et l'association sur chaque requête.
 *
 * Tient la place de src/middleware/association.js, sans l'annuaire : les tests
 * n'ont pas à écrire un annuaire sur disque pour éprouver un calcul d'arriérés.
 *
 * @param {object} bd connexion à servir
 * @param {object} [association] association à annoncer
 */
function injecter(bd, association = ASSOCIATION) {
  return function poser(requete, reponse, suite) {
    requete.db = bd;
    requete.association = association;
    suite();
  };
}

/**
 * Inscrit un code de rôle, comme le ferait le président depuis son écran.
 *
 * @param {object} bd connexion de l'association
 * @param {object} role
 * @param {string} role.role rôle attribué
 * @param {string} role.code code en clair (il ne sera stocké que haché)
 * @param {number} [role.membreId] titulaire
 * @param {string} [role.libelle] nom d'usage
 * @param {boolean} [role.temporaire] code de passation à usage unique
 * @param {string} [role.expireLe] échéance d'un code temporaire
 * @returns {Promise<number>} identifiant du rôle créé
 */
async function poserCode(bd, { role, code, membreId = null, libelle = null, temporaire = false, expireLe = null }) {
  const empreinte = await codes.hacher(code);
  const resultat = await bd.executer(
    `INSERT INTO roles_codes (role, membre_id, libelle, code_hash, temporaire, expire_le, actif)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [role, membreId, libelle, empreinte, temporaire ? 1 : 0, expireLe]
  );
  return resultat.id;
}

/** Ferme une base de test et oublie ses paramètres en cache. */
async function fermerBase(bd) {
  if (!bd) return;
  parametres.invalider(bd);
  await bd.fermer();
}

module.exports = { ASSOCIATION, ouvrirBase, ouvrirBrute, injecter, poserCode, fermerBase };
