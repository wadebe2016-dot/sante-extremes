# État LOT 1 — Santé des extrêmes

1. Backend Express (`backend/`) : SQLite embarquée (`members`, `cotisations`), migration idempotente depuis `schema.sql`, arrêt propre et journal HTTP.
2. Routes livrées : `POST`/`DELETE /api/admin/members` (Bearer `ADMIN_PASSWORD`), `POST /api/cotisations` (multipart + S3), `GET /api/stats` (public), `GET /api/health`.
3. `GET /api/stats` renvoie `summary` (total, payés, impayés, pourcentage, mois courant) et `members` (`paid`, `last_paiement`, `montant_total`).
4. Sécurité : jeton admin comparé en temps constant, aucun secret en dur, toute la configuration via `.env`, validation stricte de chaque champ.
5. Upload : multer 2.x en mémoire, images uniquement, 5 Mo max, dépôt S3 `eu-west-3` sous clé non devinable ; **justificatif facultatif**.
6. Règle métier : un membre est à jour s'il a cotisé pendant le mois calendaire en cours ; `montant_total` suit la même fenêtre.
7. Mobile Expo (`mobile/`, slug `sde-app`) : TabNavigator à 2 écrans, `axios` centralisé dans `api/client.js`, URL pilotée par `EXPO_PUBLIC_API_URL`.
8. Écrans : tableau public (`FlatList`, polling 30 s, `RefreshControl`, synthèse du mois) et enregistrement (`Picker` membres + moyen, photo caméra/galerie, Toast, reset).
9. Validation : 20 appels HTTP exécutés contre le backend local — tous conformes (201/400/401/404/409/413), cascade de suppression et logs vérifiés (§ VALIDATION du README).
10. Reste à faire hors LOT 1 : bucket S3 réel + politique IAM, `npm install` mobile et build APK (disque saturé sur le poste), écran d'administration des membres, tests automatisés.
