# Commandes clés — Santé des extrêmes

Toutes les commandes du LOT 1, regroupées. `$JETON` désigne le mot de passe administrateur
(`ADMIN_PASSWORD`, valeur du lot : `sde+691234567`).

---

## 1. Backend — installation et démarrage

```bash
cd backend
npm install                       # installe express, sqlite3, multer, cors, dotenv, @aws-sdk/client-s3
cp .env.example .env              # puis renseigner les clés AWS et ADMIN_PASSWORD
npm run migrate                   # crée ./data/sde.db et applique src/models/schema.sql
npm start                         # démarre sur http://localhost:3000
npm run dev                       # démarrage avec rechargement à chaud (node --watch)
```

## 2. Backend — tests des 4 routes

```bash
# 1. Ajouter un membre (auth obligatoire)
curl -X POST http://localhost:3000/api/admin/members \
  -H "Authorization: Bearer sde+691234567" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'

# 2. Enregistrer un paiement (justificatif facultatif)
curl -X POST http://localhost:3000/api/cotisations \
  -F "member_id=1" -F "montant=5000" -F "moyen=Mobile Money"

curl -X POST http://localhost:3000/api/cotisations \
  -F "member_id=1" -F "montant=5000" -F "moyen=Mobile Money" \
  -F "fichier=@./justificatif.jpg"

# 3. Consulter le tableau public (aucune authentification)
curl http://localhost:3000/api/stats

# 4. Supprimer un membre (auth obligatoire, cotisations supprimées en cascade)
curl -X DELETE http://localhost:3000/api/admin/members/1 \
  -H "Authorization: Bearer sde+691234567"

# Sonde de santé
curl http://localhost:3000/api/health
```

> `-H "Content-Type: application/json"` est obligatoire sur `POST /api/admin/members` :
> sans lui, `curl` envoie le corps en `x-www-form-urlencoded` et le champ `name` est ignoré.

## 3. Base de données

```bash
sqlite3 backend/data/sde.db ".schema"
sqlite3 backend/data/sde.db "SELECT * FROM members;"
sqlite3 backend/data/sde.db "SELECT * FROM cotisations ORDER BY date_paiement DESC LIMIT 10;"

rm backend/data/sde.db && npm --prefix backend run migrate   # réinitialisation complète
```

## 4. Docker

```bash
cd backend
docker build -t sde-backend .
docker run -d --name sde-backend -p 3000:3000 \
  --env-file .env -v sde-data:/app/data sde-backend

docker logs -f sde-backend
docker stop sde-backend && docker rm sde-backend
```

## 5. AWS — bucket S3 et déploiement

```bash
# Bucket des justificatifs
aws s3api create-bucket --bucket sde-cotisations-paiements \
  --region eu-west-3 --create-bucket-configuration LocationConstraint=eu-west-3

# Lecture publique des justificatifs (nécessaire pour afficher fichier_s3_url)
aws s3api put-public-access-block --bucket sde-cotisations-paiements \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"
aws s3api put-bucket-policy --bucket sde-cotisations-paiements --policy file://policy-s3.json

# Vérification des dépôts
aws s3 ls s3://sde-cotisations-paiements/cotisations/ --recursive --human-readable

# Déploiement de l'image sur ECR
aws ecr create-repository --repository-name sde-backend --region eu-west-3
aws ecr get-login-password --region eu-west-3 \
  | docker login --username AWS --password-stdin <compte>.dkr.ecr.eu-west-3.amazonaws.com
docker tag sde-backend <compte>.dkr.ecr.eu-west-3.amazonaws.com/sde-backend:1.0.0
docker push <compte>.dkr.ecr.eu-west-3.amazonaws.com/sde-backend:1.0.0
```

## 6. Mobile — développement

```bash
cd mobile
npm install
cp .env.example .env.local        # puis adapter EXPO_PUBLIC_API_URL
npm start                         # Expo Go, scanner le QR code
npm run android                   # lancement direct sur émulateur/appareil Android
```

Adresses utiles pour `EXPO_PUBLIC_API_URL` :

| Contexte | Valeur |
| --- | --- |
| Émulateur Android | `http://10.0.2.2:3000/api` |
| Téléphone physique | `http://<IP-du-poste>:3000/api` |
| Production | `https://<domaine>/api` |

## 7. Mobile — génération de l'APK Android

```bash
npm install -g eas-cli
eas login
cd mobile

eas build --platform android --profile production            # build distant, APK téléchargeable
npm run eas-build-local                                      # build local (Android SDK + JDK 17)
# APK locale : android/app/build/outputs/apk/release/app-release.apk

adb install -r android/app/build/outputs/apk/release/app-release.apk
adb logcat | grep -E "TableauPublic|Enregistrement|API"      # logs applicatifs
```

## 8. Git

```bash
git add .
git commit -m "LOT 1 — backend Express + mobile Expo"
git remote add origin https://github.com/wadebe2016-dot/sante-extremes.git
git push -u origin master
```
