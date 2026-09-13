/**
 * Exports du suivi annuel — Santé des extrêmes (LOT 3).
 *
 *   GET /api/export/historique.xlsx?annee=2026   (public)
 *   GET /api/export/historique.pdf?annee=2026    (public)
 *
 * Les deux fichiers reprennent exactement les chiffres de GET /api/historique
 * (même fonction de construction), complétés d'un second onglet — ou d'une
 * seconde page — consacré aux pénalités et suspensions.
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

/** Nom de fichier proposé au téléchargement. */
function nomFichier(extension, annee) {
  return `sante-des-extremes-cotisations-${annee}.${extension}`;
}

// ---------------------------------------------------------------------------
// Export Excel
// ---------------------------------------------------------------------------

/** GET /api/export/historique.xlsx — classeur à deux feuilles. */
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

    // --- Feuille 2 : pénalités ---------------------------------------------
    const feuillePenalites = classeur.addWorksheet(`Pénalités ${annee}`);

    feuillePenalites.columns = [
      { header: 'Membre', key: 'membre', width: 28 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Motif', key: 'motif', width: 30 },
      { header: 'Montant', key: 'montant', width: 14 },
      { header: 'Statut', key: 'statut', width: 12 },
      { header: 'Date règlement', key: 'reglement', width: 16 },
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
      ]);
    }

    if (sanctions.length === 0) {
      feuillePenalites.addRow(['Aucune sanction sur la période']);
    }

    feuillePenalites.getColumn(5).numFmt = '# ##0';
    feuillePenalites.getColumn(5).alignment = { horizontal: 'right' };

    const tampon = await classeur.xlsx.writeBuffer();

    reponse.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    reponse.setHeader('Content-Disposition', `attachment; filename="${nomFichier('xlsx', annee)}"`);
    reponse.setHeader('Content-Length', tampon.length);

    console.log(
      `[export] classeur Excel ${annee} généré : ${historique.nb_membres} membre(s), ` +
        `${sanctions.length} sanction(s), ${tampon.length} octets`
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
