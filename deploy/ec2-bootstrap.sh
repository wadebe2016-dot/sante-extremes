#!/usr/bin/env bash
###############################################################################
# Santé des extrêmes — mise en production du backend sur une instance EC2
#
# Ce script s'exécute SUR L'INSTANCE, en root. Il est envoyé et lancé par
# deploy/cloudshell-deploy.sh ; il peut aussi être exécuté à la main :
#
#   sudo DOMAINE=sde-api.atlastech.cm COURRIEL=vous@exemple.cm \
#        bash ec2-bootstrap.sh
#
# Il est IDEMPOTENT : le relancer met à jour le code et redémarre le service
# sans régénérer le mot de passe administrateur ni redemander un certificat.
#
# Ce qu'il installe :
#   - Node.js 20 (dépôt NodeSource ou paquet distribution)
#   - le backend dans /opt/sde/app, lancé par le service systemd « sde-api »
#     sous un compte système dédié, sans privilèges
#   - la base SQLite dans /var/lib/sde/sde.db (hors du dossier de code)
#   - nginx en proxy inverse 80/443 → 127.0.0.1:3000
#   - un certificat Let's Encrypt renouvelé automatiquement
#
# Pourquoi systemd et non « npm start » dans un terminal : un `npm start` lancé
# en SSH meurt à la déconnexion et ne redémarre pas après un reboot. Le service
# exécute le même point d'entrée (node src/index.js) avec redémarrage auto.
###############################################################################
set -euo pipefail

# --- Paramètres (surchargés par l'environnement) -----------------------------
DEPOT="${DEPOT_GIT:-https://github.com/wadebe2016-dot/sante-extremes.git}"
BRANCHE="${BRANCHE:-master}"
DOMAINE="${DOMAINE:-sde-api.atlastech.cm}"
COURRIEL="${COURRIEL:-}"
PORT_APP="${PORT_APP:-3000}"
REGION_AWS="${REGION_AWS:-eu-west-3}"
BUCKET_S3="${BUCKET_S3:-}"
MOT_DE_PASSE_ADMIN="${MOT_DE_PASSE_ADMIN:-}"
ACTIVER_TLS="${ACTIVER_TLS:-1}"

UTILISATEUR_SERVICE="sde"
RACINE="/opt/sde"
DOSSIER_APP="${RACINE}/app"
DOSSIER_BACKEND="${DOSSIER_APP}/backend"
DOSSIER_DONNEES="/var/lib/sde"
FICHIER_ENV="/etc/sde/api.env"
RACINE_ACME="/var/www/certbot"

# --- Sortie lisible ----------------------------------------------------------
etape()   { printf '\n\033[0;34m▶ %s\033[0m\n' "$*"; }
succes()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
avertir() { printf '\033[0;33m!\033[0m %s\n' "$*" >&2; }
echouer() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || echouer "ce script doit être lancé en root (sudo bash ec2-bootstrap.sh)"

###############################################################################
# 1. Détection de la distribution
###############################################################################
etape "Détection du système"

. /etc/os-release
DISTRIBUTION="${ID:-inconnue}"

case "${DISTRIBUTION}" in
  ubuntu|debian)
    GESTIONNAIRE="apt"
    export DEBIAN_FRONTEND=noninteractive
    ;;
  amzn|rhel|centos|fedora|rocky|almalinux)
    GESTIONNAIRE="$(command -v dnf > /dev/null 2>&1 && echo dnf || echo yum)"
    ;;
  *)
    echouer "distribution « ${DISTRIBUTION} » non prise en charge (attendu : Ubuntu, Debian ou Amazon Linux)"
    ;;
esac

succes "${PRETTY_NAME:-${DISTRIBUTION}} — gestionnaire ${GESTIONNAIRE}"

installer() {
  case "${GESTIONNAIRE}" in
    apt) apt-get install -y --no-install-recommends "$@" ;;
    *)   "${GESTIONNAIRE}" install -y "$@" ;;
  esac
}

###############################################################################
# 2. Paquets système
###############################################################################
etape "Installation des paquets système"

case "${GESTIONNAIRE}" in
  apt)
    apt-get update -qq
    installer ca-certificates curl gnupg git nginx sqlite3 \
      build-essential python3 jq
    ;;
  *)
    "${GESTIONNAIRE}" install -y ca-certificates curl gnupg2 git nginx sqlite \
      gcc gcc-c++ make python3 jq
    ;;
esac

succes "paquets de base installés"

###############################################################################
# 3. Node.js 20
###############################################################################
etape "Installation de Node.js 20"

version_node_majeure() {
  command -v node > /dev/null 2>&1 || return 1
  node -v | sed 's/^v\([0-9]*\).*/\1/'
}

MAJEURE="$(version_node_majeure || echo 0)"

if [ "${MAJEURE}" -ge 18 ] 2>/dev/null; then
  succes "Node.js $(node -v) déjà présent"
else
  case "${GESTIONNAIRE}" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      installer nodejs
      ;;
    *)
      # Amazon Linux 2023 fournit nodejs20 ; sinon on retombe sur NodeSource.
      if "${GESTIONNAIRE}" install -y nodejs20 npm 2>/dev/null; then
        alternatives --install /usr/bin/node node /usr/bin/node-20 90 2>/dev/null || true
      else
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        installer nodejs
      fi
      ;;
  esac
  command -v node > /dev/null 2>&1 || echouer "installation de Node.js échouée"
  succes "Node.js $(node -v) / npm $(npm -v)"
fi

###############################################################################
# 4. Compte système et arborescence
###############################################################################
etape "Préparation du compte de service et des dossiers"

if ! id "${UTILISATEUR_SERVICE}" > /dev/null 2>&1; then
  useradd --system --home-dir "${RACINE}" --shell /usr/sbin/nologin "${UTILISATEUR_SERVICE}" 2>/dev/null \
    || useradd --system --home-dir "${RACINE}" --shell /sbin/nologin "${UTILISATEUR_SERVICE}"
  succes "compte système « ${UTILISATEUR_SERVICE} » créé"
else
  succes "compte système « ${UTILISATEUR_SERVICE} » déjà présent"
fi

mkdir -p "${RACINE}" "${DOSSIER_DONNEES}" "$(dirname "${FICHIER_ENV}")" "${RACINE_ACME}"
chown "${UTILISATEUR_SERVICE}:${UTILISATEUR_SERVICE}" "${RACINE}" "${DOSSIER_DONNEES}"
chmod 750 "${DOSSIER_DONNEES}"

###############################################################################
# 5. Récupération du code
###############################################################################
etape "Récupération du code depuis ${DEPOT}"

if [ -d "${DOSSIER_APP}/.git" ]; then
  # Mise à jour : on aligne strictement sur la branche distante.
  git -C "${DOSSIER_APP}" remote set-url origin "${DEPOT}"
  git -C "${DOSSIER_APP}" fetch --depth 1 origin "${BRANCHE}"
  git -C "${DOSSIER_APP}" reset --hard "origin/${BRANCHE}"
  git -C "${DOSSIER_APP}" clean -fd
  succes "code mis à jour"
else
  rm -rf "${DOSSIER_APP}"
  git clone --depth 1 --branch "${BRANCHE}" "${DEPOT}" "${DOSSIER_APP}"
  succes "dépôt cloné"
fi

[ -f "${DOSSIER_BACKEND}/package.json" ] \
  || echouer "backend/package.json absent du dépôt (arborescence inattendue)"

chown -R "${UTILISATEUR_SERVICE}:${UTILISATEUR_SERVICE}" "${DOSSIER_APP}"
REVISION="$(git -C "${DOSSIER_APP}" rev-parse --short HEAD)"
succes "révision déployée : ${REVISION}"

###############################################################################
# 6. Dépendances npm
###############################################################################
etape "Installation des dépendances npm (production)"

# Compilation du module natif sqlite3 : exécutée sous le compte de service pour
# que les fichiers produits lui appartiennent.
if [ -f "${DOSSIER_BACKEND}/package-lock.json" ]; then
  sudo -u "${UTILISATEUR_SERVICE}" -H sh -c \
    "cd '${DOSSIER_BACKEND}' && npm ci --omit=dev --no-audit --no-fund"
else
  sudo -u "${UTILISATEUR_SERVICE}" -H sh -c \
    "cd '${DOSSIER_BACKEND}' && npm install --omit=dev --no-audit --no-fund"
fi

succes "dépendances installées"

###############################################################################
# 7. Configuration applicative
###############################################################################
etape "Configuration (${FICHIER_ENV})"

# Le mot de passe existant est conservé d'un déploiement à l'autre : le
# régénérer invaliderait l'accès admin de l'application mobile.
if [ -f "${FICHIER_ENV}" ] && grep -q '^ADMIN_PASSWORD=' "${FICHIER_ENV}"; then
  MOT_DE_PASSE_ADMIN="$(grep '^ADMIN_PASSWORD=' "${FICHIER_ENV}" | cut -d= -f2-)"
  succes "mot de passe administrateur existant conservé"
elif [ -n "${MOT_DE_PASSE_ADMIN}" ]; then
  succes "mot de passe administrateur fourni par le déploiement"
else
  MOT_DE_PASSE_ADMIN="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  avertir "mot de passe administrateur généré : ${MOT_DE_PASSE_ADMIN}"
  avertir "→ à noter maintenant, il ne sera plus affiché"
fi

umask 027
cat > "${FICHIER_ENV}" <<ENV
# Configuration du backend Santé des extrêmes — généré le $(date -Is)
# Fichier lu par systemd (EnvironmentFile), jamais versionné.
NODE_ENV=production
PORT=${PORT_APP}
DB_PATH=${DOSSIER_DONNEES}/sde.db
ADMIN_PASSWORD=${MOT_DE_PASSE_ADMIN}
AWS_REGION=${REGION_AWS}
AWS_BUCKET=${BUCKET_S3}
S3_MAX_FILE_SIZE=5242880
CORS_ORIGINS=*
ENV

chown "root:${UTILISATEUR_SERVICE}" "${FICHIER_ENV}"
chmod 640 "${FICHIER_ENV}"
succes "configuration écrite (lisible uniquement par root et ${UTILISATEUR_SERVICE})"

if [ -z "${BUCKET_S3}" ]; then
  avertir "AWS_BUCKET vide : l'envoi de justificatifs photo échouera (le reste de l'API fonctionne)"
fi

###############################################################################
# 8. Service systemd
###############################################################################
etape "Service systemd « sde-api »"

cat > /etc/systemd/system/sde-api.service <<UNIT
[Unit]
Description=API Sante des extremes (backend Express)
Documentation=https://github.com/wadebe2016-dot/sante-extremes
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${UTILISATEUR_SERVICE}
Group=${UTILISATEUR_SERVICE}
WorkingDirectory=${DOSSIER_BACKEND}
EnvironmentFile=${FICHIER_ENV}
ExecStart=$(command -v node) src/index.js

# Redémarrage automatique (plantage, OOM, reboot)
Restart=always
RestartSec=5

# Le schéma SQLite est appliqué au démarrage par src/index.js.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sde-api

# Durcissement : le service n'écrit que dans son dossier de données.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DOSSIER_DONNEES}
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable sde-api > /dev/null 2>&1
systemctl restart sde-api

# Laisser le temps à la migration SQLite de s'appliquer avant de sonder.
for tentative in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT_APP}/api/health" > /tmp/sante-locale.json 2>/dev/null; then
    succes "service démarré — $(cat /tmp/sante-locale.json)"
    break
  fi
  [ "${tentative}" -eq 20 ] && {
    avertir "le service ne répond pas, derniers journaux :"
    journalctl -u sde-api -n 40 --no-pager >&2
    echouer "démarrage du backend impossible"
  }
  sleep 2
done

###############################################################################
# 9. nginx en proxy inverse
###############################################################################
etape "Configuration de nginx"

CONF_NGINX="/etc/nginx/conf.d/sde-api.conf"

# Ubuntu/Debian activent un site par défaut sur le port 80 : il capterait les
# requêtes avant notre bloc server.
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

cat > "${CONF_NGINX}" <<NGINX
# Santé des extrêmes — proxy inverse vers le backend Node (port ${PORT_APP})

upstream sde_backend {
    server 127.0.0.1:${PORT_APP};
    keepalive 16;
}

# Requêtes ne portant pas le bon en-tête Host (scans par IP) : connexion fermée.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAINE};

    # Justificatifs de paiement : 5 Mo + surcharge multipart
    client_max_body_size 10m;

    access_log /var/log/nginx/sde-api.access.log;
    error_log  /var/log/nginx/sde-api.error.log;

    # Validation HTTP-01 de Let's Encrypt (certbot écrit ici)
    location ^~ /.well-known/acme-challenge/ {
        root ${RACINE_ACME};
        default_type "text/plain";
    }

    location / {
        proxy_pass http://sde_backend;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";

        proxy_connect_timeout 10s;
        proxy_read_timeout    60s;
        proxy_send_timeout    60s;
    }
}
NGINX

nginx -t || echouer "configuration nginx invalide"
systemctl enable nginx > /dev/null 2>&1
systemctl restart nginx
succes "nginx actif sur le port 80"

# SELinux (Amazon Linux / RHEL) : sans cela nginx ne peut pas joindre le backend.
if command -v getenforce > /dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  setsebool -P httpd_can_network_connect 1 || avertir "réglage SELinux httpd_can_network_connect impossible"
  succes "SELinux : connexions réseau autorisées pour nginx"
fi

# Pare-feu local éventuel (l'essentiel du filtrage reste le groupe de sécurité).
if command -v ufw > /dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp > /dev/null && ufw allow 443/tcp > /dev/null
  succes "ufw : ports 80 et 443 ouverts"
fi
if systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --add-service=http --add-service=https > /dev/null
  firewall-cmd --reload > /dev/null
  succes "firewalld : http et https autorisés"
fi

###############################################################################
# 10. HTTPS — certificat Let's Encrypt
###############################################################################
if [ "${ACTIVER_TLS}" != "1" ]; then
  avertir "HTTPS désactivé (ACTIVER_TLS=0) : l'API n'est servie qu'en HTTP"
else
  etape "Certificat TLS pour ${DOMAINE}"

  if ! command -v certbot > /dev/null 2>&1; then
    case "${GESTIONNAIRE}" in
      apt) installer certbot python3-certbot-nginx ;;
      *)   installer certbot python3-certbot-nginx || {
             avertir "certbot absent des dépôts, installation par pip"
             installer python3-pip
             pip3 install --quiet certbot certbot-nginx
             ln -sf /usr/local/bin/certbot /usr/bin/certbot
           } ;;
    esac
  fi
  command -v certbot > /dev/null 2>&1 || echouer "installation de certbot impossible"

  # Prérequis HTTP-01 : le domaine doit déjà pointer sur cette instance et le
  # port 80 être joignable depuis Internet. On le vérifie avant de consommer
  # un essai auprès de Let's Encrypt (5 échecs/heure/domaine et c'est bloqué).
  IP_PUBLIQUE="$(curl -fsS --max-time 10 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null \
    || curl -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')"
  IP_DOMAINE="$(getent hosts "${DOMAINE}" 2>/dev/null | awk '{print $1; exit}')"

  printf '  domaine %s → %s | instance → %s\n' "${DOMAINE}" "${IP_DOMAINE:-non résolu}" "${IP_PUBLIQUE:-inconnue}"

  if [ -z "${IP_DOMAINE}" ]; then
    avertir "${DOMAINE} ne résout pas : certificat reporté"
    avertir "→ créer l'enregistrement DNS puis relancer : sudo certbot --nginx -d ${DOMAINE}"
  elif [ -n "${IP_PUBLIQUE}" ] && [ "${IP_DOMAINE}" != "${IP_PUBLIQUE}" ]; then
    avertir "le DNS pointe vers ${IP_DOMAINE}, or l'instance est ${IP_PUBLIQUE} : certificat reporté"
    avertir "→ corriger l'enregistrement A puis relancer : sudo certbot --nginx -d ${DOMAINE}"
  else
    ARGUMENTS_CERTBOT=(--nginx -d "${DOMAINE}" --non-interactive --agree-tos --redirect --keep-until-expiring)
    if [ -n "${COURRIEL}" ]; then
      ARGUMENTS_CERTBOT+=(-m "${COURRIEL}")
    else
      ARGUMENTS_CERTBOT+=(--register-unsafely-without-email)
      avertir "aucun courriel fourni : pas d'alerte d'expiration de Let's Encrypt"
    fi

    if certbot "${ARGUMENTS_CERTBOT[@]}"; then
      succes "certificat installé, redirection HTTP → HTTPS activée"

      # Renouvellement automatique : rechargement de nginx après renouvellement.
      mkdir -p /etc/letsencrypt/renewal-hooks/deploy
      cat > /etc/letsencrypt/renewal-hooks/deploy/recharger-nginx.sh <<'CROCHET'
#!/bin/sh
# Recharge nginx après un renouvellement de certificat réussi.
systemctl reload nginx
CROCHET
      chmod +x /etc/letsencrypt/renewal-hooks/deploy/recharger-nginx.sh

      systemctl enable --now certbot-renew.timer 2>/dev/null \
        || systemctl enable --now certbot.timer 2>/dev/null \
        || avertir "aucune minuterie certbot : ajouter un cron « certbot renew -q »"

      certbot renew --dry-run > /dev/null 2>&1 \
        && succes "renouvellement automatique vérifié (essai à blanc concluant)" \
        || avertir "l'essai à blanc de renouvellement a échoué : à surveiller"
    else
      avertir "certbot a échoué — journaux : /var/log/letsencrypt/letsencrypt.log"
      avertir "l'API reste servie en HTTP sur le port 80"
    fi
  fi
fi

###############################################################################
# 11. Vérifications finales
###############################################################################
etape "Vérifications"

systemctl is-active --quiet sde-api && succes "service sde-api actif" || avertir "service sde-api inactif"
systemctl is-active --quiet nginx   && succes "nginx actif"           || avertir "nginx inactif"

CODE_LOCAL="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_APP}/api/health" || echo 000)"
printf '  backend local          → HTTP %s\n' "${CODE_LOCAL}"

CODE_PROXY="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAINE}" http://127.0.0.1/api/health || echo 000)"
printf '  nginx (Host: %s) → HTTP %s\n' "${DOMAINE}" "${CODE_PROXY}"

if [ -f "/etc/letsencrypt/live/${DOMAINE}/fullchain.pem" ]; then
  FIN_VALIDITE="$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/${DOMAINE}/fullchain.pem" | cut -d= -f2)"
  succes "certificat présent, valable jusqu'au ${FIN_VALIDITE}"
fi

TAILLE_BASE="$( [ -f "${DOSSIER_DONNEES}/sde.db" ] && du -h "${DOSSIER_DONNEES}/sde.db" | cut -f1 || echo "absente")"

cat <<RECAPITULATIF

────────────────────────────────────────────────────────────────────
  Backend en production
────────────────────────────────────────────────────────────────────
  Révision       : ${REVISION}
  Code           : ${DOSSIER_BACKEND}
  Base SQLite    : ${DOSSIER_DONNEES}/sde.db (${TAILLE_BASE})
  Configuration  : ${FICHIER_ENV}
  Service        : systemctl status sde-api
  Journaux       : journalctl -u sde-api -f
  Redémarrage    : systemctl restart sde-api
  Mise à jour    : sudo bash ec2-bootstrap.sh   (idempotent)
────────────────────────────────────────────────────────────────────
RECAPITULATIF
