# Envoi de SMS — DeuxZero (LOT 7)

Les SMS ne sont pas un confort : ils sont le seul moyen pour un membre du bureau
de récupérer un code perdu **sans appeler l'éditeur**, qui n'entre jamais en
contact avec les associations. Si les SMS ne partent pas, le produit reste
utilisable, mais toute perte de code devient définitive — le président ne peut
alors plus dépanner que ses collaborateurs, et personne ne peut le dépanner lui.

Chaque SMS est payé par l'éditeur. C'est pourquoi trois plafonds sont posés dans
le code et non dans la configuration : **3 réinitialisations par mois et par
association**, **5 essais erronés → blocage d'une heure**, et **1 seul SMS par
demande** (une demande déjà ouverte n'en déclenche pas une seconde).

---

## Architecture

Un seul point d'entrée pour tout le backend :

```js
const { envoyerSms } = require('./services/sms');

const resultat = await envoyerSms({
  destinataire: '+237699123456',
  message: 'Votre code de vérification est 483920.',
  association: 'SDE001',      // pour le suivi de consommation
  motif: 'reinitialisation_role',
});
// → { succes: bool, identifiant: string|null, erreur: string|null }
```

| Fichier | Rôle |
|---|---|
| `src/services/sms/index.js` | interface unique, choix du routeur, journalisation |
| `src/services/sms/transport.js` | POST HTTP commun : délai 10 s, 2 réessais, repli exponentiel |
| `src/services/sms/infobip.js` | routeur Infobip — **actif par défaut** |
| `src/services/sms/nexah.js` | routeur Nexah — **prêt, non activé** |
| `src/services/sms/journal.js` | n'envoie rien, écrit le SMS dans les logs |

**Aucune implémentation ne lève jamais.** Un routeur injoignable, une clé
absente, un numéro refusé : tout revient en `{ succes: false, erreur }`. Une
réinitialisation qui échoue répond poliment à son demandeur ; elle ne fait pas
tomber le service pour les trente-huit autres membres.

### Politique de réessai

Dans `transport.js`, une seule fois pour les deux routeurs — ils n'ont ni la même
URL ni le même corps, mais exactement les mêmes modes de panne :

- **10 s** d'attente maximum par tentative (`SMS_DELAI_MS`) ;
- **2 réessais**, repli exponentiel 1 s puis 2 s (`SMS_REESSAIS`, `SMS_REPLI_MS`) ;
- **un 4xx n'est jamais réessayé** : un numéro invalide ou une clé refusée le
  resteront, et réessayer ne ferait que tripler la facture.

---

## Variables d'environnement

### Commun

| Variable | Défaut | Rôle |
|---|---|---|
| `SMS_FOURNISSEUR` | `infobip` | `infobip`, `nexah` ou `journal` |
| `SMS_DELAI_MS` | `10000` | délai d'attente par tentative |
| `SMS_REESSAIS` | `2` | nombre de réessais |
| `SMS_REPLI_MS` | `1000` | base du repli exponentiel |

Un nom de routeur inconnu retombe sur `journal` — **jamais** sur un envoi réel —
et le signale dans les logs. Écrire dans un fichier coûte zéro franc et se voit.

### Infobip (actif)

| Variable | Exemple |
|---|---|
| `INFOBIP_BASE_URL` | `https://xxxxx.api.infobip.com` (sans barre finale) |
| `INFOBIP_API_KEY` | clé d'API |
| `INFOBIP_EXPEDITEUR` | `DeuxZero` |

Appel : `POST {BASE_URL}/sms/2/text/advanced`, en-tête
`Authorization: App {API_KEY}`, corps
`{ messages: [ { destinations: [{to}], from, text } ] }`.
Le `messageId` retourné est conservé dans `sms_envoyes.identifiant` : c'est la
seule façon de retrouver un envoi dans la console Infobip quand un membre affirme
n'avoir rien reçu.

### Nexah (prêt, non activé)

| Variable | Exemple |
|---|---|
| `NEXAH_BASE_URL` | `https://smsvas.com/bulk/public/index.php/api/v1` |
| `NEXAH_UTILISATEUR` | identifiant du compte |
| `NEXAH_MOT_DE_PASSE` | mot de passe du compte |
| `NEXAH_EXPEDITEUR` | `DeuxZero` (senderid validé auprès de Nexah) |

Appel : `POST {BASE_URL}/sendsms`, formulaire
`user, password, senderid, mobiles, sms`. Les numéros partent **sans le `+`** :
`237699123456`. La lecture de la réponse est défensive — `responses[0].messageid`,
puis `messageid`, puis `id` — parce que la forme varie selon la version du compte.
Nexah répond parfois `200` en signalant un refus dans le corps : ce cas est
détecté et rendu comme un échec.

---

## Basculer d'Infobip vers Nexah — trois lignes

Nexah est un agrégateur camerounais : ses SMS partent des réseaux locaux et
coûtent sensiblement moins cher qu'un routeur international. La bascule est une
décision de coût, pas de code.

Dans `/opt/deuxzero/backend/.env` (ou l'emplacement du service) :

```env
SMS_FOURNISSEUR=nexah
NEXAH_UTILISATEUR=votre_identifiant
NEXAH_MOT_DE_PASSE=votre_mot_de_passe
NEXAH_EXPEDITEUR=DeuxZero
NEXAH_BASE_URL=https://smsvas.com/bulk/public/index.php/api/v1
```

puis :

```bash
sudo systemctl restart sde-api
curl -s https://sde-api.atlastech.cm/api/health     # → "sms":"nexah"
```

**Aucun autre fichier n'est touché.** Les clés Infobip peuvent rester en place :
elles ne sont plus lues. Le retour en arrière est symétrique — remettre
`SMS_FOURNISSEUR=infobip` et redémarrer.

Pour éprouver la chaîne sans dépenser un SMS : `SMS_FOURNISSEUR=journal`. Le
texte complet, code compris, est alors écrit dans `journalctl -u sde-api`.

> **`journal` ne doit jamais être actif en production.** Le démarrage du service
> l'écrit en majuscules quand `NODE_ENV=production` : aucun SMS ne partira, les
> réinitialisations seront inopérantes, et les codes apparaîtront dans les logs.

---

## Suivi de la consommation

Table `sms_envoyes` dans `data/annuaire.db` — le seul endroit du produit où une
donnée traverse les associations, et c'est assumé : la facture est celle de
l'éditeur, pas celle des clients.

| Colonne | Contenu |
|---|---|
| `association` | code de l'association |
| `destinataire` | numéro **masqué** : `+237******456` |
| `motif` | `reinitialisation_role`, `contreseing_president`, … |
| `fournisseur` | routeur employé |
| `identifiant` | identifiant de message du routeur |
| `succes`, `erreur` | résultat |
| `date_envoi` | horodatage |

Le numéro complet n'y est **jamais** écrit : suivre un volume ne demande pas de
conserver les numéros des membres du bureau de chaque client.

Lecture réservée à l'éditeur :

```bash
curl -s -H "Authorization: Bearer $ADMIN_PRODUIT_CODE" \
  https://sde-api.atlastech.cm/api/admin-produit/sms/statistiques
```

Sans `ADMIN_PRODUIT_CODE` en environnement, l'espace éditeur est **fermé** (503),
jamais ouvert : une variable oubliée au déploiement ne doit pas le rendre public.

---

## Messages envoyés

Trois seulement, tous en français, tous préfixés du nom de l'association pour que
le destinataire sache de quoi on lui parle.

| Motif | Contenu |
|---|---|
| `reinitialisation_role` | code à 6 chiffres, valable 15 minutes |
| `contreseing_president` | « Le président demande la réinitialisation de son code. Répondez dans l'application pour confirmer. » |
| `code_president_reinitialise` | code temporaire à 8 caractères, valable 24 h |

Aucun message ne contient de donnée métier : ni montant, ni nom de membre, ni
situation de caisse. Un SMS transite en clair.
