/**
 * Création et reconnaissance d'une association — LOT 7 « DeuxZero ».
 *
 *   POST /api/associations                 (public) créer une association
 *   POST /api/associations/verifier-code   (public) à quelle association ce code ?
 *
 * Ces deux routes sont PUBLIQUES, et ce n'est pas un oubli : l'éditeur n'entre
 * jamais en contact avec ses clients. Une association qui découvre l'application
 * sur Google Play doit pouvoir s'inscrire et travailler le samedi suivant, sans
 * appeler personne. Il n'y a aucun formulaire de contact, aucune validation
 * manuelle, aucun délai.
 *
 * La contrepartie est qu'il faut rendre la création peu intéressante à abuser :
 *   · une base neuve ne contient rien — ni membre, ni argent, ni fichier ;
 *   · le code président n'est affiché QU'UNE FOIS et n'est stocké que haché ;
 *   · le nombre de créations par adresse IP est plafonné (voir CREATIONS_MAX) ;
 *   · « verifier-code » ne renvoie que le NOM, jamais un chiffre : un code
 *     d'association se dicte au téléphone entre membres, ce n'est pas un secret,
 *     mais il ne doit rien laisser filtrer des données.
 */
'use strict';

const express = require('express');

const annuaire = require('../bd/annuaire');
const locataires = require('../bd/locataires');
const codes = require('../services/codes');
const roles = require('../services/roles');
const parametres = require('../services/parametres');

const routeur = express.Router();

/** Longueurs acceptées pour le nom d'une association et celui du président. */
const NOM_MIN = 3;
const NOM_MAX = 80;

/** Créations autorisées par adresse IP et par heure. */
const CREATIONS_MAX = Number(process.env.CREATIONS_MAX) > 0 ? Number(process.env.CREATIONS_MAX) : 3;
const FENETRE_CREATION_MS = 60 * 60 * 1000;

/** Essais de tirage d'un code avant de renoncer, en cas de collisions répétées. */
const ESSAIS_CODE = 20;

/** Créations récentes, par adresse IP. Compteur en mémoire, comme le limiteur. */
const creations = new Map();

/**
 * L'adresse a-t-elle épuisé son quota de créations ?
 *
 * Un compteur en mémoire suffit : le déploiement est mono-instance, et le but
 * n'est pas d'arrêter un attaquant déterminé — il n'y a rien à voler dans une
 * base vide — mais d'éviter qu'un script en boucle remplisse le disque.
 */
function quotaCreationDepasse(source) {
  const maintenant = Date.now();
  for (const [adresse, suivi] of creations) {
    if (maintenant - suivi.debut > FENETRE_CREATION_MS) creations.delete(adresse);
  }

  const suivi = creations.get(source);
  return Boolean(suivi && suivi.nombre >= CREATIONS_MAX);
}

/** Comptabilise une création. */
function compterCreation(source) {
  const maintenant = Date.now();
  const suivi = creations.get(source);
  if (!suivi || maintenant - suivi.debut > FENETRE_CREATION_MS) {
    creations.set(source, { debut: maintenant, nombre: 1 });
  } else {
    suivi.nombre += 1;
  }
}

/** Lit et valide un nom (association ou président). */
function lireNom(valeur, etiquette) {
  const nom = String(valeur || '').trim().replace(/\s+/g, ' ');
  if (nom.length < NOM_MIN || nom.length > NOM_MAX) {
    return { erreur: `${etiquette} : ${NOM_MIN} à ${NOM_MAX} caractères attendus` };
  }
  return { nom };
}

/**
 * Tire un code d'association libre.
 *
 * Trois chiffres sur mille par préfixe de trois lettres : une collision est
 * possible, elle n'est pas rare pour deux associations au nom voisin. On retire
 * jusqu'à vingt fois, puis on renonce en 503 plutôt que d'écraser une base
 * existante — ce serait la perte de données la plus grave imaginable.
 *
 * @returns {Promise<string|null>} code libre, ou null après ESSAIS_CODE essais
 */
async function tirerCodeLibre(nom) {
  for (let essai = 0; essai < ESSAIS_CODE; essai += 1) {
    const candidat = codes.tirerCodeAssociation(nom);
    if (!(await annuaire.codePris(candidat))) return candidat;
  }
  console.error(`[associations] aucun code libre trouvé pour « ${nom} » après ${ESSAIS_CODE} essais`);
  return null;
}

/**
 * POST /api/associations — créer une association.
 *
 * Corps : { nom, ville, telephone_president, nom_president, contribution_defaut }
 *
 * Réponse 201 : { code_association, code_president, nom }
 *
 * LE CODE PRÉSIDENT N'EST AFFICHÉ QU'ICI, une seule fois. Il n'est stocké que
 * haché : ni l'éditeur, ni aucune route, ne peut le retrouver. Si le président le
 * perd, il passe par la réinitialisation à contre-seing (section 3.4), pas par un
 * appel au support — il n'y en a pas.
 */
routeur.post('/', async (requete, reponse) => {
  const source = requete.ip || 'inconnue';

  if (quotaCreationDepasse(source)) {
    console.warn(`[associations] quota de création dépassé pour ${source}`);
    return reponse.status(429).json({
      error: 'Trop de créations depuis cet appareil. Réessayez dans une heure.',
    });
  }

  const lectureNom = lireNom(requete.body?.nom, "Nom de l'association");
  if (lectureNom.erreur) return reponse.status(400).json({ error: lectureNom.erreur });

  const lecturePresident = lireNom(requete.body?.nom_president, 'Nom du président');
  if (lecturePresident.erreur) return reponse.status(400).json({ error: lecturePresident.erreur });

  const telephone = codes.normaliserTelephone(requete.body?.telephone_president);
  if (!telephone) {
    return reponse.status(400).json({
      error: 'Téléphone du président invalide (format attendu : +237 puis neuf chiffres)',
    });
  }

  const ville = String(requete.body?.ville || '').trim().slice(0, NOM_MAX) || null;

  // La contribution par défaut est facultative : sans elle, le barème du produit
  // s'applique et le président l'ajuste depuis ses paramètres.
  let contribution = null;
  const contributionDemandee = requete.body?.contribution_defaut;
  if (contributionDemandee !== undefined && contributionDemandee !== null && String(contributionDemandee).trim() !== '') {
    const validation = parametres.valider('contribution_defaut', contributionDemandee);
    if (validation.erreur) return reponse.status(400).json({ error: validation.erreur });
    contribution = validation.valeur;
  }

  let association = null;
  try {
    const code = await tirerCodeLibre(lectureNom.nom);
    if (!code) {
      return reponse.status(503).json({
        error: 'Création momentanément impossible. Réessayez dans un instant.',
      });
    }

    association = await annuaire.inscrire({
      code,
      nom: lectureNom.nom,
      ville,
      telephonePresident: telephone,
    });

    // L'ouverture crée le fichier et applique le schéma complet, paramètres par
    // défaut compris : la base est immédiatement utilisable.
    const bd = await locataires.obtenirBase(association);
    await parametres.charger(bd);

    if (contribution) {
      await parametres.ecrire(bd, { contribution_defaut: contribution }, lecturePresident.nom);
    }

    // Le président est aussi un membre : il cotise comme les autres, et son
    // téléphone doit être en base pour que la réinitialisation par SMS marche.
    const membre = await bd.executer(
      "INSERT INTO members (name, telephone, date_adhesion, contribution, statut)" +
        " VALUES (?, ?, date('now', 'start of month'), ?, 'actif')",
      [lecturePresident.nom, telephone, parametres.entier(bd, 'contribution_defaut', 10000)]
    );

    // Le seul code DÉFINITIF que le produit remette jamais de lui-même. Il n'est
    // pas temporaire : il n'y a personne au-dessus du président pour lui en
    // donner un second, et l'obliger à le changer tout de suite alors qu'il vient
    // de le recevoir n'apporterait rien.
    const codePresident = codes.tirerCodeLisible();
    const empreinte = await codes.hacher(codePresident);
    await bd.executer(
      `INSERT INTO roles_codes (role, membre_id, libelle, code_hash, temporaire, actif)
       VALUES ('president', ?, ?, ?, 0, 1)`,
      [membre.id, lecturePresident.nom, empreinte]
    );

    console.log(
      `[associations] association créée : ${association.code} — « ${association.nom} »` +
        `${ville ? ` (${ville})` : ''} — président ${lecturePresident.nom}`
    );
    compterCreation(source);

    return reponse.status(201).json({
      code_association: association.code,
      code_president: codePresident,
      nom: association.nom,
      ville: association.ville,
      president: lecturePresident.nom,
      // Rappel destiné à l'écran de remise : il ne sera plus affiché.
      avertissement:
        'Notez ces deux codes maintenant : le code président ne sera plus jamais affiché.',
    });
  } catch (erreur) {
    console.error(`[associations] création impossible : ${erreur.message}`);
    if (association) {
      // L'association est inscrite mais incomplète : on le dit, plutôt que de
      // laisser croire à un échec total. Sa base sera complétée au prochain
      // démarrage par la migration, mais sans code président utilisable — le
      // journal ci-dessus est le seul moyen de le diagnostiquer.
      console.error(
        `[associations] ATTENTION : ${association.code} inscrite sans code président exploitable`
      );
    }
    return reponse.status(500).json({ error: "Impossible de créer l'association" });
  }
});

/**
 * POST /api/associations/verifier-code — à quelle association ce code appartient-il ?
 *
 * Corps : { code }  →  200 { code, nom, ville } | 404
 *
 * Sert à l'écran « Rejoindre une association » : le membre saisit les six
 * caractères que le président lui a dictés, et l'application lui affiche le nom
 * pour confirmation avant de mémoriser le code. Aucune donnée métier ne sort ici.
 */
routeur.post('/verifier-code', async (requete, reponse) => {
  const code = annuaire.normaliserCode(requete.body?.code);
  if (!code) {
    return reponse.status(400).json({ error: 'Code invalide (six lettres ou chiffres attendus)' });
  }

  try {
    const association = await annuaire.trouverParCode(code);
    if (!association) {
      console.warn(`[associations] code inconnu présenté : ${code}`);
      return reponse.status(404).json({ error: 'Aucune association ne porte ce code.' });
    }

    if (association.statut === 'suspendue') {
      return reponse.status(403).json({ error: 'Cette association est suspendue.' });
    }

    console.log(`[associations] code reconnu : ${code} — ${association.nom}`);
    return reponse.status(200).json({
      code: association.code,
      nom: association.nom,
      ville: association.ville,
    });
  } catch (erreur) {
    console.error(`[associations] vérification impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Vérification momentanément indisponible' });
  }
});

/**
 * GET /api/associations/moi — carte d'identité de l'association courante.
 *
 * Exige l'en-tête X-Association comme toutes les routes métier. L'application
 * s'en sert pour afficher le nom au bon endroit : plus aucun écran ne doit
 * écrire « Santé des extrêmes » en dur.
 */
routeur.get('/moi', (requete, reponse) => {
  if (!requete.association) {
    return reponse.status(400).json({
      error: "Association non précisée. Renseignez l'en-tête X-Association.",
      code: 'association_requise',
    });
  }

  return reponse.status(200).json({
    code: requete.association.code,
    nom: requete.association.nom,
    ville: requete.association.ville,
    date_creation: requete.association.date_creation,
    statut: requete.association.statut,
    parametres: parametres.vue(requete.db),
    roles: roles.LIBELLES_ROLES,
  });
});

module.exports = routeur;
