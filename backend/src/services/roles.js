/**
 * Rôles et codes d'accès d'une association — LOT 7 « DeuxZero ».
 *
 * Les codes de rôle vivaient dans le .env du serveur. C'était tenable pour une
 * association : l'éditeur éditait le fichier. Ça ne l'est plus pour un produit
 * vendu à des dizaines d'associations que l'éditeur ne rencontre JAMAIS —
 * personne ne peut éditer un fichier à leur place, et il n'y a pas de support à
 * appeler.
 *
 * Les codes vivent donc dans la base de l'association, hachés, et c'est le
 * président qui les distribue depuis son téléphone. Deux conséquences dont tout
 * le reste découle :
 *
 *   · le président ne remet jamais un code définitif, il remet un code
 *     TEMPORAIRE valable vingt-quatre heures et à usage unique. Son porteur
 *     choisit lui-même son code personnel à la première connexion. Le président
 *     ne connaît donc pas le code de ses collaborateurs — et ne peut pas agir en
 *     leur nom ;
 *
 *   · l'authentification ne peut plus comparer un code à une variable connue :
 *     elle doit l'éprouver contre TOUS les codes actifs de l'association. C'est
 *     fait en temps constant par code éprouvé, et derrière le limiteur de
 *     tentatives, qui reste la vraie protection.
 */
'use strict';

const codes = require('./codes');

/** Rôles reconnus. « president » remplace « admin » depuis le LOT 7. */
const ROLES = Object.freeze([
  'president',
  'secretaire',
  'tresorier',
  'censeur',
  'intendant',
  'competitions',
]);

/** Libellés affichés, en français, pour l'interface et les journaux. */
const LIBELLES_ROLES = Object.freeze({
  president: 'Président',
  secretaire: 'Secrétaire',
  tresorier: 'Trésorier',
  censeur: 'Censeur',
  intendant: 'Intendant',
  competitions: 'Compétitions',
});

/** Durée de validité d'un code temporaire remis par le président. */
const HEURES_CODE_TEMPORAIRE = 24;

/**
 * Compatibilité ascendante du renommage « admin » → « président ».
 *
 * Le rôle s'appelait « admin » jusqu'au LOT 6 : le mot subsiste dans des
 * enregistrements (demandes.role_demandeur, cotisations.valide_par) et dans les
 * appels des lots précédents. Traduire silencieusement évite une migration de
 * données à seule fin cosmétique, et garantit qu'un jeton ancien reste accepté.
 *
 * @param {string} role rôle éventuellement ancien
 * @returns {string} rôle du LOT 7
 */
function normaliserRole(role) {
  const valeur = String(role || '').trim().toLowerCase();
  return valeur === 'admin' ? 'president' : valeur;
}

/** Horodatage ISO à la seconde, au format des autres dates de la base. */
function maintenantIso() {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** Horodatage ISO dans [heures] heures. */
function dansHeures(heures) {
  return new Date(Date.now() + heures * 3600 * 1000).toISOString().slice(0, 19) + 'Z';
}

/**
 * Codes actifs de l'association, les plus récents d'abord.
 *
 * Les temporaires expirés sont écartés de la comparaison — mais PAS effacés : la
 * ligne dit que le président a bien remis un code, et cette trace se lit dans
 * l'écran « Rôles et accès ».
 */
async function codesActifs(bd) {
  return bd.lireToutes(
    `SELECT r.id, r.role, r.membre_id, r.libelle, r.code_hash, r.temporaire, r.expire_le,
            r.cree_le, r.derniere_utilisation, m.name AS membre_nom, m.telephone AS membre_telephone
       FROM roles_codes r
       LEFT JOIN members m ON m.id = r.membre_id
      WHERE r.actif = 1
        AND (r.temporaire = 0 OR r.expire_le IS NULL OR r.expire_le > ?)
      ORDER BY r.id DESC`,
    [maintenantIso()]
  );
}

/**
 * Identifie un code parmi les codes actifs de l'association.
 *
 * Tous les codes sont éprouvés, sans court-circuit sur le premier succès : la
 * durée de la réponse ne doit pas révéler la POSITION du code trouvé, qui
 * renseignerait sur l'ancienneté de la ligne et donc sur le rôle.
 *
 * @returns {Promise<object|null>} la ligne de roles_codes, ou null
 */
async function identifier(bd, code) {
  const presente = String(code || '');
  if (!presente) return null;

  const actifs = await codesActifs(bd);
  let trouve = null;

  for (const ligne of actifs) {
    const correspond = await codes.verifier(presente, ligne.code_hash);
    if (correspond && !trouve) trouve = ligne;
  }

  return trouve;
}

/** Inscrit l'usage d'un code : c'est la seule colonne que l'écran du président lit. */
async function marquerUtilisation(bd, id) {
  try {
    await bd.executer('UPDATE roles_codes SET derniere_utilisation = ? WHERE id = ?', [
      maintenantIso(),
      id,
    ]);
  } catch (erreur) {
    // Une trace d'usage manquante ne doit pas empêcher quiconque de travailler.
    console.error(`[roles] dernière utilisation non inscrite (#${id}) : ${erreur.message}`);
  }
}

/**
 * Liste des rôles de l'association, SANS AUCUN CODE.
 *
 * La colonne code_hash n'est pas sélectionnée. Ce n'est pas une précaution
 * superflue : c'est ce qui garantit qu'un jour de refonte de l'écran, personne
 * ne renverra par mégarde une empreinte au client.
 */
async function lister(bd) {
  const lignes = await bd.lireToutes(
    `SELECT r.id, r.role, r.membre_id, r.libelle, r.temporaire, r.expire_le, r.actif,
            r.cree_le, r.derniere_utilisation,
            m.name AS membre_nom, m.telephone AS membre_telephone
       FROM roles_codes r
       LEFT JOIN members m ON m.id = r.membre_id
      ORDER BY r.actif DESC, r.role ASC, r.id DESC`
  );

  const maintenant = maintenantIso();
  return lignes.map((ligne) => ({
    id: ligne.id,
    role: ligne.role,
    role_libelle: LIBELLES_ROLES[ligne.role] || ligne.role,
    libelle: ligne.libelle,
    membre_id: ligne.membre_id,
    membre_nom: ligne.membre_nom,
    membre_telephone: ligne.membre_telephone ? codes.masquerTelephone(ligne.membre_telephone) : null,
    temporaire: ligne.temporaire === 1,
    expire_le: ligne.expire_le,
    expire: Boolean(ligne.temporaire === 1 && ligne.expire_le && ligne.expire_le <= maintenant),
    actif: ligne.actif === 1,
    cree_le: ligne.cree_le,
    derniere_utilisation: ligne.derniere_utilisation,
    etat: etatLisible(ligne, maintenant),
  }));
}

/** État d'un rôle en un mot, tel qu'affiché dans l'écran du président. */
function etatLisible(ligne, maintenant) {
  if (ligne.actif !== 1) return 'révoqué';
  if (ligne.temporaire === 1) {
    if (ligne.expire_le && ligne.expire_le <= maintenant) return 'code temporaire expiré';
    return 'code temporaire en attente de première connexion';
  }
  return ligne.derniere_utilisation ? 'actif' : 'actif, jamais utilisé';
}

/**
 * Attribue un rôle à un membre et tire son code temporaire.
 *
 * Le code en clair est renvoyé UNE SEULE FOIS, à l'appelant immédiat. Il n'est
 * stocké que haché : ni cette fonction, ni aucune autre, ne peut le restituer
 * ensuite.
 *
 * @returns {Promise<{id: number, code: string, expire_le: string}>}
 */
async function attribuer(bd, { role, membreId, libelle }) {
  const roleNormalise = normaliserRole(role);
  if (!ROLES.includes(roleNormalise)) throw new Error(`rôle inconnu : ${role}`);

  const code = codes.tirerCodeLisible();
  const empreinte = await codes.hacher(code);
  const expire = dansHeures(HEURES_CODE_TEMPORAIRE);

  const resultat = await bd.executer(
    `INSERT INTO roles_codes (role, membre_id, libelle, code_hash, temporaire, expire_le, actif)
     VALUES (?, ?, ?, ?, 1, ?, 1)`,
    [roleNormalise, membreId || null, libelle ? String(libelle).trim() : null, empreinte, expire]
  );

  console.log(
    `[roles] code temporaire émis — ${roleNormalise} — rôle #${resultat.id} — expire le ${expire}`
  );
  return { id: resultat.id, code, expire_le: expire, role: roleNormalise };
}

/**
 * Pose le code définitif d'un rôle, choisi par son porteur.
 *
 * C'est l'unique chemin par lequel un code non temporaire entre en base, et il
 * part TOUJOURS d'une saisie de son porteur. Le président n'y a pas accès.
 */
async function definirCodePersonnel(bd, id, nouveauCode) {
  const refus = codes.refusCodePersonnel(nouveauCode);
  if (refus) throw Object.assign(new Error(refus), { refusUtilisateur: true });

  const empreinte = await codes.hacher(nouveauCode);
  const resultat = await bd.executer(
    `UPDATE roles_codes
        SET code_hash = ?, temporaire = 0, expire_le = NULL, actif = 1,
            derniere_utilisation = ?
      WHERE id = ?`,
    [empreinte, maintenantIso(), id]
  );

  if (resultat.changements === 0) throw new Error(`rôle #${id} introuvable`);
  console.log(`[roles] code personnel posé sur le rôle #${id}`);
}

/**
 * Émet un nouveau code temporaire sur un rôle existant.
 *
 * L'ancien code — temporaire ou définitif — cesse aussitôt de fonctionner. C'est
 * voulu : renouveler, c'est reprendre la main sur un accès, par exemple parce
 * que le collaborateur a changé de téléphone ou que le code a fuité.
 */
async function renouveler(bd, id) {
  const existant = await bd.lireUne('SELECT id, role FROM roles_codes WHERE id = ?', [id]);
  if (!existant) throw Object.assign(new Error('Rôle introuvable.'), { refusUtilisateur: true });

  const code = codes.tirerCodeLisible();
  const empreinte = await codes.hacher(code);
  const expire = dansHeures(HEURES_CODE_TEMPORAIRE);

  await bd.executer(
    `UPDATE roles_codes
        SET code_hash = ?, temporaire = 1, expire_le = ?, actif = 1
      WHERE id = ?`,
    [empreinte, expire, id]
  );

  console.log(`[roles] code temporaire renouvelé — rôle #${id} (${existant.role})`);
  return { id, code, expire_le: expire, role: existant.role };
}

/**
 * Révoque un rôle.
 *
 * La ligne reste en base, « actif » passe à 0 : une révocation doit se voir dans
 * l'écran du président, et un rôle effacé rendrait incompréhensible l'historique
 * des validations portant le nom de son titulaire.
 */
async function revoquer(bd, id) {
  const resultat = await bd.executer('UPDATE roles_codes SET actif = 0 WHERE id = ? AND actif = 1', [id]);
  if (resultat.changements === 0) {
    throw Object.assign(new Error('Rôle introuvable ou déjà révoqué.'), { refusUtilisateur: true });
  }
  console.log(`[roles] rôle #${id} révoqué`);
}

/**
 * Nombre de présidents actifs, hors codes temporaires expirés.
 *
 * Sert à un seul refus, mais un refus capital : révoquer le dernier président
 * laisserait l'association sans personne pour attribuer des rôles, et l'éditeur
 * n'intervient jamais. Il n'y aurait aucun moyen de revenir en arrière.
 */
async function nombrePresidentsActifs(bd, sauf = null) {
  const ligne = await bd.lireUne(
    `SELECT COUNT(*) AS nombre
       FROM roles_codes
      WHERE actif = 1 AND role = 'president' AND (id != ? OR ? IS NULL)`,
    [sauf, sauf]
  );
  return ligne ? Number(ligne.nombre) : 0;
}

/**
 * Deux titulaires de rôle actifs les plus anciens, président exclu.
 *
 * Ce sont eux qui contresignent la réinitialisation du code président. Le
 * secrétaire et le trésorier passent devant : ce sont les fonctions du bureau
 * les plus susceptibles d'être joignables, et l'ordre importe puisqu'on n'en
 * prévient que deux.
 */
async function contresignataires(bd) {
  return bd.lireToutes(
    `SELECT r.id, r.role, r.membre_id, m.name AS membre_nom, m.telephone AS membre_telephone
       FROM roles_codes r
       JOIN members m ON m.id = r.membre_id
      WHERE r.actif = 1
        AND r.role != 'president'
        AND m.telephone IS NOT NULL AND m.telephone != ''
      ORDER BY CASE r.role
                 WHEN 'secretaire' THEN 0
                 WHEN 'tresorier' THEN 1
                 ELSE 2
               END,
               r.cree_le ASC, r.id ASC
      LIMIT 2`
  );
}

/**
 * Rôle actif rattaché à ce numéro de téléphone, ou undefined.
 *
 * Un membre peut cumuler deux fonctions — c'est fréquent dans un bureau de
 * quinze personnes — et la réinitialisation doit alors viser celle qu'il utilise
 * réellement. D'où cet ordre de préférence, qui n'est pas cosmétique :
 *
 *   1. un code DÉFINITIF avant un code temporaire. Réinitialiser un code de
 *      passation que l'intéressé n'a jamais consommé le laisserait sans accès à
 *      sa fonction principale, et c'est exactement ce qu'il essaie de récupérer ;
 *   2. le rôle le plus ANCIEN avant le plus récent : c'est sa fonction d'origine ;
 *   3. le président en DERNIER : il a son propre parcours, à contre-seing, et ne
 *      doit pas se voir réinitialiser par le chemin ordinaire.
 *
 * Les codes temporaires EXPIRÉS sont écartés : ils ne valent plus rien, les
 * réinitialiser ne rendrait aucun accès.
 */
async function roleParTelephone(bd, telephone) {
  return bd.lireUne(
    `SELECT r.id, r.role, r.membre_id, r.temporaire,
            m.name AS membre_nom, m.telephone AS membre_telephone
       FROM roles_codes r
       JOIN members m ON m.id = r.membre_id
      WHERE r.actif = 1
        AND m.telephone = ?
        AND (r.temporaire = 0 OR r.expire_le IS NULL OR r.expire_le > ?)
      ORDER BY CASE WHEN r.role = 'president' THEN 1 ELSE 0 END,
               r.temporaire ASC,
               r.cree_le ASC,
               r.id ASC
      LIMIT 1`,
    [telephone, maintenantIso()]
  );
}

module.exports = {
  ROLES,
  LIBELLES_ROLES,
  HEURES_CODE_TEMPORAIRE,
  normaliserRole,
  maintenantIso,
  dansHeures,
  codesActifs,
  identifier,
  marquerUtilisation,
  lister,
  attribuer,
  definirCodePersonnel,
  renouveler,
  revoquer,
  nombrePresidentsActifs,
  contresignataires,
  roleParTelephone,
};
