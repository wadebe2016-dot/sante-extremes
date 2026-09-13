# Déploiement du backend sur EC2 depuis CloudShell

Mise en production du backend **Santé des extrêmes** sur l'instance EC2
`15.237.45.39` (eu-west-3), exposée en HTTPS sur
**`https://sde-api.atlastech.cm/api`**.

> Variante « instance unique » du LOT 2. Le déploiement ECS Fargate reste
> disponible dans [`DEPLOYMENT.md`](DEPLOYMENT.md) ; les deux ne doivent pas
> tourner en même temps sur le même domaine.

---

## Ce qui est installé sur l'instance

```
        Internet
           │
           ▼  :443 (Let's Encrypt) · :80 → redirection 301
     ┌─────────────┐
     │    nginx    │  proxy inverse, client_max_body_size 10m
     └──────┬──────┘
            │  127.0.0.1:3000  (jamais exposé : port non ouvert au groupe de sécurité)
     ┌──────▼──────────────────┐
     │ systemd « sde-api »     │  User=sde, Restart=always, durci
     │ node src/index.js       │
     └──────┬──────────────────┘
            │
     /var/lib/sde/sde.db        base SQLite, hors du dossier de code
     /etc/sde/api.env           configuration + mot de passe admin (mode 640)
     /opt/sde/app               clone git du dépôt
```

**Pourquoi systemd et non `npm start` dans le terminal SSH** : un `npm start`
lancé à la main meurt à la déconnexion et ne revient pas après un reboot. Le
service exécute exactement le même point d'entrée (`node src/index.js`), avec
redémarrage automatique et journalisation.

**Pourquoi Let's Encrypt et non ACM** : un certificat ACM ne s'attache qu'à un
ALB ou à CloudFront, jamais à une instance EC2. Sur une instance seule, c'est
certbot qui fournit le HTTPS — renouvellement automatique inclus.

---

## Étape 0 — Amener les scripts dans CloudShell

Les deux scripts (`deploy/cloudshell-deploy.sh` et `deploy/ec2-bootstrap.sh`)
ne sont pas encore sur GitHub. Deux façons de les obtenir dans CloudShell :

### Option A — Téléverser l'archive (aucun push nécessaire)

Dans CloudShell : **Actions ▸ Upload file** → `sante-extremes-lot2.zip`, puis :

```bash
cd ~
unzip -o sante-extremes-lot2.zip -d sante-extremes-lot2
cd sante-extremes-lot2
chmod +x deploy/*.sh scripts/*.sh
```

### Option B — Pousser le dépôt puis le cloner

Depuis le poste Windows :

```bash
cd /c/Users/wadeb/sante-extremes
git add -A
git commit -m "LOT 2 — deploiement AWS (ECS/Fargate + variante EC2)"
git push origin master
```

Puis dans CloudShell :

```bash
git clone https://github.com/wadebe2016-dot/sante-extremes.git
cd sante-extremes && chmod +x deploy/*.sh
```

> Option B a un avantage durable : `ec2-bootstrap.sh` cloner le dépôt sur
> l'instance, donc tout ce qui n'est pas poussé n'est pas déployé. Sans push,
> l'instance exécute le code du LOT 1 — fonctionnel, mais sans les ajustements
> `PUBLIC_MEDIA_BASE_URL` et `CORS_ORIGINS`.

---

## Étape 1 — Déploiement complet (une seule commande)

```bash
# La clé SSH doit être dans CloudShell (Actions ▸ Upload file → sde-api-key.pem)
export CLOUDFLARE_API_TOKEN='...'        # Zone ▸ DNS ▸ Edit sur atlastech.cm
export COURRIEL='vous@exemple.cm'        # alertes d'expiration Let's Encrypt

./deploy/cloudshell-deploy.sh
```

Compter **5 à 10 minutes**. Le script enchaîne :

| # | Étape | Détail |
|---|---|---|
| 1 | Instance | Recherche par IP publique, démarrage si elle est arrêtée, relevé du groupe de sécurité |
| 2 | Ports | Ouvre 22 (depuis la seule IP de CloudShell), 80 et 443. Le port 3000 reste fermé |
| 3 | SSH | Essaie `ubuntu`, `ec2-user`, `admin`, `debian` jusqu'à connexion, 6 tentatives espacées |
| 4 | DNS | Enregistrement A `sde-api.atlastech.cm` → `15.237.45.39`, **DNS only**, puis attente de propagation |
| 5 | Installation | Transfère et exécute `ec2-bootstrap.sh` : paquets, Node 20, clone, `npm ci`, systemd, nginx, certbot |
| 6 | Vérification | `/api/health` par IP, puis en HTTPS sur le domaine, `/api/stats`, lecture du certificat |

Sortie attendue en fin d'exécution :

```
✓ HTTPS sde-api.atlastech.cm → HTTP 200 {"status":"ok","service":"sante-extremes-backend"}
════════════════════════════════════════════════════════════════════
  Backend en production — https://sde-api.atlastech.cm/api
════════════════════════════════════════════════════════════════════
```

Le mot de passe administrateur est affiché et recopié dans
`~/sde-admin-password.txt` (mode 600) dans CloudShell.

### Paramètres surchargeables

```bash
IP_INSTANCE=15.237.45.39 \
CLE_SSH=~/sde-api-key.pem \
DOMAINE=sde-api.atlastech.cm \
DEPOT_GIT=https://github.com/wadebe2016-dot/sante-extremes.git \
BRANCHE=master \
BUCKET_S3=sde-cotisations-paiements \
./deploy/cloudshell-deploy.sh
```

`BUCKET_S3` est facultatif mais nécessaire aux justificatifs photo : sans lui,
`POST /api/cotisations` avec image échoue (le reste de l'API fonctionne). Le
rôle IAM de l'instance doit alors autoriser `s3:PutObject` sur ce bucket.

---

## Étape 2 — Vérification manuelle

```bash
curl -s https://sde-api.atlastech.cm/api/health | jq
curl -s https://sde-api.atlastech.cm/api/stats  | jq '.summary'

# Redirection HTTP → HTTPS (doit répondre 301)
curl -s -o /dev/null -w '%{http_code} → %{redirect_url}\n' http://sde-api.atlastech.cm/api/health

# Certificat
echo | openssl s_client -connect sde-api.atlastech.cm:443 \
  -servername sde-api.atlastech.cm 2>/dev/null | openssl x509 -noout -issuer -dates

# Accès administrateur
read -rsp 'Mot de passe admin : ' MDP && echo
curl -s -X POST https://sde-api.atlastech.cm/api/admin/members \
  -H "Authorization: Bearer $MDP" -H 'Content-Type: application/json' \
  -d '{"name":"Membre de test"}' | jq
unset MDP
```

---

## Étape 3 — Application mobile

```bash
cd mobile
echo 'EXPO_PUBLIC_API_URL=https://sde-api.atlastech.cm/api' > .env.local
npx expo start
```

`mobile/app.json ▸ extra.apiUrl` contient déjà cette URL : les builds EAS la
prennent sans configuration supplémentaire.

---

## Exploitation

Toutes ces commandes s'exécutent sur l'instance
(`ssh -i sde-api-key.pem ubuntu@15.237.45.39`).

```bash
sudo systemctl status sde-api         # état
sudo journalctl -u sde-api -f         # journaux en direct
sudo journalctl -u sde-api --since 1h # dernière heure
sudo systemctl restart sde-api        # redémarrage
sudo nginx -t && sudo systemctl reload nginx
```

### Mise à jour du code

```bash
# Depuis CloudShell, après un git push
./deploy/cloudshell-deploy.sh          # relance complète, idempotente

# Ou directement sur l'instance
sudo DOMAINE=sde-api.atlastech.cm bash /tmp/sde-bootstrap.sh
```

Le script aligne le clone sur `origin/master` (`git reset --hard`), réinstalle
les dépendances et redémarre le service. Le mot de passe administrateur et le
certificat existants sont conservés.

### Sauvegarde de la base

La base est un fichier unique : `/var/lib/sde/sde.db`.

```bash
# Copie cohérente pendant que le service tourne
sudo sqlite3 /var/lib/sde/sde.db ".backup '/tmp/sde-$(date +%F).db'"

# Récupération vers CloudShell
scp -i sde-api-key.pem ubuntu@15.237.45.39:/tmp/sde-*.db .

# Vers S3 (si un bucket existe)
aws s3 cp /tmp/sde-$(date +%F).db s3://<bucket>/sauvegardes/ --region eu-west-3
```

Sauvegarde quotidienne automatique (sur l'instance) :

```bash
sudo tee /etc/cron.daily/sauvegarde-sde > /dev/null <<'CRON'
#!/bin/sh
# Sauvegarde quotidienne de la base, 14 jours d'historique
mkdir -p /var/backups/sde
sqlite3 /var/lib/sde/sde.db ".backup '/var/backups/sde/sde-$(date +%F).db'"
find /var/backups/sde -name 'sde-*.db' -mtime +14 -delete
CRON
sudo chmod +x /etc/cron.daily/sauvegarde-sde
```

### Rotation du mot de passe administrateur

```bash
sudo sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')/" /etc/sde/api.env
sudo systemctl restart sde-api
sudo grep '^ADMIN_PASSWORD=' /etc/sde/api.env
```

### Renouvellement du certificat

Automatique (minuterie systemd de certbot). Pour vérifier :

```bash
sudo certbot certificates
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

---

## Dépannage

### Connexion SSH impossible

```bash
ssh -vvv -i sde-api-key.pem ubuntu@15.237.45.39
```

| Message | Cause | Correctif |
|---|---|---|
| `Connection timed out` | Port 22 fermé, ou IP de CloudShell changée | Relancer `cloudshell-deploy.sh` (il réouvre 22 depuis l'IP courante) |
| `Permission denied (publickey)` | Mauvaise clé, ou mauvais compte | Essayer `ec2-user@` ; vérifier la paire de clés associée à l'instance dans la console EC2 |
| `WARNING: UNPROTECTED PRIVATE KEY` | Droits trop larges | `chmod 400 sde-api-key.pem` |

### `502 Bad Gateway`

nginx tourne mais le backend ne répond pas.

```bash
sudo systemctl status sde-api
sudo journalctl -u sde-api -n 50
sudo curl -s http://127.0.0.1:3000/api/health
```

| Symptôme | Cause | Correctif |
|---|---|---|
| `Cannot find module` | `npm ci` incomplet | `cd /opt/sde/app/backend && sudo -u sde npm ci --omit=dev` |
| `SQLITE_CANTOPEN` | Droits sur `/var/lib/sde` | `sudo chown -R sde:sde /var/lib/sde` |
| `[auth] ADMIN_PASSWORD absent` | Configuration vide | Vérifier `/etc/sde/api.env` puis redémarrer |
| `EACCES` sur le port | Port < 1024 | Le backend doit rester sur 3000, nginx écoute 80/443 |
| `13: Permission denied` (nginx) | SELinux | `sudo setsebool -P httpd_can_network_connect 1` |

### Certificat non émis

Prérequis HTTP-01 : le domaine doit pointer sur l'instance **et** le port 80
être joignable depuis Internet.

```bash
dig +short sde-api.atlastech.cm        # doit renvoyer 15.237.45.39
curl -I http://sde-api.atlastech.cm/api/health
sudo tail -40 /var/log/letsencrypt/letsencrypt.log
sudo certbot --nginx -d sde-api.atlastech.cm --redirect
```

Causes fréquentes :

- **Nuage orange Cloudflare** (enregistrement proxifié) : la validation
  n'atteint pas l'origine. Le script force `proxied=false` ; si quelqu'un le
  réactive, le renouvellement cassera.
- **DNS pas encore propagé** : attendre, le TTL est à 120 s.
- **Quota Let's Encrypt** : 5 échecs par heure et par domaine. Attendre une
  heure avant de réessayer.

> ⚠️ Au moment de la rédaction, `sde-api.atlastech.cm` résolvait vers
> **35.180.88.49**, pas vers `15.237.45.39`. Un enregistrement pointant sur une
> autre machine existait donc déjà. Le script le remplace ; si cette autre IP
> correspond à un service encore utilisé, le vérifier avant de lancer.

### Le service ne redémarre pas après un reboot

```bash
sudo systemctl is-enabled sde-api nginx   # doivent répondre « enabled »
sudo systemctl enable sde-api nginx
```

---

## Différences avec le déploiement ECS Fargate

| | EC2 + nginx (ce document) | ECS Fargate ([`DEPLOYMENT.md`](DEPLOYMENT.md)) |
|---|---|---|
| Coût mensuel | ~8 € (t3.micro) | ~40 € (dont 19 € d'ALB) |
| TLS | Let's Encrypt sur l'instance | ACM sur l'ALB |
| Base | Fichier local `/var/lib/sde/sde.db` | Fichier sur S3, versionné |
| Sauvegarde | À mettre en place (cron fourni ci-dessus) | Automatique, à chaque synchronisation |
| Mises à jour | `cloudshell-deploy.sh`, ou push + relance | `git push` → GitHub Actions |
| Remplacement d'instance | Manuel, base à restaurer | Automatique, base récupérée depuis S3 |
| Interruption au déploiement | ~5 s (redémarrage systemd) | ~1 min (arrêt puis démarrage de tâche) |

Le choix EC2 est cohérent pour une association : moins cher, plus simple à
diagnostiquer. Son point faible est la durabilité — la base vit sur le disque
de l'instance. **Mettre en place la sauvegarde quotidienne ci-dessus n'est pas
optionnel.**
