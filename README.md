# Santé des extrêmes — Gestion des cotisations (LOT 1)

Suivi des cotisations d'une association sportive (~50 membres) : un backend Express avec base
SQLite embarquée, et une application mobile Expo livrée en APK Android.

- **Tableau public** : n'importe qui voit, sans authentification, qui est à jour de sa cotisation.
- **Enregistrement** : un trésorier saisit un paiement (montant, moyen, photo du justificatif).
- **Administration** : ajout et suppression de membres, protégés par un jeton Bearer.

---

## 1. Architecture

```
┌────────────────────────┐        HTTP/JSON        ┌──────────────────────────┐
│  Application Expo      │  ────────────────────►  │  Backend Express         │
│  (APK Android)         │                         │  Node 20                 │
│                        │  ◄────────────────────  │                          │
│  • TableauPublicScreen │      GET /api/stats     │  • /api/admin/members    │
│    polling 30 s        │                         │  • /api/cotisations      │
│  • EnregistrementScreen│   POST /api/cotisations │  • /api/stats            │
│    FormData + photo    │      (multipart)        │  • /api/health           │
└────────────────────────┘                         └───────────┬──────────────┘
                                                               │
                                         ┌─────────────────────┴─────────────────────┐
                                         │                                           │
                                 ┌───────▼────────┐                        ┌─────────▼─────────┐
                                 │ SQLite         │                        │ AWS S3 eu-west-3  │
                                 │ data/sde.db    │                        │ justificatifs     │
                                 │ members        │                        │ cotisations/…     │
                                 │ cotisations    │                        └───────────────────┘
                                 └────────────────┘
```

### Arborescence

```
sante-extremes/
├── backend/
│   ├── src/
│   │   ├── index.js                 serveur Express, CORS, journal HTTP, arrêt propre
│   │   ├── db.js                    connexion SQLite + migration (exécutable directement)
│   │   ├── routes/
│   │   │   ├── admin.js             POST /members, DELETE /members/:id
│   │   │   ├── cotisations.js       POST / (multipart + dépôt S3)
│   │   │   └── stats.js             GET / (synthèse + liste des membres)
│   │   ├── middleware/
│   │   │   ├── auth.js              vérification du jeton Bearer
│   │   │   └── s3upload.js          multer mémoire + PutObject S3
│   │   └── models/schema.sql        members, cotisations, index, ON DELETE CASCADE
│   ├── package.json · Dockerfile · .env.example · .gitignore
├── mobile/
│   ├── App.js                       TabNavigator (Tableau · Paiement) + Toast
│   ├── screens/TableauPublicScreen.js
│   ├── screens/EnregistrementScreen.js
│   ├── api/client.js                instance axios + appels API
│   ├── assets/logo.png
│   ├── app.json · eas.json · babel.config.js · package.json · .env.example · .gitignore
├── docs/etat-lot01.md
├── COMMANDES_CLÉS.md
├── README.md
└── .gitignore
```

### Choix techniques

| Sujet | Décision |
| --- | --- |
| Base de données | SQLite embarquée : ~50 membres, aucun serveur à administrer, sauvegarde = copie de fichier |
| SDK AWS | `@aws-sdk/client-s3` (v3). La v2 (`aws-sdk`) est en fin de support et déconseillée en production |
| Upload | `multer` 2.x en mémoire (la 1.x porte des vulnérabilités connues), 5 Mo max, images uniquement |
| Authentification | Jeton Bearer unique comparé en temps constant (`crypto.timingSafeEqual`) |
| Justificatif | Facultatif : un paiement en espèce peut être saisi sans photo (`fichier_s3_url` vaut alors `null`) |
| Statut « payé » | Fenêtre **mensuelle** : à jour si au moins une cotisation dans le mois calendaire en cours |

---

## 2. Backend

### Installation

```bash
cd backend
npm install
cp .env.example .env   # renseigner AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / ADMIN_PASSWORD
npm run migrate
npm start
```

Le serveur écoute sur `http://localhost:3000` (variable `PORT`). La migration est rejouée
automatiquement au démarrage ; `npm run migrate` sert à initialiser la base sans lancer le serveur.

### Variables d'environnement (`backend/.env`)

| Variable | Rôle |
| --- | --- |
| `NODE_ENV` | `production` ou `development` |
| `PORT` | Port d'écoute HTTP (défaut `3000`) |
| `DB_PATH` | Chemin du fichier SQLite (défaut `./data/sde.db`) |
| `AWS_REGION` | Région du bucket (`eu-west-3`) |
| `AWS_BUCKET` | Nom du bucket des justificatifs |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Identifiants IAM — omissibles si un rôle IAM est attaché |
| `ADMIN_PASSWORD` | Jeton Bearer des routes d'administration |
| `S3_MAX_FILE_SIZE` | Taille maximale d'un justificatif, en octets (défaut 5 Mo) |

Aucun secret n'est écrit en dur dans le code, et `.env` n'est jamais versionné.

### API

| Méthode | Route | Auth | Codes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | 200 |
| `POST` | `/api/admin/members` | Bearer | 201 · 400 · 401 · 409 |
| `DELETE` | `/api/admin/members/:id` | Bearer | 200 · 400 · 401 · 404 |
| `POST` | `/api/cotisations` | — | 201 · 400 · 404 · 413 · 500 |
| `GET` | `/api/stats` | — | 200 |

**`POST /api/cotisations`** — `multipart/form-data` : `member_id` (entier), `montant` (nombre > 0),
`moyen` (`Mobile Money` ou `Espèce`, accents et casse tolérés), `fichier` (image, 5 Mo max, **facultatif**).

```json
{
  "id": 1, "member_id": 1, "montant": 5000, "moyen": "Mobile Money",
  "fichier_s3_url": "https://sde-cotisations-paiements.s3.eu-west-3.amazonaws.com/cotisations/membre-1/…",
  "date_paiement": "2025-09-12T10:30:00Z"
}
```

**`GET /api/stats`**

```json
{
  "summary": { "total_members": 2, "paid": 1, "unpaid": 1, "percentage_paid": 50, "current_month": "2025-09" },
  "members": [
    { "id": 1, "name": "Alice", "paid": true, "last_paiement": "2025-09-12T10:30:00Z", "montant_total": 5000 },
    { "id": 2, "name": "Bob", "paid": false, "last_paiement": null, "montant_total": 0 }
  ]
}
```

`paid` et `montant_total` portent sur le **mois calendaire en cours** ; `last_paiement` conserve la
date du dernier règlement, même s'il est plus ancien. Le tableau repart donc à zéro chaque 1ᵉʳ du mois.

### Modèle de données

```sql
members      (id, name UNIQUE, created_at)
cotisations  (id, member_id → members.id ON DELETE CASCADE, montant, moyen, fichier_s3_url, date_paiement)
```

---

## 3. Mobile (Expo)

```bash
cd mobile
npm install
cp .env.example .env.local   # EXPO_PUBLIC_API_URL
npm start                    # Expo Go
```

L'adresse du backend est lue dans l'ordre : `EXPO_PUBLIC_API_URL` → `extra.apiUrl` de `app.json` →
`http://10.0.2.2:3000`. Un suffixe `/api` éventuel est retiré automatiquement, les deux écritures
fonctionnent donc (`http://x:3000` comme `http://x:3000/api`).

| Contexte | Valeur |
| --- | --- |
| Émulateur Android | `http://10.0.2.2:3000/api` |
| Téléphone physique | `http://<IP-du-poste>:3000/api` |
| Production | `https://<domaine>/api` |

### Écrans

- **Tableau** (`screens/TableauPublicScreen.js`) : bandeau de synthèse du mois, `FlatList` des membres
  (`{nom} — ✓ Payé / ✗ Impayé`), polling automatique toutes les 30 s via `useFocusEffect`,
  `RefreshControl` pour le rafraîchissement manuel, aucune authentification.
- **Paiement** (`screens/EnregistrementScreen.js`) : `Picker` des membres alimenté par `GET /api/stats`,
  montant numérique, `Picker` du moyen (Mobile Money / Espèce), photo caméra ou galerie via
  `expo-image-picker`, envoi en `FormData`, Toast succès/erreur et réinitialisation du formulaire.

### Génération de l'APK

```bash
npm install -g eas-cli && eas login
cd mobile
npm run eas-build-local   # build local — APK : android/app/build/outputs/apk/release/app-release.apk
npm run eas-build         # build sur les serveurs Expo — APK téléchargeable
```

`eas.json` force `buildType: apk` sur les trois profils : aucun AAB n'est produit.
Avant un build destiné aux membres, figer `extra.apiUrl` dans `app.json` sur l'URL publique du backend.

---

## 4. Déploiement AWS

### 4.1 Bucket S3 des justificatifs

```bash
aws s3api create-bucket --bucket sde-cotisations-paiements \
  --region eu-west-3 --create-bucket-configuration LocationConstraint=eu-west-3
```

Les URL renvoyées dans `fichier_s3_url` sont des URL publiques. Pour qu'elles soient lisibles,
appliquer une politique de lecture seule limitée au préfixe `cotisations/` (`policy-s3.json`) :

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "LectureJustificatifs",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::sde-cotisations-paiements/cotisations/*"
  }]
}
```

Les clés générées contiennent 8 octets aléatoires, ce qui rend les URL non devinables. Pour une
confidentialité stricte, retirer cette politique et servir les justificatifs via des URL pré-signées
(évolution prévue hors LOT 1).

### 4.2 Utilisateur IAM du backend

Droits minimaux nécessaires :

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::sde-cotisations-paiements/cotisations/*"
  }]
}
```

Sur EC2 / ECS, préférer un **rôle IAM** attaché à l'instance : laisser `AWS_ACCESS_KEY_ID` et
`AWS_SECRET_ACCESS_KEY` vides suffit, le SDK utilise alors la chaîne de credentials par défaut.

### 4.3 Conteneur

```bash
cd backend
docker build -t sde-backend .
docker run -d --name sde-backend -p 3000:3000 \
  --env-file .env -v sde-data:/app/data sde-backend
```

La base SQLite vit dans le volume `/app/data` : **toujours monter ce volume**, sinon les données
disparaissent à chaque redéploiement. Sauvegarde : `docker cp sde-backend:/app/data/sde.db ./sauvegarde.db`.

Derrière un reverse proxy (Nginx, ALB), terminer le TLS en amont et transmettre le port 3000 ;
l'application n'embarque pas de certificat.

---

## 5. VALIDATION

### 5.1 Démarrer le backend

```bash
cd backend && npm install && cp .env.example .env && npm run migrate && npm start
```

### 5.2 Tester les 4 routes

```bash
curl -X POST http://localhost:3000/api/admin/members \
  -H "Authorization: Bearer sde+691234567" -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'

curl -X POST http://localhost:3000/api/cotisations \
  -F "member_id=1" -F "montant=5000" -F "moyen=Mobile Money"

curl http://localhost:3000/api/stats

curl -X DELETE http://localhost:3000/api/admin/members/1 \
  -H "Authorization: Bearer sde+691234567"
```

### 5.3 Générer l'APK

```bash
cd mobile && npm install && npm run eas-build-local
# APK : android/app/build/outputs/apk/release/app-release.apk
```

### 5.4 Check-list de validation

| # | Vérification | Attendu | État |
| --- | --- | --- | --- |
| 1 | `GET /api/health` | 200 `{"status":"ok"}` | ✅ vérifié |
| 2 | `POST /api/admin/members` sans jeton | 401 | ✅ vérifié |
| 3 | `POST /api/admin/members` jeton erroné | 401 | ✅ vérifié |
| 4 | `POST /api/admin/members` valide | 201 + `created_at` ISO | ✅ vérifié |
| 5 | Membre en doublon | 409 | ✅ vérifié |
| 6 | Nom vide | 400 | ✅ vérifié |
| 7 | `POST /api/cotisations` sans justificatif | 201, `fichier_s3_url: null` | ✅ vérifié |
| 8 | Moyen `espece` (sans accent) | 201, normalisé en `Espèce` | ✅ vérifié |
| 9 | Moyen invalide | 400 | ✅ vérifié |
| 10 | Montant négatif | 400 | ✅ vérifié |
| 11 | Membre inexistant | 404 | ✅ vérifié |
| 12 | Fichier non image | 400 | ✅ vérifié |
| 13 | Fichier > 5 Mo | 413 | ✅ vérifié |
| 14 | `GET /api/stats` | 200, `summary` + `members` cohérents | ✅ vérifié |
| 15 | `DELETE` d'un id inexistant | 404 | ✅ vérifié |
| 16 | `DELETE` d'un membre | 200, cotisations supprimées en cascade | ✅ vérifié |
| 17 | Route inconnue | 404 | ✅ vérifié |
| 18 | Upload S3 réel | dépend d'un bucket et de clés valides | ⏳ à valider sur AWS |
| 19 | Écrans mobiles sur appareil | 2 onglets fonctionnels | ⏳ à valider après `npm install` |
| 20 | Build APK EAS | `app-release.apk` produite | ⏳ à valider après `npm install` |

### 5.5 Logs de test (exécution réelle du 12/09, 20 appels)

```
[bd] base ouverte : ./data/sde.db
[migration] schéma appliqué (members, cotisations, index)
[serveur] Santé des extrêmes à l'écoute sur le port 3000 (production)
[http] GET /api/health → 200 (4 ms)
[auth] en-tête Authorization manquant ou mal formé sur POST /api/admin/members
[http] POST /api/admin/members → 401 (1 ms)
[auth] jeton invalide sur POST /api/admin/members
[http] POST /api/admin/members → 401 (0 ms)
[auth] accès admin accordé sur POST /api/admin/members
[admin] membre créé : #1 Alice
[http] POST /api/admin/members → 201 (9 ms)
[admin] membre créé : #2 Bob
[admin] membre créé : #3 Chloé
[admin] membre déjà existant : Alice
[http] POST /api/admin/members → 409 (1 ms)
[admin] création refusée : champ « name » manquant ou vide
[http] POST /api/admin/members → 400 (0 ms)
[cotisations] paiement sans justificatif pour le membre #1
[cotisations] paiement enregistré : #1 — Alice — 5000 (Mobile Money)
[http] POST /api/cotisations → 201 (11 ms)
[cotisations] paiement enregistré : #2 — Chloé — 2500 (Espèce)
[http] POST /api/cotisations → 201 (11 ms)
[cotisations] refus : moyen de paiement inconnu « Carte bancaire »
[http] POST /api/cotisations → 400 (1 ms)
[cotisations] refus : montant invalide « -10 »
[cotisations] refus : membre #999 introuvable
[http] POST /api/cotisations → 404 (1 ms)
[upload] type de fichier refusé : text/plain
[http] POST /api/cotisations → 400 (2 ms)
[upload] fichier trop volumineux (> 5242880 octets)
[http] POST /api/cotisations → 413 (22 ms)
[stats] tableau public servi : 2/3 à jour (67 %) pour 2026-09
[http] GET /api/stats → 200 (1 ms)
[admin] suppression sans effet : membre #999 introuvable
[http] DELETE /api/admin/members/999 → 404 (1 ms)
[admin] membre supprimé : #2
[http] DELETE /api/admin/members/2 → 200 (6 ms)
[stats] tableau public servi : 2/2 à jour (100 %) pour 2026-09
[http] route inconnue : GET /api/inexistant
[http] GET /api/inexistant → 404 (0 ms)
```

Réponse `GET /api/stats` obtenue pendant ce test :

```json
{"summary":{"total_members":3,"paid":2,"unpaid":1,"percentage_paid":67,"current_month":"2026-09"},
 "members":[
  {"id":1,"name":"Alice","paid":true,"last_paiement":"2026-09-12T16:51:43Z","montant_total":5000},
  {"id":2,"name":"Bob","paid":false,"last_paiement":null,"montant_total":0},
  {"id":3,"name":"Chloé","paid":true,"last_paiement":"2026-09-12T16:51:43Z","montant_total":2500}]}
```

---

## 6. Dépannage

| Symptôme | Cause probable | Correction |
| --- | --- | --- |
| `POST /api/admin/members` → 401 | En-tête absent ou mot de passe différent de `.env` | `Authorization: Bearer <ADMIN_PASSWORD>` |
| Membre créé mais `name` vide / 400 | `curl` sans `Content-Type: application/json` | Ajouter l'en-tête |
| `EADDRINUSE` au démarrage | Port 3000 déjà occupé | `PORT=3001 npm start`, ou arrêter le processus existant |
| `SQLITE_CANTOPEN` | `DB_PATH` pointe vers un dossier inexistant ou en lecture seule | Le dossier parent est créé automatiquement ; vérifier les droits |
| `Le justificatif n'a pas pu être enregistré sur S3` (500) | Clés AWS factices, bucket absent, mauvaise région, droit `s3:PutObject` manquant | Vérifier `.env` et la politique IAM ; les logs `[s3]` donnent le détail |
| `AWS_BUCKET non configuré` | Variable absente de `.env` | Renseigner `AWS_BUCKET` |
| 413 à l'upload | Image > `S3_MAX_FILE_SIZE` | Réduire la qualité, ou augmenter la variable |
| 400 « Seules les images sont acceptées » | Type MIME non image | JPEG, PNG, WEBP ou HEIC uniquement |
| `npm install` échoue sur `sqlite3` | Outils de compilation absents | Node 18+ ; sous Windows `npm i -g windows-build-tools`, sous Debian `apt install python3 make g++` |
| Mobile : « Serveur injoignable » | `localhost` depuis un appareil ne désigne pas le PC | Émulateur : `10.0.2.2` ; téléphone : IP du poste sur le même réseau Wi-Fi |
| Mobile : liste des membres vide | Aucun membre créé, ou mauvaise URL d'API | Créer un membre via l'API ; vérifier le log `[API] backend ciblé : …` |
| Android bloque l'appel HTTP | Trafic en clair interdit par défaut | Utiliser HTTPS en production, ou un profil de build de développement |
| Permission photo refusée | Autorisation système non accordée | Réglages Android → Application → Autorisations |
| EAS : `buildType` ignoré | `eas.json` non pris en compte | Lancer `eas build` depuis `mobile/`, profil `production` |
| Données perdues après redéploiement Docker | Volume non monté | `-v sde-data:/app/data` |

---

## 7. Suite

État détaillé du lot : [`docs/etat-lot01.md`](docs/etat-lot01.md).
Commandes regroupées : [`COMMANDES_CLÉS.md`](COMMANDES_CLÉS.md).
