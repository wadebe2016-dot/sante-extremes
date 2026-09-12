/**
 * Client HTTP unique de l'application — pointe vers le backend Express.
 *
 * L'URL est lue dans cet ordre :
 *   1. la variable d'environnement EXPO_PUBLIC_API_URL (.env.local / build EAS)
 *   2. le champ extra.apiUrl de app.json
 *   3. l'adresse par défaut de l'émulateur Android (10.0.2.2 = localhost du PC)
 *
 * Le suffixe « /api » éventuellement présent dans la configuration est retiré :
 * les chemins appelés ici incluent déjà « /api ».
 */
import axios from 'axios';
import Constants from 'expo-constants';

const URL_PAR_DEFAUT = 'http://10.0.2.2:3000';

/**
 * Normalise l'URL configurée : retire la barre finale et un éventuel suffixe /api.
 */
function normaliserUrl(valeur) {
  return String(valeur || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}

export const URL_API =
  normaliserUrl(process.env.EXPO_PUBLIC_API_URL) ||
  normaliserUrl(Constants.expoConfig?.extra?.apiUrl) ||
  URL_PAR_DEFAUT;

const client = axios.create({
  baseURL: URL_API,
  timeout: 20000,
  headers: { Accept: 'application/json' },
});

console.log(`[API] backend ciblé : ${URL_API}`);

/**
 * Traduit une erreur axios en message lisible par l'utilisateur.
 */
export function messageErreur(erreur) {
  if (erreur?.response?.data?.error) return erreur.response.data.error;
  if (erreur?.code === 'ECONNABORTED') return 'Le serveur ne répond pas (délai dépassé)';
  if (erreur?.message === 'Network Error') return 'Serveur injoignable, vérifiez la connexion';
  return erreur?.message || 'Une erreur inattendue est survenue';
}

/**
 * Récupère le tableau public des cotisations.
 * @returns {Promise<{summary: object, members: Array}>}
 */
export async function recupererStats() {
  try {
    const reponse = await client.get('/api/stats');
    const membres = reponse.data?.members || [];
    const synthese = reponse.data?.summary || {
      total_members: membres.length,
      paid: 0,
      unpaid: membres.length,
      percentage_paid: 0,
      current_month: null,
    };
    console.log(`[API] stats reçues : ${membres.length} membre(s), ${synthese.paid} à jour`);
    return { summary: synthese, members: membres };
  } catch (erreur) {
    console.error(`[API] échec du chargement des stats : ${messageErreur(erreur)}`);
    throw erreur;
  }
}

/**
 * Enregistre un paiement de cotisation, avec justificatif photo facultatif.
 * @param {{memberId:number, montant:number, moyen:string, image?:{uri:string,mimeType?:string,fileName?:string}|null}} paiement
 */
export async function enregistrerCotisation({ memberId, montant, moyen, image }) {
  const formulaire = new FormData();
  formulaire.append('member_id', String(memberId));
  formulaire.append('montant', String(montant));
  formulaire.append('moyen', moyen);

  if (image?.uri) {
    formulaire.append('fichier', {
      uri: image.uri,
      name: image.fileName || `justificatif-${memberId}.jpg`,
      type: image.mimeType || 'image/jpeg',
    });
  }

  try {
    const reponse = await client.post('/api/cotisations', formulaire, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    console.log(`[API] cotisation enregistrée : #${reponse.data?.id}`);
    return reponse.data;
  } catch (erreur) {
    console.error(`[API] échec de l'enregistrement : ${messageErreur(erreur)}`);
    throw erreur;
  }
}

export default client;
