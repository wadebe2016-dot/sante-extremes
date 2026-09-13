#!/usr/bin/env bash
###############################################################################
# Santé des extrêmes — déploiement du backend sur EC2, piloté depuis CloudShell
#
# À exécuter DANS AWS CloudShell (région eu-west-3), là où se trouve la clé
# sde-api-key.pem :
#
#   export CLOUDFLARE_API_TOKEN='...'        # Zone ▸ DNS ▸ Edit sur atlastech.cm
#   chmod +x deploy/cloudshell-deploy.sh
#   ./deploy/cloudshell-deploy.sh
#
# Enchaînement, chaque étape vérifiée avant de passer à la suivante :
#   1. identification de l'instance et de son groupe de sécurité
#   2. ouverture des ports 22 (depuis CloudShell), 80 et 443
#   3. connexion SSH et détection du compte système de l'AMI
#   4. enregistrement DNS Cloudflare : sde-api.atlastech.cm → IP de l'instance
#   5. exécution de deploy/ec2-bootstrap.sh sur l'instance
#      (git clone, npm, service systemd, nginx, certificat Let's Encrypt)
#   6. vérification de l'API en HTTP puis en HTTPS depuis l'extérieur
#
# Idempotent : relançable autant que nécessaire. Aucun secret n'est écrit dans
# le dépôt ; le mot de passe administrateur est conservé sur l'instance d'un
# déploiement à l'autre et récapitulé en fin d'exécution.
###############################################################################
set -euo pipefail

# --- Paramètres --------------------------------------------------------------
IP_INSTANCE="${IP_INSTANCE:-15.237.45.39}"
CLE_SSH="${CLE_SSH:-$HOME/sde-api-key.pem}"
REGION="${AWS_REGION:-eu-west-3}"
DOMAINE="${DOMAINE:-sde-api.atlastech.cm}"
DOMAINE_RACINE="${DOMAINE_RACINE:-atlastech.cm}"
DEPOT_GIT="${DEPOT_GIT:-https://github.com/wadebe2016-dot/sante-extremes.git}"
BRANCHE="${BRANCHE:-master}"
COURRIEL="${COURRIEL:-}"
BUCKET_S3="${BUCKET_S3:-}"
TTL_DNS="${TTL_DNS:-120}"
UTILISATEURS_SSH="${UTILISATEURS_SSH:-ubuntu ec2-user admin debian}"

RACINE_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_BOOTSTRAP="${RACINE_SCRIPT}/ec2-bootstrap.sh"

if [ -t 1 ]; then
  VERT=$'\033[0;32m'; ROUGE=$'\033[0;31m'; JAUNE=$'\033[0;33m'; BLEU=$'\033[0;34m'; NEUTRE=$'\033[0m'
else
  VERT=""; ROUGE=""; JAUNE=""; BLEU=""; NEUTRE=""
fi

etape()   { printf '\n%s▶ %s%s\n' "${BLEU}" "$*" "${NEUTRE}"; }
succes()  { printf '%s✓%s %s\n' "${VERT}" "${NEUTRE}" "$*"; }
avertir() { printf '%s!%s %s\n' "${JAUNE}" "${NEUTRE}" "$*" >&2; }
echouer() { printf '%s✗ %s%s\n' "${ROUGE}" "$*" "${NEUTRE}" >&2; exit 1; }

###############################################################################
# 0. Prérequis
###############################################################################
etape "Vérification des prérequis"

for outil in aws jq curl ssh scp; do
  command -v "${outil}" > /dev/null 2>&1 || echouer "${outil} est requis mais introuvable"
done

[ -f "${SCRIPT_BOOTSTRAP}" ] \
  || echouer "script d'installation introuvable : ${SCRIPT_BOOTSTRAP}"

# La clé peut être dans le dossier courant ou dans ~ selon l'upload CloudShell.
if [ ! -f "${CLE_SSH}" ]; then
  for candidate in "./sde-api-key.pem" "$HOME/sde-api-key.pem" "/tmp/sde-api-key.pem"; do
    [ -f "${candidate}" ] && { CLE_SSH="${candidate}"; break; }
  done
fi

[ -f "${CLE_SSH}" ] || echouer "clé SSH introuvable — téléverser sde-api-key.pem dans CloudShell (Actions ▸ Upload file), ou préciser CLE_SSH=/chemin/cle.pem"

# SSH refuse une clé privée lisible par d'autres comptes.
chmod 400 "${CLE_SSH}"
succes "clé SSH : ${CLE_SSH}"

aws sts get-caller-identity > /tmp/sde-identite.json 2>/dev/null \
  || echouer "identifiants AWS indisponibles (ce script doit tourner dans CloudShell)"
succes "compte AWS $(jq -r .Account /tmp/sde-identite.json)"

OPTIONS_SSH=(-i "${CLE_SSH}"
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts_sde"
  -o ConnectTimeout=15
  -o ServerAliveInterval=20
  -o BatchMode=yes)

###############################################################################
# 1. Identification de l'instance
###############################################################################
etape "Identification de l'instance ${IP_INSTANCE}"

INSTANCE="$(aws ec2 describe-instances \
  --region "${REGION}" \
  --filters "Name=ip-address,Values=${IP_INSTANCE}" \
  --query 'Reservations[].Instances[]|[0]' \
  --output json 2>/dev/null || echo null)"

if [ "${INSTANCE}" = "null" ] || [ -z "${INSTANCE}" ]; then
  avertir "aucune instance en cours d'exécution avec l'IP publique ${IP_INSTANCE} dans ${REGION}"
  avertir "instances de la région :"
  aws ec2 describe-instances --region "${REGION}" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress,InstanceType]' \
    --output table >&2 || true
  echouer "vérifier l'IP, la région, ou démarrer l'instance"
fi

ID_INSTANCE="$(printf '%s' "${INSTANCE}" | jq -r '.InstanceId')"
ETAT="$(printf '%s' "${INSTANCE}" | jq -r '.State.Name')"
GROUPE_SECURITE="$(printf '%s' "${INSTANCE}" | jq -r '.SecurityGroups[0].GroupId')"
TYPE="$(printf '%s' "${INSTANCE}" | jq -r '.InstanceType')"

succes "${ID_INSTANCE} (${TYPE}, état « ${ETAT} »), groupe de sécurité ${GROUPE_SECURITE}"

if [ "${ETAT}" != "running" ]; then
  avertir "instance à l'état « ${ETAT} » : démarrage"
  aws ec2 start-instances --region "${REGION}" --instance-ids "${ID_INSTANCE}" > /dev/null
  aws ec2 wait instance-running --region "${REGION}" --instance-ids "${ID_INSTANCE}"
  succes "instance démarrée"
fi

###############################################################################
# 2. Groupe de sécurité : ports 22, 80, 443
###############################################################################
etape "Ouverture des ports nécessaires"

IP_CLOUDSHELL="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
succes "IP publique de CloudShell : ${IP_CLOUDSHELL}"

autoriser() {
  local port="$1" source="$2" description="$3"

  # InvalidPermission.Duplicate = la règle existe déjà : cas normal en relance.
  if aws ec2 authorize-security-group-ingress \
      --region "${REGION}" \
      --group-id "${GROUPE_SECURITE}" \
      --ip-permissions "IpProtocol=tcp,FromPort=${port},ToPort=${port},IpRanges=[{CidrIp=${source},Description='${description}'}]" \
      > /dev/null 2>/tmp/sde-sg.err; then
    succes "port ${port} ouvert depuis ${source}"
  elif grep -q 'InvalidPermission.Duplicate' /tmp/sde-sg.err; then
    succes "port ${port} déjà ouvert depuis ${source}"
  else
    avertir "port ${port} : $(tr -d '\n' < /tmp/sde-sg.err | head -c 200)"
  fi
}

autoriser 22 "${IP_CLOUDSHELL}/32" "SSH depuis CloudShell"
# 80 est indispensable à la validation HTTP-01 de Let's Encrypt, en plus de la
# redirection vers HTTPS.
autoriser 80 "0.0.0.0/0" "HTTP public (redirection + ACME)"
autoriser 443 "0.0.0.0/0" "HTTPS public"

# Le port 3000 n'est volontairement PAS ouvert : le backend n'est joignable que
# par nginx, en local sur l'instance.

###############################################################################
# 3. Connexion SSH
###############################################################################
etape "Connexion SSH"

UTILISATEUR_SSH=""
for tentative in 1 2 3 4 5 6; do
  for candidat in ${UTILISATEURS_SSH}; do
    if ssh "${OPTIONS_SSH[@]}" "${candidat}@${IP_INSTANCE}" 'echo pret' > /dev/null 2>&1; then
      UTILISATEUR_SSH="${candidat}"
      break 2
    fi
  done
  avertir "SSH pas encore disponible (tentative ${tentative}/6), nouvel essai dans 10 s"
  sleep 10
done

[ -n "${UTILISATEUR_SSH}" ] || echouer "connexion SSH impossible sur ${IP_INSTANCE}
  - la clé sde-api-key.pem correspond-elle bien à cette instance ?
  - comptes essayés : ${UTILISATEURS_SSH}
  - test manuel : ssh -i ${CLE_SSH} ubuntu@${IP_INSTANCE}"

succes "connecté en tant que ${UTILISATEUR_SSH}@${IP_INSTANCE}"
ssh "${OPTIONS_SSH[@]}" "${UTILISATEUR_SSH}@${IP_INSTANCE}" \
  '. /etc/os-release && echo "  système : $PRETTY_NAME"'

###############################################################################
# 4. DNS Cloudflare
###############################################################################
etape "Enregistrement DNS ${DOMAINE} → ${IP_INSTANCE}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  avertir "CLOUDFLARE_API_TOKEN absent : étape DNS ignorée"
  avertir "sans DNS correct, le certificat Let's Encrypt ne pourra pas être émis"
  avertir "→ export CLOUDFLARE_API_TOKEN='...' puis relancer ce script"
  DNS_CONFIGURE=0
else
  API_CF="https://api.cloudflare.com/client/v4"

  appeler_cf() {
    local methode="$1" chemin="$2" corps="${3:-}"
    local reponse
    if [ -n "${corps}" ]; then
      reponse="$(curl -sS -X "${methode}" "${API_CF}${chemin}" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        -H "Content-Type: application/json" --data "${corps}")"
    else
      reponse="$(curl -sS -X "${methode}" "${API_CF}${chemin}" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
    fi

    if [ "$(printf '%s' "${reponse}" | jq -r '.success // false')" != "true" ]; then
      printf '%s' "${reponse}" | jq -r '(.errors // []) | map("  - [\(.code)] \(.message)") | join("\n")' >&2
      echouer "appel Cloudflare ${methode} ${chemin} refusé"
    fi
    printf '%s' "${reponse}"
  }

  ZONE="${CLOUDFLARE_ZONE_ID:-$(appeler_cf GET "/zones?name=${DOMAINE_RACINE}" | jq -r '.result[0].id // empty')}"
  [ -n "${ZONE}" ] || echouer "zone ${DOMAINE_RACINE} introuvable avec ce jeton"
  succes "zone ${DOMAINE_RACINE} → ${ZONE}"

  EXISTANT="$(appeler_cf GET "/zones/${ZONE}/dns_records?name=${DOMAINE}")"
  ID_ENREGISTREMENT="$(printf '%s' "${EXISTANT}" | jq -r '.result[0].id // empty')"
  TYPE_ACTUEL="$(printf '%s' "${EXISTANT}" | jq -r '.result[0].type // empty')"
  CONTENU_ACTUEL="$(printf '%s' "${EXISTANT}" | jq -r '.result[0].content // empty')"
  PROXY_ACTUEL="$(printf '%s' "${EXISTANT}" | jq -r '.result[0].proxied // false')"

  # « DNS only » obligatoire : le proxy Cloudflare terminerait le TLS lui-même,
  # ce qui empêche la validation HTTP-01 de Let's Encrypt sur l'origine.
  CHARGE="$(jq -nc --arg name "${DOMAINE}" --arg content "${IP_INSTANCE}" --argjson ttl "${TTL_DNS}" \
    '{type:"A", name:$name, content:$content, ttl:$ttl, proxied:false}')"

  if [ -n "${ID_ENREGISTREMENT}" ]; then
    if [ "${TYPE_ACTUEL}" = "A" ] && [ "${CONTENU_ACTUEL}" = "${IP_INSTANCE}" ] && [ "${PROXY_ACTUEL}" = "false" ]; then
      succes "enregistrement A déjà correct → ${IP_INSTANCE} (DNS only)"
    else
      avertir "enregistrement existant ${TYPE_ACTUEL} → ${CONTENU_ACTUEL} (proxy : ${PROXY_ACTUEL}) : remplacement"
      appeler_cf PUT "/zones/${ZONE}/dns_records/${ID_ENREGISTREMENT}" "${CHARGE}" > /dev/null
      succes "enregistrement A mis à jour → ${IP_INSTANCE} (DNS only)"
    fi
  else
    appeler_cf POST "/zones/${ZONE}/dns_records" "${CHARGE}" > /dev/null
    succes "enregistrement A créé → ${IP_INSTANCE} (DNS only)"
  fi

  DNS_CONFIGURE=1

  etape "Attente de propagation DNS"
  RESOLU=""
  for tentative in $(seq 1 24); do
    RESOLU="$(getent hosts "${DOMAINE}" 2>/dev/null | awk '{print $1; exit}')"
    [ "${RESOLU}" = "${IP_INSTANCE}" ] && break
    printf '  tentative %s/24 : %s → %s\n' "${tentative}" "${DOMAINE}" "${RESOLU:-non résolu}"
    sleep 10
  done

  if [ "${RESOLU}" = "${IP_INSTANCE}" ]; then
    succes "${DOMAINE} résout vers ${IP_INSTANCE}"
  else
    avertir "${DOMAINE} résout encore vers « ${RESOLU:-rien} » (cache DNS)"
    avertir "le certificat sera reporté ; relancer ce script une fois la propagation faite"
  fi
fi

###############################################################################
# 5. Installation sur l'instance
###############################################################################
etape "Installation du backend sur l'instance"

DISTANT_BOOTSTRAP="/tmp/sde-bootstrap.sh"
scp "${OPTIONS_SSH[@]}" "${SCRIPT_BOOTSTRAP}" "${UTILISATEUR_SSH}@${IP_INSTANCE}:${DISTANT_BOOTSTRAP}" > /dev/null
succes "script d'installation transféré"

printf '  exécution (compter 3 à 6 minutes : paquets, Node, compilation de sqlite3)\n\n'

# Les paramètres passent par l'environnement de la session SSH : aucun secret
# n'apparaît dans la ligne de commande distante (visible via ps).
ssh "${OPTIONS_SSH[@]}" -t "${UTILISATEUR_SSH}@${IP_INSTANCE}" \
  "sudo DEPOT_GIT='${DEPOT_GIT}' \
        BRANCHE='${BRANCHE}' \
        DOMAINE='${DOMAINE}' \
        COURRIEL='${COURRIEL}' \
        REGION_AWS='${REGION}' \
        BUCKET_S3='${BUCKET_S3}' \
        bash ${DISTANT_BOOTSTRAP}" \
  || echouer "l'installation a échoué sur l'instance (voir la sortie ci-dessus)"

###############################################################################
# 6. Vérification depuis l'extérieur
###############################################################################
etape "Vérification de l'API depuis CloudShell"

# verifier <libellé> <code attendu> <url> [arguments curl supplémentaires…]
verifier() {
  local libelle="$1" attendu="$2" url="$3"
  shift 3
  local code
  code="$(curl -s -o /tmp/sde-reponse.txt -w '%{http_code}' --max-time 20 "$@" "${url}" || echo 000)"
  if [ "${code}" = "${attendu}" ]; then
    succes "${libelle} → HTTP ${code} $(head -c 120 /tmp/sde-reponse.txt)"
    return 0
  fi
  avertir "${libelle} → HTTP ${code} (attendu ${attendu})"
  return 1
}

# Test par l'IP avec l'en-tête Host attendu : valide nginx et le backend même
# si le DNS n'est pas encore propagé.
verifier "API par IP" 200 "http://${IP_INSTANCE}/api/health" -H "Host: ${DOMAINE}" || true

SANTE_HTTPS=0
if [ "${DNS_CONFIGURE:-0}" = "1" ]; then
  for tentative in $(seq 1 6); do
    if verifier "HTTPS ${DOMAINE}" 200 "https://${DOMAINE}/api/health"; then
      SANTE_HTTPS=1
      break
    fi
    sleep 10
  done

  [ "${SANTE_HTTPS}" = "1" ] && { verifier "tableau public" 200 "https://${DOMAINE}/api/stats" || true; }

  if [ "${SANTE_HTTPS}" = "1" ]; then
    etape "Certificat TLS"
    echo | openssl s_client -connect "${DOMAINE}:443" -servername "${DOMAINE}" 2>/dev/null \
      | openssl x509 -noout -issuer -subject -dates 2>/dev/null \
      | sed 's/^/  /' || avertir "lecture du certificat impossible"
  fi
fi

###############################################################################
# Récapitulatif
###############################################################################
MOT_DE_PASSE="$(ssh "${OPTIONS_SSH[@]}" "${UTILISATEUR_SSH}@${IP_INSTANCE}" \
  "sudo grep '^ADMIN_PASSWORD=' /etc/sde/api.env | cut -d= -f2-" 2>/dev/null || echo "")"

if [ -n "${MOT_DE_PASSE}" ]; then
  umask 077
  printf '%s\n' "${MOT_DE_PASSE}" > "$HOME/sde-admin-password.txt"
  chmod 600 "$HOME/sde-admin-password.txt"
fi

printf '\n%s════════════════════════════════════════════════════════════════════%s\n' "${VERT}" "${NEUTRE}"
if [ "${SANTE_HTTPS}" = "1" ]; then
  printf '%s  Backend en production — https://%s/api%s\n' "${VERT}" "${DOMAINE}" "${NEUTRE}"
else
  printf '%s  Backend déployé — HTTPS à finaliser (voir avertissements)%s\n' "${JAUNE}" "${NEUTRE}"
fi
printf '%s════════════════════════════════════════════════════════════════════%s\n' "${VERT}" "${NEUTRE}"

cat <<RECAPITULATIF

  Instance        : ${ID_INSTANCE} (${IP_INSTANCE})
  Accès SSH       : ssh -i ${CLE_SSH} ${UTILISATEUR_SSH}@${IP_INSTANCE}
  API             : https://${DOMAINE}/api
  Sonde de santé  : https://${DOMAINE}/api/health
  Tableau public  : https://${DOMAINE}/api/stats

  Mot de passe administrateur${MOT_DE_PASSE:+ (aussi dans ~/sde-admin-password.txt)} :
    ${MOT_DE_PASSE:-<lecture impossible — sudo cat /etc/sde/api.env sur l'instance>}

  Exploitation (sur l'instance) :
    sudo systemctl status sde-api        état du service
    sudo journalctl -u sde-api -f        journaux en direct
    sudo systemctl restart sde-api       redémarrage
    sudo bash /tmp/sde-bootstrap.sh      mise à jour du code (idempotent)

  Application mobile — pointer sur :
    EXPO_PUBLIC_API_URL=https://${DOMAINE}/api

RECAPITULATIF

[ "${SANTE_HTTPS}" = "1" ] || cat <<SUITE
  HTTPS pas encore actif. Dans l'ordre :
    1. vérifier la propagation : dig +short ${DOMAINE}   (doit donner ${IP_INSTANCE})
    2. relancer le certificat  : ssh -i ${CLE_SSH} ${UTILISATEUR_SSH}@${IP_INSTANCE} \\
                                   "sudo certbot --nginx -d ${DOMAINE} --redirect"
    3. relancer ce script      : ./deploy/cloudshell-deploy.sh

SUITE
