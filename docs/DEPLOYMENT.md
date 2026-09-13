# Déploiement AWS — Santé des extrêmes (LOT 2)

Mise en production du backend Express sur **AWS eu-west-3 (Paris)**, exposé en
HTTPS sur **`https://sde-api.atlastech.cm/api`**, avec intégration continue
GitHub Actions et DNS géré chez Cloudflare.

---

## Sommaire

1. [Architecture](#1-architecture)
2. [Prérequis](#2-prérequis)
3. [Première mise en service](#3-première-mise-en-service)
4. [Intégration continue GitHub Actions](#4-intégration-continue-github-actions)
5. [Déploiement manuel](#5-déploiement-manuel)
6. [Application mobile](#6-application-mobile)
7. [Exploitation courante](#7-exploitation-courante)
8. [Sauvegarde et restauration de la base](#8-sauvegarde-et-restauration-de-la-base)
9. [Dépannage](#9-dépannage)
10. [Coûts](#10-coûts)
11. [Suppression de l'infrastructure](#11-suppression-de-linfrastructure)

---

## 1. Architecture

```
                    Cloudflare (DNS only, sans proxy)
                    ┌──────────────────────┬─────────────────────┐
                    │ sde-api.atlastech.cm │ sde-cdn.atlastech.cm│
                    └──────────┬───────────┴──────────┬──────────┘
                               │ CNAME                │ CNAME
                    ┌──────────▼───────────┐  ┌───────▼─────────────┐
                    │  ALB + ACM (TLS 1.3) │  │ CloudFront + ACM    │
                    │  :443 → :3000        │  │ (certificat us-east-1)│
                    └──────────┬───────────┘  └───────┬─────────────┘
                               │                      │ OAC (lecture seule)
                    ┌──────────▼───────────┐  ┌───────▼─────────────┐
                    │ ECS Fargate — 1 tâche│  │ S3 « uploads »      │
                    │ backend Express      │──▶ justificatifs       │
                    │ (rôle IAM, sans clé) │  └─────────────────────┘
                    └──────────┬───────────┘
                               │ restore au démarrage / backup toutes les 5 min
                    ┌──────────▼───────────┐
                    │ S3 « db » (versionné)│  base SQLite = sqlite/sde.db
                    └──────────────────────┘

  Secrets Manager  sde-prod/admin-password   → injecté dans le conteneur
  CloudWatch Logs  /ecs/sde-prod-backend     → journaux applicatifs
  ECR              sde-prod-backend          → images Docker
```

### Choix structurants

| Décision | Raison |
|---|---|
| **SQLite sur S3, pas de RDS** | Volumétrie de l'association (quelques centaines de membres) ; RDS coûterait ~15 €/mois pour un besoin que S3 couvre à quelques centimes. Le versioning S3 tient lieu d'historique de sauvegardes. |
| **Une seule tâche ECS** | SQLite n'admet qu'un seul écrivain. `desired_count = 1`, sans autoscaling : deux tâches provoqueraient une perte d'écritures à la synchronisation S3. |
| **Déploiement « stop puis start »** | `minimumHealthyPercent = 0`, `maximumPercent = 100` : l'ancienne tâche s'arrête (et sauvegarde la base) avant que la nouvelle démarre (et la restaure). Coupure de ~1 minute, assumée. |
| **Pas de NAT Gateway** | Les tâches sont en sous-réseau public avec IP publique, protégées par groupe de sécurité (seul l'ALB peut les joindre). Économie d'environ 32 €/mois. |
| **CNAME et non enregistrement A** | Un ALB n'a pas d'IP fixe : AWS en change au fil du temps. Pointer une IP casserait le service sous quelques jours. |
| **Cloudflare en « DNS only »** | C'est l'ALB qui termine le TLS avec son certificat ACM. Le proxy Cloudflare (nuage orange) casserait la validation ACM et masquerait inutilement une API mobile. |
| **Zéro secret en dur** | Mot de passe admin dans Secrets Manager ; CI authentifiée par OIDC (aucune clé AWS dans GitHub) ; accès S3 par rôle IAM de tâche. |

### Fichiers livrés

| Fichier | Rôle |
|---|---|
| `terraform/main.tf` | Toute l'infrastructure (VPC, ALB, ECS, S3, CloudFront, ACM, IAM, alarmes) |
| `terraform/variables.tf` | Paramètres (domaine, région, dimensionnement, garde-fous) |
| `terraform/terraform.tfvars.example` | Modèle de configuration à copier |
| `backend/Dockerfile` | Image de production en deux étages, utilisateur non privilégié |
| `backend/.dockerignore` | Contexte de build minimal |
| `backend/docker-entrypoint.sh` | Restauration / sauvegarde de la base autour du serveur |
| `backend/scripts/s3-db-sync.js` | Persistance SQLite ⇄ S3 (`restore`, `backup`, `watch`) |
| `backend/.env.example` | Variables d'environnement, sans aucun secret |
| `.github/workflows/deploy.yml` | CI/CD : vérification → image ECR → déploiement ECS → test |
| `scripts/deploy.sh` | Déploiement manuel complet |
| `scripts/cloudflare-dns.sh` | DNS Cloudflare : validation ACM, CNAME de service, vérification |
| `mobile/lib/services/api_service.dart` | Service d'API (client Flutter) ciblant l'URL de production |

---

## 2. Prérequis

### Outils

```bash
aws --version        # ≥ 2.15
terraform -version   # ≥ 1.5
docker --version     # ≥ 24
jq --version         # ≥ 1.6
git --version
```

Sous Windows, exécuter les scripts `.sh` depuis **Git Bash** ou **WSL**.

### Accès

| Accès | Détail |
|---|---|
| Compte AWS | Droits d'administration pour le premier `terraform apply` (crée VPC, IAM, ECS, S3, CloudFront) |
| Jeton Cloudflare | `Zone ▸ DNS ▸ Edit` sur la zone `atlastech.cm` — [créer un jeton](https://dash.cloudflare.com/profile/api-tokens) |
| Dépôt GitHub | Droit de configurer secrets et variables d'Actions |

### Authentification

```bash
aws configure                      # ou : aws sso login --profile sde
aws sts get-caller-identity        # doit renvoyer le bon compte

export CLOUDFLARE_API_TOKEN='...'  # jamais écrit sur disque
```

> Le domaine `atlastech.cm` doit déjà être actif chez Cloudflare
> (`./scripts/cloudflare-dns.sh list` le confirme).

---

## 3. Première mise en service

Compter **45 à 60 minutes**, dont l'essentiel en attente de la validation ACM
et du déploiement CloudFront.

### 3.1 (Optionnel) État Terraform distant

Recommandé dès que plusieurs personnes déploient : l'état local
`terraform.tfstate` ne serait plus la référence unique.

```bash
COMPTE=$(aws sts get-caller-identity --query Account --output text)

aws s3api create-bucket \
  --bucket "sde-terraform-state-${COMPTE}" \
  --region eu-west-3 \
  --create-bucket-configuration LocationConstraint=eu-west-3

aws s3api put-bucket-versioning \
  --bucket "sde-terraform-state-${COMPTE}" \
  --versioning-configuration Status=Enabled
```

Décommenter ensuite le bloc `backend "s3"` en tête de `terraform/main.tf` en y
inscrivant le nom du bucket.

### 3.2 Configuration

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Ajuster au besoin : domaine, dépôt GitHub, dimensionnement
terraform init
```

### 3.3 Création des certificats ACM

ACM exige une preuve de maîtrise du domaine par enregistrement DNS. Comme la
zone est chez Cloudflare (et non Route 53), la validation se fait en deux temps :
on crée d'abord les certificats seuls, puis on publie les enregistrements.

```bash
terraform apply \
  -target=aws_acm_certificate.api \
  -target=aws_acm_certificate.cdn
```

### 3.4 Publication des enregistrements de validation

```bash
cd ..
./scripts/cloudflare-dns.sh validate
```

Le script lit la sortie `certificate_validation_records` et crée les CNAME
correspondants (en mode DNS only — un CNAME proxifié serait réécrit et la
validation échouerait).

Suivi de l'état :

```bash
# Certificat de l'API (régional)
aws acm list-certificates --region eu-west-3 \
  --query 'CertificateSummaryList[].[DomainName,Status]' --output table

# Certificat du CDN (obligatoirement dans us-east-1 pour CloudFront)
aws acm list-certificates --region us-east-1 \
  --query 'CertificateSummaryList[?contains(DomainName,`atlastech`)].[DomainName,Status]' \
  --output table
```

Le passage en `ISSUED` prend généralement 5 à 30 minutes.

### 3.5 Création de l'infrastructure complète

```bash
terraform -chdir=terraform apply
```

Terraform attend la validation des deux certificats (jusqu'à 45 minutes, réglable
via `certificate_validation_timeout`), puis crée VPC, ALB, ECR, ECS, S3,
CloudFront, IAM et alarmes.

> **Le service ECS démarre en échec** à ce stade : aucune image n'existe encore
> dans ECR. C'est attendu — l'étape suivante y remédie.

### 3.6 Première image

```bash
./scripts/deploy.sh
```

Le script construit l'image, la pousse sur ECR, enregistre une révision de
définition de tâche, met à jour le service, attend sa stabilité puis teste
`/api/health`.

### 3.7 Enregistrements DNS de service

```bash
./scripts/cloudflare-dns.sh apply
./scripts/cloudflare-dns.sh check
```

Résultat attendu :

```
✓ https://sde-api.atlastech.cm/api/health → {"status":"ok","service":"sante-extremes-backend"}
✓ https://sde-cdn.atlastech.cm/ → HTTP 403 (distribution joignable)
```

Un **403 sur la racine du CDN est normal** : le bucket n'a pas d'index et
CloudFront ne sert que les clés existantes.

### 3.8 Mot de passe administrateur

Terraform en a généré un et l'a déposé dans Secrets Manager. Pour le lire :

```bash
aws secretsmanager get-secret-value \
  --secret-id sde-prod/admin-password \
  --region eu-west-3 \
  --query SecretString --output text
```

Pour le remplacer par une valeur choisie (Terraform ne l'écrasera plus :
`ignore_changes` est posé sur la valeur du secret) :

```bash
read -rsp 'Nouveau mot de passe admin : ' MDP && echo
aws secretsmanager put-secret-value \
  --secret-id sde-prod/admin-password \
  --secret-string "$MDP" \
  --region eu-west-3
unset MDP

# Redémarrage de la tâche pour prise en compte
aws ecs update-service --cluster sde-prod-cluster --service sde-prod-backend \
  --force-new-deployment --region eu-west-3
```

### 3.9 Vérification finale

```bash
curl -s https://sde-api.atlastech.cm/api/health | jq
curl -s https://sde-api.atlastech.cm/api/stats  | jq '.summary'

# Accès admin (le mot de passe reste hors historique shell avec -r -s)
read -rsp 'Mot de passe admin : ' MDP && echo
curl -s -X POST https://sde-api.atlastech.cm/api/admin/members \
  -H "Authorization: Bearer $MDP" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Membre de test"}' | jq
unset MDP
```

---

## 4. Intégration continue GitHub Actions

Après ces étapes, tout `push` sur `master` touchant `backend/**` construit,
publie et déploie automatiquement.

### 4.1 Secret et variables du dépôt

`Settings ▸ Secrets and variables ▸ Actions`

**Secret** (un seul, et ce n'est pas une clé d'accès) :

| Nom | Valeur |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `terraform -chdir=terraform output -raw github_deploy_role_arn` |

**Variables** (facultatives — le workflow a les bonnes valeurs par défaut) :

| Nom | Défaut |
|---|---|
| `AWS_REGION` | `eu-west-3` |
| `ECR_REPOSITORY` | `sde-prod-backend` |
| `ECS_CLUSTER` | `sde-prod-cluster` |
| `ECS_SERVICE` | `sde-prod-backend` |
| `ECS_TASK_FAMILY` | `sde-prod-backend` |
| `API_BASE_URL` | `https://sde-api.atlastech.cm` |

En ligne de commande :

```bash
gh secret set AWS_DEPLOY_ROLE_ARN \
  --body "$(terraform -chdir=terraform output -raw github_deploy_role_arn)"
```

> **Aucune clé AWS n'est stockée dans GitHub.** Le workflow obtient des
> identifiants temporaires par OIDC, et le rôle n'est assumable que depuis les
> références listées dans `github_allowed_refs` (par défaut `master`, `main`,
> environnement `production`).

### 4.2 Environnement protégé (recommandé)

`Settings ▸ Environments ▸ New environment ▸ production`, avec
« Required reviewers ». Le job `deploiement` s'y rattache : chaque mise en
production demande alors une approbation humaine.

### 4.3 Enchaînement du workflow

| Job | Déclenchement | Contenu |
|---|---|---|
| `verification` | push, PR, dispatch | `npm ci`, `node --check` sur tous les fichiers, `bash -n` sur l'entrypoint, recherche de secrets en dur, démarrage réel du serveur + sonde `/api/health` |
| `image` | push, dispatch | OIDC → ECR, build Buildx (cache GitHub), tags `<sha>` et `latest` |
| `deploiement` | après `image` | Nouvelle révision de tâche, `update-service`, attente de stabilité, test de `https://sde-api.atlastech.cm/api/health` |
| `terraform` | PR, dispatch | `fmt -check`, `validate`, `plan` en lecture seule (jamais d'`apply` automatique) |

La `concurrency` sérialise les déploiements sans annuler celui en cours : deux
déploiements simultanés sur un service mono-tâche se marcheraient dessus.

Le *circuit breaker* ECS est actif : une nouvelle tâche qui ne devient pas saine
déclenche un retour automatique à la révision précédente.

---

## 5. Déploiement manuel

```bash
./scripts/deploy.sh                  # build + push + déploiement + test
./scripts/deploy.sh --tag v1.2.0     # étiquette explicite
./scripts/deploy.sh --no-build       # redéployer une image déjà sur ECR
./scripts/deploy.sh --dry-run        # afficher les actions sans les exécuter
./scripts/deploy.sh --help
```

Le script lit automatiquement les sorties Terraform (cluster, service, dépôt
ECR, URL d'API) et retombe sur les valeurs par défaut du LOT 2 si l'état n'est
pas accessible.

Retour arrière :

```bash
aws ecs list-task-definitions --family-prefix sde-prod-backend \
  --sort DESC --max-items 5 --region eu-west-3

aws ecs update-service --cluster sde-prod-cluster --service sde-prod-backend \
  --task-definition sde-prod-backend:<révision> --region eu-west-3
```

---

## 6. Application mobile

L'URL de production est inscrite à trois endroits, chacun servant un usage :

| Fichier | Usage |
|---|---|
| `mobile/app.json` ▸ `extra.apiUrl` | Valeur embarquée dans les builds EAS (APK) |
| `mobile/.env.example` ▸ `EXPO_PUBLIC_API_URL` | Modèle pour `.env.local` (développement) |
| `mobile/lib/services/api_service.dart` ▸ `defaultBaseUrl` | Client Flutter |

Toutes pointent sur `https://sde-api.atlastech.cm/api`, les justificatifs étant
servis par `https://sde-cdn.atlastech.cm`.

### Application Expo (application effectivement livrée au LOT 1)

`mobile/api/client.js` résout l'URL dans cet ordre : `EXPO_PUBLIC_API_URL`,
puis `app.json ▸ extra.apiUrl`, puis l'adresse de l'émulateur. Rien à modifier
dans le code.

```bash
cd mobile

# Développement sur backend local
echo 'EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api' > .env.local
npx expo start

# Build de production (utilise app.json ▸ extra.apiUrl)
rm -f .env.local
npx eas build --platform android --profile production
```

### Client Flutter

`mobile/lib/services/api_service.dart` est livré conformément à la demande du
LOT 2. **Note :** l'application mobile du LOT 1 est une application
**Expo / React Native**, pas Flutter — ce fichier est donc prêt à l'emploi pour
un futur client Flutter, mais il n'est pas utilisé par l'APK actuel. La
configuration réellement effective pour l'APK est `app.json` (ci-dessus).

Utilisation :

```dart
final api = ApiService();                       // https://sde-api.atlastech.cm/api
final tableau = await api.recupererTableau();
await api.enregistrerCotisation(
  membreId: 12,
  montant: 2000,
  moyen: MoyenPaiement.mobileMoney,
  cheminJustificatif: '/data/.../recu.jpg',
);
```

Surcharge de l'URL au build, sans toucher au code :

```bash
flutter build apk --dart-define=API_BASE_URL=http://10.0.2.2:3000/api
```

Dépendance à ajouter dans `pubspec.yaml` : `http: ^1.2.0`.

---

## 7. Exploitation courante

### Journaux

```bash
# Flux en direct
aws logs tail /ecs/sde-prod-backend --follow --region eu-west-3

# Dernière heure, erreurs uniquement
aws logs tail /ecs/sde-prod-backend --since 1h --region eu-west-3 \
  | grep -E 'erreur|error|\[db-sync\]'
```

Préfixes utiles : `[http]` (accès), `[auth]`, `[s3]`, `[db-sync]`
(synchronisation de la base), `[entrypoint]` (cycle de vie du conteneur).

### État du service

```bash
aws ecs describe-services --cluster sde-prod-cluster --services sde-prod-backend \
  --region eu-west-3 \
  --query 'services[0].{souhaite:desiredCount,actif:runningCount,definition:taskDefinition}'

# Derniers évènements (utile après un échec de déploiement)
aws ecs describe-services --cluster sde-prod-cluster --services sde-prod-backend \
  --region eu-west-3 --query 'services[0].events[0:10].[createdAt,message]' --output table
```

### Shell dans la tâche en cours

```bash
TACHE=$(aws ecs list-tasks --cluster sde-prod-cluster --service-name sde-prod-backend \
  --region eu-west-3 --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster sde-prod-cluster --task "$TACHE" \
  --container backend --interactive --command "/bin/bash" --region eu-west-3
```

(Nécessite le plugin Session Manager de l'AWS CLI.)

### Redémarrage sans changement de code

```bash
aws ecs update-service --cluster sde-prod-cluster --service sde-prod-backend \
  --force-new-deployment --region eu-west-3
```

La base est sauvegardée sur S3 avant l'arrêt, puis restaurée au démarrage.

### Invalidation du cache CDN

```bash
aws cloudfront create-invalidation \
  --distribution-id "$(terraform -chdir=terraform output -raw cloudfront_distribution_id)" \
  --paths '/cotisations/*'
```

---

## 8. Sauvegarde et restauration de la base

La base `sqlite/sde.db` vit dans le bucket `sde-prod-db-<compte>`, dont le
**versioning est activé** : chaque synchronisation crée une version. Les
versions antérieures sont conservées 90 jours (`db_backup_retention_days`), avec
au minimum les 30 dernières.

Rythme des sauvegardes : toutes les 5 minutes (`db_sync_interval_seconds`) **et**
systématiquement à l'arrêt de la tâche. Un envoi est ignoré si la base n'a pas
changé (comparaison d'empreinte SHA-256). L'instantané est pris par
`VACUUM INTO`, ce qui garantit un fichier intègre pendant que le serveur tourne.

### Copie locale de la base de production

```bash
BUCKET=$(terraform -chdir=terraform output -raw db_bucket)
aws s3 cp "s3://${BUCKET}/sqlite/sde.db" ./sde-production.db --region eu-west-3
sqlite3 ./sde-production.db 'SELECT COUNT(*) FROM members;'
```

### Restauration d'une version antérieure

```bash
BUCKET=$(terraform -chdir=terraform output -raw db_bucket)

# 1. Lister les versions disponibles
aws s3api list-object-versions --bucket "$BUCKET" --prefix sqlite/sde.db \
  --region eu-west-3 \
  --query 'Versions[0:10].[LastModified,VersionId,Size]' --output table

# 2. Arrêter le service (sinon il écraserait la restauration à sa prochaine synchro)
aws ecs update-service --cluster sde-prod-cluster --service sde-prod-backend \
  --desired-count 0 --region eu-west-3
aws ecs wait services-stable --cluster sde-prod-cluster --services sde-prod-backend \
  --region eu-west-3

# 3. Récupérer la version voulue et la réinstaller comme version courante
aws s3api get-object --bucket "$BUCKET" --key sqlite/sde.db \
  --version-id '<VERSION_ID>' ./restauration.db --region eu-west-3
sqlite3 ./restauration.db 'PRAGMA integrity_check;'   # doit répondre « ok »
aws s3 cp ./restauration.db "s3://${BUCKET}/sqlite/sde.db" --region eu-west-3

# 4. Redémarrer
aws ecs update-service --cluster sde-prod-cluster --service sde-prod-backend \
  --desired-count 1 --region eu-west-3
```

> **L'ordre compte.** Restaurer sans avoir mis `desired-count` à 0 fait perdre
> la restauration à la synchronisation suivante.

### Import initial des données

`backend/import_cotisations.py` (voir `backend/IMPORT_DONNEES.md`) travaille sur
un fichier local : télécharger la base, importer, arrêter le service, renvoyer
le fichier, redémarrer — même séquence que ci-dessus.

---

## 9. Dépannage

### `502 Bad Gateway` / `503 Service Unavailable`

Aucune tâche saine derrière l'ALB.

```bash
aws ecs describe-services --cluster sde-prod-cluster --services sde-prod-backend \
  --region eu-west-3 --query 'services[0].events[0:5].message'
aws logs tail /ecs/sde-prod-backend --since 15m --region eu-west-3
```

Causes fréquentes :

| Symptôme dans les journaux | Cause | Correctif |
|---|---|---|
| `CannotPullContainerError` | Aucune image dans ECR | `./scripts/deploy.sh` |
| `[db-sync] échec de la restauration` | Rôle de tâche sans accès au bucket | `terraform apply` (recrée la policy) |
| `ResourceInitializationError: ... secretsmanager` | Secret inaccessible au rôle d'exécution | Vérifier `sde-prod/admin-password` |
| `[auth] ADMIN_PASSWORD absent` | Secret vide | `put-secret-value` puis `--force-new-deployment` |
| `exec format error` | Image construite pour ARM alors que la tâche est en x86 | `./scripts/deploy.sh --platform linux/amd64` |

### Certificat ACM bloqué en `PENDING_VALIDATION`

```bash
./scripts/cloudflare-dns.sh list     # les CNAME _xxx sont-ils présents ?
dig +short _xxxx.atlastech.cm CNAME  # résolvent-ils ?
```

Le CNAME de validation doit être **DNS only** (nuage gris). Proxifié, Cloudflare
réécrit la réponse et ACM ne reconnaît pas sa preuve.

### Erreur TLS sur `sde-api.atlastech.cm`

- Certificat non encore `ISSUED` → attendre, puis relancer `terraform apply`.
- Nuage orange actif sur l'enregistrement → le repasser en DNS only, ou relancer
  `./scripts/cloudflare-dns.sh apply` qui force `proxied=false`.

### `curl` fonctionne, l'application mobile non

Vérifier que l'APK a bien été reconstruit après modification de `app.json` : la
valeur de `extra.apiUrl` est figée à la compilation.

```bash
adb logcat | grep '\[API\]'   # la ligne « backend ciblé : … » donne l'URL réelle
```

### Perte d'écritures après un déploiement

Vérifier qu'une **seule** tâche tourne. Deux écrivains SQLite simultanés se
recouvrent mutuellement à la synchronisation.

```bash
aws ecs describe-services --cluster sde-prod-cluster --services sde-prod-backend \
  --region eu-west-3 --query 'services[0].[desiredCount,runningCount]'
```

Les deux valeurs doivent être `1`. Ne jamais augmenter `desired_count` ni
ajouter d'autoscaling sans migrer au préalable vers une base multi-écrivains
(PostgreSQL/RDS).

### Justificatifs inaccessibles (403 sur une image existante)

Le bucket est privé : les URL doivent passer par CloudFront. Vérifier que
`PUBLIC_MEDIA_BASE_URL` vaut bien `https://sde-cdn.atlastech.cm` dans la
définition de tâche.

```bash
aws ecs describe-task-definition --task-definition sde-prod-backend \
  --region eu-west-3 \
  --query "taskDefinition.containerDefinitions[0].environment[?name=='PUBLIC_MEDIA_BASE_URL']"
```

---

## 10. Coûts

Estimation mensuelle en eu-west-3, trafic d'une association (quelques centaines
de membres, usage quotidien modéré) :

| Ressource | Estimation |
|---|---|
| Fargate 0,5 vCPU / 1 Gio, 24×7 | ~18 € |
| Application Load Balancer | ~19 € |
| S3 (base + justificatifs, < 5 Gio) | < 1 € |
| CloudFront (< 10 Gio sortants) | ~1 € |
| ECR, Secrets Manager, CloudWatch, ACM | ~2 € |
| **Total** | **~40 €/mois** |

Leviers d'économie :

- `cpu_architecture = "ARM64"` : environ −20 % sur Fargate (construire l'image
  avec `--platform linux/arm64`).
- `task_cpu = 256` / `task_memory = 512` : environ −50 % sur Fargate, suffisant
  si la charge reste faible.
- L'ALB est le poste le plus lourd et le moins compressible ; le supprimer
  impliquerait de renoncer au domaine HTTPS stable.

---

## 11. Suppression de l'infrastructure

> Opération destructive. La base de production est dans le bucket `db` :
> **en faire une copie locale avant toute chose** (§ 8).

```bash
# 1. Sauvegarde
aws s3 cp "s3://$(terraform -chdir=terraform output -raw db_bucket)/sqlite/sde.db" \
  ./sauvegarde-finale.db --region eu-west-3

# 2. Lever la protection contre la suppression
terraform -chdir=terraform apply -var 'enable_deletion_protection=false'

# 3. Vider les buckets (Terraform refuse de supprimer un bucket non vide)
for b in $(terraform -chdir=terraform output -raw db_bucket) \
         $(terraform -chdir=terraform output -raw uploads_bucket); do
  aws s3 rm "s3://${b}" --recursive --region eu-west-3
done

# 4. Destruction
terraform -chdir=terraform destroy

# 5. DNS
./scripts/cloudflare-dns.sh delete --yes
```

La suppression de la distribution CloudFront prend 15 à 20 minutes. Le secret
Secrets Manager reste récupérable 7 jours
(`secret_recovery_window_days`).
