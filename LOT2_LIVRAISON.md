# LOT 2 — Déploiement AWS · livraison

Deux chemins de mise en production du backend **Santé des extrêmes**, au choix :

| Cible | Point d'entrée | Coût | Quand la choisir |
|---|---|---|---|
| **EC2 + nginx** (instance `15.237.45.39`) | [`docs/DEPLOIEMENT_EC2.md`](docs/DEPLOIEMENT_EC2.md) | ~8 €/mois | Instance déjà provisionnée, mise en ligne immédiate |
| **ECS Fargate** (infrastructure Terraform) | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | ~40 €/mois | Base durable sur S3, déploiement continu, remplacement automatique |

⚠️ **Les deux ne doivent pas viser `sde-api.atlastech.cm` en même temps** :
un seul enregistrement DNS, une seule base de données.

---

## A. Déploiement EC2 depuis CloudShell

Les 6 étapes demandées (SSH, clone, npm, DNS Cloudflare, HTTPS, vérification)
sont automatisées dans deux scripts idempotents.

| Fichier | Rôle |
|---|---|
| `deploy/cloudshell-deploy.sh` | **À lancer dans CloudShell.** Identifie l'instance, ouvre les ports 22/80/443, détecte le compte SSH, publie le DNS Cloudflare, exécute l'installation à distance, vérifie l'API en HTTPS |
| `deploy/ec2-bootstrap.sh` | Exécuté sur l'instance : Node 20, `git clone`, `npm ci`, service systemd durci, nginx en proxy inverse, certificat Let's Encrypt + renouvellement automatique |
| `docs/DEPLOIEMENT_EC2.md` | Mode opératoire, exploitation, sauvegarde, dépannage |

```bash
# Dans CloudShell, après avoir téléversé sde-api-key.pem et cette archive
unzip -o sante-extremes-lot2.zip -d sante-extremes-lot2 && cd sante-extremes-lot2
chmod +x deploy/*.sh

export CLOUDFLARE_API_TOKEN='...'     # Zone ▸ DNS ▸ Edit sur atlastech.cm
export COURRIEL='vous@exemple.cm'     # alertes d'expiration du certificat

./deploy/cloudshell-deploy.sh
```

Durée : 5 à 10 minutes. Le mot de passe administrateur est affiché en fin
d'exécution et recopié dans `~/sde-admin-password.txt` (mode 600).

### Trois points relevés avant déploiement

1. **`sde-api.atlastech.cm` pointait vers `35.180.88.49`, pas vers
   `15.237.45.39`.** Un enregistrement existant visait donc une autre machine.
   Le script le remplace — à vérifier si cette IP sert encore.
2. **`npm start` a été remplacé par un service systemd.** Un `npm start` lancé
   en SSH meurt à la déconnexion et ne revient pas après un reboot. Le service
   exécute le même `node src/index.js`, avec `Restart=always`.
3. **HTTPS via Let's Encrypt, pas ACM.** Un certificat ACM ne s'attache qu'à un
   ALB ou à CloudFront, jamais à une instance EC2 seule.

### Ce qui n'est pas déployé sans `git push`

`ec2-bootstrap.sh` clone le dépôt GitHub, dont le dernier commit est le LOT 1
(`9cb212a`). Le backend fonctionne tel quel, mais les ajustements
`PUBLIC_MEDIA_BASE_URL` et `CORS_ORIGINS` ne seront présents qu'après :

```bash
git add -A && git commit -m "LOT 2 — deploiement AWS" && git push origin master
```

---

## B. Déploiement ECS Fargate (Terraform)

| Fichier demandé | Livré |
|---|---|
| 1. Infrastructure AWS | `terraform/main.tf` — VPC, ALB + ACM, ECS Fargate, ECR, S3 ×2, CloudFront + OAC, IAM, Secrets Manager, OIDC GitHub, alarmes |
| 2. Variables | `terraform/variables.tf` (+ `terraform.tfvars.example`) |
| 3. Dockerfile backend | `backend/Dockerfile` — 2 étages, utilisateur non privilégié, `HEALTHCHECK` |
| 4. CI/CD GitHub Actions | `.github/workflows/deploy.yml` — vérification → image ECR → déploiement ECS → test |
| 5. Déploiement manuel | `scripts/deploy.sh` |
| 6. DNS Cloudflare | `scripts/cloudflare-dns.sh` — `validate`, `apply`, `check`, `list`, `delete` |
| 7. URL API mobile | `mobile/lib/services/api_service.dart` (client Flutter) |
| 8. Documentation | `docs/DEPLOYMENT.md` |
| 9. Variables d'environnement | `backend/.env.example` — sans aucune clé |

Fichiers d'appui : `backend/docker-entrypoint.sh`, `backend/scripts/s3-db-sync.js`
(persistance SQLite ⇄ S3), `backend/.dockerignore`.

---

## Contraintes respectées

| Contrainte | Mise en œuvre |
|---|---|
| **SQLite, pas de RDS** | EC2 : fichier `/var/lib/sde/sde.db`. Fargate : fichier sur S3 versionné, restauré au démarrage, sauvegardé toutes les 5 min et à l'arrêt (`VACUUM INTO`). Aucune ressource RDS. |
| **eu-west-3** | Région par défaut partout. Seule exception imposée par AWS : le certificat CloudFront, obligatoirement émis en `us-east-1`. |
| **HTTPS + SSL** | EC2 : Let's Encrypt + redirection 301, renouvellement automatique vérifié par essai à blanc. Fargate : ACM sur l'ALB (TLS 1.3). |
| **GitHub Actions automatique** | Tout `push` sur `master` touchant `backend/**` construit, publie et déploie, avec test de `/api/health` et retour arrière automatique. |
| **Zéro secret en dur** | Mot de passe admin généré à l'exécution (Secrets Manager côté Fargate, `/etc/sde/api.env` en mode 640 côté EC2) ; CI authentifiée par OIDC, aucune clé AWS dans GitHub ; le workflow échoue s'il détecte un identifiant en dur. |

---

## État de vérification

| Élément | Vérification |
|---|---|
| `deploy/cloudshell-deploy.sh`, `deploy/ec2-bootstrap.sh` | `bash -n` ✅ |
| `terraform/*.tf` | `terraform validate` ✅ · `fmt -check` ✅ (Terraform 1.9.8) |
| `.github/workflows/deploy.yml` | Analyse YAML ✅ (4 jobs, 27 étapes) |
| `scripts/*.sh`, `backend/docker-entrypoint.sh` | `bash -n` ✅ |
| `backend/scripts/s3-db-sync.js` | `node --check` ✅ + exécution réelle (instantané `VACUUM INTO`) ✅ |
| `backend/src/*.js` modifiés | `node --check` ✅ |
| **Exécution sur l'instance EC2** | **Non réalisée.** Impossible depuis le poste Windows : pas d'AWS CLI, pas de `sde-api-key.pem` en local, ports 22 et 80 de `15.237.45.39` injoignables, pas de token Cloudflare. Le déploiement doit être lancé depuis CloudShell. |
| `docker build` | Non exécuté : Docker absent du poste. |

_L'archive exclut `backend/data/`, `*.db`, `*.xlsx`, `.env` et `node_modules/`
— ni données personnelles, ni secrets, ni dépendances._
