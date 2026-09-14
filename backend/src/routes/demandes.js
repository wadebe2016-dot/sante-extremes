/**
 * Demandes de dépense et décaissements — Santé des extrêmes (LOT 3 bis).
 *
 *   GET    /api/demandes?statut=&annee=   (public)
 *   POST   /api/demandes                  (intendant | secretaire | competitions | admin)
 *   POST   /api/demandes/:id/approuver    (trésorier)
 *   POST   /api/demandes/:id/refuser      (trésorier) { motif }
 *   DELETE /api/demandes/:id              (rôle demandeur tant que « en_attente », ou admin)
 *   POST   /api/demandes/:id/decaisser    (trésorier)
 *
 * Invariant tenu par le code ET par le schéma : un décaissement n'existe que
 * pour une demande approuvée, et une demande ne peut être payée qu'une fois
 * (contrainte UNIQUE sur decaissements.demande_id). Aucune route ne permet de
 * sortir de l'argent sans demande préalable.
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

/** Met en forme une demande pour l'API. Le devis n'est jamais exposé en clair. */
function formaterDemande(ligne) {
  return {
    id: ligne.id,
    categorie: ligne.categorie,
    categorie_libelle: CATEGORIES[ligne.categorie] || ligne.categorie,
    libelle: ligne.libelle,
    montant_estime: Number(ligne.montant_estime),
    urgence: ligne.urgence,
    role_demandeur: ligne.role_demandeur,
    statut: ligne.statut,
    motif_refus: ligne.motif_refus || null,
    approuve_par: ligne.approuve_par || null,
    date_demande: ligne.date_demande,
    date_decision: ligne.date_decision || null,
    a_un_devis: Boolean(ligne.justificatif_cle_s3),
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

/** Requête commune : demande + décaissement éventuel. */
const SELECTION = `
  SELECT d.*,
         x.id            AS decaissement_id,
         x.montant       AS decaissement_montant,
         x.date_paiement AS decaissement_date,
         x.moyen         AS decaissement_moyen,
         x.paye_par      AS decaissement_paye_par,
         x.beneficiaire  AS decaissement_beneficiaire,
         x.decaisse_par  AS decaissement_decaisse_par,
         x.commentaire   AS decaissement_commentaire,
         x.justificatif_cle_s3 AS decaissement_cle
    FROM demandes d
    LEFT JOIN decaissements x ON x.demande_id = d.id
`;

/**
 * GET /api/demandes — liste publique.
 *
 * Les demandes en attente d'abord, puis les approuvées, puis le reste : c'est
 * l'ordre dans lequel le trésorier a quelque chose à faire.
 */
routeur.get('/', async (requete, reponse) => {
  const statutDemande = requete.query.statut ? String(requete.query.statut).toLowerCase() : null;
  const anneeBrute = requete.query.annee;

  const STATUTS = ['en_attente', 'approuvee', 'refusee', 'payee'];
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
    const conditions = [];
    const parametres = [];

    if (statutDemande) {
      conditions.push('d.statut = ?');
      parametres.push(statutDemande);
    }

    if (annee !== null) {
      conditions.push("strftime('%Y', d.date_demande) = ?");
      parametres.push(String(annee));
    }

    const lignes = await lireToutes(
      `${SELECTION} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
      parametres
    );

    const rang = { en_attente: 0, approuvee: 1, payee: 2, refusee: 3 };
    const demandes = lignes.map(formaterDemande).sort((a, b) => {
      const ecart = (rang[a.statut] ?? 9) - (rang[b.statut] ?? 9);
      if (ecart !== 0) return ecart;
      // Les urgences remontent au sein d'un même statut.
      if (a.urgence !== b.urgence) return a.urgence === 'urgente' ? -1 : 1;
      return String(b.date_demande).localeCompare(String(a.date_demande));
    });

    const totaux = { en_attente: 0, approuvee: 0, refusee: 0, payee: 0 };
    const montants = { en_attente: 0, approuvee: 0, refusee: 0, payee: 0 };

    for (const demande of demandes) {
      totaux[demande.statut] = (totaux[demande.statut] || 0) + 1;
      // Une demande payée compte pour ce qui est réellement sorti, pas pour
      // l'estimation initiale.
      montants[demande.statut] =
        (montants[demande.statut] || 0) +
        (demande.statut === 'payee' && demande.decaissement
          ? demande.decaissement.montant
          : demande.montant_estime);
    }

    console.log(`[demandes] liste servie : ${demandes.length} demande(s)`);
    return reponse.status(200).json({
      annee,
      statut: statutDemande,
      demandes,
      totaux,
      montants,
      categories: CATEGORIES,
    });
  } catch (erreur) {
    console.error(`[demandes] lecture impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les demandes' });
  }
});

/** POST /api/demandes — exprimer un besoin. */
routeur.post(
  '/',
  exigerRole(...ROLES_DEMANDEURS),
  (requete, reponse, suite) => recevoirRecu(requete, reponse, (erreur) =>
    gererErreursUpload(erreur, requete, reponse, suite)
  ),
  async (requete, reponse) => {
    const categorie = String(requete.body?.categorie || '').trim().toLowerCase();
    const libelle = typeof requete.body?.libelle === 'string' ? requete.body.libelle.trim() : '';
    const montant = Number.parseFloat(requete.body?.montant_estime);
    const urgence = String(requete.body?.urgence || 'normale').trim().toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, categorie)) {
      return reponse
        .status(400)
        .json({ error: `Catégorie invalide (attendu : ${Object.keys(CATEGORIES).join(', ')})` });
    }

    if (!libelle) {
      return reponse.status(400).json({ error: 'Le libellé de la demande est obligatoire' });
    }

    if (!Number.isFinite(montant) || montant <= 0) {
      return reponse.status(400).json({ error: 'Le montant estimé doit être strictement positif' });
    }

    if (!URGENCES.includes(urgence)) {
      return reponse.status(400).json({ error: `Urgence invalide (attendu : ${URGENCES.join(' ou ')})` });
    }

    // Le rôle inscrit est celui du demandeur, pas « admin » si l'admin agit
    // pour le compte de quelqu'un : on retient le rôle le plus précis.
    const roles = requete.roles || [];
    const roleDemandeur = ROLES_DEMANDEURS.find((role) => roles.includes(role)) || 'admin';

    try {
      let cleDevis = null;
      if (requete.file) {
        const depot = await televerserFichierPrive(requete.file, 'depenses/devis');
        cleDevis = depot.cle;
      }

      const resultat = await executer(
        `INSERT INTO demandes (categorie, libelle, montant_estime, urgence, justificatif_cle_s3, role_demandeur)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [categorie, libelle.slice(0, 200), montant, urgence, cleDevis, roleDemandeur]
      );

      const ligne = await lireUne(`${SELECTION} WHERE d.id = ?`, [resultat.id]);

      console.log(
        `[demandes] besoin exprimé : #${resultat.id} — ${CATEGORIES[categorie]} — ` +
          `${montant} XAF — ${urgence} — par ${roleDemandeur}`
      );
      return reponse.status(201).json(formaterDemande(ligne));
    } catch (erreur) {
      console.error(`[demandes] création impossible : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || "Impossible d'enregistrer la demande" });
    }
  }
);

/** Charge une demande, ou répond 404. */
async function chargerDemande(identifiant, reponse) {
  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    reponse.status(400).json({ error: 'Identifiant de demande invalide' });
    return null;
  }

  const ligne = await lireUne(`${SELECTION} WHERE d.id = ?`, [identifiant]);
  if (!ligne) {
    reponse.status(404).json({ error: 'Demande introuvable' });
    return null;
  }
  return ligne;
}

/** POST /api/demandes/:id/approuver — le trésorier donne son accord. */
routeur.post('/:id/approuver', exigerRole('tresorier'), async (requete, reponse) => {
  try {
    const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
    if (!demande) return undefined;

    if (demande.statut !== 'en_attente') {
      return reponse.status(409).json({ error: `Cette demande est déjà « ${demande.statut} »` });
    }

    await executer(
      `UPDATE demandes
          SET statut = 'approuvee', motif_refus = NULL,
              approuve_par = ?,
              date_decision = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
      [requete.agent, demande.id]
    );

    const ligne = await lireUne(`${SELECTION} WHERE d.id = ?`, [demande.id]);
    console.log(`[demandes] approuvée : #${demande.id} — ${demande.libelle}`);
    return reponse.status(200).json(formaterDemande(ligne));
  } catch (erreur) {
    console.error(`[demandes] approbation impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'approuver la demande" });
  }
});

/** POST /api/demandes/:id/refuser — le trésorier écarte, motif obligatoire. */
routeur.post('/:id/refuser', exigerRole('tresorier'), async (requete, reponse) => {
  const motif = typeof requete.body?.motif === 'string' ? requete.body.motif.trim() : '';

  if (!motif) {
    return reponse.status(400).json({ error: 'Le motif du refus est obligatoire' });
  }

  try {
    const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
    if (!demande) return undefined;

    if (demande.statut === 'payee') {
      return reponse.status(409).json({ error: 'Une demande déjà payée ne peut plus être refusée' });
    }

    if (demande.statut === 'refusee') {
      return reponse.status(409).json({ error: 'Cette demande est déjà refusée' });
    }

    await executer(
      `UPDATE demandes
          SET statut = 'refusee', motif_refus = ?,
              approuve_par = ?,
              date_decision = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
      [motif.slice(0, 200), requete.agent, demande.id]
    );

    const ligne = await lireUne(`${SELECTION} WHERE d.id = ?`, [demande.id]);
    console.log(`[demandes] refusée : #${demande.id} — ${motif}`);
    return reponse.status(200).json(formaterDemande(ligne));
  } catch (erreur) {
    console.error(`[demandes] refus impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de refuser la demande' });
  }
});

/**
 * DELETE /api/demandes/:id — le demandeur se ravise.
 *
 * Possible tant que rien n'a été décidé. Une demande déjà tranchée reste en
 * base : elle fait partie de l'historique des décisions du trésorier.
 */
routeur.delete('/:id', exigerRole(...ROLES_DEMANDEURS), async (requete, reponse) => {
  try {
    const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
    if (!demande) return undefined;

    const roles = requete.roles || [];
    const estAdmin = roles.includes('admin');

    if (!estAdmin && demande.statut !== 'en_attente') {
      return reponse
        .status(409)
        .json({ error: 'Une demande déjà traitée ne peut plus être retirée' });
    }

    if (!estAdmin && !roles.includes(demande.role_demandeur)) {
      console.warn(`[demandes] retrait refusé : #${demande.id} appartient à ${demande.role_demandeur}`);
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
 * POST /api/demandes/:id/decaisser — sortie de caisse effective (trésorier).
 *
 * 409 si la demande n'est pas approuvée : c'est là que se joue l'invariant.
 */
routeur.post(
  '/:id/decaisser',
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
      return reponse
        .status(400)
        .json({ error: 'Précisez le bénéficiaire de l’avance à rembourser' });
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
      const demande = await chargerDemande(Number.parseInt(requete.params.id, 10), reponse);
      if (!demande) return undefined;

      if (demande.statut !== 'approuvee') {
        console.warn(
          `[decaissements] refus : demande #${demande.id} au statut « ${demande.statut} »`
        );
        return reponse.status(409).json({
          error: `Seule une demande approuvée peut être décaissée (statut actuel : ${demande.statut})`,
        });
      }

      let cleJustificatif = null;
      if (requete.file) {
        const depot = await televerserFichierPrive(requete.file, 'depenses/justificatifs');
        cleJustificatif = depot.cle;
      }

      const resultat = await executer(
        `INSERT INTO decaissements
           (demande_id, montant, moyen, paye_par, beneficiaire, decaisse_par, justificatif_cle_s3, commentaire)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          demande.id,
          montant,
          moyen,
          payePar,
          beneficiaire || null,
          requete.agent,
          cleJustificatif,
          commentaire || null,
        ]
      );

      await executer("UPDATE demandes SET statut = 'payee' WHERE id = ?", [demande.id]);

      const ligne = await lireUne(`${SELECTION} WHERE d.id = ?`, [demande.id]);

      console.log(
        `[decaissements] décaissement #${resultat.id} — demande #${demande.id} — ` +
          `${montant} XAF (${moyen}, ${payePar})`
      );
      return reponse.status(201).json(formaterDemande(ligne));
    } catch (erreur) {
      // La contrainte UNIQUE est le dernier rempart si deux requêtes arrivent
      // en même temps sur la même demande.
      if (String(erreur.message).includes('UNIQUE')) {
        return reponse.status(409).json({ error: 'Cette demande a déjà été décaissée' });
      }
      console.error(`[decaissements] échec : ${erreur.message}`);
      return reponse.status(500).json({ error: erreur.message || 'Impossible de décaisser' });
    }
  }
);

module.exports = routeur;
module.exports.CATEGORIES = CATEGORIES;
module.exports.ROLES_DEMANDEURS = ROLES_DEMANDEURS;
