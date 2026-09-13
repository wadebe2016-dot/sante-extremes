/**
 * Sanctions — pénalités financières et suspensions (LOT 3).
 *
 *   GET    /api/sanctions?statut=due|toutes&annee=AAAA   (public)
 *   POST   /api/sanctions                                (censeur)
 *   POST   /api/sanctions/:id/lever                      (censeur)
 *   DELETE /api/sanctions/:id                            (censeur)
 *
 * Règle métier centrale : une pénalité n'est PAS une cotisation. Son règlement
 * n'entre ni dans le total encaissé des cotisations, ni dans l'historique
 * annuel, ni dans le statut payé/impayé du mois. Les deux comptabilités sont
 * tenues séparément (tables distinctes, routes distinctes).
 */
'use strict';

const express = require('express');
const { executer, lireUne, lireToutes } = require('../db');
const { exigerRole } = require('../middleware/auth');

const routeur = express.Router();

/**
 * Motifs prédéfinis : liste fermée, plus « autre » accompagné d'un texte libre.
 * La valeur stockée en base est le libellé affichable (ou le texte libre).
 */
const MOTIFS = Object.freeze({
  retard: 'Retard',
  absence: 'Absence',
  comportement: 'Comportement',
  tenue: 'Tenue',
  autre: 'Autre',
});

const TYPES = Object.freeze(['penalite', 'suspension']);

/** Date du jour au format AAAA-MM-JJ, pour comparer aux dates de fin de suspension. */
function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Une suspension n'est active que si elle n'a été ni levée ni annulée ET que
 * son terme n'est pas dépassé. Une suspension échue reste en base avec le
 * statut « due » : c'est la date qui fait foi, pas le statut.
 */
function suspensionActive(sanction, jour = aujourdhui()) {
  return (
    sanction.type === 'suspension' &&
    sanction.statut === 'due' &&
    typeof sanction.date_fin === 'string' &&
    sanction.date_fin >= jour
  );
}

/** Une pénalité pèse sur le membre tant qu'elle n'est ni réglée ni annulée. */
function penaliteDue(sanction) {
  return sanction.type === 'penalite' && sanction.statut === 'due';
}

/**
 * Ordre d'affichage demandé : suspensions actives, puis pénalités dues, puis
 * le reste (réglées, levées, annulées) de la plus récente à la plus ancienne.
 */
function rangAffichage(sanction) {
  if (suspensionActive(sanction)) return 0;
  if (penaliteDue(sanction)) return 1;
  return 2;
}

/** Met en forme une ligne de la base pour l'API. */
function formaterSanction(ligne) {
  return {
    id: ligne.id,
    member_id: ligne.member_id,
    member_name: ligne.member_name,
    type: ligne.type,
    motif: ligne.motif,
    montant: ligne.montant === null ? null : Number(ligne.montant),
    date_fin: ligne.date_fin || null,
    statut: ligne.statut,
    date_sanction: ligne.date_sanction,
    date_reglement: ligne.date_reglement || null,
    moyen_reglement: ligne.moyen_reglement || null,
    fichier_s3_url: ligne.fichier_s3_url || null,
    suspension_active: suspensionActive(ligne),
  };
}

/**
 * GET /api/sanctions — liste publique des sanctions.
 * @query statut « due » (défaut) ou « toutes »
 * @query annee  année des sanctions à retenir (défaut : toutes années)
 */
routeur.get('/', async (requete, reponse) => {
  const statutDemande = String(requete.query.statut || 'due').toLowerCase();
  const anneeBrute = requete.query.annee;

  if (!['due', 'toutes'].includes(statutDemande)) {
    return reponse.status(400).json({ error: 'Paramètre « statut » invalide (due ou toutes)' });
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

    // Les sanctions annulées ne sont jamais affichées : suppression douce.
    conditions.push("s.statut <> 'annulee'");

    if (statutDemande === 'due') {
      conditions.push("s.statut = 'due'");
    }

    if (annee !== null) {
      conditions.push("strftime('%Y', s.date_sanction) = ?");
      parametres.push(String(annee));
    }

    const lignes = await lireToutes(
      `SELECT s.*, m.name AS member_name
         FROM sanctions s
         JOIN members m ON m.id = s.member_id
        WHERE ${conditions.join(' AND ')}`,
      parametres
    );

    const jour = aujourdhui();
    const sanctions = lignes.map(formaterSanction).sort((a, b) => {
      const ecart = rangAffichage(a) - rangAffichage(b);
      if (ecart !== 0) return ecart;
      return String(b.date_sanction).localeCompare(String(a.date_sanction));
    });

    // Synthèse par membre : ce que l'écran État affiche en pastilles.
    const parMembre = new Map();
    for (const ligne of lignes) {
      if (!parMembre.has(ligne.member_id)) {
        parMembre.set(ligne.member_id, {
          id: ligne.member_id,
          name: ligne.member_name,
          penalite_due: 0,
          suspendu: false,
          date_fin_suspension: null,
        });
      }

      const entree = parMembre.get(ligne.member_id);
      if (penaliteDue(ligne)) entree.penalite_due += Number(ligne.montant) || 0;
      if (suspensionActive(ligne, jour)) {
        entree.suspendu = true;
        // En cas de suspensions multiples, on retient le terme le plus lointain.
        if (!entree.date_fin_suspension || ligne.date_fin > entree.date_fin_suspension) {
          entree.date_fin_suspension = ligne.date_fin;
        }
      }
    }

    const resume = {
      total_penalites_dues: sanctions
        .filter((sanction) => penaliteDue(sanction))
        .reduce((somme, sanction) => somme + (sanction.montant || 0), 0),
      nb_suspensions_actives: sanctions.filter((sanction) => sanction.suspension_active).length,
      nb_sanctions: sanctions.length,
    };

    console.log(
      `[sanctions] liste servie : ${resume.nb_sanctions} sanction(s), ` +
        `${resume.total_penalites_dues} XAF dus, ${resume.nb_suspensions_actives} suspension(s) active(s)`
    );

    return reponse.status(200).json({
      annee,
      statut: statutDemande,
      resume,
      sanctions,
      par_membre: [...parMembre.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    });
  } catch (erreur) {
    console.error(`[sanctions] échec de la lecture : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de charger les sanctions' });
  }
});

/**
 * POST /api/sanctions — infliger une sanction (censeur).
 * @body member_id, type ('penalite'|'suspension'), motif, motif_libre?, montant?, date_fin?
 */
routeur.post('/', exigerRole('censeur'), async (requete, reponse) => {
  const idMembre = Number.parseInt(requete.body?.member_id, 10);
  const type = String(requete.body?.type || '').trim().toLowerCase();
  const codeMotif = String(requete.body?.motif || '').trim().toLowerCase();
  const motifLibre = typeof requete.body?.motif_libre === 'string' ? requete.body.motif_libre.trim() : '';

  if (!Number.isInteger(idMembre) || idMembre <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de membre invalide' });
  }

  if (!TYPES.includes(type)) {
    return reponse.status(400).json({ error: `Type invalide (attendu : ${TYPES.join(' ou ')})` });
  }

  if (!Object.prototype.hasOwnProperty.call(MOTIFS, codeMotif)) {
    return reponse
      .status(400)
      .json({ error: `Motif invalide (attendu : ${Object.keys(MOTIFS).join(', ')})` });
  }

  // « autre » impose un texte : sans quoi la sanction serait incompréhensible.
  if (codeMotif === 'autre' && !motifLibre) {
    return reponse.status(400).json({ error: 'Précisez le motif' });
  }

  const motif = codeMotif === 'autre' ? motifLibre.slice(0, 200) : MOTIFS[codeMotif];

  let montant = null;
  let dateFin = null;

  if (type === 'penalite') {
    montant = Number.parseFloat(requete.body?.montant);
    if (!Number.isFinite(montant) || montant <= 0) {
      return reponse.status(400).json({ error: 'Le montant de la pénalité doit être strictement positif' });
    }
  } else {
    dateFin = String(requete.body?.date_fin || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFin)) {
      return reponse.status(400).json({ error: 'Date de fin invalide (format attendu : AAAA-MM-JJ)' });
    }
    if (dateFin < aujourdhui()) {
      return reponse.status(400).json({ error: 'La date de fin de suspension doit être future' });
    }
  }

  try {
    const membre = await lireUne('SELECT id, name FROM members WHERE id = ?', [idMembre]);
    if (!membre) {
      return reponse.status(404).json({ error: 'Membre introuvable' });
    }

    const resultat = await executer(
      'INSERT INTO sanctions (member_id, type, motif, montant, date_fin) VALUES (?, ?, ?, ?, ?)',
      [idMembre, type, motif, montant, dateFin]
    );

    const ligne = await lireUne(
      `SELECT s.*, m.name AS member_name
         FROM sanctions s JOIN members m ON m.id = s.member_id
        WHERE s.id = ?`,
      [resultat.id]
    );

    const detail = type === 'penalite' ? `${montant} XAF` : `jusqu'au ${dateFin}`;
    console.log(`[sanctions] sanction infligée : #${ligne.id} — ${membre.name} — ${type} (${motif}, ${detail})`);
    return reponse.status(201).json(formaterSanction(ligne));
  } catch (erreur) {
    console.error(`[sanctions] échec de l'enregistrement : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'enregistrer la sanction" });
  }
});

/** POST /api/sanctions/:id/lever — lever une suspension avant son terme (censeur). */
routeur.post('/:id/lever', exigerRole('censeur'), async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);

  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de sanction invalide' });
  }

  try {
    const sanction = await lireUne('SELECT * FROM sanctions WHERE id = ?', [identifiant]);
    if (!sanction) {
      return reponse.status(404).json({ error: 'Sanction introuvable' });
    }

    if (sanction.type !== 'suspension') {
      return reponse.status(400).json({ error: 'Seule une suspension peut être levée' });
    }

    if (sanction.statut !== 'due') {
      return reponse.status(409).json({ error: `Cette suspension est déjà « ${sanction.statut} »` });
    }

    await executer("UPDATE sanctions SET statut = 'levee' WHERE id = ?", [identifiant]);

    const ligne = await lireUne(
      `SELECT s.*, m.name AS member_name
         FROM sanctions s JOIN members m ON m.id = s.member_id
        WHERE s.id = ?`,
      [identifiant]
    );

    console.log(`[sanctions] suspension levée : #${identifiant} — ${ligne.member_name}`);
    return reponse.status(200).json(formaterSanction(ligne));
  } catch (erreur) {
    console.error(`[sanctions] échec de la levée #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de lever la suspension' });
  }
});

/**
 * DELETE /api/sanctions/:id — annuler une sanction (censeur).
 *
 * Suppression douce : la ligne passe au statut « annulee » et disparaît des
 * listes, mais reste en base. Une sanction effacée sans trace serait
 * impossible à justifier en assemblée.
 */
routeur.delete('/:id', exigerRole('censeur'), async (requete, reponse) => {
  const identifiant = Number.parseInt(requete.params.id, 10);

  if (!Number.isInteger(identifiant) || identifiant <= 0) {
    return reponse.status(400).json({ error: 'Identifiant de sanction invalide' });
  }

  try {
    const sanction = await lireUne('SELECT * FROM sanctions WHERE id = ?', [identifiant]);
    if (!sanction) {
      return reponse.status(404).json({ error: 'Sanction introuvable' });
    }

    if (sanction.statut === 'annulee') {
      return reponse.status(409).json({ error: 'Cette sanction est déjà annulée' });
    }

    if (sanction.statut === 'reglee') {
      return reponse.status(409).json({ error: 'Une pénalité déjà réglée ne peut plus être annulée' });
    }

    await executer("UPDATE sanctions SET statut = 'annulee' WHERE id = ?", [identifiant]);

    console.log(`[sanctions] sanction annulée : #${identifiant}`);
    return reponse.status(200).json({ message: 'Sanction annulée' });
  } catch (erreur) {
    console.error(`[sanctions] échec de l'annulation #${identifiant} : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible d'annuler la sanction" });
  }
});

module.exports = routeur;
module.exports.MOTIFS = MOTIFS;
module.exports.suspensionActive = suspensionActive;
