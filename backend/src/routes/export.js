/**
 * Exports du suivi annuel — Santé des extrêmes (LOT 3).
 *
 *   GET /api/export/historique.xlsx?annee=2026   (public)
 *   GET /api/export/historique.pdf?annee=2026    (public)
 *
 * Les deux fichiers reprennent exactement les chiffres de GET /api/historique
 * (même fonction de construction), complétés des pénalités et suspensions, des
 * dépenses et du solde de caisse.
 *
 * Le tableau des cotisations range les montants sur le MOIS DÛ — il ne change
 * pas. Le classeur Excel porte en plus une feuille « Versements » : la même
 * population, vue par date de remise de l'argent, régularisations signalées,
 * et depuis le LOT 4 une feuille « Arriérés » : qui doit quoi, et depuis quand,
 * avec la contribution mensuelle attendue de chacun — elle n'est pas uniforme.
 *
 * Les fiches santé n'apparaissent dans aucun export : ce sont des données de
 * santé, elles ne sortent jamais de l'écran du secrétariat.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { lireToutes } = require('../db');
const { construireHistorique, lireAnnee, MOIS } = require('./historique');
const { CATEGORIES } = require('./demandes');
const { calculerSoldeReel } = require('./tresorerie');
const { estRegularisation } = require('./cotisations');
const { construireArrieres } = require('./arrieres');
const { moisCourant, moisAnneeEnLettres } = require('../services/arrieres');

const routeur = express.Router();

const CHEMIN_LOGO = path.join(__dirname, '..', '..', 'assets', 'logo.png');

/** Libellés d'affichage des statuts de sanction. */
const LIBELLE_STATUT = Object.freeze({
  due: 'Due',
  reglee: 'Réglée',
  levee: 'Levée',
  annulee: 'Annulée',
});

const LIBELLE_TYPE = Object.freeze({
  penalite: 'Pénalité',
  suspension: 'Suspension',
});

/** Formate un montant à la française : 1 845 000 (espace insécable fine exclue). */
function formaterMontant(valeur) {
  const nombre = Math.round(Number(valeur) || 0);
  return nombre.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Formate une date ISO en JJ/MM/AAAA ; chaîne vide si absente. */
function formaterDate(valeur) {
  if (!valeur) return '';
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return String(valeur).slice(0, 10);
  const jour = String(date.getUTCDate()).padStart(2, '0');
  const mois = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${jour}/${mois}/${date.getUTCFullYear()}`;
}

/**
 * Sanctions de l'année, tous statuts confondus sauf les annulées.
 * @param {number} annee année civile
 */
function lireSanctions(annee) {
  return lireToutes(
    `SELECT s.*, m.name AS member_name
       FROM sanctions s
       JOIN members m ON m.id = s.member_id
      WHERE strftime('%Y', s.date_sanction) = ?
        AND s.statut <> 'annulee'
      ORDER BY m.name COLLATE NOCASE ASC, s.date_sanction ASC`,
    [String(annee)]
  );
}

/**
 * Cotisations validées de l'année, avec leur date de versement.
 *
 * MÊME POPULATION que le tableau croisé : les lignes dont le MOIS DÛ tombe dans
 * l'année. Le total de la feuille doit pouvoir être rapproché de celui du
 * tableau, ligne par ligne — d'où l'ordre par date de remise, qui met les
 * régularisations en évidence.
 *
 * @param {number} annee année civile
 */
function lireVersements(annee) {
  return lireToutes(
    `SELECT c.id, m.name AS member_name, c.date_paiement, c.date_versement,
            c.date_validation, c.montant, c.moyen, c.valide_par
       FROM cotisations c
       JOIN members m ON m.id = c.member_id
      WHERE c.statut = 'validee'
        AND strftime('%Y', c.date_paiement) = ?
      ORDER BY COALESCE(c.date_versement, c.date_validation, c.date_paiement) ASC,
               m.name COLLATE NOCASE ASC`,
    [String(annee)]
  );
}

/** Mois dû en clair : « sept 2026 ». */
function formaterMoisDu(valeur) {
  const texte = String(valeur || '');
  const numero = Number(texte.slice(5, 7));
  if (numero < 1 || numero > 12) return texte.slice(0, 7);
  return `${MOIS[numero - 1]} ${texte.slice(0, 4)}`;
}

/** Date de remise réellement connue d'une cotisation, ou sa validation à défaut. */
function versementDe(cotisation) {
  return cotisation.date_versement || cotisation.date_validation || null;
}

const LIBELLE_PAYE_PAR = Object.freeze({
  caisse: 'Caisse',
  avance_rembourse: 'Avance remboursée',
});

/** Dépenses décaissées sur l'année, du plus ancien au plus récent. */
function lireDepenses(annee) {
  return lireToutes(
    `SELECT x.*, d.categorie, d.libelle
       FROM decaissements x
       JOIN demandes d ON d.id = x.demande_id
      WHERE strftime('%Y', x.date_paiement) = ?
      ORDER BY x.date_paiement ASC, x.id ASC`,
    [String(annee)]
  );
}

/**
 * Solde de caisse à la date d'édition, tous exercices confondus.
 *
 * Le document doit porter le même chiffre que l'écran Trésorerie, sans quoi
 * l'assemblée aurait deux vérités à concilier. D'où l'appel au calcul de
 * tresorerie.js plutôt qu'une seconde version des mêmes requêtes : la première
 * avait déjà divergé, en retenant les cotisations sur leur mois dû au lieu de
 * leur date de validation.
 *
 * Les TABLEAUX de cotisations de l'export, eux, restent rangés par
 * « date_paiement » : ils affichent le mois dû, qui ne bouge pas.
 *
 * @returns {Promise<{ouverture: object|null, cotisations: number,
 *                    penalites: number, depenses: number, solde: number}>}
 */
async function calculerSolde() {
  const situation = await calculerSoldeReel();

  return {
    ouverture: situation.ouverture,
    cotisations: Number(situation.cotisations.somme) || 0,
    penalites: Number(situation.penalites.somme) || 0,
    depenses: Number(situation.decaissements.somme) || 0,
    solde: situation.solde,
  };
}

/**
 * Nom de fichier propose au telechargement.
 *
 * L'application enregistre le fichier sous ce nom : il doit rester court et
 * reconnaissable dans une liste de telechargements.
 */
function nomFichier(extension, annee) {
  return `Cotisations_${annee}.${extension}`;
}

/**
 * Mois auquel arrêter l'état des arriérés d'un classeur.
 *
 * Pour l'année en cours, le mois courant — c'est la question qu'on se pose en
 * réunion. Pour une année révolue, son mois de décembre : arrêter un exercice
 * clos au mois d'aujourd'hui n'aurait aucun sens.
 *
 * @param {number} annee année demandée à l'export
 * @returns {string} mois au format AAAA-MM
 */
function moisArrieres(annee) {
  const courant = moisCourant();
  return String(annee) === courant.slice(0, 4) ? courant : `${annee}-12`;
}

// ---------------------------------------------------------------------------
// Export Excel
// ---------------------------------------------------------------------------

/** GET /api/export/historique.xlsx — cotisations, versements, pénalités, dépenses. */
routeur.get('/historique.xlsx', async (requete, reponse) => {
  const lecture = lireAnnee(requete.query.annee);
  if (lecture.erreur) {
    return reponse.status(400).json({ error: lecture.erreur });
  }
  const annee = lecture.annee;

  try {
    const historique = await construireHistorique(annee);
    const sanctions = await lireSanctions(annee);

    const classeur = new ExcelJS.Workbook();
    classeur.creator = 'Santé des extrêmes';
    classeur.created = new Date();

    // --- Feuille 1 : cotisations -------------------------------------------
    const feuille = classeur.addWorksheet(`Cotisations ${annee}`);

    feuille.columns = [
      { header: 'Nom', key: 'nom', width: 28 },
      ...MOIS.map((mois) => ({ header: mois, key: mois, width: 11 })),
      { header: 'Total', key: 'total', width: 14 },
    ];

    const enTete = feuille.getRow(1);
    enTete.font = { bold: true };
    enTete.alignment = { vertical: 'middle', horizontal: 'center' };
    enTete.eachCell((cellule) => {
      cellule.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E3DD' } };
      cellule.border = { bottom: { style: 'thin', color: { argb: 'FF888780' } } };
    });
    feuille.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };

    for (const membre of historique.members) {
      feuille.addRow([membre.name, ...membre.montants, membre.total]);
    }

    const ligneTotal = feuille.addRow([
      'TOTAL',
      ...historique.totaux_mois,
      historique.total_annee,
    ]);
    ligneTotal.font = { bold: true };
    ligneTotal.eachCell((cellule) => {
      cellule.border = { top: { style: 'thin', color: { argb: 'FF1C1B1A' } } };
    });

    // Format numérique sur toutes les colonnes de montants (B → N).
    for (let colonne = 2; colonne <= MOIS.length + 2; colonne += 1) {
      feuille.getColumn(colonne).numFmt = '# ##0';
      feuille.getColumn(colonne).alignment = { horizontal: 'right' };
    }

    feuille.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

    // --- Feuille 2 : versements --------------------------------------------
    //
    // Le tableau croisé range les montants sur leur MOIS DÛ ; il ne dit donc pas
    // quand l'argent est entré en caisse. Cette feuille le dit, ligne par ligne,
    // et signale les régularisations — un versement postérieur au mois couvert.
    const versements = await lireVersements(annee);
    const feuilleVersements = classeur.addWorksheet(`Versements ${annee}`);

    feuilleVersements.columns = [
      { header: 'Membre', key: 'membre', width: 28 },
      { header: 'Mois dû', key: 'mois_du', width: 14 },
      { header: 'Date de versement', key: 'versement', width: 18 },
      { header: 'Montant', key: 'montant', width: 14 },
      { header: 'Moyen', key: 'moyen', width: 16 },
      { header: 'Régularisation', key: 'regularisation', width: 16 },
      { header: 'Validé par', key: 'valide_par', width: 22 },
    ];

    const enTeteVersements = feuilleVersements.getRow(1);
    enTeteVersements.font = { bold: true };
    enTeteVersements.eachCell((cellule) => {
      cellule.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E3DD' } };
      cellule.border = { bottom: { style: 'thin', color: { argb: 'FF888780' } } };
    });

    for (const versement of versements) {
      const remise = versementDe(versement);
      feuilleVersements.addRow([
        versement.member_name,
        formaterMoisDu(versement.date_paiement),
        formaterDate(remise),
        Number(versement.montant),
        versement.moyen,
        estRegularisation(versement.date_paiement, remise) ? 'Oui' : '',
        versement.valide_par || '',
      ]);
    }

    if (versements.length === 0) {
      feuilleVersements.addRow(['Aucune cotisation validée sur la période']);
    }

    const totalVersements = versements.reduce((somme, ligne) => somme + Number(ligne.montant), 0);
    const ligneTotalVersements = feuilleVersements.addRow([
      'TOTAL',
      '',
      '',
      totalVersements,
      '',
      '',
      '',
    ]);
    ligneTotalVersements.font = { bold: true };
    ligneTotalVersements.eachCell((cellule) => {
      cellule.border = { top: { style: 'thin', color: { argb: 'FF1C1B1A' } } };
    });

    feuilleVersements.getColumn(4).numFmt = '# ##0';
    feuilleVersements.getColumn(4).alignment = { horizontal: 'right' };

    // --- Feuille 3 : arriérés ----------------------------------------------
    //
    // LOT 4. Les feuilles précédentes disent ce qui est ENTRÉ ; celle-ci dit ce
    // qui MANQUE. Les mois dus partent de la DATE D'ADHÉSION de chaque membre,
    // jamais de janvier : un membre entré en mai ne doit rien pour les quatre
    // premiers mois de l'année, et l'écrire autrement gonflerait le total
    // présenté en assemblée.
    //
    // Mêmes chiffres que GET /api/arrieres, par construction : la feuille
    // appelle la fonction de la route, elle ne refait pas le calcul.
    const moisCible = moisArrieres(annee);
    const arrieres = await construireArrieres(moisCible);
    const feuilleArrieres = classeur.addWorksheet('Arriérés');

    feuilleArrieres.columns = [
      { header: 'Membre', key: 'membre', width: 28 },
      { header: 'Adhésion', key: 'adhesion', width: 14 },
      // La contribution attendue explique le montant dû : sans elle, deux
      // membres à trois mois de retard affichent 15 000 et 30 000 sans raison
      // apparente.
      { header: 'Contribution', key: 'contribution', width: 14 },
      { header: 'Mois dus', key: 'nb_mois', width: 11 },
      { header: 'Détail des mois', key: 'detail', width: 38 },
      { header: 'Montant dû', key: 'montant', width: 14 },
      { header: 'Pénalités dues', key: 'penalites', width: 15 },
      { header: 'Total dû', key: 'total', width: 14 },
      { header: 'Dernier versement', key: 'versement', width: 18 },
      { header: 'Statut', key: 'statut', width: 16 },
    ];

    const enTeteArrieres = feuilleArrieres.getRow(1);
    enTeteArrieres.font = { bold: true };
    enTeteArrieres.eachCell((cellule) => {
      cellule.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E3DD' } };
      cellule.border = { bottom: { style: 'thin', color: { argb: 'FF888780' } } };
    });

    for (const membre of arrieres.membres) {
      feuilleArrieres.addRow([
        membre.name,
        formaterMoisDu(`${membre.adhesion}-01`),
        membre.contribution,
        membre.nb_mois,
        membre.mois_dus.map((mois) => formaterMoisDu(`${mois}-01`)).join(', '),
        membre.montant_du,
        membre.penalites_dues,
        membre.total_du,
        formaterDate(membre.dernier_versement),
        membre.statut === 'ecarte' ? 'Mis à l’écart' : 'Actif',
      ]);
    }

    if (arrieres.membres.length === 0) {
      feuilleArrieres.addRow(['Aucun arriéré : tous les membres sont à jour']);
    }

    const ligneTotalArrieres = feuilleArrieres.addRow([
      'TOTAL',
      '',
      '',
      '',
      '',
      arrieres.resume.total_arrieres,
      arrieres.resume.total_penalites,
      arrieres.resume.total_arrieres + arrieres.resume.total_penalites,
      '',
      '',
    ]);
    ligneTotalArrieres.font = { bold: true };
    ligneTotalArrieres.eachCell((cellule) => {
      cellule.border = { top: { style: 'thin', color: { argb: 'FF1C1B1A' } } };
    });

    // Contribution (C), montant dû (F), pénalités (G) et total (H).
    for (const colonne of [3, 6, 7, 8]) {
      feuilleArrieres.getColumn(colonne).numFmt = '# ##0';
      feuilleArrieres.getColumn(colonne).alignment = { horizontal: 'right' };
    }
    feuilleArrieres.getColumn(4).alignment = { horizontal: 'center' };

    // Pied de feuille : l'arrêté et sa répartition, pour qu'une page imprimée
    // se suffise à elle-même.
    feuilleArrieres.addRow([]);
    const ligneArrete = feuilleArrieres.addRow([
      `Arrêté au mois de ${moisAnneeEnLettres(moisCible)}`,
      '',
      '',
      '',
      `${arrieres.resume.membres_a_jour} à jour · ${arrieres.resume.membres_en_retard} en retard`,
      '',
      '',
      '',
      '',
      '',
    ]);
    ligneArrete.font = { italic: true };

    const repartition = arrieres.resume.par_anciennete;
    const ligneRepartition = feuilleArrieres.addRow([
      'Répartition',
      '',
      '',
      '',
      `1 mois : ${repartition['1_mois']} · 2 mois : ${repartition['2_mois']} · ` +
        `3 mois et plus : ${repartition['3_mois_et_plus']}`,
      '',
      '',
      '',
      '',
      '',
    ]);
    ligneRepartition.font = { italic: true };

    feuilleArrieres.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

    // --- Feuille 4 : pénalités ---------------------------------------------
    const feuillePenalites = classeur.addWorksheet(`Pénalités ${annee}`);

    feuillePenalites.columns = [
      { header: 'Membre', key: 'membre', width: 28 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Motif', key: 'motif', width: 30 },
      { header: 'Montant', key: 'montant', width: 14 },
      { header: 'Statut', key: 'statut', width: 12 },
      { header: 'Date règlement', key: 'reglement', width: 16 },
      { header: 'Encaissé par', key: 'encaisse_par', width: 22 },
    ];

    const enTetePenalites = feuillePenalites.getRow(1);
    enTetePenalites.font = { bold: true };
    enTetePenalites.eachCell((cellule) => {
      cellule.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E3DD' } };
      cellule.border = { bottom: { style: 'thin', color: { argb: 'FF888780' } } };
    });

    for (const sanction of sanctions) {
      feuillePenalites.addRow([
        sanction.member_name,
        formaterDate(sanction.date_sanction),
        LIBELLE_TYPE[sanction.type] || sanction.type,
        sanction.type === 'suspension' && sanction.date_fin
          ? `${sanction.motif} (jusqu'au ${formaterDate(sanction.date_fin)})`
          : sanction.motif,
        sanction.montant === null ? '' : Number(sanction.montant),
        LIBELLE_STATUT[sanction.statut] || sanction.statut,
        formaterDate(sanction.date_reglement),
        sanction.encaisse_par || '',
      ]);
    }

    if (sanctions.length === 0) {
      feuillePenalites.addRow(['Aucune sanction sur la période']);
    }

    feuillePenalites.getColumn(5).numFmt = '# ##0';
    feuillePenalites.getColumn(5).alignment = { horizontal: 'right' };

    // --- Feuille 5 : dépenses ----------------------------------------------
    const depenses = await lireDepenses(annee);
    const feuilleDepenses = classeur.addWorksheet(`Dépenses ${annee}`);

    feuilleDepenses.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Catégorie', key: 'categorie', width: 26 },
      { header: 'Libellé', key: 'libelle', width: 38 },
      { header: 'Montant', key: 'montant', width: 14 },
      { header: 'Bénéficiaire', key: 'beneficiaire', width: 24 },
      { header: 'Payé par', key: 'paye_par', width: 20 },
      { header: 'Décaissé par', key: 'decaisse_par', width: 22 },
    ];

    const enTeteDepenses = feuilleDepenses.getRow(1);
    enTeteDepenses.font = { bold: true };
    enTeteDepenses.eachCell((cellule) => {
      cellule.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E3DD' } };
      cellule.border = { bottom: { style: 'thin', color: { argb: 'FF888780' } } };
    });

    for (const depense of depenses) {
      feuilleDepenses.addRow([
        formaterDate(depense.date_paiement),
        CATEGORIES[depense.categorie] || depense.categorie,
        depense.libelle,
        Number(depense.montant),
        depense.beneficiaire || '',
        LIBELLE_PAYE_PAR[depense.paye_par] || depense.paye_par,
        depense.decaisse_par || '',
      ]);
    }

    if (depenses.length === 0) {
      feuilleDepenses.addRow(['Aucune dépense sur la période']);
    }

    const totalDepenses = depenses.reduce((somme, ligne) => somme + Number(ligne.montant), 0);
    const ligneTotalDepenses = feuilleDepenses.addRow(['TOTAL', '', '', totalDepenses, '', '', '']);
    ligneTotalDepenses.font = { bold: true };
    ligneTotalDepenses.eachCell((cellule) => {
      cellule.border = { top: { style: 'thin', color: { argb: 'FF1C1B1A' } } };
    });

    feuilleDepenses.getColumn(4).numFmt = '# ##0';
    feuilleDepenses.getColumn(4).alignment = { horizontal: 'right' };

    // Ligne de solde, en fin de document : le même chiffre que l'écran Trésorerie.
    const situation = await calculerSolde();
    feuilleDepenses.addRow([]);

    if (situation.ouverture) {
      const ligneOuverture = feuilleDepenses.addRow([
        `Solde d'ouverture au ${formaterDate(situation.ouverture.date)}`,
        '',
        '',
        situation.ouverture.montant,
        '',
        '',
      ]);
      ligneOuverture.font = { italic: true };
    }

    const ligneSolde = feuilleDepenses.addRow([
      'SOLDE DE CAISSE',
      `cotisations versées ${formaterMontant(situation.cotisations)} + pénalités ${formaterMontant(situation.penalites)} − dépenses ${formaterMontant(situation.depenses)}`,
      '',
      situation.solde,
      '',
      '',
    ]);
    ligneSolde.font = { bold: true };

    const tampon = await classeur.xlsx.writeBuffer();

    reponse.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    reponse.setHeader('Content-Disposition', `attachment; filename="${nomFichier('xlsx', annee)}"`);
    reponse.setHeader('Content-Length', tampon.length);

    console.log(
      `[export] classeur Excel ${annee} généré : ${historique.nb_membres} membre(s), ` +
        `${sanctions.length} sanction(s), ${arrieres.membres.length} membre(s) en retard, ` +
        `${tampon.length} octets`
    );
    return reponse.status(200).end(Buffer.from(tampon));
  } catch (erreur) {
    console.error(`[export] échec de l'export Excel : ${erreur.message}`);
    return reponse.status(500).json({ error: "Impossible de générer le fichier Excel" });
  }
});

// ---------------------------------------------------------------------------
// Export PDF
// ---------------------------------------------------------------------------

/** Trace l'en-tête de la page : logo, titre, date de génération. */
function dessinerEnTete(document, annee) {
  const hautDePage = document.page.margins.top;

  if (fs.existsSync(CHEMIN_LOGO)) {
    try {
      document.image(CHEMIN_LOGO, document.page.margins.left, hautDePage, { fit: [34, 34] });
    } catch (erreur) {
      // Un logo illisible ne doit pas empêcher la production du document.
      console.warn(`[export] logo ignoré : ${erreur.message}`);
    }
  }

  document
    .fillColor('#1C1B1A')
    .fontSize(15)
    .font('Helvetica-Bold')
    .text(`Santé des extrêmes — Suivi des cotisations ${annee}`, document.page.margins.left + 44, hautDePage + 2);

  document
    .fillColor('#888780')
    .fontSize(8)
    .font('Helvetica')
    .text(`Document généré le ${formaterDate(new Date().toISOString())}`, document.page.margins.left + 44, hautDePage + 21);

  document.y = hautDePage + 44;
}

/**
 * Trace une ligne du tableau des cotisations.
 * @param {number[]} colonnes largeurs de colonnes
 */
function dessinerLigne(document, valeurs, colonnes, { gras = false, fond = null } = {}) {
  const hauteur = 15;
  const y = document.y;
  let x = document.page.margins.left;

  if (fond) {
    const largeurTotale = colonnes.reduce((somme, largeur) => somme + largeur, 0);
    document.rect(x, y - 2, largeurTotale, hauteur).fill(fond);
  }

  document.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);

  valeurs.forEach((valeur, index) => {
    document
      .fillColor(fond === '#1C1B1A' ? '#FFFFFF' : '#2C2C2A')
      .text(String(valeur), x + 3, y + 1, {
        width: colonnes[index] - 6,
        align: index === 0 ? 'left' : 'right',
        lineBreak: false,
      });
    x += colonnes[index];
  });

  document.y = y + hauteur;
}

/** GET /api/export/historique.pdf — document A4 paysage. */
routeur.get('/historique.pdf', async (requete, reponse) => {
  const lecture = lireAnnee(requete.query.annee);
  if (lecture.erreur) {
    return reponse.status(400).json({ error: lecture.erreur });
  }
  const annee = lecture.annee;

  try {
    const historique = await construireHistorique(annee);
    const sanctions = await lireSanctions(annee);

    const document = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 28, bottom: 34, left: 25, right: 25 },
      bufferPages: true, // nécessaire à la numérotation en fin de génération
      info: {
        Title: `Santé des extrêmes — Cotisations ${annee}`,
        Author: 'Santé des extrêmes',
      },
    });

    const morceaux = [];
    document.on('data', (morceau) => morceaux.push(morceau));

    const fin = new Promise((resoudre, rejeter) => {
      document.on('end', resoudre);
      document.on('error', rejeter);
    });

    // --- Page 1 : tableau des cotisations ----------------------------------
    const colonnes = [118, ...new Array(12).fill(47), 62];
    const basDePage = document.page.height - document.page.margins.bottom - 20;

    dessinerEnTete(document, annee);
    dessinerLigne(document, ['Membre', ...MOIS, 'Total'], colonnes, { gras: true, fond: '#E6E3DD' });

    for (const membre of historique.members) {
      if (document.y > basDePage) {
        document.addPage();
        dessinerEnTete(document, annee);
        dessinerLigne(document, ['Membre', ...MOIS, 'Total'], colonnes, { gras: true, fond: '#E6E3DD' });
      }

      dessinerLigne(
        document,
        [
          membre.name,
          ...membre.montants.map((montant) => (montant > 0 ? formaterMontant(montant) : '·')),
          formaterMontant(membre.total),
        ],
        colonnes
      );
    }

    if (historique.members.length === 0) {
      dessinerLigne(document, ['Aucun membre enregistré', ...new Array(13).fill('')], colonnes);
    }

    // Ligne de total, sur fond charbon comme dans l'application.
    dessinerLigne(
      document,
      [
        'TOTAL',
        ...historique.totaux_mois.map((montant) => (montant > 0 ? formaterMontant(montant) : '·')),
        formaterMontant(historique.total_annee),
      ],
      colonnes,
      { gras: true, fond: '#1C1B1A' }
    );

    document.moveDown(0.8);
    document
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#888780')
      .text(
        `${historique.nb_paiements} paiement(s) · ${historique.nb_membres} membre(s) · ` +
          `total ${formaterMontant(historique.total_annee)} XAF`,
        document.page.margins.left,
        document.y
      );

    // Le tableau range les montants sur le mois dû ; la caisse, elle, compte les
    // versements au jour de leur remise. Le dire ici évite qu'on cherche à
    // retrouver le solde en additionnant les colonnes.
    document.moveDown(0.3);
    document.text(
      'Montants rangés sur le mois de cotisation dû. Le solde de caisse compte les versements ' +
        'à leur date de remise — le détail figure dans la feuille « Versements » de l’export Excel.',
      document.page.margins.left,
      document.y
    );

    // --- Page 2 : pénalités et suspensions ---------------------------------
    document.addPage();
    dessinerEnTete(document, annee);

    document
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#1C1B1A')
      .text('Pénalités et suspensions', document.page.margins.left, document.y);
    document.moveDown(0.5);

    const colonnesSanctions = [150, 70, 80, 200, 80, 80, 90];
    dessinerLigne(
      document,
      ['Membre', 'Date', 'Type', 'Motif', 'Montant', 'Statut', 'Date règlement'],
      colonnesSanctions,
      { gras: true, fond: '#E6E3DD' }
    );

    for (const sanction of sanctions) {
      if (document.y > basDePage) {
        document.addPage();
        dessinerEnTete(document, annee);
        dessinerLigne(
          document,
          ['Membre', 'Date', 'Type', 'Motif', 'Montant', 'Statut', 'Date règlement'],
          colonnesSanctions,
          { gras: true, fond: '#E6E3DD' }
        );
      }

      dessinerLigne(
        document,
        [
          sanction.member_name,
          formaterDate(sanction.date_sanction),
          LIBELLE_TYPE[sanction.type] || sanction.type,
          sanction.type === 'suspension' && sanction.date_fin
            ? `${sanction.motif} (jusqu'au ${formaterDate(sanction.date_fin)})`
            : sanction.motif,
          sanction.montant === null ? '·' : formaterMontant(sanction.montant),
          LIBELLE_STATUT[sanction.statut] || sanction.statut,
          formaterDate(sanction.date_reglement) || '·',
        ],
        colonnesSanctions
      );
    }

    if (sanctions.length === 0) {
      dessinerLigne(document, ['Aucune sanction sur la période', '', '', '', '', '', ''], colonnesSanctions);
    }

    document.moveDown(0.8);
    document
      .font('Helvetica-Oblique')
      .fontSize(7.5)
      .fillColor('#888780')
      .text(
        "Les règlements de pénalité sont comptabilisés à part : ils n'entrent pas dans le total des cotisations.",
        document.page.margins.left,
        document.y
      );

    // --- Page 3 : dépenses --------------------------------------------------
    const depenses = await lireDepenses(annee);

    document.addPage();
    dessinerEnTete(document, annee);

    document
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#1C1B1A')
      .text(`Dépenses ${annee}`, document.page.margins.left, document.y);
    document.moveDown(0.5);

    const colonnesDepenses = [70, 130, 240, 85, 130, 95];
    const enTeteDepenses = ['Date', 'Catégorie', 'Libellé', 'Montant', 'Bénéficiaire', 'Payé par'];
    dessinerLigne(document, enTeteDepenses, colonnesDepenses, { gras: true, fond: '#E6E3DD' });

    for (const depense of depenses) {
      if (document.y > basDePage) {
        document.addPage();
        dessinerEnTete(document, annee);
        dessinerLigne(document, enTeteDepenses, colonnesDepenses, { gras: true, fond: '#E6E3DD' });
      }

      dessinerLigne(
        document,
        [
          formaterDate(depense.date_paiement),
          CATEGORIES[depense.categorie] || depense.categorie,
          depense.libelle,
          formaterMontant(depense.montant),
          depense.beneficiaire || '·',
          LIBELLE_PAYE_PAR[depense.paye_par] || depense.paye_par,
        ],
        colonnesDepenses
      );
    }

    if (depenses.length === 0) {
      dessinerLigne(document, ['Aucune dépense sur la période', '', '', '', '', ''], colonnesDepenses);
    }

    const totalDepenses = depenses.reduce((somme, ligne) => somme + Number(ligne.montant), 0);
    dessinerLigne(
      document,
      ['TOTAL', '', '', formaterMontant(totalDepenses), '', ''],
      colonnesDepenses,
      { gras: true, fond: '#1C1B1A' }
    );

    // --- Ligne de solde, en fin de document ---------------------------------
    const situation = await calculerSolde();

    document.moveDown(1);
    document
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#1C1B1A')
      .text(
        `Solde de caisse : ${formaterMontant(situation.solde)} XAF`,
        document.page.margins.left,
        document.y
      );

    document.moveDown(0.3);
    document
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#888780')
      .text(
        (situation.ouverture
          ? `solde d'ouverture au ${formaterDate(situation.ouverture.date)} ` +
            `${formaterMontant(situation.ouverture.montant)} + `
          : '') +
          `cotisations versées ${formaterMontant(situation.cotisations)} ` +
          `+ pénalités encaissées ${formaterMontant(situation.penalites)} ` +
          `− dépenses ${formaterMontant(situation.depenses)}`,
        document.page.margins.left,
        document.y
      );

    // --- Pied de page numéroté sur toutes les pages ------------------------
    const pages = document.bufferedPageRange();
    for (let index = 0; index < pages.count; index += 1) {
      document.switchToPage(pages.start + index);
      document
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor('#888780')
        .text(
          `Santé des extrêmes · Page ${index + 1} sur ${pages.count}`,
          document.page.margins.left,
          document.page.height - document.page.margins.bottom + 6,
          { width: document.page.width - document.page.margins.left - document.page.margins.right, align: 'center' }
        );
    }

    document.end();
    await fin;

    const tampon = Buffer.concat(morceaux);

    reponse.setHeader('Content-Type', 'application/pdf');
    reponse.setHeader('Content-Disposition', `attachment; filename="${nomFichier('pdf', annee)}"`);
    reponse.setHeader('Content-Length', tampon.length);

    console.log(
      `[export] document PDF ${annee} généré : ${pages.count} page(s), ${tampon.length} octets`
    );
    return reponse.status(200).end(tampon);
  } catch (erreur) {
    console.error(`[export] échec de l'export PDF : ${erreur.message}`);
    return reponse.status(500).json({ error: 'Impossible de générer le document PDF' });
  }
});

module.exports = routeur;
