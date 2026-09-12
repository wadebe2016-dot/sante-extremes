#!/usr/bin/env bash
###############################################################################
# Santé des extrêmes — LOT 2 : déploiement manuel du backend sur ECS Fargate
#
# Reproduit exactement ce que fait GitHub Actions, pour les cas où la CI n'est
# pas disponible (première mise en service, correctif urgent, poste local).
#
#   1. construction de l'image Docker du backend
#   2. envoi vers ECR
#   3. nouvelle révision de définition de tâche pointant sur cette image
#   4. mise à jour du service et attente de stabilité
#   5. test de bon fonctionnement sur l'API publique
#
# La configuration est lue dans les sorties Terraform quand elles sont
# disponibles ; sinon les valeurs par défaut du LOT 2 s'appliquent et peuvent
# être surchargées par option ou par variable d'environnement.
#
# Aucun secret n'est manipulé ici : l'accès AWS vient du profil/rôle courant,
# le mot de passe admin reste dans Secrets Manager.
#
# Usage :
#   ./scripts/deploy.sh                     déploiement complet
#   ./scripts/deploy.sh --tag v1.2.0        étiquette d'image explicite
#   ./scripts/deploy.sh --no-build          redéployer une image déjà poussée
#   ./scripts/deploy.sh --dry-run           afficher les actions sans les exécuter
###############################################################################
set -euo pipefail

RACINE_DEPOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOSSIER_BACKEND="${RACINE_DEPOT}/backend"
DOSSIER_TERRAFORM="${RACINE_DEPOT}/terraform"

# --- Valeurs par défaut (alignées sur terraform/variables.tf) ----------------
REGION="${AWS_REGION:-eu-west-3}"
DEPOT_ECR="${ECR_REPOSITORY:-sde-prod-backend}"
CLUSTER="${ECS_CLUSTER:-sde-prod-cluster}"
SERVICE="${ECS_SERVICE:-sde-prod-backend}"
FAMILLE="${ECS_TASK_FAMILY:-sde-prod-backend}"
CONTENEUR="${CONTAINER_NAME:-backend}"
URL_API="${API_BASE_URL:-https://sde-api.atlastech.cm}"
PLATEFORME="${DOCKER_PLATFORM:-linux/amd64}"

ETIQUETTE=""
CONSTRUIRE=1
SIMULATION=0
ATTENTE_MINUTES="${DEPLOY_WAIT_MINUTES:-15}"

# --- Sortie lisible ----------------------------------------------------------
if [ -t 1 ]; then
  VERT=$'\033[0;32m'; ROUGE=$'\033[0;31m'; JAUNE=$'\033[0;33m'; BLEU=$'\033[0;34m'; NEUTRE=$'\033[0m'
else
  VERT=""; ROUGE=""; JAUNE=""; BLEU=""; NEUTRE=""
fi

etape()   { printf '\n%s▶ %s%s\n' "${BLEU}" "$*" "${NEUTRE}"; }
succes()  { printf '%s✓%s %s\n' "${VERT}" "${NEUTRE}" "$*"; }
avertir() { printf '%s!%s %s\n' "${JAUNE}" "${NEUTRE}" "$*" >&2; }
echouer() { printf '%s✗ %s%s\n' "${ROUGE}" "$*" "${NEUTRE}" >&2; exit 1; }

executer() {
  if [ "${SIMULATION}" -eq 1 ]; then
    printf '  [simulation] %s\n' "$*"
    return 0
  fi
  "$@"
}

aide() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Options -----------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)      ETIQUETTE="${2:?--tag attend une valeur}"; shift 2 ;;
    --region)   REGION="${2:?--region attend une valeur}"; shift 2 ;;
    --cluster)  CLUSTER="${2:?--cluster attend une valeur}"; shift 2 ;;
    --service)  SERVICE="${2:?--service attend une valeur}"; shift 2 ;;
    --family)   FAMILLE="${2:?--family attend une valeur}"; shift 2 ;;
    --api-url)  URL_API="${2:?--api-url attend une valeur}"; shift 2 ;;
    --platform) PLATEFORME="${2:?--platform attend une valeur}"; shift 2 ;;
    --no-build) CONSTRUIRE=0; shift ;;
    --dry-run)  SIMULATION=1; shift ;;
    -h|--help)  aide ;;
    *)          echouer "option inconnue : $1 (voir --help)" ;;
  esac
done

# --- Prérequis ---------------------------------------------------------------
etape "Vérification des prérequis"

for outil in aws docker jq git; do
  command -v "${outil}" > /dev/null 2>&1 || echouer "${outil} est requis mais introuvable"
done

docker info > /dev/null 2>&1 || echouer "le démon Docker ne répond pas"

IDENTITE="$(aws sts get-caller-identity --output json 2>/dev/null)" \
  || echouer "identifiants AWS invalides ou expirés (aws configure / aws sso login)"

COMPTE="$(printf '%s' "${IDENTITE}" | jq -r '.Account')"
APPELANT="$(printf '%s' "${IDENTITE}" | jq -r '.Arn')"
succes "compte AWS ${COMPTE} — ${APPELANT}"

# --- Configuration depuis Terraform (si l'état est accessible) ---------------
etape "Lecture de la configuration"

if [ -d "${DOSSIER_TERRAFORM}" ] && command -v terraform > /dev/null 2>&1; then
  if SORTIES="$(terraform -chdir="${DOSSIER_TERRAFORM}" output -json 2>/dev/null)" \
     && [ "$(printf '%s' "${SORTIES}" | jq 'length')" -gt 0 ]; then
    lire_sortie() { printf '%s' "${SORTIES}" | jq -r --arg cle "$1" '.[$cle].value // empty'; }

    valeur="$(lire_sortie ecs_cluster_name)";  [ -n "${valeur}" ] && CLUSTER="${valeur}"
    valeur="$(lire_sortie ecs_service_name)";  [ -n "${valeur}" ] && SERVICE="${valeur}"
    valeur="$(lire_sortie ecs_task_family)";   [ -n "${valeur}" ] && FAMILLE="${valeur}"
    valeur="$(lire_sortie ecr_repository_url)"
    if [ -n "${valeur}" ]; then
      URL_DEPOT="${valeur}"
      DEPOT_ECR="${valeur##*/}"
    fi
    valeur="$(lire_sortie api_url)"; [ -n "${valeur}" ] && URL_API="${valeur%/api}"
    succes "configuration issue des sorties Terraform"
  else
    avertir "sorties Terraform indisponibles : utilisation des valeurs par défaut"
  fi
else
  avertir "Terraform absent : utilisation des valeurs par défaut"
fi

REGISTRE="${COMPTE}.dkr.ecr.${REGION}.amazonaws.com"
URL_DEPOT="${URL_DEPOT:-${REGISTRE}/${DEPOT_ECR}}"

if [ -z "${ETIQUETTE}" ]; then
  SHA_COURT="$(git -C "${RACINE_DEPOT}" rev-parse --short HEAD 2>/dev/null || echo manuel)"
  if [ -n "$(git -C "${RACINE_DEPOT}" status --porcelain 2>/dev/null)" ]; then
    avertir "arbre de travail non validé : l'image ne correspondra à aucun commit publié"
    ETIQUETTE="${SHA_COURT}-local"
  else
    ETIQUETTE="${SHA_COURT}"
  fi
fi

IMAGE="${URL_DEPOT}:${ETIQUETTE}"

cat <<RESUME

  Région        : ${REGION}
  Cluster       : ${CLUSTER}
  Service       : ${SERVICE}
  Famille       : ${FAMILLE}
  Image         : ${IMAGE}
  Plateforme    : ${PLATEFORME}
  API publique  : ${URL_API}
RESUME

[ "${SIMULATION}" -eq 1 ] && avertir "mode simulation : aucune modification ne sera appliquée"

# --- Construction et envoi de l'image ---------------------------------------
if [ "${CONSTRUIRE}" -eq 1 ]; then
  etape "Construction de l'image (${PLATEFORME})"

  [ -f "${DOSSIER_BACKEND}/Dockerfile" ] || echouer "Dockerfile introuvable dans ${DOSSIER_BACKEND}"

  executer docker build \
    --platform "${PLATEFORME}" \
    --tag "${IMAGE}" \
    --tag "${URL_DEPOT}:latest" \
    --label "org.opencontainers.image.revision=${ETIQUETTE}" \
    "${DOSSIER_BACKEND}"
  succes "image construite : ${IMAGE}"

  etape "Envoi vers ECR"
  if [ "${SIMULATION}" -eq 0 ]; then
    aws ecr describe-repositories --repository-names "${DEPOT_ECR}" --region "${REGION}" > /dev/null 2>&1 \
      || echouer "dépôt ECR « ${DEPOT_ECR} » inexistant : lancer terraform apply d'abord"

    aws ecr get-login-password --region "${REGION}" \
      | docker login --username AWS --password-stdin "${REGISTRE}" > /dev/null
    succes "authentifié sur ${REGISTRE}"
  fi

  executer docker push "${IMAGE}"
  executer docker push "${URL_DEPOT}:latest"
  succes "image publiée"
else
  avertir "construction ignorée (--no-build) : l'image ${IMAGE} doit déjà exister sur ECR"
fi

# --- Nouvelle révision de définition de tâche --------------------------------
etape "Enregistrement d'une définition de tâche"

if [ "${SIMULATION}" -eq 0 ]; then
  aws ecs describe-task-definition \
    --task-definition "${FAMILLE}" \
    --region "${REGION}" \
    --query 'taskDefinition' \
    --output json > /tmp/sde-definition-courante.json \
    || echouer "famille de tâche « ${FAMILLE} » introuvable : lancer terraform apply d'abord"

  REVISION_PRECEDENTE="$(jq -r '.revision' /tmp/sde-definition-courante.json)"

  # On repart de la définition en place et on ne change QUE l'image du conteneur :
  # les variables d'environnement et les secrets restent pilotés par Terraform.
  jq --arg conteneur "${CONTENEUR}" --arg image "${IMAGE}" '
    {
      family, taskRoleArn, executionRoleArn, networkMode, volumes, placementConstraints,
      requiresCompatibilities, cpu, memory, runtimePlatform, tags, ephemeralStorage,
      containerDefinitions: (
        .containerDefinitions
        | map(if .name == $conteneur then .image = $image else . end)
      )
    }
    | with_entries(select(.value != null))
  ' /tmp/sde-definition-courante.json > /tmp/sde-definition-nouvelle.json

  jq -e --arg image "${IMAGE}" \
    'any(.containerDefinitions[]; .image == $image)' /tmp/sde-definition-nouvelle.json > /dev/null \
    || echouer "conteneur « ${CONTENEUR} » absent de la définition de tâche"

  NOUVELLE_DEFINITION="$(aws ecs register-task-definition \
    --region "${REGION}" \
    --cli-input-json "file:///tmp/sde-definition-nouvelle.json" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"

  succes "révision ${REVISION_PRECEDENTE} → ${NOUVELLE_DEFINITION##*:}"
else
  printf '  [simulation] register-task-definition (%s → %s)\n' "${FAMILLE}" "${IMAGE}"
  NOUVELLE_DEFINITION="${FAMILLE}:simulation"
fi

# --- Mise à jour du service --------------------------------------------------
# Rappel : une seule tâche tourne (SQLite mono-écrivain). L'ancienne est
# arrêtée — elle sauvegarde alors la base sur S3 — puis la nouvelle démarre et
# la restaure. Coupure de service de l'ordre de la minute.
etape "Mise à jour du service ECS"

executer aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service "${SERVICE}" \
  --task-definition "${NOUVELLE_DEFINITION}" \
  --region "${REGION}" \
  --output text --query 'service.serviceName' > /dev/null

succes "déploiement demandé"

if [ "${SIMULATION}" -eq 0 ]; then
  etape "Attente de stabilité (jusqu'à ${ATTENTE_MINUTES} min)"
  if aws ecs wait services-stable \
      --cluster "${CLUSTER}" \
      --services "${SERVICE}" \
      --region "${REGION}"; then
    succes "service stable"
  else
    printf '\n%sÉchec du déploiement.%s Derniers évènements du service :\n' "${ROUGE}" "${NEUTRE}" >&2
    aws ecs describe-services \
      --cluster "${CLUSTER}" --services "${SERVICE}" --region "${REGION}" \
      --query 'services[0].events[0:8].[createdAt,message]' --output table >&2 || true
    printf '\nJournaux applicatifs :\n  aws logs tail /ecs/%s --follow --region %s\n' "${FAMILLE}" "${REGION}" >&2
    echouer "le service ne s'est pas stabilisé (rollback automatique par le circuit breaker)"
  fi

  # --- Test de bon fonctionnement -------------------------------------------
  etape "Test de l'API publique"
  for tentative in $(seq 1 12); do
    CODE="$(curl -s -o /tmp/sde-sante.json -w '%{http_code}' "${URL_API}/api/health" || echo 000)"
    if [ "${CODE}" = "200" ]; then
      succes "$(cat /tmp/sde-sante.json)"
      break
    fi
    avertir "tentative ${tentative} : HTTP ${CODE}"
    [ "${tentative}" -eq 12 ] && echouer "${URL_API}/api/health ne répond pas 200"
    sleep 10
  done
fi

printf '\n%s✓ Déploiement terminé%s\n' "${VERT}" "${NEUTRE}"
cat <<FIN

  API        : ${URL_API}/api
  Image      : ${IMAGE}
  Journaux   : aws logs tail /ecs/${FAMILLE} --follow --region ${REGION}
  Retour arrière :
    aws ecs update-service --cluster ${CLUSTER} --service ${SERVICE} \\
      --task-definition ${FAMILLE}:<révision-précédente> --region ${REGION}
FIN
