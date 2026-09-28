/**
 * Appel HTTP commun aux routeurs SMS — LOT 7 « DeuxZero ».
 *
 * Infobip et Nexah n'ont ni la même URL, ni le même corps, ni le même format de
 * réponse — mais ils ont exactement les mêmes modes de panne : un réseau
 * camerounais qui coupe, une passerelle qui met huit secondes, un 503
 * passager. La politique de réessai vit donc ici, une seule fois.
 *
 *   · dix secondes d'attente maximum par tentative ;
 *   · deux réessais, repli exponentiel (une puis deux secondes) ;
 *   · un 4xx n'est JAMAIS réessayé : un numéro invalide ou une clé refusée le
 *     resteront, et réessayer trois fois ne ferait que tripler la facture.
 */
'use strict';

const DELAI_MS = Number(process.env.SMS_DELAI_MS) > 0 ? Number(process.env.SMS_DELAI_MS) : 10000;
const REESSAIS = Number.isInteger(Number(process.env.SMS_REESSAIS)) ? Number(process.env.SMS_REESSAIS) : 2;
const REPLI_MS = Number(process.env.SMS_REPLI_MS) > 0 ? Number(process.env.SMS_REPLI_MS) : 1000;

/** Pause, pour le repli exponentiel entre deux tentatives. */
function attendre(millisecondes) {
  return new Promise((resoudre) => setTimeout(resoudre, millisecondes));
}

/**
 * POST JSON (ou formulaire) avec délai d'attente et réessais.
 *
 * @param {object} appel
 * @param {string} appel.url URL complète
 * @param {object} appel.entetes en-têtes HTTP
 * @param {string} appel.corps corps déjà sérialisé
 * @param {string} appel.etiquette nom du routeur, pour les journaux
 * @returns {Promise<{ok: boolean, statut: number, texte: string, erreur: string|null}>}
 */
async function poster({ url, entetes, corps, etiquette }) {
  let dernier = { ok: false, statut: 0, texte: '', erreur: 'Aucune tentative' };

  for (let tentative = 0; tentative <= REESSAIS; tentative += 1) {
    if (tentative > 0) {
      const pause = REPLI_MS * 2 ** (tentative - 1);
      console.warn(`[sms:${etiquette}] réessai ${tentative}/${REESSAIS} dans ${pause} ms`);
      await attendre(pause);
    }

    const arret = new AbortController();
    const minuterie = setTimeout(() => arret.abort(), DELAI_MS);

    try {
      const reponse = await fetch(url, {
        method: 'POST',
        headers: entetes,
        body: corps,
        signal: arret.signal,
      });
      const texte = await reponse.text();

      if (reponse.ok) return { ok: true, statut: reponse.status, texte, erreur: null };

      dernier = {
        ok: false,
        statut: reponse.status,
        texte,
        erreur: `HTTP ${reponse.status}`,
      };

      // Une erreur de requête ne se corrige pas en la répétant.
      if (reponse.status >= 400 && reponse.status < 500) {
        console.error(`[sms:${etiquette}] refus définitif HTTP ${reponse.status}, aucun réessai`);
        return dernier;
      }
      console.warn(`[sms:${etiquette}] HTTP ${reponse.status}, réessai possible`);
    } catch (erreur) {
      const cause = erreur.name === 'AbortError' ? `délai de ${DELAI_MS} ms dépassé` : erreur.message;
      dernier = { ok: false, statut: 0, texte: '', erreur: cause };
      console.warn(`[sms:${etiquette}] tentative ${tentative + 1} en échec : ${cause}`);
    } finally {
      clearTimeout(minuterie);
    }
  }

  return dernier;
}

module.exports = { poster, DELAI_MS, REESSAIS, REPLI_MS };
