#!/usr/bin/env bash
###############################################################################
# Santé des extrêmes — LOT 2 : configuration DNS Cloudflare
#
# Le domaine atlastech.cm est hébergé chez Cloudflare, l'infrastructure chez
# AWS : ce script crée (ou met à jour) les enregistrements qui relient les deux.
#
#   validate   CNAME de validation des certificats ACM (à lancer AVANT le
#              terraform apply complet, sinon ACM reste bloqué en « pending »)
#   apply      sde-api.atlastech.cm  → nom DNS de l'ALB
#              sde-cdn.atlastech.cm  → domaine de la distribution CloudFront
#   list       enregistrements du projet présents dans la zone
#   check      résolution DNS + test HTTPS réel des deux noms
#   delete     suppression des enregistrements du projet
#
# Pourquoi des CNAME et pas des enregistrements A : un ALB n'a pas d'adresse IP
# fixe (AWS en change au fil des heures). Pointer une IP casserait le service.
#
# Mode « DNS only » (proxied=false) imposé : c'est l'ALB qui termine le TLS
# avec son certificat ACM. Activer le proxy Cloudflare masquerait l'origine
# mais exigerait un certificat côté Cloudflare et casserait la validation ACM.
#
# Secrets : le jeton d'API est lu dans l'environnement, jamais écrit sur disque.
#   export CLOUDFLARE_API_TOKEN='...'   (droits : Zone ▸ DNS ▸ Edit)
#
# Usage :
#   ./scripts/cloudflare-dns.sh validate
#   ./scripts/cloudflare-dns.sh apply
#   ./scripts/cloudflare-dns.sh check
#   ./scripts/cloudflare-dns.sh list
#   ./scripts/cloudflare-dns.sh delete --yes
###############################################################################
set -euo pipefail

RACINE_DEPOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOSSIER_TERRAFORM="${RACINE_DEPOT}/terraform"

API_CLOUDFLARE="https://api.cloudflare.com/client/v4"
DOMAINE="${CLOUDFLARE_DOMAIN:-atlastech.cm}"
SOUS_DOMAINE_API="${API_SUBDOMAIN:-sde-api}"
SOUS_DOMAINE_CDN="${CDN_SUBDOMAIN:-sde-cdn}"
TTL="${CLOUDFLARE_TTL:-300}"

CONFIRME=0

if [ -t 1 ]; then
  VERT=$'\033[0;32m'; ROUGE=$'\033[0;31m'; JAUNE=$'\033[0;33m'; BLEU=$'\033[0;34m'; NEUTRE=$'\033[0m'
else
  VERT=""; ROUGE=""; JAUNE=""; BLEU=""; NEUTRE=""
fi

etape()   { printf '\n%s▶ %s%s\n' "${BLEU}" "$*" "${NEUTRE}"; }
succes()  { printf '%s✓%s %s\n' "${VERT}" "${NEUTRE}" "$*"; }
avertir() { printf '%s!%s %s\n' "${JAUNE}" "${NEUTRE}" "$*" >&2; }
echouer() { printf '%s✗ %s%s\n' "${ROUGE}" "$*" "${NEUTRE}" >&2; exit 1; }

aide() {
  sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Arguments ---------------------------------------------------------------
COMMANDE="${1:-}"
shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)    DOMAINE="${2:?--domain attend une valeur}"; shift 2 ;;
    --ttl)       TTL="${2:?--ttl attend une valeur}"; shift 2 ;;
    --yes|-y)    CONFIRME=1; shift ;;
    -h|--help)   aide ;;
    *)           echouer "option inconnue : $1 (voir --help)" ;;
  esac
done

case "${COMMANDE}" in
  validate|apply|list|check|delete) : ;;
  ''|-h|--help) aide ;;
  *) echouer "commande inconnue : ${COMMANDE} (validate|apply|list|check|delete)" ;;
esac

FQDN_API="${SOUS_DOMAINE_API}.${DOMAINE}"
FQDN_CDN="${SOUS_DOMAINE_CDN}.${DOMAINE}"

# --- Prérequis ---------------------------------------------------------------
for outil in curl jq; do
  command -v "${outil}" > /dev/null 2>&1 || echouer "${outil} est requis mais introuvable"
done

if [ "${COMMANDE}" != "check" ]; then
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] \
    || echouer "CLOUDFLARE_API_TOKEN absent — export CLOUDFLARE_API_TOKEN='...' (droits Zone ▸ DNS ▸ Edit)"
fi

# --- Appel générique de l'API Cloudflare -------------------------------------
# Toute réponse dont « success » est faux interrompt le script avec le message
# d'erreur renvoyé par Cloudflare (plus utile qu'un code HTTP nu).
appeler_api() {
  local methode="$1" chemin="$2" corps="${3:-}"
  local reponse

  if [ -n "${corps}" ]; then
    reponse="$(curl -sS -X "${methode}" "${API_CLOUDFLARE}${chemin}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "${corps}")"
  else
    reponse="$(curl -sS -X "${methode}" "${API_CLOUDFLARE}${chemin}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  fi

  if [ "$(printf '%s' "${reponse}" | jq -r '.success // false')" != "true" ]; then
    printf '%s' "${reponse}" | jq -r '
      (.errors // []) | if length == 0 then "réponse inattendue de l'"'"'API Cloudflare"
      else map("  - [\(.code)] \(.message)") | join("\n") end' >&2
    echouer "appel ${methode} ${chemin} refusé par Cloudflare"
  fi

  printf '%s' "${reponse}"
}

identifiant_zone() {
  if [ -n "${CLOUDFLARE_ZONE_ID:-}" ]; then
    printf '%s' "${CLOUDFLARE_ZONE_ID}"
    return 0
  fi

  local zone
  zone="$(appeler_api GET "/zones?name=${DOMAINE}&status=active" | jq -r '.result[0].id // empty')"
  [ -n "${zone}" ] || echouer "zone « ${DOMAINE} » introuvable (jeton limité à une autre zone ?)"
  printf '%s' "${zone}"
}

# --- Création ou mise à jour d'un enregistrement -----------------------------
upsert_enregistrement() {
  local zone="$1" type="$2" nom="$3" contenu="$4" proxifie="${5:-false}"

  nom="${nom%.}" # les noms de validation ACM se terminent par un point
  contenu="${contenu%.}"

  local existant id contenu_actuel
  existant="$(appeler_api GET "/zones/${zone}/dns_records?type=${type}&name=${nom}")"
  id="$(printf '%s' "${existant}" | jq -r '.result[0].id // empty')"
  contenu_actuel="$(printf '%s' "${existant}" | jq -r '.result[0].content // empty')"

  local charge
  charge="$(jq -nc \
    --arg type "${type}" --arg name "${nom}" --arg content "${contenu}" \
    --argjson ttl "${TTL}" --argjson proxied "${proxifie}" \
    '{type:$type, name:$name, content:$content, ttl:$ttl, proxied:$proxied}')"

  if [ -n "${id}" ]; then
    if [ "${contenu_actuel}" = "${contenu}" ]; then
      succes "${type} ${nom} déjà correct → ${contenu}"
      return 0
    fi
    appeler_api PUT "/zones/${zone}/dns_records/${id}" "${charge}" > /dev/null
    succes "${type} ${nom} mis à jour : ${contenu_actuel} → ${contenu}"
  else
    appeler_api POST "/zones/${zone}/dns_records" "${charge}" > /dev/null
    succes "${type} ${nom} créé → ${contenu}"
  fi
}

supprimer_enregistrement() {
  local zone="$1" type="$2" nom="$3"
  nom="${nom%.}"

  local id
  id="$(appeler_api GET "/zones/${zone}/dns_records?type=${type}&name=${nom}" | jq -r '.result[0].id // empty')"

  if [ -z "${id}" ]; then
    avertir "${type} ${nom} : aucun enregistrement à supprimer"
    return 0
  fi

  appeler_api DELETE "/zones/${zone}/dns_records/${id}" > /dev/null
  succes "${type} ${nom} supprimé"
}

# --- Lecture des sorties Terraform -------------------------------------------
sorties_terraform() {
  command -v terraform > /dev/null 2>&1 \
    || echouer "Terraform est requis pour lire les valeurs à publier"

  local sorties
  sorties="$(terraform -chdir="${DOSSIER_TERRAFORM}" output -json 2>/dev/null)" \
    || echouer "impossible de lire les sorties Terraform (terraform init/apply effectué ?)"

  [ "$(printf '%s' "${sorties}" | jq 'length')" -gt 0 ] \
    || echouer "aucune sortie Terraform : lancer d'abord terraform apply"

  printf '%s' "${sorties}"
}

###############################################################################
# validate — enregistrements de validation des certificats ACM
###############################################################################
commande_validate() {
  etape "Validation DNS des certificats ACM"

  local sorties enregistrements zone nombre
  sorties="$(sorties_terraform)"
  enregistrements="$(printf '%s' "${sorties}" | jq -c '.certificate_validation_records.value // [] | .[]')"

  [ -n "${enregistrements}" ] \
    || echouer "sortie certificate_validation_records vide — appliquer d'abord :
  terraform -chdir=terraform apply -target=aws_acm_certificate.api -target=aws_acm_certificate.cdn"

  zone="$(identifiant_zone)"
  succes "zone ${DOMAINE} → ${zone}"

  nombre=0
  while IFS= read -r ligne; do
    [ -n "${ligne}" ] || continue
    local nom type contenu usage
    nom="$(printf '%s' "${ligne}" | jq -r '.name')"
    type="$(printf '%s' "${ligne}" | jq -r '.type')"
    contenu="$(printf '%s' "${ligne}" | jq -r '.value')"
    usage="$(printf '%s' "${ligne}" | jq -r '.usage // "acm"')"

    printf '  [%s] ' "${usage}"
    # Validation ACM : toujours en DNS only, un CNAME proxifié serait réécrit.
    upsert_enregistrement "${zone}" "${type}" "${nom}" "${contenu}" false
    nombre=$((nombre + 1))
  done <<< "${enregistrements}"

  succes "${nombre} enregistrement(s) de validation publié(s)"
  cat <<SUITE

  ACM valide les certificats sous 5 à 30 minutes. Étape suivante :
    terraform -chdir=terraform apply
  puis, une fois l'ALB et CloudFront créés :
    ./scripts/cloudflare-dns.sh apply
SUITE
}

###############################################################################
# apply — enregistrements publics du service
###############################################################################
commande_apply() {
  etape "Publication des enregistrements de service"

  local sorties dns_alb domaine_cdn zone
  sorties="$(sorties_terraform)"
  dns_alb="$(printf '%s' "${sorties}" | jq -r '.alb_dns_name.value // empty')"
  domaine_cdn="$(printf '%s' "${sorties}" | jq -r '.cloudfront_domain_name.value // empty')"

  [ -n "${dns_alb}" ] || echouer "sortie alb_dns_name absente : terraform apply incomplet"
  [ -n "${domaine_cdn}" ] || echouer "sortie cloudfront_domain_name absente : terraform apply incomplet"

  zone="$(identifiant_zone)"
  succes "zone ${DOMAINE} → ${zone}"

  # CNAME et non A : le nom DNS de l'ALB résout vers des IP qui changent.
  upsert_enregistrement "${zone}" CNAME "${FQDN_API}" "${dns_alb}" false
  upsert_enregistrement "${zone}" CNAME "${FQDN_CDN}" "${domaine_cdn}" false

  cat <<SUITE

  Propagation typique : 1 à 5 minutes (TTL ${TTL} s). Vérification :
    ./scripts/cloudflare-dns.sh check
SUITE
}

###############################################################################
# list — enregistrements du projet dans la zone
###############################################################################
commande_list() {
  etape "Enregistrements du projet dans ${DOMAINE}"

  local zone
  zone="$(identifiant_zone)"

  appeler_api GET "/zones/${zone}/dns_records?per_page=200" | jq -r --arg domaine "${DOMAINE}" '
    .result
    | map(select(.name | test("^(_[a-z0-9]+\\.)?(sde-|_acme)|^_") or (. | startswith("sde-"))))
    | if length == 0 then "  (aucun enregistrement « sde- » ni de validation)"
      else
        (["NOM","TYPE","VALEUR","PROXY","TTL"] | @tsv),
        (.[] | [.name, .type, (.content | .[0:60]), (if .proxied then "oui" else "non" end), (.ttl|tostring)] | @tsv)
      end' | column -t -s "$(printf '\t')" 2>/dev/null \
    || appeler_api GET "/zones/${zone}/dns_records?per_page=200" | jq -r '.result[] | "  \(.type)\t\(.name)\t\(.content)"'
}

###############################################################################
# check — résolution DNS et test HTTPS
###############################################################################
commande_check() {
  etape "Vérification de ${FQDN_API} et ${FQDN_CDN}"

  local resolveur=""
  for candidat in dig host nslookup; do
    command -v "${candidat}" > /dev/null 2>&1 && { resolveur="${candidat}"; break; }
  done

  for nom in "${FQDN_API}" "${FQDN_CDN}"; do
    case "${resolveur}" in
      dig)      printf '  %s → %s\n' "${nom}" "$(dig +short "${nom}" | tr '\n' ' ')" ;;
      host)     printf '  %s → %s\n' "${nom}" "$(host "${nom}" 2>&1 | head -3 | tr '\n' ' ')" ;;
      nslookup) printf '  %s → %s\n' "${nom}" "$(nslookup "${nom}" 2>&1 | tail -4 | tr '\n' ' ')" ;;
      *)        avertir "aucun outil de résolution DNS disponible (dig/host/nslookup)" ;;
    esac
  done

  etape "Test HTTPS de l'API"
  local code
  code="$(curl -s -o /tmp/sde-sante.json -w '%{http_code}' --max-time 15 "https://${FQDN_API}/api/health" || echo 000)"
  if [ "${code}" = "200" ]; then
    succes "https://${FQDN_API}/api/health → $(cat /tmp/sde-sante.json)"
  else
    avertir "https://${FQDN_API}/api/health → HTTP ${code}"
    cat <<PISTES >&2

  Pistes :
    - 000 / délai dépassé : DNS non propagé, ou CNAME proxifié par Cloudflare
    - 502 / 503 : aucune tâche ECS saine → aws logs tail /ecs/sde-prod-backend --follow
    - erreur TLS : certificat ACM non encore validé → ./scripts/cloudflare-dns.sh validate
PISTES
  fi

  etape "Test HTTPS du CDN"
  # Un 403 est le comportement attendu de S3+CloudFront sur une clé inexistante :
  # il prouve que le nom, le certificat et l'origine répondent.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${FQDN_CDN}/" || echo 000)"
  case "${code}" in
    200|403|404) succes "https://${FQDN_CDN}/ → HTTP ${code} (distribution joignable)" ;;
    *)           avertir "https://${FQDN_CDN}/ → HTTP ${code}" ;;
  esac
}

###############################################################################
# delete — retrait des enregistrements du projet
###############################################################################
commande_delete() {
  etape "Suppression des enregistrements du projet"

  if [ "${CONFIRME}" -ne 1 ]; then
    printf 'Supprimer %s et %s de la zone %s ? [--yes requis]\n' "${FQDN_API}" "${FQDN_CDN}" "${DOMAINE}" >&2
    echouer "opération annulée : relancer avec --yes pour confirmer"
  fi

  local zone
  zone="$(identifiant_zone)"

  supprimer_enregistrement "${zone}" CNAME "${FQDN_API}"
  supprimer_enregistrement "${zone}" CNAME "${FQDN_CDN}"

  avertir "les CNAME de validation ACM (_xxx.${DOMAINE}) sont conservés : ACM en a besoin pour renouveler les certificats"
}

case "${COMMANDE}" in
  validate) commande_validate ;;
  apply)    commande_apply ;;
  list)     commande_list ;;
  check)    commande_check ;;
  delete)   commande_delete ;;
esac
