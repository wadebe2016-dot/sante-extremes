#!/usr/bin/env bash
###############################################################################
# Entrypoint du conteneur backend — Santé des extrêmes (LOT 2)
#
# Cycle de vie d'une tâche Fargate, dont le disque est éphémère :
#   1. restauration de la base SQLite depuis S3
#   2. démarrage du serveur Express (commande passée en CMD)
#   3. sauvegarde périodique de la base vers S3, en tâche de fond
#   4. sur SIGTERM (déploiement, arrêt de tâche) : arrêt propre du serveur
#      PUIS sauvegarde finale — dans cet ordre, pour capturer les dernières
#      écritures une fois la base refermée.
#
# Si S3_DB_BUCKET n'est pas défini, les étapes S3 sont inertes : la même image
# tourne alors en local avec une base sur le système de fichiers.
###############################################################################
set -euo pipefail

RACINE="${APP_ROOT:-/app}"
SYNCHRO="${RACINE}/scripts/s3-db-sync.js"

journal() {
  printf '[entrypoint] %s\n' "$*"
}

pid_serveur=""
pid_synchro=""
arret_demande=0

# Arrêt propre : le serveur d'abord (il ferme la connexion SQLite), la
# sauvegarde ensuite. stopTimeout est réglé à 60 s côté ECS pour laisser
# le temps à l'envoi S3.
arreter() {
  local signal="$1"
  [ "${arret_demande}" -eq 1 ] && return 0
  arret_demande=1
  journal "signal ${signal} reçu, arrêt en cours"

  if [ -n "${pid_serveur}" ] && kill -0 "${pid_serveur}" 2>/dev/null; then
    kill -TERM "${pid_serveur}" 2>/dev/null || true
    wait "${pid_serveur}" 2>/dev/null || true
    journal "serveur arrêté"
  fi

  if [ -n "${pid_synchro}" ] && kill -0 "${pid_synchro}" 2>/dev/null; then
    # Le processus de synchro effectue sa sauvegarde finale sur SIGTERM.
    kill -TERM "${pid_synchro}" 2>/dev/null || true
    wait "${pid_synchro}" 2>/dev/null || true
    journal "sauvegarde finale de la base terminée"
  fi

  exit 0
}

trap 'arreter TERM' TERM
trap 'arreter INT' INT

# --- 1. Restauration de la base ----------------------------------------------
if [ -f "${SYNCHRO}" ]; then
  journal "restauration de la base SQLite depuis S3"
  node "${SYNCHRO}" restore
else
  journal "script de synchronisation absent (${SYNCHRO}) : étape ignorée"
fi

# --- 2. Serveur applicatif ----------------------------------------------------
journal "démarrage du serveur : $*"
"$@" &
pid_serveur=$!

# --- 3. Sauvegarde périodique -------------------------------------------------
if [ -f "${SYNCHRO}" ] && [ -n "${S3_DB_BUCKET:-}" ]; then
  node "${SYNCHRO}" watch &
  pid_synchro=$!
  journal "synchronisation S3 en tâche de fond (pid ${pid_synchro})"
fi

# --- 4. Attente ---------------------------------------------------------------
# `wait` est interrompu par les signaux : la boucle rend la main au trap puis
# reprend l'attente tant que le serveur tourne.
while kill -0 "${pid_serveur}" 2>/dev/null; do
  wait "${pid_serveur}" && code=0 || code=$?
  # Code > 128 = attente interrompue par un signal, pas une sortie du serveur.
  if [ "${code}" -le 128 ]; then
    break
  fi
done

if [ "${arret_demande}" -eq 0 ]; then
  journal "le serveur s'est arrêté de lui-même (code ${code:-0}) : sauvegarde de la base"
  if [ -n "${pid_synchro}" ] && kill -0 "${pid_synchro}" 2>/dev/null; then
    kill -TERM "${pid_synchro}" 2>/dev/null || true
    wait "${pid_synchro}" 2>/dev/null || true
  fi
  # Sortie non nulle : ECS redémarre la tâche et l'ALB la retire du pool.
  exit "${code:-1}"
fi
