/**
 * Paramètres propres à chaque association — LOT 7 « DeuxZero ».
 *
 * Tout le comportement métier était écrit en dur : cotisation de base, barème
 * des pénalités, seuil de mise à l'écart, fenêtre de versement, jour de séance,
 * postes de dépense. Ces valeurs sont celles de « Santé des extrêmes », et elles
 * n'ont aucune raison de convenir à une association qui joue le dimanche,
 * demande 5 000 et pénalise à 500.
 *
 * Les valeurs par défaut sont posées par la migration (src/bd/migration.js) et
 * REPRODUISENT EXACTEMENT le comportement d'avant le LOT 7 : la bascule ne
 * change rien pour les trente-neuf membres de SDE001.
 *
 * Lecture SYNCHRONE côté appelant, grâce à un cache par base : les fonctions de
 * calcul d'arriérés sont appelées des centaines de fois par requête (une fois
 * par membre et par mois) et ne peuvent pas devenir asynchrones sans réécrire
 * tout le calcul. Le cache est chargé une fois par requête par le middleware
 * d'association, et invalidé à chaque écriture.
 */
'use strict';

const { PARAMETRES_PAR_DEFAUT } = require('../bd/migration');

/** Cache des paramètres, par chemin de base. */
const cache = new Map();

/**
 * Clés modifiables depuis l'application, avec leur mode de validation.
 *
 * Une clé absente de cette table est refusée en 400 : la table « parametres »
 * porte aussi le solde d'ouverture de la trésorerie (LOT 3 ter), qui a sa propre
 * route et ses propres droits. Un PUT /api/parametres ne doit pas pouvoir le
 * réécrire au passage.
 */
const CLES_MODIFIABLES = Object.freeze({
  jour_seance: { type: 'jour_semaine' },
  fenetre_cotisation_debut: { type: 'jour_mois' },
  fenetre_cotisation_fin: { type: 'jour_mois' },
  contribution_defaut: { type: 'montant', min: 100, max: 1000000 },
  penalite_un_mois: { type: 'montant', min: 0, max: 1000000 },
  penalite_deux_mois: { type: 'montant', min: 0, max: 1000000 },
  seuil_exclusion_mois: { type: 'entier', min: 1, max: 24 },
  devise: { type: 'devise' },
  postes_depenses: { type: 'postes' },
  fiches_sante_actives: { type: 'booleen' },
});

/** Jours de la semaine acceptés pour la séance, index 0 = dimanche (comme Date). */
const JOURS_SEMAINE = Object.freeze({
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
});

/**
 * Charge (ou recharge) les paramètres d'une base dans le cache.
 *
 * Les défauts servent de socle : une clé absente de la table — base restaurée
 * d'une sauvegarde antérieure, migration interrompue — ne doit pas faire
 * disparaître les pénalités.
 *
 * @param {object} bd connexion de l'association
 * @returns {Promise<object>} paramètres lus, valeurs brutes (chaînes)
 */
async function charger(bd) {
  const lignes = await bd.lireToutes('SELECT cle, valeur FROM parametres');
  const valeurs = { ...PARAMETRES_PAR_DEFAUT };
  for (const ligne of lignes) {
    if (ligne.valeur !== null && ligne.valeur !== undefined) valeurs[ligne.cle] = String(ligne.valeur);
  }
  cache.set(bd.chemin, valeurs);
  return valeurs;
}

/** Paramètres en cache pour cette base ; les défauts si rien n'est chargé. */
function lus(bd) {
  return cache.get(bd.chemin) || { ...PARAMETRES_PAR_DEFAUT };
}

/** Oublie le cache d'une base (après écriture). */
function invalider(bd) {
  cache.delete(bd.chemin);
}

/** Valeur entière d'un paramètre, avec repli sur le défaut puis sur [secours]. */
function entier(bd, cle, secours = 0) {
  const brut = Number(lus(bd)[cle]);
  if (Number.isFinite(brut)) return brut;
  const defaut = Number(PARAMETRES_PAR_DEFAUT[cle]);
  return Number.isFinite(defaut) ? defaut : secours;
}

/** Valeur textuelle d'un paramètre. */
function texte(bd, cle) {
  const valeur = lus(bd)[cle];
  return valeur === undefined || valeur === null ? String(PARAMETRES_PAR_DEFAUT[cle] || '') : String(valeur);
}

/** Valeur booléenne d'un paramètre ( « 1 » = vrai ). */
function booleen(bd, cle) {
  return texte(bd, cle) === '1';
}

/**
 * Postes de dépense de l'association : { clé: libellé }.
 *
 * Un JSON illisible — saisie manuelle en base, sauvegarde tronquée — ne doit pas
 * priver l'intendant de tout poste de dépense : on retombe sur la liste par
 * défaut, en le signalant.
 */
function postesDepenses(bd) {
  const brut = texte(bd, 'postes_depenses');
  try {
    const analyse = JSON.parse(brut);
    if (analyse && typeof analyse === 'object' && !Array.isArray(analyse) && Object.keys(analyse).length > 0) {
      return Object.freeze({ ...analyse });
    }
    console.error('[parametres] postes_depenses vide ou de forme inattendue : liste par défaut appliquée');
  } catch (erreur) {
    console.error(`[parametres] postes_depenses illisible (${erreur.message}) : liste par défaut appliquée`);
  }
  return Object.freeze(JSON.parse(PARAMETRES_PAR_DEFAUT.postes_depenses));
}

/** Index du jour de séance au sens de Date.getUTCDay ; samedi par défaut. */
function jourSeance(bd) {
  const nom = texte(bd, 'jour_seance').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(JOURS_SEMAINE, nom) ? JOURS_SEMAINE[nom] : 6;
}

/** Vue complète des paramètres, telle que servie par GET /api/parametres. */
function vue(bd) {
  const valeurs = lus(bd);
  return {
    jour_seance: texte(bd, 'jour_seance'),
    fenetre_cotisation_debut: entier(bd, 'fenetre_cotisation_debut', 25),
    fenetre_cotisation_fin: entier(bd, 'fenetre_cotisation_fin', 5),
    contribution_defaut: entier(bd, 'contribution_defaut', 10000),
    penalite_un_mois: entier(bd, 'penalite_un_mois', 1000),
    penalite_deux_mois: entier(bd, 'penalite_deux_mois', 2000),
    seuil_exclusion_mois: entier(bd, 'seuil_exclusion_mois', 3),
    devise: texte(bd, 'devise'),
    postes_depenses: postesDepenses(bd),
    fiches_sante_actives: booleen(bd, 'fiches_sante_actives'),
    // Le solde d'ouverture garde sa route dédiée : il est ici pour information.
    solde_ouverture_defini: Boolean(valeurs.solde_ouverture),
  };
}

/**
 * Valide une valeur soumise par le président.
 * @returns {{valeur: string}|{erreur: string}} valeur normalisée, ou refus en français
 */
function valider(cle, valeurBrute) {
  const regle = CLES_MODIFIABLES[cle];
  if (!regle) return { erreur: `Paramètre inconnu : ${cle}` };

  if (regle.type === 'jour_semaine') {
    const nom = String(valeurBrute || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(JOURS_SEMAINE, nom)) {
      return { erreur: `Jour de séance invalide (attendu : ${Object.keys(JOURS_SEMAINE).join(', ')})` };
    }
    return { valeur: nom };
  }

  if (regle.type === 'jour_mois') {
    const jour = Number(valeurBrute);
    if (!Number.isInteger(jour) || jour < 1 || jour > 28) {
      // Plafond à 28 : un 30 ou un 31 n'existe pas tous les mois, et une
      // fenêtre qui disparaît en février serait un piège.
      return { erreur: 'Jour du mois invalide (1 à 28)' };
    }
    return { valeur: String(jour) };
  }

  if (regle.type === 'montant' || regle.type === 'entier') {
    const nombre = Number(valeurBrute);
    if (!Number.isFinite(nombre) || nombre < regle.min || nombre > regle.max) {
      return { erreur: `Valeur invalide pour ${cle} (${regle.min} à ${regle.max})` };
    }
    if (regle.type === 'entier' && !Number.isInteger(nombre)) {
      return { erreur: `${cle} doit être un nombre entier` };
    }
    return { valeur: String(nombre) };
  }

  if (regle.type === 'devise') {
    const devise = String(valeurBrute || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(devise)) return { erreur: 'Devise invalide (trois lettres, ex. XAF)' };
    return { valeur: devise };
  }

  if (regle.type === 'booleen') {
    const brut = String(valeurBrute).trim().toLowerCase();
    if (['1', 'true', 'oui'].includes(brut)) return { valeur: '1' };
    if (['0', 'false', 'non'].includes(brut)) return { valeur: '0' };
    return { erreur: `${cle} attend oui ou non` };
  }

  if (regle.type === 'postes') {
    let objet = valeurBrute;
    if (typeof objet === 'string') {
      try {
        objet = JSON.parse(objet);
      } catch (erreur) {
        return { erreur: 'postes_depenses : JSON illisible' };
      }
    }
    if (!objet || typeof objet !== 'object' || Array.isArray(objet)) {
      return { erreur: 'postes_depenses attend un objet { clé: libellé }' };
    }
    const entrees = Object.entries(objet);
    if (entrees.length === 0) return { erreur: 'postes_depenses ne peut pas être vide' };
    if (entrees.length > 40) return { erreur: 'postes_depenses : 40 postes au maximum' };
    for (const [clePoste, libelle] of entrees) {
      if (!/^[a-z0-9_]{2,40}$/.test(clePoste)) {
        return { erreur: `Clé de poste invalide : ${clePoste} (minuscules, chiffres, souligné)` };
      }
      if (typeof libelle !== 'string' || !libelle.trim() || libelle.length > 80) {
        return { erreur: `Libellé invalide pour le poste ${clePoste}` };
      }
    }
    return { valeur: JSON.stringify(Object.fromEntries(entrees.map(([c, l]) => [c, String(l).trim()]))) };
  }

  return { erreur: `Paramètre non modifiable : ${cle}` };
}

/**
 * Écrit un lot de paramètres, après validation de l'ensemble.
 *
 * Tout ou rien : un lot dont une seule valeur est refusée n'écrit rien. Un
 * président qui corrige trois réglages d'un coup ne doit pas se retrouver avec
 * un état à moitié appliqué, impossible à comprendre à l'écran.
 *
 * @returns {Promise<{ecrits: string[]}>}
 */
async function ecrire(bd, valeurs, acteur) {
  const aEcrire = [];

  for (const [cle, valeur] of Object.entries(valeurs || {})) {
    const resultat = valider(cle, valeur);
    if (resultat.erreur) throw Object.assign(new Error(resultat.erreur), { refusUtilisateur: true });
    aEcrire.push([cle, resultat.valeur]);
  }

  if (aEcrire.length === 0) {
    throw Object.assign(new Error('Aucun paramètre à modifier.'), { refusUtilisateur: true });
  }

  for (const [cle, valeur] of aEcrire) {
    await bd.executer(
      `INSERT INTO parametres (cle, valeur, definit_par, date_maj)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (cle) DO UPDATE
         SET valeur = excluded.valeur,
             definit_par = excluded.definit_par,
             date_maj = excluded.date_maj`,
      [cle, valeur, acteur || null]
    );
  }

  invalider(bd);
  await charger(bd);

  console.log(
    `[parametres] ${aEcrire.length} réglage(s) modifié(s) par ${acteur || 'inconnu'} : ` +
      aEcrire.map(([cle]) => cle).join(', ')
  );
  return { ecrits: aEcrire.map(([cle]) => cle) };
}

module.exports = {
  charger,
  lus,
  invalider,
  entier,
  texte,
  booleen,
  postesDepenses,
  jourSeance,
  vue,
  valider,
  ecrire,
  CLES_MODIFIABLES,
  JOURS_SEMAINE,
};
