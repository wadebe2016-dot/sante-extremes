/**
 * Espace de l'éditeur — LOT 7 « DeuxZero ».
 *
 *   GET /api/admin-produit/sms/statistiques  consommation SMS par association et par mois
 *   GET /api/admin-produit/associations      liste des associations inscrites
 *
 * Réservé à Atlastech, protégé par ADMIN_PRODUIT_CODE — une variable
 * d'environnement, et non un code de rôle : l'éditeur n'est pas un membre du
 * bureau d'une association, et son accès ne doit dépendre d'aucune base cliente.
 *
 * CE QUE CES ROUTES NE MONTRENT PAS, ET NE DOIVENT JAMAIS MONTRER : aucune donnée
 * métier. Pas un membre, pas une cotisation, pas un montant. L'éditeur suit sa
 * facture SMS et le nombre de ses clients ; le contenu des bases appartient aux
 * associations. C'est aussi ce qui rend l'engagement « nous n'entrons jamais en
 * contact avec vous » crédible : il n'y a rien à regarder.
 *
 * Sans ADMIN_PRODUIT_CODE en environnement, l'espace est FERMÉ (503) — jamais
 * ouvert. Une variable oubliée au déploiement ne doit pas laisser l'espace de
 * l'éditeur accessible à tous.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');

const annuaire = require('../bd/annuaire');
const limiteur = require('../middleware/limiteur');

const routeur = express.Router();

/** Comparaison à temps constant du code de l'éditeur. */
function memeCode(recu, attendu) {
  const gauche = Buffer.from(String(recu), 'utf8');
  const droite = Buffer.from(String(attendu), 'utf8');
  if (gauche.length !== droite.length) return false;
  return crypto.timingSafeEqual(gauche, droite);
}

/** Contrôle d'accès de l'espace éditeur. */
function exigerCodeProduit(requete, reponse, suite) {
  const attendu = String(process.env.ADMIN_PRODUIT_CODE || '').trim();

  if (!attendu) {
    console.error('[admin-produit] ADMIN_PRODUIT_CODE absent : espace éditeur fermé');
    return reponse.status(503).json({ error: 'Espace éditeur non configuré' });
  }

  const source = `admin-produit|${limiteur.sourceDe(requete)}`;
  if (limiteur.estBloquee(source)) return limiteur.repondreBloque(reponse, source);

  const entete = requete.headers.authorization || '';
  const [schema, jeton] = entete.split(' ');
  if (schema !== 'Bearer' || !jeton || !memeCode(jeton, attendu)) {
    limiteur.enregistrerEchec(source, 'espace éditeur');
    return reponse.status(401).json({ error: 'Code invalide' });
  }

  limiteur.reinitialiser(source);
  return suite();
}

routeur.use(exigerCodeProduit);

/**
 * GET /api/admin-produit/sms/statistiques — volume par association et par mois.
 *
 * Le destinataire n'apparaît nulle part, même masqué : ce qui est facturé, c'est
 * un nombre d'envois.
 */
routeur.get('/sms/statistiques', async (requete, reponse) => {
  try {
    const lignes = await annuaire.statistiquesSms();

    const parMois = new Map();
    let total = 0;
    let reussis = 0;

    for (const ligne of lignes) {
      total += Number(ligne.envois) || 0;
      reussis += Number(ligne.reussis) || 0;

      if (!parMois.has(ligne.mois)) parMois.set(ligne.mois, []);
      parMois.get(ligne.mois).push({
        association: ligne.association,
        fournisseur: ligne.fournisseur,
        envois: Number(ligne.envois) || 0,
        reussis: Number(ligne.reussis) || 0,
        echecs: Number(ligne.echecs) || 0,
      });
    }

    console.log(`[admin-produit] statistiques SMS servies : ${total} envoi(s) sur ${parMois.size} mois`);

    return reponse.status(200).json({
      fournisseur_actif: require('../services/sms').fournisseurActif(),
      total_envois: total,
      total_reussis: reussis,
      total_echecs: total - reussis,
      par_mois: [...parMois.entries()].map(([mois, detail]) => ({
        mois,
        envois: detail.reduce((somme, entree) => somme + entree.envois, 0),
        detail,
      })),
    });
  } catch (erreur) {
    console.error(`[admin-produit] statistiques SMS impossibles : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les statistiques' });
  }
});

/**
 * GET /api/admin-produit/associations — les associations inscrites.
 *
 * Code, nom, ville, date de création, statut. Rien d'autre : ni effectif, ni
 * montant, ni téléphone.
 */
routeur.get('/associations', async (requete, reponse) => {
  try {
    const liste = await annuaire.lister();
    console.log(`[admin-produit] ${liste.length} association(s) listée(s)`);
    return reponse.status(200).json({
      nombre: liste.length,
      associations: liste.map((association) => ({
        code: association.code,
        nom: association.nom,
        ville: association.ville,
        statut: association.statut,
        date_creation: association.date_creation,
      })),
    });
  } catch (erreur) {
    console.error(`[admin-produit] liste impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les associations' });
  }
});

module.exports = routeur;
