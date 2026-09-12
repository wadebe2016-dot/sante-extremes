# Image de production du backend — Santé des extrêmes
FROM node:20-bookworm-slim

# Outils de compilation nécessaires au module natif sqlite3
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Couche de dépendances mise en cache
COPY package.json ./
RUN npm install --omit=dev

# Code applicatif
COPY src ./src

# Volume de la base SQLite embarquée
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/sde.db

EXPOSE 3000

# La migration est appliquée automatiquement au démarrage par src/index.js
CMD ["node", "src/index.js"]
