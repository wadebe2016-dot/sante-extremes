/**
 * Cycle de cotisation, arriérés et mesures — Santé des extrêmes (LOT 4).
 *
 * Un seul endroit calcule « qui doit quoi » : /api/arrieres, /api/seance,
 * /api/mesures et la feuille « Arriérés » de l'export en dépendent tous. Trois
 * versions de la même règle auraient divergé au premier ajustement, et les
 * censeurs auraient lu à l'entrée du terrain un chiffre différent de celui du
 * trésorier.
 *
 * RÈGLES DU BUREAU EXÉCUTIF
 *
 *   Fenêtre  La cotisation du mois M se verse entre le 25 de M-1 et le 5 de M
 *            inclus. Au-delà du 5, le membre est en retard.
 *   Terrain  Plus de crédit : la cotisation du mois doit être versée ET validée
 *            avant le coup d'envoi.
 *   Mesures  1 mois de retard → pénalité de 1 000 ; 2 mois → 2 000 ;
 *            3 mois ou plus → mise à l'écart proposée, sans pénalité en plus.
 *   Date     Aucune mesure n'est proposée avant le 6 octobre 2026. L'état des
 *            arriérés, lui, est disponible immédiatement.
 *
 * LE POINT DE DÉPART EST LA DATE D'ADHÉSION, JAMAIS JANVIER. Compter depuis le
 * début de l'année attribuait à un membre entré en mai quatre mois d'arriérés
 * qu'il ne devait pas — c'est le défaut que ce module corrige.
 *
 * Rien n'est appliqué ici : ce module PROPOSE. Les pénalités et les mises à
 * l'écart ne sont écrites qu'après confirmation d'un responsable, par les
 * routes POST de src/routes/mesures.js.
 */
'use strict';

const { lireToutes } = require('../db');

/**
 * Montant d'une cotisation mensuelle, en francs CFA.
 *
 * Ce n'est pas un secret mais un réglage : la variable d'environnement permet
 * de le corriger sans reprendre le code si l'assemblée en décide autrement.
 * Tant qu'elle est absente, la valeur en vigueur s'applique.
 */
const COTISATION_MENSUELLE =
  Number(process.env.COTISATION_MENSUELLE) > 0 ? Number(process.env.COTISATION_MENSUELLE) : 10000;

/** Barème des pénalités de retard, par nombre de mois dus. */
const PENALITES = Object.freeze({ 1: 1000, 2: 2000 });

/** À partir de ce nombre de mois dus, la mise à l'écart remplace la pénalité. */
const SEUIL_ECART = 3;

/** Jour d'ouverture de la fenêtre de versement, dans le mois précédent. */
const JOUR_OUVERTURE = 25;

/** Jour d'échéance, dans le mois concerné. */
const JOUR_ECHEANCE = 5;

/**
 * Date à partir de laquelle les mesures peuvent être appliquées.
 *
 * Avant elle, les listes sont calculées et consultables — le bureau veut voir
 * venir — mais les POST sont refusés en 409. C'est une décision d'assemblée :
 * elle est écrite ici, en clair, et se lit dans l'interface.
 *
 * La variable d'environnement n'existe que pour deux usages : éprouver les deux
 * côtés de l'échéance dans les tests, et déplacer la date si l'assemblée en
 * décide autrement sans reprendre le code. En production, elle n'est pas posée.
 */
const DATE_EFFET_MESURES = '2026-10-06';

/** Date d'effet réellement en vigueur (valeur d'assemblée, sauf surcharge). */
function dateEffetMesures() {
  const surcharge = String(process.env.DATE_EFFET_MESURES || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(surcharge) ? surcharge : DATE_EFFET_MESURES;
}

/** Mois en toutes lettres, index 0 = janvier. */
const MOIS_LONGS = Object.freeze([
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]);

/** Jour courant au format AAAA-MM-JJ, en temps universel. */
function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

/** Mois courant au format AAAA-MM. */
function moisCourant() {
  return aujourdhui().slice(0, 7);
}

/** Un mois est-il au format AAAA-MM et plausible ? */
function moisValide(valeur) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(valeur || ''));
}

/** Une date est-elle au format AAAA-MM-JJ et réellement existante ? */
function jourValide(valeur) {
  const brut = String(valeur || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) return false;
  const horodatage = Date.parse(`${brut}T12:00:00Z`);
  // « 2026-02-31 » passe l'expression régulière ; l'aller-retour le démasque.
  return !Number.isNaN(horodatage) && new Date(horodatage).toISOString().slice(0, 10) === brut;
}

/**
 * Décale un mois AAAA-MM de [pas] mois, en avant ou en arrière.
 * @returns {string} mois au même format
 */
function moisDecale(mois, pas) {
  const annee = Number(String(mois).slice(0, 4));
  const numero = Number(String(mois).slice(5, 7));
  const rang = annee * 12 + (numero - 1) + pas;
  const anneeCible = Math.floor(rang / 12);
  const moisCible = rang - anneeCible * 12 + 1;
  return `${String(anneeCible).padStart(4, '0')}-${String(moisCible).padStart(2, '0')}`;
}

/** Nombre de mois entre deux mois AAAA-MM ; négatif si [fin] précède [debut]. */
function ecartMois(debut, fin) {
  const rang = (mois) => Number(String(mois).slice(0, 4)) * 12 + Number(String(mois).slice(5, 7));
  return rang(fin) - rang(debut);
}

/**
 * Tous les mois de [debut] à [fin] inclus.
 *
 * Le plafond n'est pas décoratif : une date d'adhésion saisie à l'envers
 * (« 1926 » pour « 2026 ») produirait douze cents lignes dans la réponse.
 *
 * @returns {string[]} mois au format AAAA-MM, dans l'ordre chronologique
 */
function listeMois(debut, fin, plafond = 120) {
  const mois = [];
  let courant = debut;
  while (courant <= fin && mois.length < plafond) {
    mois.push(courant);
    courant = moisDecale(courant, 1);
  }
  return mois;
}

/** Mois en toutes lettres : « octobre ». Chaîne vide si le mois est illisible. */
function moisEnLettres(mois) {
  const numero = Number(String(mois || '').slice(5, 7));
  return numero >= 1 && numero <= 12 ? MOIS_LONGS[numero - 1] : '';
}

/** Mois et année en toutes lettres : « octobre 2026 ». */
function moisAnneeEnLettres(mois) {
  const lettres = moisEnLettres(mois);
  return lettres ? `${lettres} ${String(mois).slice(0, 4)}` : String(mois || '');
}

/** Jour au format JJ/MM, pour les motifs affichés : « suspendu jusqu'au 12/10 ». */
function jourCourt(valeur) {
  const brut = String(valeur || '');
  if (brut.length < 10) return brut;
  return `${brut.slice(8, 10)}/${brut.slice(5, 7)}`;
}

/**
 * État de la fenêtre de versement à une date donnée.
 *
 * Du 25 au 5, la fenêtre est ouverte et l'échéance à venir ; du 6 au 24, elle
 * est dépassée pour le mois en cours. C'est ce qui décide du bandeau de l'écran
 * État et du mois proposé par défaut à la déclaration.
 *
 * @param {string} [jour] date AAAA-MM-JJ ; aujourd'hui par défaut
 * @returns {{jour: string, ouverte: boolean, depassee: boolean,
 *            mois_concerne: string, echeance: string, mois_libelle: string}}
 */
function fenetreVersement(jour = aujourdhui()) {
  const numeroJour = Number(String(jour).slice(8, 10));
  const mois = String(jour).slice(0, 7);

  // À partir du 25, c'est déjà la cotisation du mois SUIVANT qui se verse.
  const moisConcerne = numeroJour >= JOUR_OUVERTURE ? moisDecale(mois, 1) : mois;
  const echeance = `${moisConcerne}-${String(JOUR_ECHEANCE).padStart(2, '0')}`;
  const ouverte = numeroJour >= JOUR_OUVERTURE || numeroJour <= JOUR_ECHEANCE;

  return {
    jour,
    ouverte,
    depassee: !ouverte,
    mois_concerne: moisConcerne,
    echeance,
    mois_libelle: moisEnLettres(moisConcerne),
  };
}

/**
 * Un versement est-il intervenu dans les délais pour le mois qu'il couvre ?
 *
 * Vrai entre le 25 de M-1 et le 5 de M inclus. Un versement du 28 septembre
 * pour octobre est donc dans les délais — en avance, pas en retard.
 *
 * @param {string} moisDu mois couvert, AAAA-MM
 * @param {string} dateVersement jour de la remise, AAAA-MM-JJ (ou ISO complet)
 */
function dansLesDelais(moisDu, dateVersement) {
  const jour = String(dateVersement || '').slice(0, 10);
  if (!moisValide(moisDu) || jour.length !== 10) return false;

  const ouverture = `${moisDecale(moisDu, -1)}-${String(JOUR_OUVERTURE).padStart(2, '0')}`;
  const echeance = `${moisDu}-${String(JOUR_ECHEANCE).padStart(2, '0')}`;
  // Comparaison lexicographique : le format AAAA-MM-JJ la rend chronologique.
  return jour >= ouverture && jour <= echeance;
}

/** Pénalité proposée pour un nombre de mois dus ; 0 au-delà du seuil d'écart. */
function penaliteProposee(nbMois) {
  if (nbMois >= SEUIL_ECART) return 0; // mise à l'écart, et pas de pénalité en plus
  return PENALITES[nbMois] || 0;
}

/** Les mesures sont-elles applicables à cette date ? */
function mesuresApplicables(jour = aujourdhui()) {
  return String(jour) >= dateEffetMesures();
}

/**
 * Mois d'adhésion d'un membre, au format AAAA-MM.
 *
 * Trois sources, dans cet ordre : la colonne « date_adhesion », le mois de
 * création de la fiche, puis le mois courant. La cascade évite qu'une fiche
 * ancienne sans date d'adhésion ne fasse remonter les arriérés à l'infini.
 */
function moisAdhesion(membre) {
  const adhesion = String(membre.date_adhesion || '').slice(0, 7);
  if (moisValide(adhesion)) return adhesion;

  const creation = String(membre.created_at || '').slice(0, 7);
  if (moisValide(creation)) return creation;

  return moisCourant();
}

/** Statut d'un membre, avec repli sur « actif » pour les fiches d'avant le LOT 4. */
function statutMembre(membre) {
  return membre.statut === 'ecarte' ? 'ecarte' : 'actif';
}

/**
 * Situation complète de tous les membres au regard d'un mois donné.
 *
 * Une seule lecture de la base sert les trois routes : chacune projette ensuite
 * ce dont elle a besoin. Les requêtes sont agrégées plutôt que jouées par
 * membre — l'écran Séance se recharge à chaque tirer-pour-rafraîchir, à
 * l'entrée du terrain, sur une connexion mobile.
 *
 * @param {string} mois mois de référence, AAAA-MM
 * @param {string} [jour] jour de référence pour les suspensions, AAAA-MM-JJ
 * @returns {Promise<Array<object>>} un état par membre, trié par nom
 */
async function construireSituation(mois, jour = aujourdhui()) {
  const membres = await lireToutes(
    `SELECT id, name, date_adhesion, statut, created_at
       FROM members
      ORDER BY name COLLATE NOCASE ASC`
  );

  // Cotisations validées : un mois réglé est un mois qui ne compte plus comme
  // dû. Le mois retenu est le MOIS DÛ (date_paiement), pas celui du versement.
  const reglees = await lireToutes(
    `SELECT member_id,
            substr(date_paiement, 1, 7) AS mois,
            SUM(montant) AS montant,
            MAX(COALESCE(date_versement, date_validation, date_paiement)) AS versement
       FROM cotisations
      WHERE statut = 'validee'
      GROUP BY member_id, mois`
  );

  // Déclarations encore en attente du trésorier : elles ne mettent personne à
  // jour, mais elles expliquent pourquoi un membre ne peut pas fouler le
  // terrain — « déclaration en attente » n'est pas « rien versé ».
  const enAttente = await lireToutes(
    `SELECT member_id, substr(date_paiement, 1, 7) AS mois
       FROM cotisations
      WHERE statut = 'en_attente'
      GROUP BY member_id, mois`
  );

  const sanctions = await lireToutes(
    `SELECT member_id, type, statut, montant, date_fin
       FROM sanctions
      WHERE statut = 'due'`
  );

  // Pénalités de retard déjà prononcées, par mois de cotisation : c'est elles
  // qui portent l'idempotence des mesures.
  const penalitesParMois = await lireToutes(
    `SELECT member_id, mois_concerne
       FROM sanctions
      WHERE type = 'penalite'
        AND statut <> 'annulee'
        AND mois_concerne IS NOT NULL`
  );

  const regleesParMembre = new Map();
  const versementsParMembre = new Map();
  for (const ligne of reglees) {
    if (!regleesParMembre.has(ligne.member_id)) regleesParMembre.set(ligne.member_id, new Map());
    regleesParMembre.get(ligne.member_id).set(ligne.mois, {
      montant: Number(ligne.montant) || 0,
      versement: ligne.versement || null,
    });

    // Dernier versement connu, tous mois confondus.
    const connu = versementsParMembre.get(ligne.member_id);
    if (ligne.versement && (!connu || ligne.versement > connu)) {
      versementsParMembre.set(ligne.member_id, ligne.versement);
    }
  }

  const attenteParMembre = new Map();
  for (const ligne of enAttente) {
    if (!attenteParMembre.has(ligne.member_id)) attenteParMembre.set(ligne.member_id, new Set());
    attenteParMembre.get(ligne.member_id).add(ligne.mois);
  }

  const sanctionsParMembre = new Map();
  for (const ligne of sanctions) {
    if (!sanctionsParMembre.has(ligne.member_id)) {
      sanctionsParMembre.set(ligne.member_id, { penalite_due: 0, suspendu: false, date_fin: null });
    }
    const entree = sanctionsParMembre.get(ligne.member_id);

    if (ligne.type === 'penalite') {
      entree.penalite_due += Number(ligne.montant) || 0;
      continue;
    }

    // Une suspension échue reste « due » en base : c'est la date qui fait foi.
    if (ligne.type === 'suspension' && ligne.date_fin && ligne.date_fin >= jour) {
      entree.suspendu = true;
      // Suspensions multiples : on retient le terme le plus lointain.
      if (!entree.date_fin || ligne.date_fin > entree.date_fin) entree.date_fin = ligne.date_fin;
    }
  }

  const penalisesParMembre = new Map();
  for (const ligne of penalitesParMois) {
    if (!penalisesParMembre.has(ligne.member_id)) penalisesParMembre.set(ligne.member_id, new Set());
    penalisesParMembre.get(ligne.member_id).add(ligne.mois_concerne);
  }

  return membres.map((membre) => {
    const adhesion = moisAdhesion(membre);
    const payes = regleesParMembre.get(membre.id) || new Map();
    const attentes = attenteParMembre.get(membre.id) || new Set();
    const sanction = sanctionsParMembre.get(membre.id) || {
      penalite_due: 0,
      suspendu: false,
      date_fin: null,
    };

    // Adhésion postérieure au mois demandé : le membre n'était pas encore là,
    // il ne doit rien et n'a rien à régulariser.
    const pasEncoreAdherent = ecartMois(adhesion, mois) < 0;

    // Un mois est dû s'il est postérieur ou égal au mois d'adhésion, antérieur
    // ou égal au mois demandé, et sans cotisation validée.
    const moisDus = pasEncoreAdherent
      ? []
      : listeMois(adhesion, mois).filter((candidat) => !payes.has(candidat));

    const cotisationDuMois = payes.get(mois) || null;
    const penalitesDues = Math.round(sanction.penalite_due);
    const montantDu = moisDus.length * COTISATION_MENSUELLE;

    return {
      id: membre.id,
      name: membre.name,
      statut: statutMembre(membre),
      adhesion,
      date_adhesion: membre.date_adhesion || null,
      pas_encore_adherent: pasEncoreAdherent,
      mois_dus: moisDus,
      nb_mois: moisDus.length,
      montant_du: montantDu,
      penalites_dues: penalitesDues,
      total_du: montantDu + penalitesDues,
      dernier_versement: versementsParMembre.get(membre.id)
        ? String(versementsParMembre.get(membre.id)).slice(0, 10)
        : null,
      cotisation_mois_validee: cotisationDuMois !== null,
      montant_verse_mois: cotisationDuMois ? Math.round(cotisationDuMois.montant) : 0,
      date_versement_mois: cotisationDuMois
        ? String(cotisationDuMois.versement || '').slice(0, 10) || null
        : null,
      declaration_en_attente: attentes.has(mois),
      suspendu: sanction.suspendu,
      date_fin_suspension: sanction.date_fin,
      deja_penalise: (penalisesParMembre.get(membre.id) || new Set()).has(mois),
    };
  });
}

module.exports = {
  COTISATION_MENSUELLE,
  PENALITES,
  SEUIL_ECART,
  JOUR_OUVERTURE,
  JOUR_ECHEANCE,
  DATE_EFFET_MESURES,
  dateEffetMesures,
  aujourdhui,
  moisCourant,
  moisValide,
  jourValide,
  moisDecale,
  ecartMois,
  listeMois,
  moisEnLettres,
  moisAnneeEnLettres,
  jourCourt,
  fenetreVersement,
  dansLesDelais,
  penaliteProposee,
  mesuresApplicables,
  moisAdhesion,
  statutMembre,
  construireSituation,
};
