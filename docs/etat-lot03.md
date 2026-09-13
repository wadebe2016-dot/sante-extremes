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

1. **Backend** : six rôles par code (ajout d'`intendant` et `competitions`), codes à **six chiffres** protégés par un plafond de 5 échecs par IP sur 15 minutes (429 ensuite, chaque échec journalisé) ; **demandes de dépense et décaissements** — personne ne décaisse sans demande approuvée, invariant tenu par le code et par une contrainte `UNIQUE` ; reçu de déclaration désormais facultatif en espèces, obligatoire en Mobile Money.
2. **Trésorerie** : `solde réel = cotisations validées + pénalités encaissées − décaissements`, plus un bloc « engagé » et la répartition des dépenses par catégorie. Exports enrichis d'une feuille et d'une page « Dépenses AAAA » et d'une ligne de solde.
3. **Flutter** : écran Trésorerie à trois sections (demandes, dépenses, répartition), bouton « Exprimer un besoin », approbation, refus et décaissement par le trésorier, badge des demandes en attente sur le portefeuille. Champ de code en clavier numérique à six chiffres. État et Historique inchangés — cotisations uniquement.
4. **Sur l'instance** : `cd ~/sante-extremes/backend && git pull && npm install && npm run migrate && sudo systemctl restart sde-api`
5. **Écrire dans le `.env` de l'instance** les six variables, chacune avec un code à six chiffres choisi par vos soins et **jamais écrit dans le dépôt** : `ADMIN_PASSWORD`, `TRESORIER_PASSWORD`, `SECRETAIRE_PASSWORD`, `CENSEUR_PASSWORD`, `INTENDANT_PASSWORD`, `COMPETITIONS_PASSWORD`. Un rôle dont la variable est absente n'est jamais accordé.
6. **Tester** : `/api/auth/verify` avec chacun des six codes → le rôle attendu ; six codes erronés d'affilée → 429 au sixième ; création d'une demande par le trésorier → 401, par le secrétaire → 201 ; décaisser une demande non approuvée → 409 ; après décaissement, `/api/tresorerie.solde_reel` baisse du montant et `/api/historique` ne bouge pas ; déclarer en espèces sans reçu → 201, en Mobile Money sans reçu → 400.
7. **Bloquant S3 inchangé** : sans rôle IAM sur l'instance, justificatifs, règlement, fiches santé, déclarations **et pièces de dépense** échouent en 500. Politique minimale et commandes exactes ci-dessus.
8. **Changer les six codes** avant l'assemblée, et ne jamais les transmettre par un canal qui les conserve.
