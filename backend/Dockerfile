# syntax=docker/dockerfile:1.7
###############################################################################
# Backend Express — Santé des extrêmes (image de production, LOT 2)
#
# Deux étages : les outils de compilation de sqlite3 (python3/make/g++, ~250 Mo)
# restent dans l'étage de build et n'entrent jamais dans l'image finale.
# L'entrypoint restaure la base SQLite depuis S3 au démarrage et la sauvegarde
# périodiquement puis à l'arrêt (SIGTERM) — cf. scripts/s3-db-sync.js.
###############################################################################

ARG NODE_VERSION=20.18-bookworm-slim

# --- Étage 1 : dépendances et modules natifs ---------------------------------
FROM node:${NODE_VERSION} AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Couche de dépendances isolée : réutilisée tant que le verrou ne change pas.
COPY package.json package-lock.json ./

# npm ci respecte le verrou ; sqlite3 est compilé ici, une fois pour toutes.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# --- Étage 2 : image d'exécution ---------------------------------------------
FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/sde.db \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Les modules arrivent déjà compilés depuis l'étage de build.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/s3-db-sync.js ./scripts/s3-db-sync.js
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R node:node /app/data

# Aucun privilège root à l'exécution (l'utilisateur « node » existe dans l'image).
USER node

EXPOSE 3000

# Sonde locale sans dépendance externe (pas de curl dans l'image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# La migration du schéma est appliquée au démarrage par src/index.js.
CMD ["node", "src/index.js"]
