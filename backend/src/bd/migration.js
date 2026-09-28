/**
 * Migration du schéma d'UNE base d'association — LOT 7 « DeuxZero ».
 *
 * Le contenu de ce module vient de src/db.js, où il ne pouvait s'appliquer qu'à
 * une base unique. Une seule chose a changé : chaque fonction reçoit la
 * connexion sur laquelle elle travaille. C'est ce qui permet de créer une base
 * neuve pour une association qui s'inscrit, avec le schéma complet et à jour,
 * sans que le code de migration ait à savoir où ce fichier se trouve.
 *
 * Le contrat reste celui des lots précédents : la migration est ADDITIVE et
 * REJOUABLE. Elle tourne à chaque ouverture d'une base d'association, y compris
 * sur celle de « Santé des extrêmes », qui porte vingt et un mois de données.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { colonnesDe } = require('./connexion');

const CHEMIN_SCHEMA = path.join(__dirname, '..', 'models', 'schema.sql');

/**
 * Colonnes ajoutées après la mise en service, par table.
 *
 * « CREATE TABLE IF NOT EXISTS » ne touche pas une table déjà présente : sur une
 * base de production existante, les colonnes nouvelles doivent être posées une
 * par une. Chaque entrée est purement additive et porte sa valeur par défaut,
 * de sorte que les lignes déjà écrites gardent le comportement d'avant.
 *
 * Une entrée peut porter un ordre « apres » : une requête jouée juste après
 * l'ALTER, donc une seule fois dans la vie de la base, pour donner une valeur de
 * départ aux lignes existantes.
 */
const COLONNES_AJOUTEES = {
  members: [
    // LOT 4 — mois d'entrée dans l'association, point de départ de tout calcul
    // d'arriéré. Sans elle, un membre entré en mai se voyait réclamer janvier à
    // avril : quatre mois qu'il ne devait pas.
    {
      nom: 'date_adhesion',
      definition: 'DATE',
      // Remplissage UNIQUE, au moment même de l'ajout de la colonne. La
      // première cotisation VALIDÉE d'un membre prouve qu'il était là ce
      // mois-là ; à défaut, la création de sa fiche fait foi. « substr » plutôt
      // que « strftime » : la valeur de départ ne doit dépendre d'aucune
      // tolérance de format sur les dates déjà écrites.
      apres: `UPDATE members SET date_adhesion = COALESCE(
                (SELECT substr(MIN(c.date_paiement), 1, 7) || '-01'
                   FROM cotisations c
                  WHERE c.member_id = members.id AND c.statut = 'validee'),
                substr(created_at, 1, 7) || '-01'
              )`,
    },
    // LOT 4 bis — contribution mensuelle attendue, propre à chaque membre.
    //
    // La cotisation n'a jamais été uniforme : certains membres sont à 5 000,
    // d'autres à 10 000. Le calcul appliquait 10 000 à tous et surestimait les
    // arriérés de la moitié de l'effectif.
    {
      nom: 'contribution',
      definition: 'REAL NOT NULL DEFAULT 10000',
      // Remplissage UNIQUE, au moment même de l'ajout de la colonne. Ce qu'un
      // membre verse d'habitude est la meilleure preuve de ce qu'on attend de
      // lui : on retient le montant le PLUS FRÉQUENT parmi ses cotisations
      // validées. À égalité de fréquence, le plus récemment versé l'emporte —
      // c'est l'attente en vigueur, pas celle d'il y a deux ans. Sans aucune
      // cotisation, la valeur par défaut s'applique.
      apres: `UPDATE members SET contribution = COALESCE(
                (SELECT c.montant
                   FROM cotisations c
                  WHERE c.member_id = members.id
                    AND c.statut = 'validee'
                    AND c.montant > 0
                  GROUP BY c.montant
                  ORDER BY COUNT(*) DESC, MAX(c.date_paiement) DESC
                  LIMIT 1),
                10000)`,
    },
    // LOT 4 — « mis à l'écart », jamais « radié ». Le CHECK vit dans
    // schema.sql, pour les bases neuves : SQLite ne sait pas ajouter une
    // contrainte à une table existante, et la liste fermée est tenue par
    // src/routes/admin.js, qui refuse en 400 toute autre valeur.
    { nom: 'statut', definition: "TEXT NOT NULL DEFAULT 'actif'" },
    { nom: 'date_statut', definition: 'DATETIME' },
    { nom: 'motif_statut', definition: 'TEXT' },
    // LOT 7 — téléphone du membre, indispensable à la réinitialisation par SMS.
    // Laissée vide sur l'existant : le secrétariat la renseigne au fil de l'eau,
    // et seul un membre pourvu d'un numéro peut recevoir un rôle.
    { nom: 'telephone', definition: 'TEXT' },
  ],
  cotisations: [
    // L'existant est réputé validé : ces lignes ont été saisies par le trésorier.
    { nom: 'statut', definition: "TEXT NOT NULL DEFAULT 'validee'" },
    { nom: 'motif_refus', definition: 'TEXT' },
    { nom: 'date_validation', definition: 'TEXT' },
    { nom: 'cle_s3', definition: 'TEXT' },
    // LOT 3 ter — qui a validé, refusé ou saisi cette cotisation
    { nom: 'valide_par', definition: 'TEXT' },
    // Date de versement — le jour où l'argent a réellement été remis. C'est la
    // seule date qui compte pour la caisse : « date_paiement » porte le mois dû
    // (le 5 du mois), « date_validation » le contrôle du trésorier.
    {
      nom: 'date_versement',
      definition: 'DATETIME',
      // Remplissage UNIQUE, au moment même de l'ajout de la colonne : pour une
      // ligne déjà en base, l'entrée en caisse la plus proche de la vérité est
      // sa validation, et à défaut son mois dû. La requête ne se rejoue jamais,
      // la colonne n'étant ajoutée qu'une fois.
      apres: 'UPDATE cotisations SET date_versement = COALESCE(date_validation, date_paiement)',
    },
  ],
  sanctions: [
    // LOT 3 ter — qui a encaissé la pénalité
    { nom: 'encaisse_par', definition: 'TEXT' },
    // LOT 4 — qui a prononcé la sanction. Le journal inscrivait « censeur »
    // en dur ; depuis que les pénalités de retard s'appliquent par lots
    // (POST /api/mesures/penalites), il faut le nom de celui qui a confirmé.
    { nom: 'inflige_par', definition: 'TEXT' },
    // LOT 4 — mois de cotisation à l'origine d'une pénalité de retard
    // (AAAA-MM). C'est lui qui porte l'idempotence : un membre déjà pénalisé
    // pour ce mois ne l'est pas une seconde fois.
    { nom: 'mois_concerne', definition: 'TEXT' },
  ],
  demandes: [
    // LOT 3 ter — qui a approuvé ou refusé la demande
    { nom: 'approuve_par', definition: 'TEXT' },
  ],
  decaissements: [
    // LOT 3 ter — qui a sorti l'argent de la caisse
    { nom: 'decaisse_par', definition: 'TEXT' },
  ],
  parametres: [
    // Solde d'ouverture ouvert aux trésoriers — qui a fixé ce réglage.
    { nom: 'definit_par', definition: 'TEXT' },
  ],
};

/**
 * Ajoute les colonnes manquantes aux tables déjà créées.
 *
 * SQLite ne connaît pas « ADD COLUMN IF NOT EXISTS » : on inspecte donc la table
 * avant d'écrire. Aucune colonne n'est jamais supprimée ni retypée.
 */
async function completerColonnes(bd) {
  for (const [table, colonnes] of Object.entries(COLONNES_AJOUTEES)) {
    let existantes;
    try {
      existantes = await colonnesDe(bd, table);
    } catch (erreur) {
      console.error(`[migration] lecture impossible de ${table} : ${erreur.message}`);
      throw erreur;
    }

    // Table absente : schema.sql vient de la créer avec toutes ses colonnes.
    if (existantes.length === 0) continue;

    for (const colonne of colonnes) {
      if (existantes.includes(colonne.nom)) continue;

      await bd.executer(`ALTER TABLE ${table} ADD COLUMN ${colonne.nom} ${colonne.definition}`);
      console.log(`[migration] colonne ajoutée : ${table}.${colonne.nom}`);

      // Valeur de départ des lignes déjà écrites, posée une seule fois.
      if (colonne.apres) {
        const resultat = await bd.executer(colonne.apres);
        console.log(
          `[migration] ${table}.${colonne.nom} initialisée sur ${resultat.changements} ligne(s)`
        );
      }
    }
  }
}

/**
 * Libère « demandes.categorie » de sa contrainte CHECK sur une base existante.
 *
 * SQLite ne sait pas modifier un CHECK : ajouter « eau_collation » et
 * « entretien » à la liste fermée impose de reconstruire la table. C'est la
 * seule opération non strictement additive de tout le projet, d'où les
 * précautions :
 *   - elle ne s'exécute QUE si la contrainte est encore présente ;
 *   - toutes les lignes sont recopiées, colonne par colonne, dans une
 *     transaction ;
 *   - les clés étrangères sont désactivées le temps de l'échange, sans quoi la
 *     suppression de « demandes » buterait sur « decaissements ».
 *
 * La liste fermée n'est pas perdue : elle est tenue par src/routes/demandes.js,
 * qui refuse en 400 toute catégorie inconnue.
 */
async function libererCategorieDemandes(bd) {
  const table = await bd.lireUne("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'demandes'");
  if (!table || !table.sql) return; // table absente : schema.sql la créera sans CHECK
  if (!/CHECK\s*\(\s*categorie\s+IN/i.test(table.sql)) return; // déjà libérée

  console.log('[migration] reconstruction de « demandes » pour libérer la catégorie');

  const colonnes = (await colonnesDe(bd, 'demandes')).join(', ');

  await bd.executerScript('PRAGMA foreign_keys = OFF');
  try {
    await bd.executerScript('BEGIN IMMEDIATE');
    await bd.executerScript(`
      CREATE TABLE demandes_nouveau (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        categorie            TEXT NOT NULL,
        libelle              TEXT NOT NULL,
        montant_estime       REAL NOT NULL CHECK (montant_estime > 0),
        urgence              TEXT NOT NULL DEFAULT 'normale' CHECK (urgence IN ('normale', 'urgente')),
        justificatif_cle_s3  TEXT,
        role_demandeur       TEXT NOT NULL
                               CHECK (role_demandeur IN ('intendant', 'secretaire', 'competitions', 'admin')),
        statut               TEXT NOT NULL DEFAULT 'en_attente'
                               CHECK (statut IN ('en_attente', 'approuvee', 'refusee', 'payee')),
        motif_refus          TEXT,
        approuve_par         TEXT,
        date_demande         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        date_decision        TEXT
      )
    `);
    await bd.executerScript(`INSERT INTO demandes_nouveau (${colonnes}) SELECT ${colonnes} FROM demandes`);
    await bd.executerScript('DROP TABLE demandes');
    await bd.executerScript('ALTER TABLE demandes_nouveau RENAME TO demandes');
    await bd.executerScript('COMMIT');
    console.log('[migration] « demandes » reconstruite, lignes préservées');
  } catch (erreur) {
    await bd.executerScript('ROLLBACK').catch(() => {});
    console.error(`[migration] reconstruction de « demandes » impossible : ${erreur.message}`);
    throw erreur;
  } finally {
    await bd.executerScript('PRAGMA foreign_keys = ON');
  }
}

/**
 * LOT 5 — Postes d'une demande : création de « demande_lignes », reprise des
 * demandes existantes, et bascule de « decaissements » sur la ligne.
 *
 * C'est la seule migration du LOT 5, et elle est rejouable : chaque étape
 * vérifie d'abord ce qui est déjà fait.
 *
 *   1. la table des lignes est créée si elle manque — schema.sql la créerait
 *      aussi, mais il ne passe qu'APRÈS, et la reprise en a besoin tout de
 *      suite ;
 *   2. chaque demande sans ligne en reçoit UNE, copie exacte de ses propres
 *      colonnes : catégorie, libellé, montant, statut, motif, décideur, date de
 *      décision. Le statut agrégé d'une demande à une ligne est celui de cette
 *      ligne : rien ne bouge à l'écran ;
 *   3. « decaissements.demande_id » devient « decaissements.ligne_id ». SQLite ne
 *      sait ni renommer une contrainte ni changer une clé étrangère : la table
 *      est reconstruite, lignes recopiées une à une, dans une transaction et
 *      clés étrangères désactivées le temps de l'échange. Les identifiants sont
 *      conservés — un justificatif déjà servi par /api/decaissements/:id garde
 *      son adresse.
 *
 * Sauvegarder data/sde.db avant de jouer cette migration : c'est la seule du
 * projet qui réécrive une table de mouvements.
 */
async function migrerLignesDeDemande(bd) {
  const demandes = await colonnesDe(bd, 'demandes');
  if (demandes.length === 0) return; // base neuve : schema.sql fait tout

  // 1. La table des lignes, avant toute reprise.
  await bd.executerScript(`
    CREATE TABLE IF NOT EXISTS demande_lignes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      demande_id     INTEGER NOT NULL,
      categorie      TEXT NOT NULL,
      libelle        TEXT NOT NULL,
      montant_estime REAL NOT NULL CHECK (montant_estime > 0),
      statut         TEXT NOT NULL DEFAULT 'en_attente'
                       CHECK (statut IN ('en_attente', 'approuvee', 'refusee', 'payee')),
      motif_refus    TEXT,
      approuve_par   TEXT,
      date_decision  TEXT,
      FOREIGN KEY (demande_id) REFERENCES demandes (id) ON DELETE CASCADE
    )
  `);

  // 2. Une ligne par demande qui n'en a pas encore. Le « NOT EXISTS » rend
  //    l'opération rejouable : une demande déjà reprise est laissée en place.
  const reprise = await bd.executer(
    `INSERT INTO demande_lignes
       (demande_id, categorie, libelle, montant_estime, statut, motif_refus, approuve_par, date_decision)
     SELECT d.id, d.categorie, d.libelle, d.montant_estime, d.statut,
            d.motif_refus, d.approuve_par, d.date_decision
       FROM demandes d
      WHERE NOT EXISTS (SELECT 1 FROM demande_lignes l WHERE l.demande_id = d.id)`
  );

  if (reprise.changements > 0) {
    console.log(`[migration] ${reprise.changements} demande(s) reprise(s) en une ligne`);
  }

  // 3. Bascule des décaissements sur la ligne.
  const decaissements = await colonnesDe(bd, 'decaissements');
  if (decaissements.length === 0) return; // table absente : schema.sql la créera
  if (decaissements.includes('ligne_id')) return; // déjà basculés

  const orphelins = await bd.lireUne(
    `SELECT COUNT(*) AS nombre
       FROM decaissements x
      WHERE NOT EXISTS (SELECT 1 FROM demande_lignes l WHERE l.demande_id = x.demande_id)`
  );

  // Aucun décaissement ne devrait être orphelin : sa demande est obligatoire et
  // sa suppression l'emporte en cascade. S'il en reste un, il serait perdu par
  // la reconstruction — on refuse plutôt que d'effacer une sortie de caisse.
  if (orphelins && Number(orphelins.nombre) > 0) {
    throw new Error(
      `${orphelins.nombre} décaissement(s) sans demande : reprise interrompue, base inchangée`
    );
  }

  console.log('[migration] reconstruction de « decaissements » pour la bascule sur la ligne');

  await bd.executerScript('PRAGMA foreign_keys = OFF');
  try {
    await bd.executerScript('BEGIN IMMEDIATE');
    await bd.executerScript(`
      CREATE TABLE decaissements_nouveau (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        ligne_id            INTEGER NOT NULL UNIQUE,
        montant             REAL NOT NULL CHECK (montant > 0),
        date_paiement       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        moyen               TEXT NOT NULL CHECK (moyen IN ('Mobile Money', 'Espèce')),
        paye_par            TEXT NOT NULL CHECK (paye_par IN ('caisse', 'avance_rembourse')),
        beneficiaire        TEXT,
        decaisse_par        TEXT,
        justificatif_cle_s3 TEXT,
        commentaire         TEXT,
        FOREIGN KEY (ligne_id) REFERENCES demande_lignes (id) ON DELETE CASCADE
      )
    `);
    await bd.executerScript(`
      INSERT INTO decaissements_nouveau
        (id, ligne_id, montant, date_paiement, moyen, paye_par,
         beneficiaire, decaisse_par, justificatif_cle_s3, commentaire)
      SELECT x.id,
             (SELECT l.id FROM demande_lignes l
               WHERE l.demande_id = x.demande_id ORDER BY l.id LIMIT 1),
             x.montant, x.date_paiement, x.moyen, x.paye_par,
             x.beneficiaire, x.decaisse_par, x.justificatif_cle_s3, x.commentaire
        FROM decaissements x
    `);
    await bd.executerScript('DROP TABLE decaissements');
    await bd.executerScript('ALTER TABLE decaissements_nouveau RENAME TO decaissements');
    await bd.executerScript('COMMIT');
    console.log('[migration] « decaissements » rattachés à leur ligne, identifiants préservés');
  } catch (erreur) {
    await bd.executerScript('ROLLBACK').catch(() => {});
    console.error(`[migration] bascule des décaissements impossible : ${erreur.message}`);
    throw erreur;
  } finally {
    await bd.executerScript('PRAGMA foreign_keys = ON');
  }
}


/**
 * LOT 7 — Paramètres propres à l'association.
 *
 * Tout le comportement métier était écrit en dur : la cotisation de base, le
 * barème des pénalités, le seuil de mise à l'écart, la fenêtre de versement.
 * Ces valeurs sont celles de « Santé des extrêmes » ; une autre association
 * joue le dimanche, demande 5 000 et pénalise à 500.
 *
 * Les valeurs ci-dessous REPRODUISENT EXACTEMENT le comportement d'avant le
 * LOT 7 — c'est la condition pour que la bascule de SDE001 ne change rien pour
 * ses trente-neuf membres. Deux points méritent attention :
 *
 *   · « fenetre_cotisation_debut = 25 » n'est pas une coquille. La fenêtre de
 *     versement s'ouvre le 25 du mois PRÉCÉDENT et se ferme le 5 du mois dû :
 *     c'est le fonctionnement en vigueur depuis le LOT 4, et le cahier des
 *     charges du LOT 7 annonçait « 1 » par approximation. Entre la valeur
 *     annoncée et la règle « ne rien changer pour SDE001 », c'est la seconde
 *     qui l'emporte : poser « 1 » aurait fermé la fenêtre du 6 au 31 et rendu
 *     impossible toute déclaration anticipée. Une association qui préfère le 1er
 *     le règle depuis son écran de paramètres.
 *
 *   · « fiches_sante_actives = 0 » est le seul réglage dont la valeur par
 *     défaut DIFFÈRE de l'existant : les fiches de santé portent des données
 *     médicales, et une association qui découvre le produit ne doit pas en
 *     collecter sans l'avoir décidé. SDE001 s'en voit poser 1 par le script de
 *     migration, puisqu'elle en a déjà.
 */
const PARAMETRES_PAR_DEFAUT = Object.freeze({
  jour_seance: 'samedi',
  fenetre_cotisation_debut: '25',
  fenetre_cotisation_fin: '5',
  contribution_defaut: '10000',
  penalite_un_mois: '1000',
  penalite_deux_mois: '2000',
  seuil_exclusion_mois: '3',
  devise: 'XAF',
  // Liste reprise MOT POUR MOT de src/routes/demandes.js avant le LOT 7 : les
  // clés sont écrites dans « demandes.categorie » et « demande_lignes.categorie »
  // depuis le LOT 3 bis. En changer une seule rendrait illisibles les dépenses
  // déjà enregistrées de SDE001.
  postes_depenses: JSON.stringify({
    equipement: 'Équipement',
    location_stade: 'Location de stade',
    kine_medical: 'Kiné et médical',
    transport: 'Transport',
    arbitrage: 'Arbitrage',
    competition_evenement: 'Compétition et évènement',
    eau_collation: 'Eau et collation',
    entretien: 'Entretien',
    autre: 'Autre',
  }),
  fiches_sante_actives: '0',
});

/**
 * Pose les paramètres manquants, sans jamais écraser un réglage existant.
 *
 * « INSERT OR IGNORE » porte toute l'idempotence : un président qui a ramené sa
 * pénalité à 500 ne la retrouve pas à 1 000 au redémarrage suivant.
 */
async function poserParametresParDefaut(bd) {
  let poses = 0;
  for (const [cle, valeur] of Object.entries(PARAMETRES_PAR_DEFAUT)) {
    const resultat = await bd.executer(
      "INSERT OR IGNORE INTO parametres (cle, valeur, definit_par) VALUES (?, ?, 'defaut')",
      [cle, valeur]
    );
    poses += resultat.changements;
  }
  if (poses > 0) console.log(`[migration] ${poses} paramètre(s) par défaut posé(s)`);
}

/**
 * Migration complète d'une base d'association, en trois temps.
 *
 * L'ORDRE COMPTE : les colonnes manquantes sont ajoutées AVANT l'application de
 * schema.sql. Ce dernier crée un index sur « cotisations (member_id, statut) » ;
 * sur une base antérieure, cette colonne n'existe pas encore et tout le script
 * échouerait — donc aussi les instructions censées la créer.
 *
 * Les paramètres viennent APRÈS schema.sql : la table « parametres » doit
 * exister avant qu'on y écrive.
 *
 * Sur une base neuve, aucune table n'existe : completerColonnes ne fait rien et
 * schema.sql les crée toutes d'emblée, avec leurs colonnes du LOT 7.
 *
 * @param {object} bd connexion retournée par src/bd/connexion.js
 */
async function migrer(bd) {
  let schema;
  try {
    schema = fs.readFileSync(CHEMIN_SCHEMA, 'utf8');
  } catch (erreur) {
    console.error(`[migration] schema.sql illisible : ${erreur.message}`);
    throw erreur;
  }

  try {
    await completerColonnes(bd);
    await libererCategorieDemandes(bd);
    await migrerLignesDeDemande(bd);
    await bd.executerScript(schema);
    await poserParametresParDefaut(bd);
  } catch (erreur) {
    console.error(`[migration] échec sur ${bd.etiquette} : ${erreur.message}`);
    throw erreur;
  }

  console.log(`[migration] schéma appliqué sur ${bd.etiquette}`);
}

module.exports = { migrer, PARAMETRES_PAR_DEFAUT, CHEMIN_SCHEMA };
