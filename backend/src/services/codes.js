/**
 * Codes de rôle : tirage, hachage, vérification — LOT 7 « DeuxZero ».
 *
 * TOUT ce lot repose sur une seule promesse : le président ne connaît JAMAIS le
 * code définitif de ses collaborateurs, et personne — pas même l'éditeur avec la
 * base en main — ne peut relire un code. D'où trois règles sans exception :
 *
 *   1. un code n'est stocké que HACHÉ, avec un sel propre à chaque ligne ;
 *   2. un code en clair n'existe qu'en mémoire, le temps d'une requête, et n'est
 *      renvoyé qu'UNE FOIS : à l'instant de sa création ;
 *   3. aucun code, même faux, n'est écrit dans un journal.
 *
 * Le hachage est scrypt, de la bibliothèque standard de Node. bcrypt aurait
 * demandé une dépendance à compilation native : sur une micro-instance, une mise
 * à jour de Node qui casse le binaire, c'est une association entière privée
 * d'accès, sans personne à appeler. scrypt offre la même résistance et ne peut
 * pas se casser à l'installation.
 *
 * Le coût est réglé à N = 2^14, soit quelques dizaines de millisecondes par
 * vérification. C'est assez pour mettre une attaque par dictionnaire hors de
 * portée, et assez peu pour qu'une authentification reste imperceptible même
 * quand elle doit essayer tous les codes actifs d'une association.
 */
'use strict';

const crypto = require('crypto');

/**
 * Paramètres scrypt, inscrits dans l'empreinte elle-même : un durcissement
 * futur du coût ne rendra pas invérifiables les codes déjà posés.
 */
const COUT_N = 16384;
const COUT_R = 8;
const COUT_P = 1;
const OCTETS_SEL = 16;
const OCTETS_EMPREINTE = 32;
const MEMOIRE_MAX = 64 * 1024 * 1024;

/**
 * Alphabet des codes remis à un humain.
 *
 * Ni I, ni l, ni 1, ni O, ni 0 : ces caractères se confondent à l'oral comme à
 * l'écrit, et un code transmis par WhatsApp ou de vive voix doit pouvoir être
 * ressaisi sans hésitation. Trente et un caractères restants, soit près de
 * quarante bits d'entropie sur huit positions — hors de portée d'un tirage
 * aveugle, a fortiori derrière le limiteur de tentatives.
 */
const ALPHABET_LISIBLE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Les vingt-trois premières positions de l'alphabet lisible sont des lettres. */
const LETTRES_LISIBLES = 23;

/** Longueur d'un code remis par le président ou à la création d'association. */
const LONGUEUR_CODE = 8;

/** Bornes d'un code personnel choisi par son porteur. */
const CODE_PERSONNEL_MIN = 6;
const CODE_PERSONNEL_MAX = 12;

/**
 * Tire un code lisible de [longueur] caractères.
 *
 * « randomInt » plutôt qu'un modulo sur randomBytes : le modulo d'un octet par
 * trente et un favorise les premiers caractères de l'alphabet, ce qui réduit
 * l'entropie réelle du code.
 */
function tirerCodeLisible(longueur = LONGUEUR_CODE) {
  let code = '';
  for (let rang = 0; rang < longueur; rang += 1) {
    code += ALPHABET_LISIBLE[crypto.randomInt(ALPHABET_LISIBLE.length)];
  }
  return code;
}

/** Tire un code SMS de six chiffres, zéros de tête compris. */
function tirerCodeSms() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Hache un code. Format : « scrypt$N$r$p$sel$empreinte », en base64url.
 * @returns {Promise<string>} empreinte stockable
 */
function hacher(code) {
  return new Promise((resoudre, rejeter) => {
    const sel = crypto.randomBytes(OCTETS_SEL);
    crypto.scrypt(
      String(code),
      sel,
      OCTETS_EMPREINTE,
      { N: COUT_N, r: COUT_R, p: COUT_P, maxmem: MEMOIRE_MAX },
      (erreur, empreinte) => {
        if (erreur) return rejeter(erreur);
        const sels = sel.toString('base64url');
        const brut = empreinte.toString('base64url');
        resoudre(`scrypt$${COUT_N}$${COUT_R}$${COUT_P}$${sels}$${brut}`);
      }
    );
  });
}

/**
 * Le code correspond-il à cette empreinte ?
 *
 * Toujours en temps constant, et sans jamais rejeter : une empreinte corrompue
 * en base donne « faux », pas une erreur 500 qui renseignerait un attaquant sur
 * l'état interne du serveur.
 *
 * @returns {Promise<boolean>}
 */
function verifier(code, empreinteStockee) {
  return new Promise((resoudre) => {
    const morceaux = String(empreinteStockee || '').split('$');
    if (morceaux.length !== 6 || morceaux[0] !== 'scrypt') {
      console.error('[codes] empreinte de format inconnu ignorée');
      return resoudre(false);
    }

    const [, n, r, p, selBase64, empreinteBase64] = morceaux;
    let sel;
    let attendue;
    try {
      sel = Buffer.from(selBase64, 'base64url');
      attendue = Buffer.from(empreinteBase64, 'base64url');
    } catch (erreur) {
      console.error('[codes] empreinte illisible ignorée');
      return resoudre(false);
    }

    if (sel.length === 0 || attendue.length === 0) {
      console.error('[codes] empreinte vide ignorée');
      return resoudre(false);
    }

    return crypto.scrypt(
      String(code),
      sel,
      attendue.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MEMOIRE_MAX },
      (erreur, calculee) => {
        if (erreur) {
          console.error(`[codes] vérification impossible : ${erreur.message}`);
          return resoudre(false);
        }
        if (calculee.length !== attendue.length) return resoudre(false);
        return resoudre(crypto.timingSafeEqual(calculee, attendue));
      }
    );
  });
}

/**
 * Un code personnel est-il recevable ?
 *
 * Six à douze caractères, sans espace : c'est la seule contrainte. Exiger une
 * majuscule et un chiffre à des membres qui saisissent leur code sur un clavier
 * de téléphone, chaque samedi au bord d'un terrain, produirait des codes écrits
 * sur un papier dans la poche — moins sûr, pas plus.
 *
 * @returns {string|null} message d'erreur en français, ou null si le code va
 */
function refusCodePersonnel(code) {
  const valeur = String(code == null ? '' : code);
  if (!valeur) return 'Choisissez un code personnel.';
  if (/\s/.test(valeur)) return "Le code ne doit pas contenir d'espace.";
  if (valeur.length < CODE_PERSONNEL_MIN || valeur.length > CODE_PERSONNEL_MAX) {
    return `Le code doit comporter de ${CODE_PERSONNEL_MIN} à ${CODE_PERSONNEL_MAX} caractères.`;
  }
  return null;
}

/**
 * Code d'association tiré du nom : trois lettres du nom, trois chiffres.
 *
 * Les lettres rendent le code mémorisable — un président le dicte au téléphone à
 * ses membres — et les chiffres écartent les collisions entre deux « Les Lions ».
 * Les accents sont dépliés et les caractères hors alphabet écartés ; un nom trop
 * court est complété par des lettres TIRÉES AU SORT, et non par un remplissage
 * prévisible qui rendrait le code devinable.
 *
 * @param {string} nom nom de l'association
 * @returns {string} code de six caractères
 */
function tirerCodeAssociation(nom) {
  const deplie = String(nom || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  let lettres = deplie.slice(0, 3);
  while (lettres.length < 3) {
    lettres += ALPHABET_LISIBLE[crypto.randomInt(LETTRES_LISIBLES)];
  }

  const chiffres = String(crypto.randomInt(0, 1000)).padStart(3, '0');
  return `${lettres}${chiffres}`;
}

/** Masque un numéro pour les journaux : « +237******789 ». */
function masquerTelephone(telephone) {
  const brut = String(telephone || '');
  if (brut.length < 4) return '***';
  return `${brut.slice(0, 4)}******${brut.slice(-3)}`;
}

/**
 * Le numéro est-il un mobile camerounais valide ?
 *
 * Format retenu : « +237 » suivi de neuf chiffres commençant par 6 ou 2. La
 * tolérance de saisie (espaces, points, indicatif omis, 00237) est traitée par
 * « normaliserTelephone » : un président qui tape « 6 99 12 34 56 » ne doit pas
 * se voir refuser sa création d'association.
 */
function telephoneValide(telephone) {
  return /^\+237[62]\d{8}$/.test(String(telephone || ''));
}

/**
 * Normalise un numéro camerounais vers « +237XXXXXXXXX ».
 * @returns {string} numéro normalisé, ou chaîne vide s'il est inexploitable
 */
function normaliserTelephone(valeur) {
  let brut = String(valeur || '').replace(/[\s.\-()]/g, '');
  if (brut.startsWith('00237')) brut = `+${brut.slice(2)}`;
  else if (brut.startsWith('237')) brut = `+${brut}`;
  else if (/^[62]\d{8}$/.test(brut)) brut = `+237${brut}`;
  return telephoneValide(brut) ? brut : '';
}

module.exports = {
  tirerCodeLisible,
  tirerCodeSms,
  tirerCodeAssociation,
  hacher,
  verifier,
  refusCodePersonnel,
  masquerTelephone,
  telephoneValide,
  normaliserTelephone,
  ALPHABET_LISIBLE,
  LONGUEUR_CODE,
  CODE_PERSONNEL_MIN,
  CODE_PERSONNEL_MAX,
};
