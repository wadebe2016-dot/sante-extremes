#!/usr/bin/env bash
###############################################################################
# Vérification de l'API — Santé des extrêmes
#
# Rejoue les contrôles des LOT 3 et 3 bis sur une instance en fonctionnement et
# rend un tableau de résultats. Aucun code n'est affiché ni journalisé.
#
# Usage :
#   export ADMIN_PASSWORD=… TRESORIER_PASSWORD=… SECRETAIRE_PASSWORD=… \
#          CENSEUR_PASSWORD=… INTENDANT_PASSWORD=… COMPETITIONS_PASSWORD=…
#   ./tests/verifier-api.sh                        # production
#   API=http://localhost:3000/api ./tests/verifier-api.sh
#   ./tests/verifier-api.sh --lecture-seule        # aucune écriture en base
#   ./tests/verifier-api.sh --avec-blocage         # teste aussi le plafond 429
#
# ATTENTION : sans --lecture-seule, le script ÉCRIT dans la base visée (membre
# d'essai, cotisation, sanction, demande). À lancer de préférence sur une
# instance de test, ou accepter ces quelques lignes en production.
#
# --avec-blocage est volontairement optionnel : il envoie cinq codes erronés et
# bloque donc votre adresse IP pendant quinze minutes, y compris pour l'usage
# normal de l'application.
###############################################################################
set -uo pipefail

API="${API:-https://sde-api.atlastech.cm/api}"
LECTURE_SEULE=0
AVEC_BLOCAGE=0

for argument in "$@"; do
  case "${argument}" in
    --lecture-seule) LECTURE_SEULE=1 ;;
    --avec-blocage)  AVEC_BLOCAGE=1 ;;
    -h|--help)       sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               echo "Option inconnue : ${argument}" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  VERT=$'\033[0;32m'; ROUGE=$'\033[0;31m'; JAUNE=$'\033[0;33m'; BLEU=$'\033[0;34m'; NEUTRE=$'\033[0m'
else
  VERT=""; ROUGE=""; JAUNE=""; BLEU=""; NEUTRE=""
fi

REUSSIS=0
ECHOUES=0
IGNORES=0

titre()  { printf '\n%s── %s%s\n' "${BLEU}" "$*" "${NEUTRE}"; }
ignore() { printf '  %s–%s %-52s %s\n' "${JAUNE}" "${NEUTRE}" "$1" "$2"; IGNORES=$((IGNORES + 1)); }

# verifier <libellé> <codes attendus, séparés par |> <arguments curl…>
verifier() {
  local libelle="$1" attendus="$2"; shift 2
  local obtenu
  obtenu="$(curl -s -o /tmp/sde-verif.out -w '%{http_code}' --max-time 25 "$@" || echo 000)"

  if printf '%s' "${attendus}" | tr '|' '\n' | grep -qx "${obtenu}"; then
    printf '  %s✓%s %-52s %s\n' "${VERT}" "${NEUTRE}" "${libelle}" "${obtenu}"
    REUSSIS=$((REUSSIS + 1))
    return 0
  fi

  printf '  %s✗%s %-52s %s (attendu %s)\n' "${ROUGE}" "${NEUTRE}" "${libelle}" "${obtenu}" "${attendus}"
  head -c 160 /tmp/sde-verif.out 2>/dev/null | sed 's/^/      /'
  echo
  ECHOUES=$((ECHOUES + 1))
  return 1
}

# Extrait une valeur d'une réponse JSON sans dépendre de jq.
#
# Le chemin est passé en argument, jamais interpolé dans le script Node : une
# expression contenant des apostrophes casserait sinon le guillemetage.
valeur_json() {
  node -e "
    let d = '';
    process.stdin.on('data', (c) => (d += c)).on('end', () => {
      try {
        const o = JSON.parse(d);
        const v = process.argv[1].split('.').reduce((a, k) => (a == null ? a : a[k]), o);
        console.log(Array.isArray(v) ? v.join(',') : (v ?? ''));
      } catch (e) {
        console.log('');
      }
    });
  " "$1" 2>/dev/null
}

manque_code() {
  local nom="$1"
  [ -z "${!nom:-}" ]
}

printf '%sVérification de %s%s\n' "${BLEU}" "${API}" "${NEUTRE}"
[ "${LECTURE_SEULE}" -eq 1 ] && printf '%smode lecture seule : aucune écriture en base%s\n' "${JAUNE}" "${NEUTRE}"

###############################################################################
titre "Routes publiques (aucun code requis)"
###############################################################################
verifier "GET /health" "200" "${API}/health"
verifier "GET /stats" "200" "${API}/stats"
verifier "GET /historique" "200" "${API}/historique?annee=$(date +%Y)"
verifier "GET /tresorerie" "200" "${API}/tresorerie"
verifier "GET /sanctions" "200" "${API}/sanctions?statut=toutes"
verifier "GET /demandes" "200" "${API}/demandes"
verifier "GET /decaissements" "200" "${API}/decaissements"
verifier "GET /documents/reglement" "200|404" "${API}/documents/reglement"
verifier "GET /export/historique.xlsx" "200" "${API}/export/historique.xlsx?annee=$(date +%Y)"
verifier "GET /export/historique.pdf" "200" "${API}/export/historique.pdf?annee=$(date +%Y)"

###############################################################################
titre "Refus sans code, et avec un mauvais code"
###############################################################################
verifier "POST /cotisations sans code" "401" -X POST "${API}/cotisations"
verifier "GET /admin/members sans code" "401" "${API}/admin/members"
verifier "POST /sanctions sans code" "401" -X POST "${API}/sanctions"
verifier "POST /demandes sans code" "401" -X POST "${API}/demandes"
verifier "GET /cotisations/en-attente sans code" "401" "${API}/cotisations/en-attente"
verifier "GET /documents/fiche-sante/1 sans code" "401" "${API}/documents/fiche-sante/1"

###############################################################################
titre "Reconnaissance des six codes"
###############################################################################
controler_role() {
  local variable="$1" role_attendu="$2"

  if manque_code "${variable}"; then
    ignore "${variable}" "non défini dans l'environnement"
    return
  fi

  local roles
  roles="$(curl -s --max-time 25 -X POST "${API}/auth/verify" \
    -H 'Content-Type: application/json' \
    -d "{\"code\":\"${!variable}\"}" | valeur_json roles)"

  if printf '%s' "${roles}" | grep -q "${role_attendu}"; then
    printf '  %s✓%s %-52s %s\n' "${VERT}" "${NEUTRE}" "${variable}" "${roles}"
    REUSSIS=$((REUSSIS + 1))
  else
    printf '  %s✗%s %-52s « %s » (attendu %s)\n' "${ROUGE}" "${NEUTRE}" "${variable}" "${roles}" "${role_attendu}"
    ECHOUES=$((ECHOUES + 1))
  fi
}

controler_role ADMIN_PASSWORD admin
controler_role TRESORIER_PASSWORD tresorier
controler_role SECRETAIRE_PASSWORD secretaire
controler_role CENSEUR_PASSWORD censeur
controler_role INTENDANT_PASSWORD intendant
controler_role COMPETITIONS_PASSWORD competitions

###############################################################################
titre "Cloisonnement des rôles"
###############################################################################
if manque_code TRESORIER_PASSWORD; then
  ignore "trésorier sur une route secrétaire" "TRESORIER_PASSWORD absent"
else
  verifier "trésorier sur GET /admin/members" "401" \
    -H "Authorization: Bearer ${TRESORIER_PASSWORD}" "${API}/admin/members"
  verifier "trésorier sur POST /demandes" "401" \
    -X POST -H "Authorization: Bearer ${TRESORIER_PASSWORD}" \
    -F 'categorie=autre' -F 'libelle=Essai' -F 'montant_estime=1000' "${API}/demandes"
  verifier "trésorier sur /documents/fiche-sante/1" "401" \
    -H "Authorization: Bearer ${TRESORIER_PASSWORD}" "${API}/documents/fiche-sante/1"
fi

if manque_code SECRETAIRE_PASSWORD; then
  ignore "secrétaire sur GET /admin/members" "SECRETAIRE_PASSWORD absent"
else
  verifier "secrétaire sur GET /admin/members" "200" \
    -H "Authorization: Bearer ${SECRETAIRE_PASSWORD}" "${API}/admin/members"
fi

if manque_code TRESORIER_PASSWORD; then
  ignore "trésorier sur /cotisations/en-attente" "TRESORIER_PASSWORD absent"
else
  verifier "trésorier sur /cotisations/en-attente" "200" \
    -H "Authorization: Bearer ${TRESORIER_PASSWORD}" "${API}/cotisations/en-attente"
fi

###############################################################################
titre "Déclaration de paiement : reçu selon le moyen"
###############################################################################
MOIS_COURANT="$(date +%Y-%m)"

verifier "déclarer Mobile Money sans reçu" "400" \
  -X POST -F 'member_id=999999' -F "mois=${MOIS_COURANT}" \
  -F 'montant=1000' -F 'moyen=Mobile Money' "${API}/cotisations/declarer"

###############################################################################
titre "Chaîne des dépenses"
###############################################################################
if [ "${LECTURE_SEULE}" -eq 1 ]; then
  ignore "création et décaissement d'une demande" "mode lecture seule"
elif manque_code INTENDANT_PASSWORD || manque_code TRESORIER_PASSWORD; then
  ignore "création et décaissement d'une demande" "codes intendant ou trésorier absents"
else
  ID_DEMANDE="$(curl -s --max-time 25 -X POST "${API}/demandes" \
    -H "Authorization: Bearer ${INTENDANT_PASSWORD}" \
    -F 'categorie=autre' -F 'libelle=Vérification automatique' \
    -F 'montant_estime=1000' | valeur_json 'id')"

  if [ -z "${ID_DEMANDE}" ]; then
    printf '  %s✗%s %-52s création impossible\n' "${ROUGE}" "${NEUTRE}" "POST /demandes (intendant)"
    ECHOUES=$((ECHOUES + 1))
  else
    printf '  %s✓%s %-52s #%s\n' "${VERT}" "${NEUTRE}" "POST /demandes (intendant)" "${ID_DEMANDE}"
    REUSSIS=$((REUSSIS + 1))

    # Le cœur de l'invariant : pas de décaissement sans approbation.
    verifier "décaisser une demande « en_attente »" "409" \
      -X POST -H "Authorization: Bearer ${TRESORIER_PASSWORD}" \
      -F 'montant=1000' -F 'moyen=Espece' -F 'paye_par=caisse' \
      "${API}/demandes/${ID_DEMANDE}/decaisser"

    SOLDE_AVANT="$(curl -s --max-time 25 "${API}/tresorerie" | valeur_json 'solde_reel')"
    HISTO_AVANT="$(curl -s --max-time 25 "${API}/historique?annee=$(date +%Y)" | valeur_json 'total_annee')"

    verifier "approuver la demande" "200" \
      -X POST -H "Authorization: Bearer ${TRESORIER_PASSWORD}" \
      "${API}/demandes/${ID_DEMANDE}/approuver"

    verifier "décaisser 1 000 XAF" "201" \
      -X POST -H "Authorization: Bearer ${TRESORIER_PASSWORD}" \
      -F 'montant=1000' -F 'moyen=Espece' -F 'paye_par=caisse' \
      "${API}/demandes/${ID_DEMANDE}/decaisser"

    verifier "décaisser une seconde fois" "409" \
      -X POST -H "Authorization: Bearer ${TRESORIER_PASSWORD}" \
      -F 'montant=1000' -F 'moyen=Espece' -F 'paye_par=caisse' \
      "${API}/demandes/${ID_DEMANDE}/decaisser"

    SOLDE_APRES="$(curl -s --max-time 25 "${API}/tresorerie" | valeur_json 'solde_reel')"
    HISTO_APRES="$(curl -s --max-time 25 "${API}/historique?annee=$(date +%Y)" | valeur_json 'total_annee')"

    if [ "$((SOLDE_AVANT - 1000))" = "${SOLDE_APRES}" ]; then
      printf '  %s✓%s %-52s %s → %s\n' "${VERT}" "${NEUTRE}" "solde diminué du montant décaissé" "${SOLDE_AVANT}" "${SOLDE_APRES}"
      REUSSIS=$((REUSSIS + 1))
    else
      printf '  %s✗%s %-52s %s → %s\n' "${ROUGE}" "${NEUTRE}" "solde diminué du montant décaissé" "${SOLDE_AVANT}" "${SOLDE_APRES}"
      ECHOUES=$((ECHOUES + 1))
    fi

    if [ "${HISTO_AVANT}" = "${HISTO_APRES}" ]; then
      printf '  %s✓%s %-52s %s\n' "${VERT}" "${NEUTRE}" "historique des cotisations inchangé" "${HISTO_APRES}"
      REUSSIS=$((REUSSIS + 1))
    else
      printf '  %s✗%s %-52s %s → %s\n' "${ROUGE}" "${NEUTRE}" "historique des cotisations inchangé" "${HISTO_AVANT}" "${HISTO_APRES}"
      ECHOUES=$((ECHOUES + 1))
    fi
  fi
fi

###############################################################################
titre "Plafond d'essais (bloque l'adresse IP quinze minutes)"
###############################################################################
if [ "${AVEC_BLOCAGE}" -ne 1 ]; then
  ignore "cinq codes erronés puis 429" "passer --avec-blocage pour l'exécuter"
else
  printf '  %s!%s votre IP va être bloquée quinze minutes\n' "${JAUNE}" "${NEUTRE}"
  DERNIER=""
  for essai in 1 2 3 4 5 6; do
    DERNIER="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 \
      -X POST "${API}/auth/verify" -H 'Content-Type: application/json' \
      -d '{"code":"000001"}')"
    printf '     essai %s → %s\n' "${essai}" "${DERNIER}"
  done

  if [ "${DERNIER}" = "429" ]; then
    printf '  %s✓%s %-52s 429 au sixième essai\n' "${VERT}" "${NEUTRE}" "plafond d'essais actif"
    REUSSIS=$((REUSSIS + 1))
  else
    printf '  %s✗%s %-52s %s au sixième essai\n' "${ROUGE}" "${NEUTRE}" "plafond d'essais actif" "${DERNIER}"
    ECHOUES=$((ECHOUES + 1))
  fi
fi

###############################################################################
printf '\n%s────────────────────────────────────────────────%s\n' "${BLEU}" "${NEUTRE}"
printf '  %s%s réussis%s · %s%s échoués%s · %s%s ignorés%s\n' \
  "${VERT}" "${REUSSIS}" "${NEUTRE}" \
  "${ROUGE}" "${ECHOUES}" "${NEUTRE}" \
  "${JAUNE}" "${IGNORES}" "${NEUTRE}"
printf '%s────────────────────────────────────────────────%s\n\n' "${BLEU}" "${NEUTRE}"

[ "${ECHOUES}" -eq 0 ]
