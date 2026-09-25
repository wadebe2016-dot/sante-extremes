/**
 * Demandes de dépense à plusieurs postes — Santé des extrêmes (LOT 5).
 *
 *   GET    /api/demandes?statut=&annee=                    (public)
 *   POST   /api/demandes                                   (intendant | secretaire | competitions | admin)
 *   POST   /api/demandes/:id/approuver                     (trésorier) — tous les postes en attente
 *   POST   /api/demandes/:id/refuser                       (trésorier) { motif } — idem
 *   DELETE /api/demandes/:id                               (rôle demandeur tant que rien n'est tranché, ou admin)
 *   POST   /api/demandes/:id/lignes/:ligneId/approuver     (trésorier)
 *   POST   /api/demandes/:id/lignes/:ligneId/refuser       (trésorier) { motif }
 *   POST   /api/demandes/:id/lignes/:ligneId/decaisser     (trésorier)
 *
 * UN BESOIN, PLUSIEURS POSTES. Un samedi, l'intendant engage l'eau, le kiné, la
 * location du stade et le lavage des chasubles. Il exprime tout cela en une
 * saisie ; le trésorier, lui, garde la main POSTE PAR POSTE — c'est lui qui
 * engage l'argent, il doit pouvoir approuver l'eau et refuser le kiné.
 *
 * D'où le partage : la décision et le paiement vivent sur la LIGNE. Le statut de
 * la demande n'est plus saisi, il est CALCULÉ à partir de ses lignes :
 *
 *   'en_attente'  au moins une ligne en attente
 *   'payee'       sinon, toutes les lignes non refusées sont payées
 *   'approuvee'   sinon, au moins une ligne approuvée
 *   'refusee'     sinon, toutes les lignes sont refusées
 *
 * Invariant tenu par le code ET par le schéma : un décaissement n'existe que
 * pour un poste approuvé, et un poste ne peut être payé qu'une fois (contrainte
 * UNIQUE sur decaissements.ligne_id). Aucune route ne permet de sortir de
 * l'argent sans demande préalable, et on ne décaisse JAMAIS une demande entière
 * — toujours un poste.
 *
 * Le trésorier ne peut pas exprimer de besoin : celui qui décide du
 * décaissement ne doit pas être celui qui le demande. Seul l'admin cumule.
 */
'use strict';

const express = require('express');
const { executer, lireUne, lireToutes } = require('../db');
const { exigerRole, memeMembre } = require('../middleware/auth');
const {
  recevoirRecu,
  televerserFichierPrive,
  gererErreursUpload,
} = require('../middleware/s3upload');

const routeur = express.Router();

/** Catégories fermées : une liste libre rendrait toute statistique illisible. */
const CATEGORIES = Object.freeze({
  equipement: 'Équipement',
  location_stade: 'Location de stade',
  kine_medical: 'Kiné et médical',
  transport: 'Transport',
  arbitrage: 'Arbitrage',
  competition_evenement: 'Compétition et évènement',
  eau_collation: 'Eau et collation',
  entretien: 'Entretien',
  autre: 'Autre',
});

const URGENCES = Object.freeze(['normale', 'urgente']);
const MOYENS = Object.freeze(['Mobile Money', 'Espèce']);
const PAYE_PAR = Object.freeze(['caisse', 'avance_rembourse']);
const STATUTS = Object.freeze(['en_attente', 'approuvee', 'refusee', 'payee']);

/** Un samedi chargé compte quatre ou cinq postes ; dix est une borne, pas un usage. */
const MAX_LIGNES = 10;

/** Rôles autorisés à exprimer un besoin. */
const ROLES_DEMANDEURS = Object.freeze(['intendant', 'secretaire', 'competitions']);

/** Ramène un moyen de paiement à sa valeur canonique. */
function normaliserMoyen(valeur) {
  const brut = String(valeur || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();

  if (brut === 'mobile money') return 'Mobile Money';
  if (brut === 'espece' || brut === 'especes') return 'Espèce';
  return null;
}

/**
 * Statut d'une demande, déduit de ses postes. Jamais saisi.
 *
 * L'ordre des règles compte : tant qu'un poste attend, la demande attend, même
 * si tout le reste est déjà payé — le trésorier a encore quelque chose à faire.
 *
 * @param {Array<{statut: string}>} lignes
 * @returns {string} l'un de STATUTS
 */
function statutAgrege(lignes) {
  if (!lignes || lignes.length === 0) return 'en_attente';

  if (lignes.some((ligne) => ligne.statut === 'en_attente')) return 'en_attente';

  const retenues = lignes.filter((ligne) => ligne.statut !== 'refusee');
  if (retenues.length === 0) return 'refusee';

  if (retenues.every((ligne) => ligne.statut === 'payee')) return 'payee';
  return 'approuvee';
}

/** Requête commune : un poste et son décaissement éventuel. */
const SELECTION_LIGNES = `
  SELECT l.*,
         x.id            AS decaissement_id,
         x.montant       AS decaissement_montant,
         x.date_paiement AS decaissement_date,
         x.moyen         AS decaissement_moyen,
         x.paye_par      AS decaissement_paye_par,
         x.beneficiaire  AS decaissement_beneficiaire,
         x.decaisse_par  AS decaissement_decaisse_par,
         x.commentaire   AS decaissement_commentaire,
         x.justificatif_cle_s3 AS decaissement_cle
    FROM demande_lignes l
    LEFT JOIN decaissements x ON x.ligne_id = l.id
`;

/** Met en forme un poste pour l'API. */
function formaterLigne(ligne) {
  return {
    id: ligne.id,
    demande_id: ligne.demande_id,
    categorie: ligne.categorie,
    categorie_libelle: CATEGORIES[ligne.categorie] || ligne.categorie,
    libelle: ligne.libelle,
    montant_estime: Number(ligne.montant_estime),
    statut: ligne.statut,
    motif_refus: ligne.motif_refus || null,
    approuve_par: ligne.approuve_par || null,
    date_decision: ligne.date_decision || null,
    decaissement: ligne.decaissement_id
      ? {
          id: ligne.decaissement_id,
          montant: Number(ligne.decaissement_montant),
          date_paiement: ligne.decaissement_date,
          moyen: ligne.decaissement_moyen,
          paye_par: ligne.decaissement_paye_par,
          beneficiaire: ligne.decaissement_beneficiaire || null,
          decaisse_par: ligne.decaissement_decaisse_par || null,
          commentaire: ligne.decaissement_commentaire || null,
          a_un_justificatif: Boolean(ligne.decaissement_cle),
        }
      : null,
  };
}

/**
 * Met en forme une demande et ses postes. Le devis n'est jamais exposé en clair.
 *
 * Les champs plats d'avant le LOT 5 (categorie, libelle, montant_estime,
 * decaissement) restent servis : une demande à un poste se lit exactement comme
 * avant, et rien de ce qui consomme l'API ne casse le jour du déploiement.
 */
function formaterDemande(demande, lignes) {
  const postes = lignes.map(formaterLigne);
  const totalEstime = postes.reduce((somme, poste) => somme + poste.montant_estime, 0);
  const totalDecaisse = postes.reduce(
    (somme, poste) => somme + (poste.decaissement ? poste.decaissement.montant : 0),
    0
  );
  const premier = postes[0] || null;

  return {
    id: demande.id,
    categorie: premier ? premier.categorie : demande.categorie,
    categorie_libelle: premier
      ? premier.categorie_libelle
      : CATEGORIES[demande.categorie] || demande.categorie,
    libelle: demande.libelle,
    montant_estime: totalEstime,
    total_estime: totalEstime,
    total_decaisse: totalDecaisse,
    nb_lignes: postes.length,
    urgence: demande.urgence,
    role_demandeur: demande.role_demandeur,
    statut: statutAgrege(postes),
    motif_refus: demande.motif_refus || null,
    approuve_par: demande.approuve_par || null,
    date_demande: demande.date_demande,
    date_decision: demande.date_decision || null,
    a_un_devis: Boolean(demande.justificatif_cle_s3),
    lignes: postes,
    // Une demande à un poste garde son décaissement au premier niveau.
    decaissement: postes.length === 1 ? postes[0].decaissement : null,
  };
}

/** Postes d'une demande, dans l'ordre de saisie. */
function lireLignes(demandeId) {
  return lireToutes(`${SELECTION_LIGNES} WHERE l.demande_id = ? ORDER BY l.id ASC`, [demandeId]);
}

/**
 * Réaligne les colonnes d'une demande sur ses postes.
 *
 * Le statut, le montant et la trace de décision de « demandes » sont un reflet,
 * pas une source : ils sont recalculés après chaque décision pour que les
 * lectures qui ne joignent pas les lignes — filtre par statut, journal, reprise
 * d'une base ancienne — restent justes.
 *
 * @returns {Promise<string>} le statut agrégé retenu
 */
async function recalculerDemande(demandeId) {
  const lignes = await lireToutes(
    `SELECT statut, montant_estime, motif_refus, approuve_par, date_decision
       FROM demande_lignes WHERE demande_id = ? ORDER BY id ASC`,
    [demandeId]
  );

  const statut = statutAgrege(lignes);
  const total = lignes.reduce((somme, ligne) => somme + Number(ligne.montant_estime), 0);

  // La dernière décision prise sur un poste date la demande entière.
  const decisions = lignes.map((ligne) => ligne.date_decision).filter(Boolean).sort();
  const derniere = decisions.length ? decisions[decisions.length - 1] : null;
  const decideur = derniere
    ? lignes.filter((ligne) => ligne.date_decision === derniere).map((ligne) => ligne.approuve_par)[0] ||
      null
    : null;

  // Le motif n'a de sens que si TOUT est refusé : sinon il contredirait les
  // postes retenus.
  const motif =
    statut === 'refusee' ? lignes.map((ligne) => ligne.motif_refus).filter(Boolean)[0] || null : null;

  // « montant_estime » porte un CHECK > 0 : une demande sans poste, qui ne peut
  // naître de l'API, garderait son montant plutôt que de faire échouer l'écriture.
  await executer(
    `UPDATE demandes
        SET statut = ?, motif_refus = ?, approuve_par = ?, date_decision = ?,
            montant_estime = CASE WHEN ? > 0 THEN ? ELSE montant_estime END
      WHERE id = ?`,
    [statut, motif, decideur, derniere, total, total, demandeId]
  );

  return statut;
}

/**
 * GET /api/demandes — liste publique.
 *
 * Les demandes en attente d'abord, puis les approuvées, puis le reste : c'est
 * l'ordre dans lequel le trésorier a quelque chose à faire.
 */
routeur.get('/', async (requete, reponse) => {
  const statutDemande = requete.query.statut ? String(requete.query.statut).toLowerCase() : null;
  const anneeBrute = requete.query.annee;

  if (statutDemande && !STATUTS.includes(statutDemande)) {
    return reponse.status(400).json({ error: `Statut invalide (attendu : ${STATUTS.join(', ')})` });
  }

  let annee = null;
  if (anneeBrute !== undefined && String(anneeBrute).trim() !== '') {
    annee = Number.parseInt(anneeBrute, 10);
    if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
      return reponse.status(400).json({ error: 'Paramètre « annee » invalide' });
    }
  }

  try {
    const entetes = await lireToutes(
      `SELECT d.* FROM demandes d
        ${annee === null ? '' : "WHERE strftime('%Y', d.date_demande) = ?"}`,
      annee === null ? [] : [String(annee)]
    );

    // Une seule lecture des postes pour toute la liste : une requête par
    // demande ferait vingt allers-retours pour un écran.
    const postes = await lireToutes(`${SELECTION_LIGNES} ORDER BY l.demande_id ASC, l.id ASC`);
    const parDemande = new Map();
    for (const poste of postes) {
      if (!parDemande.has(poste.demande_id)) parDemande.set(poste.demande_id, []);
      parDemande.get(poste.demande_id).push(poste);
    }

    const rang = { en_attente: 0, approuvee: 1, payee: 2, refusee: 3 };
    let demandes = entetes
      .map((entete) => formaterDemande(entete, parDemande.get(entete.id) || []))
      .sort((a, b) => {
        const ecart = (rang[a.statut] ?? 9) - (rang[b.statut] ?? 9);
        if (ecart !== 0) return ecart;
        // Les urgences remontent au sein d'un même statut.
        if (a.urgence !== b.urgence) return a.urgence === 'urgente' ? -1 : 1;
        return String(b.date_demande).localeCompare(String(a.date_demande));
      });

    // Le filtre porte sur le statut AGRÉGÉ : c'est ce que l'écran affiche.
    if (statutDemande) {
      demandes = demandes.filter((demande) => demande.statut === statutDemande);
    }

    const totaux = { en_attente: 0, approuvee: 0, refusee: 0, payee: 0 };
    const montants = { en_attente: 0, approuvee: 0, refusee: 0, payee: 0 };

    // Les compteurs se comptent POSTE PAR POSTE : c'est le poste qui attend une
    // décision, pas la demande. Un besoin dont l'eau est payée et le kiné en
    // attente pèse dans les deux colonnes, chacune pour son montant.
    for (const demande of demandes) {
      for (const poste of demande.lignes) {
        totaux[poste.statut] = (totaux[poste.statut] || 0) + 1;
        // Un poste payé compte pour ce qui est réellement sorti, pas pour
        // l'estimation initiale.
        montants[poste.statut] =
          (montants[poste.statut] || 0) +
          (poste.statut === 'payee' && poste.decaissement
            ? poste.decaissement.montant
            : poste.montant_estime);
      }
    }

    const nbPostes = demandes.reduce((somme, demande) => somme + demande.nb_lignes, 0);
    console.log(`[demandes] liste servie : ${demandes.length} demande(s), ${nbPostes} poste(s)`);

    return reponse.status(200).json({
      annee,
      statut: statutDemande,
      demandes,
      totaux,
      montants,
      categories: CATEGORIES,
      max_lignes: MAX_LIGNES,
    });
  } catch (erreur) {
    console.error(`[demandes] lecture impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les demandes' });
  }
});

/**
 * Postes reçus, quelle que soit la forme employée.
 *
 * DEUX FORMES ACCEPTÉES, une seule attendue des applications à jour :
 *   - « lignes », tableau d'objets — en JSON dans le corps, ou en texte JSON
 *     dans un champ de formulaire (un envoi multipart ne transporte que du
 *     texte) ;
 *   - les anciens champs plats « categorie / libelle / montant_estime », qui
 *     créent une demande à UN poste. La rétrocompatibilité n'est pas un
 *     ornement : une version antérieure de l'application reste installée sur
 *     les téléphones le jour du déploiement.
 *
 * @returns {{lignes: Array<object>}|{erreur: string}}
 */
function analyserLignes(corps) {
  let brutes = corps ? corps.lignes : undefined;

  if (typeof brutes === 'string') {
    const texte = brutes.trim();
    if (!texte) return { erreur: 'Au moins un poste est obligatoire' };
    try {
      brutes = JSON.parse(texte);
    } catch (erreur) {
      return { erreur: 'Champ « lignes » illisible (JSON attendu)' };
    }
  }

  // Forme plate d'avant le LOT 5 : un seul poste.
  if (brutes === undefined || brutes === null) {
    brutes = [
      {
        categorie: corps ? corps.categorie : undefined,
        libelle: corps ? corps.libelle : undefined,
        montant_estime: corps ? corps.montant_estime : undefined,
      },
    ];
  }

  if (!Array.isArray(brutes)) {
    return { erreur: 'Champ « lignes » invalide (tableau attendu)' };
  }

  if (brutes.length === 0) {
    return { erreur: 'Au moins un poste est obligatoire' };
  }

  if (brutes.length > MAX_LIGNES) {
    return { erreur: `Un besoin ne peut pas porter plus de ${MAX_LIGNES} postes` };
  }

  const lignes = [];
  for (let index = 0; index < brutes.length; index += 1) {
    const brute = brutes[index] || {};
    const rang = index + 1;

    const categorie = String(brute.categorie || '').trim().toLowerCase();
    const libelle = typeof brute.libelle === 'string' ? brute.libelle.trim() : '';
    const montant = Number.parseFloat(brute.montant_estime);

    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, categorie)) {
      return {
        erreur: `Poste ${rang} : catégorie invalide (attendu : ${Object.keys(CATEGORIES).join(', ')})`,
      };
    }

    if (!libelle) {
      return { erreur: `Poste ${rang} : le libellé est obligatoire` };
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      return { erreur: `Poste ${rang} : le montant estimé doit être strictement positif` };
    }

    lignes.push({ categorie, libelle: libelle.slice(0, 200), montant_estime: montant });
  }

  return { lignes };
}

/** POST /api/demandes — exprimer un besoin, à un ou plusieurs postes. */
routeur.post(
  '/',
  exigerRole(...ROLES_DEMANDEURS),
  (requete, reponse, suite) => recevoirRecu(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  async (requete, reponse) => {
    const analyse = analyserLignes(requete.body);
    if (analyse.erreur) {
      return reponse.status(400).json({ error: analyse.erreur });
    }

    const lignes = analyse.lignes;
    const urgence = String(requete.body?.urgence || 'normale').trim().toLowerCase();

    if (!URGENCES.includes(urgence)) {
      return reponse
        .status(400)
        .json({ error: `Urgence invalide (attendu : ${URGENCES.join(' ou ')})` });
    }

    // Le rôle inscrit est celui du demandeur, pas « admin » si l'admin agit
    // pour le compte de quelqu'un : on retient le rôle le plus précis.
    const roles = requete.roles || [];
    const roleDemandeur = ROLES_DEMANDEURS.find((role) => roles.includes(role)) || 'admin';

    const total = lignes.reduce((somme, ligne) => somme + ligne.montant_estime, 0);

    // Le libellé de l'en-tête reprend celui du poste unique, ou énumère les
    // postes : c'est ce que lisent les lectures qui ne joignent pas les lignes.
    const libelleEntete =
      lignes.length === 1
        ? lignes[0].libelle
        : lignes.map((ligne) => ligne.libelle).join(' · ').slice(0, 200);

    try {
      let cleDevis = null;
      if (requete.file) {
        const depot = await televerserFichierPrive(requete.file, 'depenses/devis');
        cleDevis = depot.cle;
      }

      const resultat = await executer(
        `INSERT INTO demandes (categorie, libelle, montant_estime, urgence, justificatif_cle_s3, role_demandeur)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lignes[0].categorie, libelleEntete, total, urgence, cleDevis, roleDemandeur]
      );

      for (const ligne of lignes) {
        await executer(
          `INSERT INTO demande_lignes (demande_id, categorie, libelle, montant_estime)
           VALUES (?, ?, ?, ?)`,
          [resultat.id, ligne.categorie, ligne.libelle, ligne.montant_estime]
        );
      }

      const entete = await lireUne('SELECT * FROM demandes WHERE id = ?', [resultat.id]);
      const postes = await lireLignes(resultat.id);

      console.log(
        `[demandes] besoin exprimé : #${resultat.id} — ${lignes.length} poste(s) — ` +
          `${total} XAF estimés — ${urgence} — par ${roleDemandeur}`
      );
      return reponse.status(201).json(formaterDemande(entete, postes));
    } catch (erreur) {
      console.error(`[demandes] création impossible : ${erreur.message}`);
      return reponse
        .status(500)
        .json({ error: erreur.message || "Impossible d'enregistrer la demande" });
    }
  }
);

/** Charge une demande, ou répond 404. */
async function chargerDemande(identifiant, reponse) {
  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    reponse.status(400).json({ error: 'Identifiant de demande invalide' });
    return null;
  }

  const ligne = await lireUne('SELECT * FROM demandes WHERE id = ?', [identifiant]);
  if (!ligne) {
    reponse.status(404).json({ error: 'Demande introuvable' });
    return null;
  }
  return ligne;
}

/** Charge un poste de LA demande indiquée, ou répond 404. */
async function chargerLigne(requete, reponse) {
  const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
  if (!demande) return null;

  const identifiant = Number.parseInt(requete.params.ligneId, 10);
  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    reponse.status(400).json({ error: 'Identifiant de poste invalide' });
    return null;
  }

  // Le poste doit appartenir à la demande de l'URL : sans cette égalité, un
  // identifiant emprunté à une autre demande passerait.
  const ligne = await lireUne(`${SELECTION_LIGNES} WHERE l.id = ? AND l.demande_id = ?`, [
    identifiant,
    demande.id,
  ]);

  if (!ligne) {
    reponse.status(404).json({ error: 'Poste introuvable sur cette demande' });
    return null;
  }

  return { demande, ligne };
}

/** Réponse commune aux décisions : la demande entière, postes compris. */
async function repondreDemande(demandeId, reponse, code = 200) {
  await recalculerDemande(demandeId);
  const entete = await lireUne('SELECT * FROM demandes WHERE id = ?', [demandeId]);
  const postes = await lireLignes(demandeId);
  return reponse.status(code).json(formaterDemande(entete, postes));
}

/**
 * POST /api/demandes/:id/approuver — tout approuver d'un bloc (trésorier).
 *
 * Le geste rapide quand rien ne fait débat : tous les postes ENCORE EN ATTENTE
 * passent approuvés. Les postes déjà refusés ne bougent pas — revenir sur un
 * refus demande une décision explicite, pas un geste de masse.
 */
routeur.post('/:id/approuver', exigerRole('tresorier'), async (requete, reponse) => {
  try {
    const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
    if (!demande) return undefined;

    const resultat = await executer(
      `UPDATE demande_lignes
          SET statut = 'approuvee', motif_refus = NULL,
              approuve_par = ?,
              date_decision = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE demande_id = ? AND statut = 'en_attente'`,
      [requete.agent, demande.id]
    );

    if (resultat.changements === 0) {
      return reponse.status(409).json({ error: 'Aucun poste en attente sur cette demande' });
    }

    console.log(`[demandes] approuvée : #${demande.id} — ${resultat.changements} poste(s)`);
    return repondreDemande(demande.id, reponse);
  } catch (erreur) {
    console.error(`[demandes] approbation impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'approuver la demande" });
  }
});

/** POST /api/demandes/:id/refuser — écarter tous les postes en attente, motif obligatoire. */
routeur.post('/:id/refuser', exigerRole('tresorier'), async (requete, reponse) => {
  const motif = typeof requete.body?.motif === 'string' ? requete.body.motif.trim() : '';

  if (!motif) {
    return reponse.status(400).json({ error: 'Le motif du refus est obligatoire' });
  }

  try {
    const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
    if (!demande) return undefined;

    const resultat = await executer(
      `UPDATE demande_lignes
          SET statut = 'refusee', motif_refus = ?,
              approuve_par = ?,
              date_decision = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE demande_id = ? AND statut = 'en_attente'`,
      [motif.slice(0, 200), requete.agent, demande.id]
    );

    if (resultat.changements === 0) {
      return reponse.status(409).json({ error: 'Aucun poste en attente sur cette demande' });
    }

    console.log(`[demandes] refusée : #${demande.id} — ${resultat.changements} poste(s) — ${motif}`);
    return repondreDemande(demande.id, reponse);
  } catch (erreur) {
    console.error(`[demandes] refus impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de refuser la demande' });
  }
});

/** POST /api/demandes/:id/lignes/:ligneId/approuver — le trésorier retient ce poste. */
routeur.post('/:id/lignes/:ligneId/approuver', exigerRole('tresorier'), async (requete, reponse) => {
  try {
    const charge = await chargerLigne(requete, reponse);
    if (!charge) return undefined;

    if (charge.ligne.statut !== 'en_attente') {
      return reponse.status(409).json({ error: `Ce poste est déjà « ${charge.ligne.statut} »` });
    }

    await executer(
      `UPDATE demande_lignes
          SET statut = 'approuvee', motif_refus = NULL,
              approuve_par = ?,
              date_decision = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
      [requete.agent, charge.ligne.id]
    );

    console.log(
      `[demandes] poste approuvé : #${charge.demande.id}/${charge.ligne.id} — ${charge.ligne.libelle}`
    );
    return repondreDemande(charge.demande.id, reponse);
  } catch (erreur) {
    console.error(`[demandes] approbation de poste impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'approuver ce poste" });
  }
});

/** POST /api/demandes/:id/lignes/:ligneId/refuser — le trésorier écarte ce poste. */
routeur.post('/:id/lignes/:ligneId/refuser', exigerRole('tresorier'), async (requete, reponse) => {
  const motif = typeof requete.body?.motif === 'string' ? requete.body.motif.trim() : '';

  if (!motif) {
    return reponse.status(400).json({ error: 'Le motif du refus est obligatoire' });
  }

  try {
    const charge = await chargerLigne(requete, reponse);
    if (!charge) return undefined;

    if (charge.ligne.statut === 'payee') {
      return reponse.status(409).json({ error: 'Un poste déjà payé ne peut plus être refusé' });
    }

    if (charge.ligne.statut === 'refusee') {
      return reponse.status(409).json({ error: 'Ce poste est déjà refusé' });
    }

    await executer(
      `UPDATE demande_lignes
          SET statut = 'refusee', motif_refus = ?,
              approuve_par = ?,
              date_decision = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
      [motif.slice(0, 200), requete.agent, charge.ligne.id]
    );

    console.log(`[demandes] poste refusé : #${charge.demande.id}/${charge.ligne.id} — ${motif}`);
    return repondreDemande(charge.demande.id, reponse);
  } catch (erreur) {
    console.error(`[demandes] refus de poste impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de refuser ce poste' });
  }
});

/**
 * DELETE /api/demandes/:id — le demandeur se ravise.
 *
 * Possible tant que rien n'a été décidé sur aucun poste. Une demande déjà
 * tranchée reste en base : elle fait partie de l'historique des décisions du
 * trésorier.
 */
routeur.delete('/:id', exigerRole(...ROLES_DEMANDEURS), async (requete, reponse) => {
  try {
    const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
    if (!demande) return undefined;

    const roles = requete.roles || [];
    const estAdmin = roles.includes('admin');

    // Un seul poste déjà tranché suffit à figer la demande : le statut agrégé
    // n'est « en attente » que si AUCUNE décision n'est encore prise.
    const postes = await lireToutes('SELECT statut FROM demande_lignes WHERE demande_id = ?', [
      demande.id,
    ]);
    const intacte = postes.every((poste) => poste.statut === 'en_attente');

    if (!estAdmin && !intacte) {
      return reponse
        .status(409)
        .json({ error: 'Une demande déjà traitée ne peut plus être retirée' });
    }

    if (!estAdmin && !roles.includes(demande.role_demandeur)) {
      console.warn(
        `[demandes] retrait refusé : #${demande.id} appartient à ${demande.role_demandeur}`
      );
      return reponse.status(401).json({ error: 'Cette demande a été exprimée par un autre rôle' });
    }

    await executer('DELETE FROM demandes WHERE id = ?', [demande.id]);
    console.log(`[demandes] retirée : #${demande.id}`);
    return reponse.status(200).json({ message: 'Demande retirée' });
  } catch (erreur) {
    console.error(`[demandes] retrait impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de retirer la demande' });
  }
});

/**
 * POST /api/demandes/:id/lignes/:ligneId/decaisser — sortie de caisse (trésorier).
 *
 * 409 si le poste n'est pas approuvé : c'est là que se joue l'invariant. Il n'y
 * a PLUS de décaissement au niveau de la demande — l'eau et le kiné ne sortent
 * pas de la caisse dans le même geste, ni au même bénéficiaire.
 */
routeur.post(
  '/:id/lignes/:ligneId/decaisser',
  exigerRole('tresorier'),
  (requete, reponse, suite) => recevoirRecu(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  async (requete, reponse) => {
    const montant = Number.parseFloat(requete.body?.montant);
    const moyen = normaliserMoyen(requete.body?.moyen);
    const payePar = String(requete.body?.paye_par || 'caisse').trim().toLowerCase();
    const beneficiaire =
      typeof requete.body?.beneficiaire === 'string' ? requete.body.beneficiaire.trim() : '';
    const commentaire =
      typeof requete.body?.commentaire === 'string' ? requete.body.commentaire.trim() : '';

    if (!Number.isFinite(montant) || montant <= 0) {
      return reponse.status(400).json({ error: 'Le montant doit être strictement positif' });
    }

    if (!moyen) {
      return reponse.status(400).json({ error: `Moyen invalide (attendu : ${MOYENS.join(' ou ')})` });
    }

    if (!PAYE_PAR.includes(payePar)) {
      return reponse
        .status(400)
        .json({ error: 'Champ « paye_par » invalide (caisse ou avance_rembourse)' });
    }

    // Une avance sans bénéficiaire ne peut pas être remboursée.
    if (payePar === 'avance_rembourse' && !beneficiaire) {
      return reponse.status(400).json({ error: 'Précisez le bénéficiaire de l’avance à rembourser' });
    }

    // Séparation des pouvoirs : celui qui sort l'argent ne peut pas être le
    // bénéficiaire. L'autre trésorier, ou l'admin, s'en charge.
    if (requete.tresorier && memeMembre(beneficiaire, requete.tresorier)) {
      console.warn(`[decaissements] refus : ${requete.tresorier} se désigne bénéficiaire`);
      return reponse.status(403).json({
        error: 'Un trésorier ne peut pas décaisser à son propre bénéfice',
      });
    }

    try {
      const charge = await chargerLigne(requete, reponse);
      if (!charge) return undefined;

      if (charge.ligne.statut !== 'approuvee') {
        console.warn(
          `[decaissements] refus : poste #${charge.ligne.id} au statut « ${charge.ligne.statut} »`
        );
        return reponse.status(409).json({
          error: `Seul un poste approuvé peut être décaissé (statut actuel : ${charge.ligne.statut})`,
        });
      }

      let cleJustificatif = null;
      if (requete.file) {
        const depot = await televerserFichierPrive(requete.file, 'depenses/justificatifs');
        cleJustificatif = depot.cle;
      }

      const resultat = await executer(
        `INSERT INTO decaissements
           (ligne_id, montant, moyen, paye_par, beneficiaire, decaisse_par, justificatif_cle_s3, commentaire)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          charge.ligne.id,
          montant,
          moyen,
          payePar,
          beneficiaire || null,
          requete.agent,
          cleJustificatif,
          commentaire || null,
        ]
      );

      await executer("UPDATE demande_lignes SET statut = 'payee' WHERE id = ?", [charge.ligne.id]);

      console.log(
        `[decaissements] décaissement #${resultat.id} — demande #${charge.demande.id}, ` +
          `poste #${charge.ligne.id} — ${montant} XAF (${moyen}, ${payePar})`
      );
      return repondreDemande(charge.demande.id, reponse, 201);
    } catch (erreur) {
      // La contrainte UNIQUE est le dernier rempart si deux requêtes arrivent
      // en même temps sur le même poste.
      if (String(erreur.message).includes('UNIQUE')) {
        return reponse.status(409).json({ error: 'Ce poste a déjà été décaissé' });
      }
      console.error(`[decaissements] échec : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || 'Impossible de décaisser' });
    }
  }
);

module.exports = routeur;
module.exports.CATEGORIES = CATEGORIES;
module.exports.ROLES_DEMANDEURS = ROLES_DEMANDEURS;
module.exports.MAX_LIGNES = MAX_LIGNES;
module.exports.statutAgrege = statutAgrege;
