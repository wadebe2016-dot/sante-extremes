/**
 * Réinitialisation d'un code perdu — LOT 7 « DeuxZero ».
 *
 *   POST /api/reinitialisation/demander              { code_association, telephone }
 *   POST /api/reinitialisation/confirmer             { …, code_sms, nouveau_code }
 *   POST /api/reinitialisation/president             { code_association, telephone }
 *   POST /api/reinitialisation/president/confirmer   (authentifié par un rôle actif)
 *
 * Un membre du bureau qui a perdu son code se dépanne SEUL : ni l'éditeur — qui
 * n'entre jamais en contact avec les associations — ni le président n'ont à
 * intervenir. C'est une exigence du produit, et c'est aussi la porte d'entrée la
 * plus évidente vers les données d'une association. D'où quatre garde-fous :
 *
 *   1. RÉPONSE NEUTRE. « demander » répond la même chose que le numéro existe ou
 *      non. Sans cela, la route serait un annuaire des membres du bureau de
 *      chaque association, interrogeable sans aucun droit.
 *
 *   2. QUOTA MENSUEL. Trois réinitialisations par mois et par association, tous
 *      rôles confondus. C'est autant une protection contre l'abus qu'un plafond
 *      de facture : chaque SMS est payé par l'éditeur.
 *
 *   3. BLOCAGE APRÈS ÉCHECS. Cinq codes SMS erronés et le numéro est bloqué une
 *      heure. Le code fait six chiffres : sans ce plafond, un million d'essais
 *      viendrait à bout de n'importe quel code en quelques heures.
 *
 *   4. CONTRE-SEING POUR LE PRÉSIDENT. Personne n'est au-dessus de lui pour
 *      attester que la demande vient bien de lui : il faut DEUX autres titulaires
 *      de rôle pour confirmer, dans les vingt-quatre heures.
 *
 * Ces routes sont dispensées de l'en-tête X-Association : leur appelant n'a plus
 * d'application configurée, il saisit le code de son association à la main. Elles
 * résolvent donc la base depuis le corps de la requête.
 */
'use strict';

const express = require('express');

const { resoudreDepuisCorps } = require('../middleware/association');
const { exigerTitulaire } = require('../middleware/auth');
const codes = require('../services/codes');
const roles = require('../services/roles');
const { envoyerSms } = require('../services/sms');

const routeur = express.Router();

/** Validité d'un code SMS, en minutes. */
const MINUTES_CODE_SMS = 15;

/** Réinitialisations autorisées par mois et par association, tous rôles confondus. */
const QUOTA_MENSUEL = Number(process.env.REINIT_QUOTA_MENSUEL) > 0
  ? Number(process.env.REINIT_QUOTA_MENSUEL)
  : 3;

/** Codes SMS erronés avant blocage du numéro. */
const ECHECS_MAX = 5;

/** Durée du blocage d'un numéro après ECHECS_MAX échecs, en minutes. */
const MINUTES_BLOCAGE = 60;

/** Confirmations nécessaires pour réinitialiser le code du président. */
const CONTRESEINGS_REQUIS = 2;

/** Validité d'une demande de réinitialisation du code président, en heures. */
const HEURES_DEMANDE_PRESIDENT = 24;

/**
 * Réponse volontairement identique dans tous les cas de « demander ».
 *
 * Ni le code d'association inconnu, ni le numéro absent, ni le rôle inexistant ne
 * se distinguent d'un envoi réussi. C'est le seul moyen d'empêcher l'énumération.
 */
const REPONSE_NEUTRE = Object.freeze({
  message:
    'Si ce numéro correspond à un membre du bureau, un code de vérification lui a été envoyé par SMS. ' +
    'Il est valable 15 minutes.',
});

/** Horodatage ISO à la seconde, au format des dates de la base. */
function maintenant() {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** Horodatage ISO dans [minutes] minutes. */
function dansMinutes(minutes) {
  return `${new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19)}Z`;
}

/** Horodatage ISO dans [heures] heures. */
function dansHeures(heures) {
  return `${new Date(Date.now() + heures * 3600000).toISOString().slice(0, 19)}Z`;
}

/** Mois courant, AAAA-MM : c'est lui qui porte le quota. */
function moisCourant() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Le quota mensuel de l'association est-il atteint ?
 *
 * Seules les demandes ABOUTIES comptent — une demande dont le SMS n'est jamais
 * parti, ou dont le code a expiré sans être utilisé, ne doit pas consommer le
 * droit d'un collègue. Le quota protège de l'abus, il ne punit pas la malchance.
 */
async function quotaAtteint(bd) {
  const ligne = await bd.lireUne(
    `SELECT COUNT(*) AS nombre
       FROM reinitialisations
      WHERE resultat = 'confirmee' AND substr(date_demande, 1, 7) = ?`,
    [moisCourant()]
  );
  return ligne ? Number(ligne.nombre) >= QUOTA_MENSUEL : false;
}

/** Le numéro est-il bloqué pour cause d'échecs répétés ? */
async function numeroBloque(bd, telephone) {
  const ligne = await bd.lireUne(
    `SELECT MAX(bloque_jusqua) AS jusqua
       FROM reinitialisations
      WHERE telephone = ? AND bloque_jusqua IS NOT NULL`,
    [telephone]
  );
  return Boolean(ligne && ligne.jusqua && ligne.jusqua > maintenant());
}

/**
 * Dernière demande en cours pour ce numéro, ou undefined.
 *
 * « En cours » veut dire : demandée, non encore confirmée, non expirée. Une
 * demande plus récente annule la précédente — si le membre du bureau a cliqué
 * deux fois, c'est le second SMS qu'il a sous les yeux.
 */
async function demandeEnCours(bd, telephone) {
  return bd.lireUne(
    `SELECT * FROM reinitialisations
      WHERE telephone = ? AND resultat = 'demandee' AND expire_le > ?
      ORDER BY id DESC LIMIT 1`,
    [telephone, maintenant()]
  );
}

/** Journalise une réinitialisation, téléphone masqué. */
function journaliser(action, telephone, association, detail = '') {
  console.log(
    `[reinitialisation] ${action} — ${codes.masquerTelephone(telephone)} — ` +
      `${association || 'association inconnue'}${detail ? ` — ${detail}` : ''}`
  );
}

/**
 * POST /api/reinitialisation/demander — envoyer un code SMS.
 *
 * Réponse toujours 200 et toujours identique, sauf dépassement de quota, qui est
 * dit explicitement : à ce stade l'appelant est déjà identifié comme titulaire
 * d'un rôle, et lui laisser croire à un envoi qui ne viendra jamais serait
 * cruel. Le message l'oriente vers la seule issue : demander un code temporaire
 * au président.
 */
routeur.post('/demander', async (requete, reponse) => {
  const telephone = codes.normaliserTelephone(requete.body?.telephone);
  const resolution = await resoudreDepuisCorps(requete.body?.code_association).catch((erreur) => {
    console.error(`[reinitialisation] association illisible : ${erreur.message}`);
    return { refus: 'indisponible' };
  });

  // Association inconnue ou numéro invalide : réponse neutre. Dire lequel des
  // deux est en cause suffirait à énumérer les codes d'association.
  if (resolution.refus || !telephone) {
    journaliser('demande écartée', requete.body?.telephone, requete.body?.code_association, resolution.refus || 'téléphone invalide');
    return reponse.status(200).json(REPONSE_NEUTRE);
  }

  const { bd, association } = resolution;

  try {
    if (await numeroBloque(bd, telephone)) {
      journaliser('demande refusée, numéro bloqué', telephone, association.code);
      return reponse.status(429).json({
        error: `Trop de codes erronés. Réessayez dans ${MINUTES_BLOCAGE} minutes.`,
        code: 'numero_bloque',
      });
    }

    if (await quotaAtteint(bd)) {
      await bd.executer(
        `INSERT INTO reinitialisations (telephone, resultat, adresse_ip) VALUES (?, 'hors_quota', ?)`,
        [telephone, requete.ip || null]
      );
      journaliser('demande refusée, quota mensuel atteint', telephone, association.code);
      return reponse.status(429).json({
        error:
          `Le quota de ${QUOTA_MENSUEL} réinitialisations pour ce mois est atteint. ` +
          'Demandez un code temporaire à votre président : il n’est jamais bloqué pour cette action.',
        code: 'quota_mensuel',
      });
    }

    const role = await roles.roleParTelephone(bd, telephone);
    if (!role) {
      // Numéro inconnu, ou membre sans rôle : réponse neutre, aucun SMS.
      await bd.executer(
        `INSERT INTO reinitialisations (telephone, resultat, adresse_ip) VALUES (?, 'refusee', ?)`,
        [telephone, requete.ip || null]
      );
      journaliser('demande sans titulaire correspondant', telephone, association.code);
      return reponse.status(200).json(REPONSE_NEUTRE);
    }

    const codeSms = codes.tirerCodeSms();
    const empreinte = await codes.hacher(codeSms);
    const expire = dansMinutes(MINUTES_CODE_SMS);

    const enregistrement = await bd.executer(
      `INSERT INTO reinitialisations
         (telephone, role_id, role, code_hash, expire_le, resultat, adresse_ip)
       VALUES (?, ?, ?, ?, ?, 'demandee', ?)`,
      [telephone, role.id, role.role, empreinte, expire, requete.ip || null]
    );

    const envoi = await envoyerSms({
      destinataire: telephone,
      message:
        `${association.nom} — DeuxZero\n` +
        `Votre code de vérification est ${codeSms}. Il est valable ${MINUTES_CODE_SMS} minutes.\n` +
        'Ne le communiquez à personne.',
      association: association.code,
      motif: 'reinitialisation_role',
    });

    if (!envoi.succes) {
      // Le SMS n'est pas parti : la demande ne doit pas rester ouverte, sinon
      // elle bloquerait une nouvelle tentative pendant quinze minutes.
      await bd.executer(
        "UPDATE reinitialisations SET resultat = 'expiree', date_fin = ? WHERE id = ?",
        [maintenant(), enregistrement.id]
      );
      journaliser('SMS non délivré', telephone, association.code, envoi.erreur || 'cause inconnue');
      return reponse.status(503).json({
        error: 'L’envoi du SMS a échoué. Réessayez dans quelques minutes.',
      });
    }

    journaliser('code SMS envoyé', telephone, association.code, role.role);
    return reponse.status(200).json(REPONSE_NEUTRE);
  } catch (erreur) {
    console.error(`[reinitialisation] demande impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Réinitialisation momentanément indisponible' });
  }
});

/**
 * POST /api/reinitialisation/confirmer — valider le code SMS et poser le nouveau code.
 *
 * Corps : { code_association, telephone, code_sms, nouveau_code }
 *
 * Le nouveau code est choisi par son porteur et n'est connu que de lui : le
 * président ne le voit pas plus que s'il avait remis un code temporaire.
 */
routeur.post('/confirmer', async (requete, reponse) => {
  const telephone = codes.normaliserTelephone(requete.body?.telephone);
  const codeSms = String(requete.body?.code_sms || '').trim();
  const nouveau = requete.body?.nouveau_code;

  const refus = codes.refusCodePersonnel(nouveau);
  if (refus) return reponse.status(400).json({ error: refus });

  const resolution = await resoudreDepuisCorps(requete.body?.code_association).catch((erreur) => {
    console.error(`[reinitialisation] association illisible : ${erreur.message}`);
    return { refus: 'indisponible' };
  });

  if (resolution.refus || !telephone || !/^\d{6}$/.test(codeSms)) {
    return reponse.status(400).json({ error: 'Code de vérification invalide ou expiré.' });
  }

  const { bd, association } = resolution;

  try {
    if (await numeroBloque(bd, telephone)) {
      return reponse.status(429).json({
        error: `Trop de codes erronés. Réessayez dans ${MINUTES_BLOCAGE} minutes.`,
        code: 'numero_bloque',
      });
    }

    const demande = await demandeEnCours(bd, telephone);
    if (!demande) {
      journaliser('confirmation sans demande valable', telephone, association.code);
      return reponse.status(400).json({ error: 'Code de vérification invalide ou expiré.' });
    }

    const correspond = await codes.verifier(codeSms, demande.code_hash);
    if (!correspond) {
      const tentatives = Number(demande.tentatives || 0) + 1;
      const bloque = tentatives >= ECHECS_MAX;

      await bd.executer(
        `UPDATE reinitialisations
            SET tentatives = ?, bloque_jusqua = ?, resultat = ?
          WHERE id = ?`,
        [
          tentatives,
          bloque ? dansMinutes(MINUTES_BLOCAGE) : demande.bloque_jusqua,
          bloque ? 'bloquee' : 'demandee',
          demande.id,
        ]
      );

      journaliser(
        'code SMS erroné',
        telephone,
        association.code,
        `échec ${tentatives}/${ECHECS_MAX}${bloque ? ' — numéro bloqué 1 h' : ''}`
      );

      if (bloque) {
        return reponse.status(429).json({
          error: `Trop de codes erronés. Réessayez dans ${MINUTES_BLOCAGE} minutes.`,
          code: 'numero_bloque',
        });
      }
      return reponse.status(401).json({ error: 'Code de vérification incorrect.' });
    }

    // Le rôle a pu être révoqué entre la demande et la confirmation.
    const role = await bd.lireUne('SELECT id, role, actif FROM roles_codes WHERE id = ?', [
      demande.role_id,
    ]);
    if (!role || role.actif !== 1) {
      await bd.executer("UPDATE reinitialisations SET resultat = 'refusee', date_fin = ? WHERE id = ?", [
        maintenant(),
        demande.id,
      ]);
      journaliser('rôle révoqué entre-temps', telephone, association.code);
      return reponse.status(409).json({ error: 'Ce rôle n’est plus actif.' });
    }

    await roles.definirCodePersonnel(bd, role.id, nouveau);
    await bd.executer("UPDATE reinitialisations SET resultat = 'confirmee', date_fin = ? WHERE id = ?", [
      maintenant(),
      demande.id,
    ]);

    journaliser('code réinitialisé', telephone, association.code, role.role);
    return reponse.status(200).json({
      role: role.role,
      role_libelle: roles.LIBELLES_ROLES[role.role] || role.role,
      code_reinitialise: true,
      message: 'Votre nouveau code est enregistré. Vous pouvez vous connecter.',
    });
  } catch (erreur) {
    if (erreur.refusUtilisateur) return reponse.status(400).json({ error: erreur.message });
    console.error(`[reinitialisation] confirmation impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Réinitialisation momentanément indisponible' });
  }
});

/**
 * POST /api/reinitialisation/president — ouvrir une demande à contre-seing.
 *
 * Corps : { code_association, telephone }
 *
 * Le président n'a personne au-dessus de lui. Sa récupération passe donc par
 * DEUX autres titulaires de rôle, prévenus par SMS, qui confirment depuis
 * l'application. Sans deux confirmations en vingt-quatre heures, la demande
 * expire silencieusement.
 *
 * Le téléphone doit être celui inscrit dans l'ANNUAIRE, pas dans la base de
 * l'association : c'est le numéro donné à la création, celui qu'un président ne
 * peut pas modifier lui-même après avoir perdu son accès.
 */
routeur.post('/president', async (requete, reponse) => {
  const telephone = codes.normaliserTelephone(requete.body?.telephone);
  const resolution = await resoudreDepuisCorps(requete.body?.code_association).catch((erreur) => {
    console.error(`[reinitialisation] association illisible : ${erreur.message}`);
    return { refus: 'indisponible' };
  });

  if (resolution.refus || !telephone) {
    return reponse.status(200).json({
      message:
        'Si ce numéro est celui du président, deux membres du bureau ont été prévenus. ' +
        'La demande aboutira dès que deux d’entre eux auront confirmé.',
    });
  }

  const { bd, association } = resolution;

  try {
    if (telephone !== codes.normaliserTelephone(association.telephone_president)) {
      journaliser('demande président avec numéro non concordant', telephone, association.code);
      return reponse.status(200).json({
        message:
          'Si ce numéro est celui du président, deux membres du bureau ont été prévenus. ' +
          'La demande aboutira dès que deux d’entre eux auront confirmé.',
      });
    }

    // Une demande déjà ouverte n'en ouvre pas une seconde : sinon chaque appel
    // enverrait deux SMS de plus, aux frais de l'éditeur.
    const ouverte = await bd.lireUne(
      `SELECT * FROM demandes_president
        WHERE etat = 'en_attente' AND expire_le > ?
        ORDER BY id DESC LIMIT 1`,
      [maintenant()]
    );

    if (ouverte) {
      journaliser('demande président déjà ouverte', telephone, association.code, `#${ouverte.id}`);
      return reponse.status(200).json({
        demande_id: ouverte.id,
        confirmations: ouverte.confirmations,
        confirmations_requises: CONTRESEINGS_REQUIS,
        expire_le: ouverte.expire_le,
        message: `Une demande est déjà en cours : ${ouverte.confirmations}/${CONTRESEINGS_REQUIS} confirmation(s).`,
      });
    }

    const temoins = await roles.contresignataires(bd);
    if (temoins.length < CONTRESEINGS_REQUIS) {
      // Cas réel et sans issue automatique : une association dont le bureau n'a
      // qu'un seul autre titulaire. On le dit clairement plutôt que de laisser
      // le président attendre un SMS qui ne viendra pas.
      journaliser('contre-seing impossible', telephone, association.code, `${temoins.length} titulaire(s)`);
      return reponse.status(409).json({
        error:
          `Il faut au moins ${CONTRESEINGS_REQUIS} autres membres du bureau avec un téléphone renseigné ` +
          'pour confirmer cette demande. Votre association n’en compte pas assez.',
        code: 'contreseing_impossible',
        titulaires_disponibles: temoins.length,
      });
    }

    const demande = await bd.executer(
      `INSERT INTO demandes_president (demandeur, etat, adresse_ip, expire_le)
       VALUES (?, 'en_attente', ?, ?)`,
      [telephone, requete.ip || null, dansHeures(HEURES_DEMANDE_PRESIDENT)]
    );

    for (const temoin of temoins) {
      await envoyerSms({
        destinataire: temoin.membre_telephone,
        message:
          `${association.nom} — DeuxZero\n` +
          `Le président demande la réinitialisation de son code. ` +
          'Répondez dans l’application pour confirmer (écran Rôles et accès).\n' +
          `Demande valable ${HEURES_DEMANDE_PRESIDENT} heures.`,
        association: association.code,
        motif: 'contreseing_president',
      });
    }

    journaliser(
      'demande président ouverte',
      telephone,
      association.code,
      `#${demande.id} — ${temoins.length} témoin(s) prévenu(s)`
    );

    return reponse.status(201).json({
      demande_id: demande.id,
      confirmations: 0,
      confirmations_requises: CONTRESEINGS_REQUIS,
      message:
        `${temoins.length} membres du bureau ont été prévenus par SMS. ` +
        `Votre code vous sera envoyé dès que ${CONTRESEINGS_REQUIS} d’entre eux auront confirmé.`,
    });
  } catch (erreur) {
    console.error(`[reinitialisation] demande président impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Réinitialisation momentanément indisponible' });
  }
});

/**
 * POST /api/reinitialisation/president/confirmer — contresigner.
 *
 * Authentifié par un rôle actif, autre que celui du président concerné. À la
 * DEUXIÈME confirmation — par deux personnes DIFFÉRENTES, ce que garantit la
 * contrainte UNIQUE de confirmations_president — un code temporaire est envoyé
 * par SMS au président.
 *
 * Cette route exige l'en-tête X-Association comme n'importe quelle route
 * authentifiée : celui qui confirme, lui, a toujours son code.
 */
routeur.post('/president/confirmer', exigerTitulaire(), async (requete, reponse) => {
  const bd = requete.db;
  const association = requete.association;

  try {
    const demande = await bd.lireUne(
      `SELECT * FROM demandes_president
        WHERE etat = 'en_attente' AND expire_le > ?
        ORDER BY id DESC LIMIT 1`,
      [maintenant()]
    );

    if (!demande) {
      return reponse.status(404).json({
        error: 'Aucune demande de réinitialisation en cours.',
        code: 'aucune_demande',
      });
    }

    if (!requete.roleId) {
      return reponse.status(409).json({
        error: 'Ce code ne permet pas de contresigner depuis l’application.',
      });
    }

    // Le président ne peut pas se contresigner lui-même : ce serait vider le
    // mécanisme de tout son sens.
    if (requete.roleCourant === 'president') {
      return reponse.status(403).json({
        error: 'Le président ne peut pas confirmer sa propre demande.',
        code: 'auto_contreseing',
      });
    }

    try {
      await bd.executer(
        'INSERT INTO confirmations_president (demande_id, role_id, role) VALUES (?, ?, ?)',
        [demande.id, requete.roleId, requete.roleCourant]
      );
    } catch (erreur) {
      // La contrainte UNIQUE (demande_id, role_id) est le cœur du dispositif :
      // « deux titulaires » veut dire deux personnes, pas deux clics.
      if (String(erreur.message).includes('UNIQUE')) {
        const deja = await bd.lireUne(
          'SELECT confirmations FROM demandes_president WHERE id = ?',
          [demande.id]
        );
        return reponse.status(409).json({
          error: 'Vous avez déjà confirmé cette demande.',
          code: 'deja_confirme',
          confirmations: deja ? deja.confirmations : demande.confirmations,
          confirmations_requises: CONTRESEINGS_REQUIS,
        });
      }
      throw erreur;
    }

    const compte = await bd.lireUne(
      'SELECT COUNT(*) AS nombre FROM confirmations_president WHERE demande_id = ?',
      [demande.id]
    );
    const confirmations = compte ? Number(compte.nombre) : 0;

    await bd.executer('UPDATE demandes_president SET confirmations = ? WHERE id = ?', [
      confirmations,
      demande.id,
    ]);

    console.log(
      `[reinitialisation] contre-seing #${demande.id} — ${confirmations}/${CONTRESEINGS_REQUIS} ` +
        `— par ${requete.roleCourant} [${association.code}]`
    );

    if (confirmations < CONTRESEINGS_REQUIS) {
      return reponse.status(200).json({
        demande_id: demande.id,
        confirmations,
        confirmations_requises: CONTRESEINGS_REQUIS,
        aboutie: false,
        message: `Confirmation enregistrée. Il en manque ${CONTRESEINGS_REQUIS - confirmations}.`,
      });
    }

    // Deuxième confirmation : le président reçoit un code TEMPORAIRE, pas un code
    // définitif. Il choisira le sien à la connexion, comme n'importe quel
    // titulaire — personne, pas même les deux témoins, ne le connaîtra.
    const presidents = await bd.lireToutes(
      "SELECT id FROM roles_codes WHERE role = 'president' AND actif = 1 ORDER BY id ASC"
    );

    let emission;
    if (presidents.length > 0) {
      emission = await roles.renouveler(bd, presidents[0].id);
    } else {
      // Aucun président actif : la demande vaut réattribution du rôle. Le
      // titulaire est le membre dont le téléphone est celui de l'annuaire.
      const membre = await bd.lireUne('SELECT id, name FROM members WHERE telephone = ?', [
        demande.demandeur,
      ]);
      emission = await roles.attribuer(bd, {
        role: 'president',
        membreId: membre ? membre.id : null,
        libelle: membre ? membre.name : 'Président',
      });
    }

    const envoi = await envoyerSms({
      destinataire: demande.demandeur,
      message:
        `${association.nom} — DeuxZero\n` +
        `Deux membres du bureau ont confirmé votre demande. Votre code temporaire est ${emission.code}.\n` +
        `Valable ${roles.HEURES_CODE_TEMPORAIRE} heures. Vous choisirez votre code personnel à la connexion.`,
      association: association.code,
      motif: 'code_president_reinitialise',
    });

    await bd.executer(
      "UPDATE demandes_president SET etat = 'confirmee', date_fin = ? WHERE id = ?",
      [maintenant(), demande.id]
    );

    journaliser(
      'code président réinitialisé',
      demande.demandeur,
      association.code,
      envoi.succes ? 'SMS délivré' : `SMS en échec : ${envoi.erreur}`
    );

    return reponse.status(200).json({
      demande_id: demande.id,
      confirmations,
      confirmations_requises: CONTRESEINGS_REQUIS,
      aboutie: true,
      sms_envoye: envoi.succes,
      message: envoi.succes
        ? 'Demande confirmée. Un code temporaire a été envoyé au président par SMS.'
        : 'Demande confirmée, mais l’envoi du SMS a échoué. Le président doit refaire une demande.',
    });
  } catch (erreur) {
    console.error(`[reinitialisation] contre-seing impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Réinitialisation momentanément indisponible' });
  }
});

/**
 * GET /api/reinitialisation/president/en-cours — état de la demande courante.
 *
 * Sert l'écran des témoins (« le président demande… confirmer ? ») et celui du
 * président, qui voit avancer les confirmations sans avoir à rappeler personne.
 */
routeur.get('/president/en-cours', exigerTitulaire(), async (requete, reponse) => {
  try {
    const demande = await requete.db.lireUne(
      `SELECT id, confirmations, etat, date_demande, expire_le
         FROM demandes_president
        WHERE etat = 'en_attente' AND expire_le > ?
        ORDER BY id DESC LIMIT 1`,
      [maintenant()]
    );

    if (!demande) return reponse.status(200).json({ demande: null });

    const dejaConfirme = requete.roleId
      ? await requete.db.lireUne(
          'SELECT id FROM confirmations_president WHERE demande_id = ? AND role_id = ?',
          [demande.id, requete.roleId]
        )
      : null;

    return reponse.status(200).json({
      demande: {
        id: demande.id,
        confirmations: demande.confirmations,
        confirmations_requises: CONTRESEINGS_REQUIS,
        date_demande: demande.date_demande,
        expire_le: demande.expire_le,
        deja_confirme_par_moi: Boolean(dejaConfirme),
        peut_confirmer: requete.roleCourant !== 'president' && !dejaConfirme,
      },
    });
  } catch (erreur) {
    console.error(`[reinitialisation] lecture de la demande impossible : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Lecture momentanément indisponible' });
  }
});

module.exports = routeur;
module.exports.QUOTA_MENSUEL = QUOTA_MENSUEL;
module.exports.ECHECS_MAX = ECHECS_MAX;
module.exports.MINUTES_CODE_SMS = MINUTES_CODE_SMS;
module.exports.MINUTES_BLOCAGE = MINUTES_BLOCAGE;
module.exports.CONTRESEINGS_REQUIS = CONTRESEINGS_REQUIS;
