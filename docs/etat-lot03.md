# État du LOT 3 — Rôles, sanctions, historique annuel, ergonomie, export, documents

Deux dépôts modifiés :

| Dépôt | Branche | Contenu |
| --- | --- | --- |
| `sante-extremes` (backend Express) | `master` | Rôles, sanctions, historique, exports, documents S3 |
| `sante-extremes-flutter` (application) | `main` | Cinq onglets, charte premium, codes de rôle |

---

## A. Rôles et codes

Quatre codes partagés, aucun compte nominatif. Le code **admin ouvre toutes les routes** ; un rôle
dont la variable d'environnement est vide n'est **jamais** accordé — un code vide n'ouvre rien.

| Variable | Rôle | Droits |
| --- | --- | --- |
| `ADMIN_PASSWORD` | admin | Tout |
| `TRESORIER_PASSWORD` | trésorier | Cotisations, encaissement des pénalités |
| `SECRETAIRE_PASSWORD` | secrétaire | Membres, règlement intérieur, fiches santé |
| `CENSEUR_PASSWORD` | censeur | Infliger, lever, annuler les sanctions |

**`src/middleware/auth.js`** — réécrit autour de `exigerRole(...roles)` :

- comparaison à temps constant (`crypto.timingSafeEqual`), longueur vérifiée avant comparaison ;
- `rolesDuCode(code)` renvoie **tous** les rôles auxquels un code correspond — deux fonctions peuvent
  partager un code sans que l'une masque l'autre ;
- le message d'erreur ne distingue jamais « code inconnu » de « droits insuffisants » : la nuance
  renseignerait un attaquant sur la validité du code ;
- `verifierAdmin` est conservé comme alias de `exigerRole('admin')` — le LOT 1 ne casse pas.

**`POST /api/auth/verify`** valide un code sans effet de bord et renvoie ses rôles, pour que
l'application sache quels onglets déverrouiller. La route est plafonnée à 20 tentatives par source et
par tranche de 5 minutes (compteur en mémoire) : c'est la seule route qui permette d'éprouver un code
sans conséquence, elle était la cible naturelle d'une attaque par essais successifs.

### Protection effective des routes

| Route | Rôle |
| --- | --- |
| `POST /api/cotisations`, `POST /api/penalites/:id/regler` | trésorier |
| `GET`/`POST` `/api/admin/members`, `DELETE /api/admin/members/:id` | secrétaire |
| `POST`/`GET`/`DELETE` `/api/documents/fiche-sante/:id`, `POST /api/documents/reglement` | secrétaire |
| `POST /api/sanctions`, `POST /api/sanctions/:id/lever`, `DELETE /api/sanctions/:id` | censeur |
| `/api/stats`, `/api/historique`, `GET /api/sanctions`, `/api/export/*`, `GET /api/documents/reglement`, `/api/health` | public |

### Rattrapage sur un mois antérieur

`POST /api/cotisations` accepte `mois` au format `AAAA-MM`. La cotisation est alors datée du **5 du
mois à 12:00Z** : une date en milieu de journée et de première semaine reste dans le bon mois quel
que soit le fuseau de lecture, là où le 1ᵉʳ à minuit basculerait sur le mois précédent à l'ouest de
Greenwich. Un mois futur est refusé (400).

---

## B. Sanctions et pénalités

Migration **strictement additive** (`src/models/schema.sql`, tout en `IF NOT EXISTS`) : table
`sanctions` et table `documents`. Aucune table supprimée, aucune colonne retirée, aucune donnée
existante touchée. Le fichier est rejoué à chaque démarrage sans effet de bord.

```
sanctions(id, member_id → members ON DELETE CASCADE, type 'penalite'|'suspension',
          motif, montant, date_fin, statut 'due'|'reglee'|'levee'|'annulee',
          date_sanction, date_reglement, moyen_reglement, fichier_s3_url)
```

Motifs : liste fermée `retard, absence, comportement, tenue, autre`. Pour `autre`, le texte libre est
stocké tel quel dans `motif` ; pour les autres, le libellé canonique (`Retard`, `Absence`…).

**Règle métier tenue de bout en bout : une pénalité n'est pas une cotisation.** Table distincte,
route distincte, et rien de ce qui est encaissé en pénalité n'entre dans `/api/historique`, dans le
total encaissé de `/api/stats`, ni dans le statut payé/impayé du mois. C'est vérifié par un test
(§ Vérifications, cas 10).

Cycle de vie : `due → reglee` (le trésorier encaisse), `due → levee` (suspension levée avant terme),
`due → annulee` (**suppression douce** : la ligne disparaît des listes mais reste en base — une
sanction effacée sans trace serait impossible à justifier en assemblée). Une pénalité déjà réglée ne
peut plus être annulée (409).

Une suspension n'est active que si elle n'est ni levée ni annulée **et** que son terme n'est pas
dépassé : c'est la date qui fait foi, pas le statut. Une suspension échue reste donc en base au
statut `due` sans plus peser sur le membre.

`GET /api/stats` porte désormais, par membre : `penalite_due`, `suspendu`, `date_fin_suspension`,
plus `dernier_montant` et `dernier_moyen` pour la sous-ligne de l'écran État.

---

## C. Historique annuel

`GET /api/historique?annee=2026` (public) renvoie le tableau croisé membres × mois, les totaux
mensuels, le total annuel, le nombre de paiements et de membres. Le mois retenu est celui de
`date_paiement` : un rattrapage saisi en septembre au titre de mars apparaît en mars.

La construction est extraite dans `construireHistorique(annee)` et **réutilisée telle quelle par les
deux exports** : le fichier téléchargé ne peut pas diverger de l'écran.

Une cotisation dont le membre a été supprimé depuis compte dans les totaux sans ligne nominative —
le total annuel reste juste même après un retrait de membre.

---

## D. Ergonomie premium (Flutter)

- **Charte centralisée** dans `lib/theme/palette.dart` : charbon `#1C1B1A`, rouge logo `#D8262E`,
  crème `#F7F5F2`, bordure `#E6E3DD`, texte `#2C2C2A`, secondaire `#888780`, succès `#1D9E75`.
  Aucun littéral de couleur dans les écrans, aucun dégradé, aucune ombre portée.
- **Manrope** via `google_fonts` (titres et chiffres en 600, texte en 400).
- **Une seule barre par écran** : l'AppBar globale de `main.dart` et celles des écrans sont
  supprimées ; chaque écran dessine son bandeau sombre (`widgets/communs.dart ▸ Bandeau`). Deux
  barres superposées mangeaient un quart de la hauteur utile sur un téléphone de 360 px.
- **Cinq onglets** : État, Paiement, Historique, Sanctions, Membres — `IndexedStack`, donc revenir
  sur un onglet ne relance pas son chargement et ne perd pas la saisie en cours.
- **Un seul écran de saisie de code** (`widgets/saisie_code.dart`), appelé soit en plein onglet
  (Paiement, Membres), soit par-dessus pour une action ponctuelle (`demanderCode`, utilisé par
  Sanctions). Cadenas ouvert vert dans le bandeau quand un code est actif ; appui long = déconnexion.
- Sur **401 pendant une action** : le code est effacé et redemandé — c'est le signe qu'il a changé
  côté serveur.
- `utils/formats.dart` : casse normale des noms (`ADAMA BEGAM` → `Adama Begam`, particules et noms
  composés gérés), abrégé `A. Begam` pour la colonne figée, montants sans décimale à séparateur
  d'espace. **La base n'est pas modifiée** : seul l'affichage est corrigé.
- Historique : colonne des noms figée, douze colonnes mensuelles défilant horizontalement, ligne
  TOTAL sur fond charbon, cellule vide = `·` gris clair.

---

## E. Exports Excel et PDF

- `GET /api/export/historique.xlsx?annee=` — feuille « Cotisations AAAA » (Nom, janv…déc, Total,
  ligne TOTAL, format `# ##0`, en-tête gras sur fond gris, colonnes ajustées, volets figés) et
  feuille « Pénalités AAAA » (Membre, Date, Type, Motif, Montant, Statut, Date règlement).
- `GET /api/export/historique.pdf?annee=` — A4 paysage, logo, titre, date de génération, tableau
  paginé avec répétition de l'en-tête, ligne TOTAL sur fond charbon, page « Pénalités et
  suspensions », pied de page numéroté.
- Les deux en `Content-Disposition: attachment`. Dépendances ajoutées : `exceljs`, `pdfkit`,
  `@aws-sdk/s3-request-presigner`. Logo : `backend/assets/logo.png` (copié depuis l'application).

Côté application : bouton « Exporter » dans Historique → feuille Excel / PDF → `url_launcher` confie
l'URL au navigateur, qui enregistre le fichier. `<queries>` ajouté à `AndroidManifest.xml` : sans
ces déclarations, Android 11+ masque les navigateurs à l'application et l'ouverture échoue en silence.

---

## G. Règlement intérieur et fiches santé

Stockage dans le bucket privé `AWS_BUCKET`, préfixes `documents/reglement/` et
`documents/fiches-sante/membre-<id>/`. **Aucune URL publique** : le backend renvoie une URL
pré-signée de 10 minutes (`@aws-sdk/s3-request-presigner`). PDF, JPEG, PNG ; 10 Mo maximum.

- **Règlement intérieur** : `POST` (secrétaire) publie une nouvelle version, les précédentes sont
  marquées `courant = 0` et **conservées** en base comme sur S3 ; `GET` est public.
- **Fiches santé** : `POST`/`GET`/`DELETE` réservés au secrétariat. Ce sont des données de santé —
  elles n'apparaissent ni dans `/api/stats` ni dans aucun export. Chaque consultation est journalisée
  (rôle, membre, date), y compris les tentatives sur une fiche absente ; **l'URL signée n'est jamais
  journalisée**, elle vaut droit de lecture. La suppression retire la ligne et l'objet S3 : sur une
  donnée de santé, la conservation par défaut ne se justifie pas.

---

## Vérifications effectuées

`node --check` sur les 12 fichiers backend modifiés ou créés : **OK**.
`flutter analyze` : **0 erreur, 0 avertissement** (61 avis de style, dont 60
`prefer_expression_function_bodies` sur les méthodes `build`).
`flutter test` : **14 tests passent** (formats, casse des noms, pastilles).

Tests curl exécutés sur un serveur local (`PORT=3999`, base neuve, quatre codes de test) :

| # | Cas | Attendu | Obtenu |
| --- | --- | --- | --- |
| 1 | `POST /api/cotisations` sans code | 401 | ✅ 401 |
| 2 | `GET /api/admin/members` sans code | 401 | ✅ 401 |
| 3 | `POST /api/cotisations` mauvais code | 401 | ✅ 401 |
| 4 | `POST /api/auth/verify` mauvais code | 401 | ✅ 401 |
| 5 | `GET /api/admin/members` avec code **trésorier** | 401 | ✅ 401 |
| 6 | `POST /api/auth/verify` avec les 4 bons codes | 200 + rôles | ✅ `["admin"]`, `["tresorier"]`, `["secretaire"]`, `["censeur"]` |
| 7 | `POST /api/admin/members` code secrétaire | 201 | ✅ 201 · `GET` → 200 |
| 8 | `POST /api/cotisations` code trésorier | 201 | ✅ 201 |
| 9 | `POST /api/cotisations` `mois=2099-01` | 400 | ✅ 400 |
| 10 | `POST /api/sanctions` code censeur | 201 | ✅ 201 · code trésorier → 401 |
| 11 | Code **admin** sur toutes les routes | OK | ✅ 200 / 201 |
| 12 | `GET /api/historique` | 200 | ✅ 200 |
| 13 | **Total historique inchangé après règlement d'une pénalité** | invariant | ✅ 27 500 → 27 500 |
| 14 | `GET /api/export/historique.xlsx` | 200 + type | ✅ 200 · `…spreadsheetml.sheet` · en-tête `PK` |
| 15 | `GET /api/export/historique.pdf` | 200 + type | ✅ 200 · `application/pdf` · en-tête `%PDF` |
| 16 | `GET /api/documents/fiche-sante/1` sans code | 401 | ✅ 401 |
| 17 | `GET /api/documents/fiche-sante/1` code trésorier | 401 | ✅ 401 |
| 18 | `GET /api/documents/fiche-sante/1` code secrétaire | 200 ou 404 | ✅ 404 (aucune fiche) |
| 19 | `GET /api/documents/reglement` sans code | 200 ou 404 | ✅ 404 (aucun règlement) |

**Non vérifié faute d'accès S3 sur ce poste** : dépôt réel d'un justificatif, d'un règlement ou d'une
fiche santé, et émission d'une URL pré-signée. Ces chemins échoueront en 500 tant que l'instance
n'aura pas d'accès S3 (voir ci-dessous).

---

## H. Déclaration de paiement par le membre

Ajouté après la première livraison. Le membre déclare lui-même son versement, reçu à l'appui ; le
trésorier tranche.

### Modèle

Migration **additive** de `cotisations` : `statut` (`validee` | `en_attente` | `refusee`, défaut
`validee`), `motif_refus`, `date_validation`, `cle_s3`, plus un index `(member_id, statut)`.

> **L'ordre de la migration compte.** Les colonnes sont ajoutées **avant** l'application de
> `schema.sql`, qui crée un index sur `statut`. Dans l'autre sens, sur une base antérieure, le script
> entier échoue — y compris les instructions censées créer cette colonne. Le premier essai est tombé
> exactement là. Vérifié ensuite sur une base reconstituée au format LOT 1 : quatre colonnes
> ajoutées, lignes existantes préservées et passées à `validee`.

### Routes

| Méthode | Route | Rôle |
| --- | --- | --- |
| `POST` | `/api/cotisations/declarer` | **public** — reçu obligatoire, 10 par IP et par heure, 409 si le mois est déjà réglé ou déjà déclaré |
| `GET` | `/api/cotisations/en-attente` | trésorier — file de validation, URL pré-signée du reçu |
| `GET` | `/api/cotisations/:id/justificatif` | trésorier |
| `POST` | `/api/cotisations/:id/valider` | trésorier |
| `POST` | `/api/cotisations/:id/refuser` | trésorier — motif obligatoire |

**Règle tenue de bout en bout** : une déclaration en attente ne compte **nulle part** — ni dans le
total encaissé, ni dans le statut du mois, ni dans `/api/historique`, ni dans les exports. Toutes les
requêtes concernées filtrent `statut = 'validee'`.

`/api/stats` expose désormais, par membre, `statut_mois` (`paye` | `en_attente` | `impaye`) et
`motif_refus` — ce dernier seulement si le membre est impayé, un membre à jour n'ayant pas à être
notifié d'un refus sans objet.

### Application

Bouton rouge « Déclarer mon paiement » sur l'écran État, ouvert à tous sans code. Trois états par
membre : coche verte, pastille orange `#EF9F27`, point rouge ; motif en rouge en cas de refus.
Écran Paiement à deux onglets internes, « Saisir » et « À valider (N) », avec badge sur la barre du
bas. **Le reçu n'est visible que dans « À valider »** : ailleurs, seul le statut est publié.

---

## I. Trésorerie visible de tous

`GET /api/tresorerie?annee=` — **publique**, accessible depuis l'icône portefeuille du bandeau de
l'écran État.

### Définition retenue

> **Solde réel = cotisations validées + pénalités encaissées.**

C'est le seul endroit de l'application où les deux comptabilités sont **réunies**. Partout ailleurs —
État, Historique, exports — les pénalités restent tenues à part des cotisations, et c'est voulu : on
y suit le respect des cotisations, pas la caisse. Ici on regarde la caisse, et elle contient bien les
deux. L'écran affiche donc la composition ligne à ligne, pour que les deux lectures ne se confondent
jamais.

Sont annoncées **à part**, comme attendues et non encaissées : les pénalités dues et les déclarations
en attente de validation.

La réponse porte le solde, sa composition, le détail de l'exercice demandé, la répartition mensuelle
et les vingt derniers mouvements — cotisations et pénalités confondues, en ordre chronologique, parce
qu'un relevé de caisse se lit d'une seule traite.

### Vérification

| Cas | Attendu | Obtenu |
| --- | --- | --- |
| `GET /api/tresorerie` sans code | 200 | ✅ 200 |
| Solde = 17 500 cotisations + 5 000 pénalité réglée | 22 500 | ✅ 22 500 |
| Pénalité due non comptée en caisse | dans `attendu` | ✅ 3 000 |
| `/api/stats` et `/api/historique` inchangés | 17 500 | ✅ 17 500 — les deux comptabilités restent séparées ailleurs |
| `POST /api/cotisations/declarer` sans fichier | 400 | ✅ « Le reçu de paiement est obligatoire » |
| Déclaration en doublon sur un mois réglé | 409 | ✅ |
| `valider` / `en-attente` / `justificatif` sans code | 401 | ✅ |
| `refuser` sans motif | 400 | ✅ |
| Après validation d'une déclaration | totaux à jour | ✅ 10 000 → 17 500, membre `en_attente` → `paye` |
| Motif de refus remonté sur un membre impayé | visible | ✅ |

**Dépendance à surveiller** : la déclaration repose entièrement sur le dépôt du reçu. Sans accès S3
sur l'instance, **elle échouera en 500** — c'est la fonction la plus exposée au point de blocage
ci-dessous.

---

## LOT 3 bis — Dépenses, nouveaux rôles, codes courts, reçu facultatif

### A. Deux rôles de plus, et des codes à six chiffres

`intendant` (`INTENDANT_PASSWORD`) et `competitions` (`COMPETITIONS_PASSWORD`) rejoignent les quatre
rôles existants. Libellés dans l'application : Admin, Trésorier, Secrétaire, Censeur, Intendant,
Compétitions.

Les codes passent à **six chiffres**. C'est un million de combinaisons — quelques heures pour un
script sans frein. Le plafond d'essais n'est donc plus un confort, c'est **la condition qui rend ces
codes courts acceptables** : cinq échecs par IP sur quinze minutes, puis 429 avec `Retry-After`.

Deux points qui comptent :

- le plafond s'applique à `/api/auth/verify` **et à toutes les routes protégées**, via un compteur
  partagé (`src/middleware/limiteur.js`). Cantonné à la vérification, il aurait suffi de changer de
  route pour repartir de zéro ;
- chaque échec est journalisé — rôle visé, IP, horodatage, rang de l'échec. **Le code essayé n'y
  figure jamais** : un journal n'est pas un endroit où écrire des secrets, et un utilisateur
  légitime se trompe régulièrement d'une touche.

Un succès remet le compteur à zéro : celui qui se trompe deux fois n'est jamais pénalisé.

Côté application, le champ de code passe en clavier numérique, six chiffres, sans autocorrection ni
suggestion.

### B. Reçu facultatif en espèces

`POST /api/cotisations/declarer` n'exige le fichier que si `moyen = Mobile Money`. Un transfert
laisse toujours une trace consultable ; une remise de billets de la main à la main n'en laisse
aucune. Exiger une pièce impossible à fournir aurait fermé la déclaration aux paiements en espèces —
c'est-à-dire à une bonne part des versements. Le formulaire affiche « obligatoire » ou « facultatif »
selon le moyen sélectionné.

### C. Demandes de dépense et décaissements

**Principe : personne ne décaisse sans demande approuvée.** Les intendants, le secrétariat et les
gestionnaires de compétitions expriment le besoin ; le trésorier approuve, refuse, puis décaisse.

Deux tables additives : `demandes` et `decaissements`. Sept catégories fermées — une liste libre
rendrait toute statistique illisible.

> **L'invariant est tenu deux fois.** Le code refuse de décaisser une demande qui n'est pas
> `approuvee` (409), et le schéma porte une contrainte `UNIQUE` sur `decaissements.demande_id`. Le
> contrôle applicatif seul laisserait passer deux requêtes simultanées sur la même demande.

**Le trésorier ne peut pas exprimer de besoin** (401) : celui qui décide du décaissement ne doit pas
être celui qui le demande. Seul l'admin cumule.

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/api/demandes?statut=&annee=` | **public** |
| `POST` | `/api/demandes` | intendant, secrétaire, compétitions |
| `POST` | `/api/demandes/:id/approuver` | trésorier |
| `POST` | `/api/demandes/:id/refuser` | trésorier — motif obligatoire |
| `DELETE` | `/api/demandes/:id` | le rôle demandeur, tant que « en_attente » |
| `POST` | `/api/demandes/:id/decaisser` | trésorier — 409 hors « approuvee » |
| `GET` | `/api/decaissements?annee=` | **public** |
| `GET` | `/api/decaissements/:id/justificatif` | trésorier, intendant, secrétaire, compétitions |

La liste des dépenses est **publique** : les membres financent l'association, ils doivent pouvoir
constater ce qui en sort. Le justificatif, lui, reste réservé aux rôles concernés et n'est servi que
par URL pré-signée.

### Trésorerie, complétée

    solde réel = cotisations validées + pénalités encaissées − décaissements

S'y ajoutent un bloc **engagé** — demandes approuvées non encore payées, l'argent est promis sans
être sorti — la répartition des dépenses par catégorie, et des mouvements chronologiques où les
décaissements figurent **en négatif** : un relevé de caisse mêle entrées et sorties, c'est son
intérêt.

Les exports gagnent une feuille et une page « Dépenses AAAA » (date, catégorie, libellé, montant,
bénéficiaire, payé par) et une **ligne de solde** en fin de document, avec sa décomposition — le
document doit porter le même chiffre que l'écran, sans quoi l'assemblée aurait deux vérités à
concilier.

### Vérifications

| Cas | Attendu | Obtenu |
| --- | --- | --- |
| Les six codes sur `/api/auth/verify` | rôle correspondant | ✅ dont `intendant` et `competitions` |
| Trésorier crée une demande | 401 | ✅ 401 |
| Secrétaire, intendant, compétitions créent | 201 | ✅ 201 chacun |
| Décaisser une demande « en_attente » | 409 | ✅ « Seule une demande approuvée peut être décaissée » |
| Décaisser deux fois la même demande | 409 | ✅ |
| Après décaissement de 8 000 | solde −8 000 | ✅ 100 000 → 92 000 |
| `/api/historique` après décaissement | inchangé | ✅ 100 000 — les cotisations ne bougent pas |
| Déclarer Espèce **sans** fichier | 201 | ✅ 201 |
| Déclarer Mobile Money **sans** fichier | 400 | ✅ « Le reçu est obligatoire pour un paiement Mobile Money » |
| 6 mauvais codes en 15 min | 429 au 6ᵉ | ✅ 401 ×5 puis 429 — et 429 aussi sur les routes protégées |
| Export `.xlsx` | 3 feuilles + solde | ✅ « Cotisations 2026 \| Pénalités 2026 \| Dépenses 2026 », ligne `SOLDE DE CAISSE … 92000` |
| Export `.pdf` | page Dépenses + solde | ✅ 200 `application/pdf` |

`node --check` sur les 10 fichiers backend modifiés ou créés : **OK**.
`flutter analyze` : **0 erreur, 0 avertissement**. `flutter test` : **14 tests**. APK release arm64
construit en local.

---

## LOT 3 ter — Separation des pouvoirs, solde d'ouverture, depenses, journal

### 1. Trésoriers nominatifs

`TRESORIERS` remplace `TRESORIER_PASSWORD` : une liste « Nom du membre:code ». Les noms doivent
correspondre **exactement** à ceux de la table `members`.

Nommer les trésoriers n'est pas un confort d'affichage, c'est ce qui rend trois refus possibles.
Un contrôle anonyme ne pourrait rien empêcher de tel :

| Situation | Réponse |
| --- | --- |
| Un trésorier valide, refuse ou saisit **sa propre** cotisation | **403** |
| Un trésorier se désigne **bénéficiaire** d'un décaissement | **403** |
| Une sanction vise un membre de `CENSEUR_MEMBRES`, sans code admin | **403** |

`TRESORIER_PASSWORD` reste accepté en repli, mais sans nom aucune de ces protections ne s'applique.

**Traçabilité** : `valide_par`, `encaisse_par`, `approuve_par`, `decaisse_par`, exposées par l'API,
dans les exports et dans le journal.

Côté application : le bandeau Paiement affiche « Trésorier · Junior », et dans « À valider » la carte
de sa propre cotisation porte « À faire valider par l'autre trésorier », sans bouton — le serveur
refuserait en 403, autant le dire avant le geste.

### 2. Solde d'ouverture

Table `parametres`, `PUT /api/tresorerie/solde-ouverture`. Le solde ne compte alors que
les mouvements **à partir de cette date** :

    solde réel = ouverture + cotisations et pénalités depuis la date − décaissements depuis la date

Sans solde défini, tout l'historique est additionné : le comportement d'avant est conservé tel quel.
L'écran Trésorerie affiche la ligne et son bouton « Définir », avec confirmation — ce montant déplace
le solde vu par toute l'association.

> La route était **réservée à l'admin** au LOT 3 ter ; elle est ouverte aux **trésoriers** depuis, avec
> enregistrement de l'auteur. Voir « Évolution — le solde d'ouverture passe aux trésoriers » en fin de
> document.

### 3. Onglet Dépenses et navigation

Cinq onglets : **État · Paiement · Dépenses · Historique · Plus**. Sanctions, Membres, Trésorerie,
Journal et Règlement sont regroupés dans « Plus » plutôt que tassés dans une barre qui ne tient pas
sur 360 px. Tout y est consultable sans code.

Deux catégories de plus : `eau_collation` et `entretien`.

> **Point de vigilance.** Cela a imposé de **reconstruire la table `demandes`** : SQLite ne sait pas
> modifier une contrainte `CHECK`. Seule opération non strictement additive du projet — donc
> conditionnée à la présence de la contrainte, transactionnelle, avec recopie colonne par colonne et
> clés étrangères désactivées le temps de l'échange. Vérifiée sur une base au format LOT 3 bis :
> demandes et décaissements préservés. La liste fermée est désormais tenue par la route, qui refuse
> en 400 — même garantie, sans migration à chaque ajout futur.

### 4. Exports et documents sans URL visible

L'application télécharge le fichier elle-même (`http` + `path_provider`), l'écrit sous
`Cotisations_AAAA.pdf` / `.xlsx`, puis l'ouvre (`open_filex`), avec le partage en secours
(`share_plus`). Plus aucune ouverture du navigateur — ni pour les exports, ni pour le règlement, ni
pour les justificatifs et fiches santé.

Confier une URL au navigateur posait trois problèmes : l'adresse de l'API s'affichait en clair, les
URL pré-signées restaient dans son historique, et le fichier atterrissait dans un dossier que
l'utilisateur ne retrouvait pas.

### 5. Journal d'activité

`GET /api/journal?annee=&limite=` (**public**) reconstitue un seul fil chronologique à partir des
cotisations tranchées, sanctions, demandes, décaissements, publication du règlement et solde
d'ouverture — avec l'acteur de chaque décision.

Ce que le journal ne contient **jamais** : fiches santé, clés S3, URL de justificatif. Le fil est
public, les pièces ne le sont pas. L'application l'expose depuis « Plus », avec une icône par type,
un filtre et une pagination.

### Vérifications

| Cas | Attendu | Obtenu |
| --- | --- | --- |
| `verify` avec le code d'un trésorier | rôle + nom | OK `{"roles":["tresorier"],"membre":"Junior JIDJOU"}` |
| Junior saisit **sa** cotisation | 403 | OK |
| Merveille, puis admin, saisissent celle de Junior | 201 | OK / OK |
| Traçabilité dans le journal | nom visible | OK « Junior JIDJOU par Merveille BADJECK » |
| Censeur sanctionne un membre protégé | 403 | OK · admin **201** |
| Solde d'ouverture sans code, puis code trésorier | 401 | OK / OK — *règle changée depuis, voir la fin du document* |
| Solde d'ouverture 100 000 au 13/09 (admin) | 200 | OK — 15 000 puis **110 000** |
| Cotisation d'août, antérieure à l'ouverture | exclue | OK |
| `eau_collation`, `entretien` · catégorie inventée | 201 · 400 | OK |
| Reconstruction de `demandes` sur base LOT 3 bis | lignes préservées | OK — demandes et décaissements intacts |
| `Content-Disposition` des exports | `Cotisations_2026` | OK `.pdf` et `.xlsx` |
| Ligne « Solde d'ouverture au 13/09/2026 » | présente | OK — 100 000 |
| Journal : fiches santé, clés S3 | aucune | OK |

`node --check` sur les 13 fichiers backend : **OK**. `flutter analyze` : **0 erreur, 0 avertissement**.
`flutter test` : **14 tests**. APK release arm64 construit en local.

---

## Correction — « téléchargement refusé » (HTTP 403) sur un reçu de paiement

Signalé depuis l'écran « Reçu de paiement » du trésorier. Ce n'était pas un problème de droits : les
URL pré-signées vivent dix minutes (`S3_URL_DUREE_SECONDES`), or la file « À valider » les fabriquait
**au chargement de la liste**. Le trésorier qui parcourt ses déclarations puis ouvre un reçu quelques
minutes plus tard présentait à S3 un lien déjà périmé, et S3 répond 403.

Trois corrections, côté application seulement — le backend et la durée de dix minutes sont inchangés :

1. **URL fabriquée à l'ouverture.** Le plein écran demande la sienne via `GET /api/cotisations/:id/justificatif`
   (route trésorier, déjà en place) au lieu de réutiliser celle de la liste. Écran de chargement,
   message d'erreur et bouton « Réessayer » si l'appel échoue. La vignette, elle, garde le lien de la
   liste : elle s'affiche dans la seconde qui suit.
2. **Message honnête.** L'ancien écran affirmait « Ce reçu est un document PDF » dès que l'image ne se
   chargeait pas — conclusion fausse quand le lien avait simplement expiré. La vignette dit maintenant
   « Toucher pour ouvrir », et le plein écran, qui vient d'obtenir une URL fraîche, peut légitimement
   conclure « Ce reçu n'est pas une image ». Un 403 au téléchargement s'annonce comme un lien expiré.
3. **Extension déduite du `Content-Type`.** Sous Android, c'est l'extension qui désigne le lecteur : un
   reçu enregistré sans elle finissait systématiquement dans le partage. `telechargerEtOuvrir` la
   complète à partir de l'en-tête de la réponse quand le nom n'en porte pas.

| Cas | Attendu | Obtenu |
| --- | --- | --- |
| `flutter analyze` | 0 erreur, 0 avertissement | OK — seuls des `info` de style préexistants |
| Autres téléchargements (règlement, fiche santé, exports) | URL déjà demandée juste avant | OK — inchangés |

---

## Point de blocage à traiter : l'instance EC2 n'a pas d'accès S3

Ni clés dans `.env`, ni rôle IAM attaché. En l'état, **les justificatifs de paiement, le règlement
intérieur et les fiches santé échoueront en 500**. Le reste de l'API fonctionne normalement.

Correctif recommandé — un **rôle IAM attaché à l'instance** (pas de clés dans `.env`, rien à faire
tourner, rien à révoquer) portant cette politique minimale :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjetsDuBucketSde",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<BUCKET>/*"
    },
    {
      "Sid": "ListerLeBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<BUCKET>"
    }
  ]
}
```

```bash
# Création du rôle, attachement de la politique, puis rattachement à l'instance
aws iam create-role --role-name sde-ec2-s3 \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam put-role-policy --role-name sde-ec2-s3 --policy-name sde-s3 --policy-document file://politique-s3.json
aws iam create-instance-profile --instance-profile-name sde-ec2-s3
aws iam add-role-to-instance-profile --instance-profile-name sde-ec2-s3 --role-name sde-ec2-s3
aws ec2 associate-iam-instance-profile --instance-id <ID> --iam-instance-profile Name=sde-ec2-s3 --region eu-west-3

# Puis, sur l'instance : renseigner AWS_BUCKET dans .env et redémarrer
sudo systemctl restart sde-api
```

Le SDK détecte seul le rôle : aucune clé ne doit être écrite dans `.env`.

---

## Résumé pour l'architecte

1. **Séparation des pouvoirs** : les trésoriers ont un code nominatif (`TRESORIERS`), ce qui interdit en 403 de traiter sa propre cotisation, de se désigner bénéficiaire d'un décaissement, et de sanctionner un membre de `CENSEUR_MEMBRES` sans le code admin. Chaque décision porte le nom de son auteur.
2. **Solde d'ouverture** (trésorier ou admin) : point de départ de la caisse, seuls les mouvements postérieurs s'y ajoutent. Sans lui, comportement inchangé. Le nom de qui l'a fixé est enregistré, affiché et journalisé.
3. **Navigation** : cinq onglets — État, Paiement, Dépenses, Historique, Plus. Journal d'activité public dans « Plus ». Exports et documents téléchargés puis ouverts dans l'application, plus par le navigateur.
4. **Sur l'instance** : `cd ~/sante-extremes/backend && git pull && npm install && npm run migrate && sudo systemctl restart sde-api`
5. **`.env` à modifier** : remplacer `TRESORIER_PASSWORD` par `TRESORIERS=Nom Prenom:code,Autre Nom:code` — noms **exactement** comme dans la table `members` — et ajouter `CENSEUR_MEMBRES=Nom Prenom`. Les autres variables sont inchangées ; aucune valeur n'est écrite dans le dépôt.
6. **Copier `/var/lib/sde/sde.db` avant `npm run migrate`** : cette migration reconstruit la table `demandes` pour lever une contrainte que SQLite ne sait pas modifier. L'opération est transactionnelle et vérifiée, mais c'est la seule du projet qui ne soit pas purement additive.
7. **Tester** : `/api/auth/verify` avec un code trésorier renvoie son nom ; ce trésorier sur sa propre cotisation → 403, l'autre → 200 ; sanction sur un membre protégé → 403 au censeur, 201 à l'admin ; `PUT /api/tresorerie/solde-ouverture` → 401 sans code, 200 avec un code trésorier ou admin ; `/api/journal` → 200, sans fiche santé ni clé S3 ; export → `Content-Disposition: Cotisations_2026.pdf`.
8. **Bloquant S3 inchangé** : sans rôle IAM sur l'instance, justificatifs, règlement, fiches santé, déclarations et pièces de dépense échouent en 500.
9. **Changer les codes** avant l'assemblée, et ne jamais les transmettre par un canal qui les conserve.
10. **403 sur un reçu corrigé côté application** : l'URL pré-signée est désormais demandée au moment d'ouvrir le justificatif, plus au chargement de la liste. Rien à déployer sur l'instance.
11. **Solde d'ouverture ouvert aux trésoriers**, avec le nom de l'auteur enregistré et journalisé. Une colonne ajoutée sur `parametres` : `npm run migrate` suffit, l'opération est purement additive.

---

## Évolution — le solde d'ouverture passe aux trésoriers

Fixer le solde d'ouverture est une reprise de caisse : un geste de trésorerie, pas une décision
administrative. L'exiger de l'administration plaçait l'opération la plus courante derrière la
personne la moins disponible — l'association attendait l'admin pour repartir d'un chiffre juste.

Le verrou est donc levé, mais pas le contrôle : il change de nature. Ce n'est plus « qui a le droit »
mais **« qui l'a fait »**.

### Backend

| Point | Avant | Après |
| --- | --- | --- |
| `PUT /api/tresorerie/solde-ouverture` | `exigerRole('admin')` | `exigerRole('tresorier')` — l'admin passe toujours |
| Auteur | non conservé | colonne `parametres.definit_par` |
| `GET /api/tresorerie` · `GET /api/stats` | `solde_ouverture` sans auteur | `solde_ouverture.definit_par` et `.date_maj` |
| `GET /api/journal` | événement attribué à « Administration » | attribué au **nom du trésorier** qui l'a fixé |

`definit_par` reçoit `requete.agent` : le nom du trésorier nominatif, ou `admin` quand
l'administration tranche elle-même. C'est la même mécanique que `valide_par`, `encaisse_par` et
`decaisse_par` — un solde d'ouverture déplace le solde vu par toute l'association, il ne doit jamais
être anonyme.

**Migration purement additive** : `definit_par` est déclarée dans `COLONNES_AJOUTEES` de `db.js` et
posée par `ALTER TABLE ADD COLUMN` sur une base existante. Un solde fixé avant ce changement reste
lisible, simplement sans auteur — le journal le range alors sous « Administration », qui est la seule
origine qu'il pouvait avoir, et l'application n'affiche aucun nom plutôt que d'en supposer un.

### Application

- Le bouton de l'écran Trésorerie demande le **code trésorier** (l'admin est accepté partout). Il
  reste visible pour tous : l'application ne connaît le rôle qu'une fois le code saisi, et masquer
  l'action ne ferait que la rendre introuvable au trésorier qui vient d'ouvrir l'application.
- Le libellé devient « **Redéfinir** » quand un solde existe déjà.
- Sous le montant : « **défini par Junior Mbarga le 18 septembre 2026** ».
- Un avertissement accompagne tout solde existant, sur la carte **et** en tête du formulaire :
  « Redéfinir le solde recalcule la caisse à partir de cette date. »
- Le formulaire **pré-remplit** montant, date et commentaire actuels — on corrige, on ne resaisit pas.
  La confirmation avant envoi est conservée.

### Vérifications

Serveur local, `TRESORIERS="Junior Mbarga:222222"`, `ADMIN_PASSWORD=111111`, `CENSEUR_PASSWORD=333333`.

| Cas | Attendu | Obtenu |
| --- | --- | --- |
| `PUT /solde-ouverture` **sans** code | 401 | OK — `{"error":"Code requis"}` |
| `PUT` avec le code **trésorier** | 200 | OK — `"definit_par":"Junior Mbarga"` |
| `PUT` avec le code **admin** | 200 | OK — `"definit_par":"admin"` |
| `PUT` avec un code **censeur** | 401 | OK — `{"error":"Code invalide ou droits insuffisants"}` |
| `GET /api/tresorerie` | `definit_par` exposé | OK — et `solde_reel` = 150 000 |
| `GET /api/stats` | `definit_par` exposé | OK — dans `summary.solde_ouverture` |
| Journal, après le `PUT` trésorier | acteur nommé | OK — « Solde d'ouverture défini · **Junior Mbarga** · 150 000 » |
| Journal, après le `PUT` admin | acteur admin | OK — « Administration » |
| Base **sans** `definit_par` (format d'avant) | colonne ajoutée, solde lisible | OK — `[migration] colonne ajoutée : parametres.definit_par`, `definit_par: null`, journal « Administration » |

`flutter analyze` : **0 erreur, 0 avertissement**. APK release arm64 construit en local.

### À faire sur l'instance

```bash
cd ~/sante-extremes/backend && git pull && npm run migrate && sudo systemctl restart sde-api
```

Aucune variable d'environnement à changer : les trésoriers utilisent le code qu'ils ont déjà.

---

## Date de versement — trois dates, trois usages

### Le défaut

Une cotisation portait deux dates, et la caisse se calculait sur la mauvaise.

`date_paiement` vaut **le 5 du mois concerné** : c'est la convention du champ `mois`, celle qui range
un règlement dans la bonne colonne du tableau annuel. Le solde de trésorerie comparait cette date à
celle du solde d'ouverture. Conséquence : une cotisation de septembre remise le 18 septembre, alors
qu'un solde d'ouverture venait d'être posé au 18, était datée du 5 — donc antérieure au point de
départ, donc **jamais entrée en caisse**. L'argent était là, le solde l'ignorait.

Se rabattre sur `date_validation` ne réglait que la moitié du problème : une déclaration tardive
portant sur un versement déjà encaissé *avant* l'ouverture aurait alors été comptée **deux fois**.
Il manquait la seule date qui compte pour une caisse : **celle où l'argent a été remis**.

### Les trois dates

| Colonne | Ce qu'elle dit | Ce qu'elle décide |
| --- | --- | --- |
| `date_paiement` | **mois dû** — le 5 du mois concerné | statut payé/impayé de `/api/stats`, `/api/historique`, tableaux des exports |
| `date_versement` | **entrée en caisse** — jour de la remise | trésorerie, et rien d'autre : `solde_reel` de `/api/tresorerie` et `/api/stats` |
| `date_validation` | **contrôle du trésorier** | traçabilité et `/api/journal` |

Le solde retient une cotisation validée si
`COALESCE(date_versement, date_validation, date_paiement) >= date d'ouverture`. Le repli en cascade
va du plus juste au plus ancien : une ligne écrite avant cette évolution retombe sur sa validation,
et une ligne d'avant le LOT 3 bis sur son mois dû — la seule date qu'elle ait jamais portée. Rien ne
disparaît du solde, jamais. Même principe pour les pénalités :
`COALESCE(date_reglement, date_sanction)`. Les décaissements étaient déjà justes, leur
`date_paiement` étant bien la date de sortie de caisse.

### Backend

| Point | Avant | Après |
| --- | --- | --- |
| Colonne | — | `cotisations.date_versement DATETIME NULL`, migration additive |
| Lignes existantes | — | remplies **une seule fois** avec `COALESCE(date_validation, date_paiement)`, au moment de l'`ALTER` |
| `POST /api/cotisations` · `/declarer` | deux dates | champ `date_versement` (`AAAA-MM-JJ`) **obligatoire** |
| Refus | — | absente ou vide → 400 « La date du versement est obligatoire » ; à venir → 400 ; > 12 mois → 400 ; jour inexistant → 400 |
| `calculerSoldeReel` | `date_paiement >= ouverture` | `COALESCE(date_versement, date_validation, date_paiement) >= ouverture` |
| `/api/cotisations/en-attente` · `/api/stats` · `/api/journal` | — | `date_versement` et `regularisation` exposés |
| `/api/journal` | « Cotisation validée » | « **Cotisation de mai versée le 18 sept** », ou « Cotisation de septembre » |
| Export Excel | 3 feuilles | 4 feuilles — **« Versements »** : membre, mois dû, date de remise, montant, moyen, régularisation, validé par |
| Export PDF | — | note sous le tableau : montants rangés sur le mois dû, la caisse compte les versements |
| `export.js` | second calcul de solde, divergent | appelle `calculerSoldeReel` — un seul chiffre pour l'assemblée |

**Aucune valeur par défaut côté serveur.** Le serveur ne devine pas une date de caisse : une saisie
de rattrapage faite un mois plus tard serait comptée au mauvais moment sans que personne ne s'en
aperçoive. La date est enregistrée à **midi UTC**, pour que la journée reste la même sous tous les
fuseaux.

`/api/historique`, le statut du mois de `/api/stats` et les **tableaux** des exports continuent de
lire `date_paiement` : le mois de cotisation ne change pas. Un arriéré de mars reste en mars.

### Application

- **« Déclarer mon paiement »** et onglet **« Saisir »** du trésorier : champ **Date du versement**,
  sélecteur de date, pré-rempli à aujourd'hui, borné aux **douze derniers mois** — la même fenêtre
  que le serveur. Aide : « Le jour où l'argent a été remis, pas le jour de la déclaration. »
- Le champ est **obligatoire** : bordure rouge et **bouton d'envoi fermé** tant qu'aucune date n'est
  retenue. Inutile de laisser partir une saisie complète vers un 400.
- **« À valider »** : sous le montant, « **versé le 12 sept** » ; si régularisation, la mention
  « **Régularisation — mois de mai** » en orange, pour qu'un mois réglé après coup ne soit pas refusé
  par réflexe comme un doublon.
- **Écran État**, sous-ligne d'un membre à jour : « **Septembre · versé le 12 sept · 10 000 · Espèce** ».
- **Écran Trésorerie**, aide du solde d'ouverture : « seuls les versements reçus à partir de cette
  date s'ajoutent au solde. C'est le jour où l'argent a été remis qui compte, pas le mois de
  cotisation réglé. »
- Rien d'autre ne bouge : navigation, charte et écrans existants inchangés.

### Vérifications

Backend : `npm test` — 20 tests, base SQLite temporaire, aucun accès réseau.

| Cas | Attendu | Obtenu |
| --- | --- | --- |
| Mois septembre, `date_versement` 2026-09-12, ouverture au 2026-09-18 | hors du solde | OK — solde = ouverture seule |
| La même, « payée » pour septembre dans `/api/stats` et `/api/historique` | mois dû inchangé | OK — `paid: true`, `statut_mois: paye`, montant en septembre |
| Même cotisation, `date_versement` 2026-09-18 | comptée | OK — solde = ouverture + 10 000 |
| `date_versement` absente sur une ligne ancienne | repli sur `date_validation` | OK — validée le 19 comptée, le 13 non |
| Ni versement ni validation (ligne d'avant le LOT 3 bis) | repli sur le mois dû | OK |
| `date_versement` dans le futur | 400 | OK — « ne peut pas être dans le futur », rien écrit en base |
| `date_versement` antérieure de 13 mois | 400 | OK — « pas antérieure de plus de 12 mois » |
| `date_versement` à exactement 12 mois | 201 | OK |
| `date_versement` absente ou vide | 400 | OK — « La date du versement est obligatoire » |
| `date_versement` = 2026-02-31 | 400 | OK — « jour inexistant » |
| Rattrapage (mois dû − 3 mois, versé ce jour) | `regularisation: true` | OK |
| `/api/historique` et exports | inchangés | OK — mêmes totaux, feuille « Versements » en plus |
| `/api/journal` sur une régularisation | libellé nommé | OK — « Cotisation de mai versée le 18 sept » |
| Migration sur une base d'avant | colonne ajoutée, lignes remplies | OK — 3 lignes initialisées, aucune colonne perdue |
| Migration rejouée | ne réécrit rien | OK — la valeur corrigée à la main survit |
| Pénalités | `date_reglement`, repli sur `date_sanction` | OK |

Application : `flutter analyze` → **0 erreur, 0 avertissement** (94 infos de style, inchangées).
`flutter test` → **18 tests verts**. APK release arm64 construit en local.

### Résumé pour l'architecte

1. Une cotisation porte désormais **trois dates** : mois dû (`date_paiement`), entrée en caisse
   (`date_versement`), contrôle du trésorier (`date_validation`).
2. Le solde de trésorerie se calcule sur la **date de versement**, avec repli en cascade sur les
   dates connues des lignes anciennes : aucun montant ne disparaît.
3. `date_versement` est **obligatoire** à la saisie et à la déclaration ; refusée si future ou
   vieille de plus de douze mois.
4. Le **mois de cotisation ne change pas** : historique, statut du mois et tableaux des exports
   restent sur `date_paiement`.
5. Migration **purement additive**, remplissage unique des lignes existantes.
6. Déploiement sur l'instance :
   `cd ~/sante-extremes/backend && git pull && npm install && npm run migrate && sudo systemctl restart sde-api`
7. **Aucune variable d'environnement à changer.**
8. Consigne aux membres : indiquer **le jour où l'argent a été remis** — pas celui de la déclaration —
   et le **mois réglé** séparément. La date de remise fait le solde de caisse, le mois réglé remplit
   la ligne du tableau annuel.
