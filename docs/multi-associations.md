# Multi-associations — DeuxZero (LOT 7)

L'application était celle d'une association. Elle devient un **produit** vendu à
des associations sportives camerounaises — les « 2-0 », groupes de collègues qui
jouent le week-end — publié sur Google Play.

La contrainte qui a façonné toute l'architecture n'est pas technique :
**l'éditeur n'entre jamais en contact avec ses clients.** Pas de formulaire de
contact, pas de validation manuelle, pas de support téléphonique. Une association
qui découvre l'application le samedi matin doit pouvoir travailler le samedi
suivant, et récupérer un code perdu six mois plus tard, sans que personne chez
Atlastech n'ait à intervenir.

---

## 1. Étanchéité : une base SQLite par association

```
data/
  annuaire.db                  ← liste des associations, et rien d'autre
  sde.db                       ← base historique, conservée intacte
  associations/
    SDE001.db                  ← Santé des extrêmes
    LIO427.db                  ← une base par association
```

**L'étanchéité ne repose pas sur un filtre SQL.** Un `WHERE association_id = ?`
oublié dans une requête sur cinquante suffirait à faire fuir les cotisations d'un
client chez un autre. Elle repose sur le **fichier** : une connexion SQLite est
ouverte sur un fichier, et une requête fautive — jointure de travers, `WHERE`
absent — ne peut pas lire des lignes qui n'y sont pas.

`annuaire.db` ne contient **aucune donnée métier** : ni membre, ni cotisation, ni
montant, ni code de rôle. S'il portait ne serait-ce qu'un total encaissé, une
requête de A pourrait lire un chiffre de B. Il n'y a rien à lire, donc rien à
fuir. Seule exception, délibérée : `sms_envoyes`, la facture SMS de l'éditeur, où
le destinataire n'apparaît que masqué.

### Résolution du locataire

Toute requête porte `X-Association: <CODE>`. Le middleware
`src/middleware/association.js` :

1. lit l'en-tête, refuse **400** s'il est absent ou mal formé ;
2. cherche le code dans l'annuaire, refuse **404** si inconnu, **403** si suspendu ;
3. ouvre la base (cache LRU, 50 connexions — `src/bd/locataires.js`) ;
4. pose `req.db` et `req.association`, charge les paramètres de l'association.

Il est monté **avant tous les routeurs métier** : aucun d'eux n'est atteignable
sans base résolue, et aucun ne détient plus de connexion globale. `src/db.js` n'en
expose plus : un `require('../db')` qui chercherait `executer` échoue au
démarrage, ce qui est voulu — une base globale oubliée quelque part serait une
fuite.

**Seules ces routes se passent de l'en-tête**, et c'est une liste fermée, pas un
motif :

| Route | Pourquoi |
|---|---|
| `GET /health` et `GET /api/health` | interrogent le service, pas une association |
| `POST /api/associations` | le code n'existe pas encore |
| `POST /api/associations/verifier-code` | le membre cherche justement quel il est |
| `POST /api/reinitialisation/{demander,confirmer,president}` | l'appelant n'a plus d'application configurée |

Le contre-seing (`/api/reinitialisation/president/confirmer`) **n'en fait pas
partie** : celui qui contresigne a toujours son code.

La sonde répond sur **les deux chemins**. Les scripts de `deploy/` sondent
`/api/health`, mais la supervision appelle `/health`, qui n'avait jamais existé
côté application : elle recevait 404 avant le LOT 7, puis un 400
« association requise ». Dispenser le chemin de l'en-tête ne suffisait pas — il
fallait aussi que la route réponde.

---

## 1 bis. `ASSOCIATION_PAR_DEFAUT` — dispositif transitoire

> **Ceci contredit en partie le paragraphe précédent, et c'est assumé.** Sur une
> instance où cette variable est renseignée, il existe une base « par défaut ».

### Pourquoi

Les applications installées chez les trente-neuf membres de « Santé des
extrêmes » ont été compilées avant le LOT 7 : elles n'envoient pas
`X-Association`. À la mise en production, elles ont reçu **400 sur toutes les
routes métier** — application hors service pour tout le monde. Trente-neuf
téléphones ne se mettent pas à jour en une soirée.

### Comportement

| Cas | Sans la variable | Avec la variable |
|---|---|---|
| en-tête **absent** | **400** `association_requise` | résolu vers `<CODE>`, **avertissement journalisé** |
| en-tête **présent mais mal formé** | **400** | **400** — inchangé |
| en-tête **valide** | résolu normalement | résolu normalement, la variable est ignorée |
| en-tête valide mais code inconnu | **404** | **404** — pas de bascule sur le repli |

La distinction absence / malformation porte tout le dispositif : une application
antérieure au LOT 7 n'envoie **rien**, tandis qu'un en-tête présent mais illisible
trahit un défaut d'application. Masquer le second le rendrait introuvable.

**L'étanchéité reste entière** : dès que l'en-tête est fourni, c'est lui qui
l'emporte. Le repli n'ouvre aucune voie d'une association vers une autre, et les
tests le vérifient explicitement (`tests/lot07-multi-associations.test.js`).

Une valeur mal formée est traitée comme une absence, et le signale en erreur : une
variable posée de travers pendant une panne se diagnostique mal.

### Mise en service

```env
# /opt/deuxzero/backend/.env — sur l'instance UNIQUEMENT
ASSOCIATION_PAR_DEFAUT=SDE001
```

```bash
sudo systemctl restart sde-api
curl -s -o /dev/null -w '%{http_code}\n' https://sde-api.atlastech.cm/api/stats   # → 200
```

**La variable ne figure volontairement pas dans `.env.example`** et n'est jamais
posée par défaut : une installation neuve est stricte, et le repli ne s'active
jamais de lui-même.

### Condition de suppression

Chaque usage laisse une trace unique et greppable :

```
[association] repli vers SDE001 (en-tête absent) sur GET /api/stats
```

```bash
# Combien d'appels de repli sur les sept derniers jours ?
journalctl -u sde-api --since '7 days ago' | grep -c 'repli vers'
```

**Quand ce compte tombe à zéro et y reste, plus aucune application antérieure au
LOT 7 n'est en service :** retirer la ligne du `.env`, redémarrer, et supprimer le
code du repli dans `src/middleware/association.js` — la fonction
`associationParDefaut`, la branche `absent` de `resoudreAssociation`, le drapeau
`requete.associationParRepli`, ainsi que les tests correspondants.

Tant que le compte n'est pas nul, la migration des clients n'est pas terminée : le
chiffre dit exactement combien de téléphones restent à mettre à jour.

---

## 2. Créer une association

```http
POST /api/associations
{ "nom": "Les Lions de Bonapriso", "ville": "Douala",
  "telephone_president": "+237699123456", "nom_president": "Joseph ESSONO",
  "contribution_defaut": 10000 }

201 → { "code_association": "LIO427", "code_president": "K7MPQR34", "nom": "…" }
```

Ce que fait le serveur :

1. tire un code libre — 3 lettres du nom + 3 chiffres, jusqu'à 20 essais, puis
   **503** plutôt que d'écraser une base existante ;
2. crée `data/associations/LIO427.db` avec le schéma complet et les paramètres
   par défaut ;
3. crée le membre « président » avec son nom et son téléphone — il cotise comme
   les autres, et son numéro est indispensable au dépannage ;
4. tire son code président, 8 caractères lisibles, et le stocke **haché**.

**Le code président n'est affiché qu'ici, une seule fois.** Il n'est pas
récupérable : ni par une route, ni par un export, ni par l'éditeur avec la base
en main. S'il est perdu, il faut passer par le contre-seing (§ 4).

Garde-fou : 3 créations par heure et par adresse IP (`CREATIONS_MAX`). Le but
n'est pas d'arrêter un attaquant déterminé — il n'y a rien à voler dans une base
vide — mais d'éviter qu'un script en boucle remplisse le disque.

---

## 3. Cycle de vie des codes

### Le rôle `admin` devient `président`

Compatibilité ascendante silencieuse : `exigerRole('admin')` fonctionne toujours,
et `req.roles` contient **les deux noms** pour un président. Cinq contrôles
existants testent encore `roles.includes('admin')` ; les faire tous basculer d'un
coup aurait été la façon la plus sûre d'ouvrir une brèche par étourderie.

### Les codes sortent du `.env`

Table `roles_codes` dans **chaque** base d'association, `code_hash` uniquement,
scrypt (N = 2¹⁴, sel par ligne). Pourquoi scrypt et pas bcrypt : bcrypt demande
une compilation native. Sur une micro-instance, une mise à jour de Node qui casse
le binaire, c'est une association entière privée d'accès — **sans personne à
appeler.**

L'authentification éprouve le code contre **tous** les codes actifs de
l'association, sans court-circuit sur le premier succès : la durée de la réponse
ne doit pas révéler la position du code trouvé. Le limiteur (5 échecs / 15 min →
429) s'applique désormais **par couple (association, IP)** — sinon une
association martelée bloquerait toutes les autres derrière le même nginx.

### Le président ne connaît jamais le code de ses collaborateurs

C'est la garantie centrale du lot, et elle tient en quatre temps :

```
        président                 collaborateur                 base
            │                           │                        │
  POST /api/roles ──────────────────────┼───────────────────────► code_hash(T)
            │◄── code TEMPORAIRE T ─────┼─────────────────────────┤
            │    (8 car., 24 h,         │                        │
            │     affiché UNE fois)     │                        │
            ├─── WhatsApp / de vive voix ►                        │
            │                           │                        │
            │        POST /api/auth/verify avec T ───────────────►│
            │                           │◄── code_temporaire: true│
            │                           │                        │
            │        toute autre route avec T ───────────────────►│
            │                           │◄── 403 code_personnel_requis
            │                           │                        │
            │   POST /api/roles/mon-code/initialiser { P } ──────►│
            │                           │                    code_hash(P)
            │                           │                    T DÉTRUIT
            │                           │                        │
            ✗ le président ne connaît pas P — et T ne vaut plus rien
```

Un code temporaire reçoit **403 `code_personnel_requis`** sur toute route sauf
`POST /api/roles/mon-code/initialiser`. L'application Flutter en fait un écran
bloquant, sans bouton retour.

### Routes du président

| Route | Effet |
|---|---|
| `GET /api/roles` | rôles, titulaires, dernière utilisation, état. **Jamais de code** — la requête ne sélectionne pas `code_hash` |
| `POST /api/roles` | attribue un rôle → code temporaire, 24 h, usage unique |
| `POST /api/roles/:id/renouveler` | nouveau code temporaire ; l'ancien meurt aussitôt |
| `DELETE /api/roles/:id` | révoque (`actif = 0` — la ligne reste, l'historique doit rester lisible) |
| `POST /api/roles/mon-code` | tout titulaire change **son** code, ancien code exigé |

Deux refus structurants :

- **un rôle ne s'attribue qu'à un membre pourvu d'un téléphone** : sans numéro,
  le jour où le code est perdu il n'y a plus personne à joindre ;
- **le dernier président ne peut pas être révoqué** : plus personne ne pourrait
  attribuer de rôle, et l'éditeur n'intervient jamais. L'association serait murée.

---

## 4. Récupérer un code perdu

### Un membre du bureau

```
POST /api/reinitialisation/demander   { code_association, telephone }
  → 200, réponse NEUTRE, toujours la même   → SMS 6 chiffres, 15 min
POST /api/reinitialisation/confirmer  { …, code_sms, nouveau_code }
  → 200 : le nouveau code est celui qu'il a choisi. Personne d'autre ne le connaît.
```

La réponse de `demander` est identique que le numéro existe ou non. Sans cela, la
route serait un **annuaire du bureau de chaque association**, interrogeable sans
aucun droit.

Trois quotas, tous éprouvés par les tests :

| Quota | Valeur | Raison |
|---|---|---|
| réinitialisations abouties | **3 / mois / association** | abus **et** facture SMS |
| codes SMS erronés | **5 → blocage 1 h du numéro** | 6 chiffres = 10⁶ combinaisons |
| validité du code SMS | **15 min** | |
| validité d'un code temporaire de rôle | **24 h** | |

Au-delà du quota mensuel, le message oriente vers le président — qui, lui, n'est
jamais bloqué pour cette action. Seules les réinitialisations **abouties**
comptent : un SMS jamais reçu ne doit pas consommer le droit d'un collègue.

### Le président

Il n'y a personne au-dessus de lui pour attester que la demande vient bien de lui.
La garantie est **collégiale** :

```
POST /api/reinitialisation/president  { code_association, telephone }
   ├─ le téléphone doit être celui de l'ANNUAIRE (donné à la création, qu'un
   │  président sans accès ne peut pas modifier lui-même)
   └─ SMS aux DEUX autres titulaires les plus anciens (secrétaire et trésorier
      en priorité)

POST /api/reinitialisation/president/confirmer   (authentifié, rôle actif)
   ├─ 1ʳᵉ confirmation → enregistrée, insuffisante
   ├─ le même titulaire ne peut pas confirmer deux fois
   │  (contrainte UNIQUE (demande_id, role_id) — « deux titulaires » veut dire
   │   deux PERSONNES, pas deux clics)
   ├─ le président ne peut pas se contresigner lui-même
   └─ 2ᵈᵉ confirmation → code TEMPORAIRE envoyé par SMS au président
```

Sans deux confirmations en 24 h, la demande expire **silencieusement**. Le
président reçoit un code temporaire, pas un définitif : il choisit le sien, et les
deux témoins ne le connaissent pas non plus.

Cas sans issue automatique, dit en clair (**409 `contreseing_impossible`**) : une
association dont le bureau ne compte pas deux autres titulaires avec téléphone.
Mieux vaut l'annoncer que laisser le président attendre un SMS qui ne viendra pas.

---

## 5. Paramètres propres à chaque association

Table `parametres` (clé/valeur), routes `GET /api/parametres` (tout rôle) et
`PUT /api/parametres` (président seul). Écriture **tout ou rien** : un lot dont
une seule valeur est refusée n'écrit rien.

| Clé | Défaut | Note |
|---|---|---|
| `jour_seance` | `samedi` | |
| `fenetre_cotisation_debut` | **`25`** | voir l'écart ci-dessous |
| `fenetre_cotisation_fin` | `5` | |
| `contribution_defaut` | `10000` | |
| `penalite_un_mois` | `1000` | |
| `penalite_deux_mois` | `2000` | |
| `seuil_exclusion_mois` | `3` | |
| `devise` | `XAF` | |
| `postes_depenses` | liste JSON | clés identiques à celles déjà en base |
| `fiches_sante_actives` | **`0`** | données médicales |

> **Écart assumé avec le cahier des charges.** Il annonçait
> `fenetre_cotisation_debut = 1`. La fenêtre de versement en vigueur depuis le
> LOT 4 s'ouvre le **25 du mois précédent** et se ferme le 5 du mois dû. Poser `1`
> aurait fermé la fenêtre du 6 au 31 et rendu impossible toute déclaration
> anticipée — c'est-à-dire changé le comportement de SDE001, ce que la règle
> « ne rien casser de l'existant » interdit. La valeur retenue est donc `25`, et
> une association qui préfère le 1ᵉʳ le règle depuis son écran.

`fiches_sante_actives` est le seul défaut qui **diffère** de l'existant : une
association qui découvre le produit ne doit pas collecter de données médicales
sans l'avoir décidé. Le script de migration pose `1` pour SDE001, qui en a déjà.

Tout le code métier lit ces paramètres. `src/services/arrieres.js` expose
`reglagesDe(bd)` et ses fonctions prennent un objet de réglages en dernier
argument, avec repli sur les **valeurs historiques** — ce qui garantit que les
tests des lots 4 à 6 produisent exactement les mêmes nombres qu'avant.

---

## 6. Reprise de l'existant, sans perte

```bash
node scripts/migrer-vers-multi.js            # reprise complète
node scripts/migrer-vers-multi.js --verifier # contrôle seul, aucune écriture
```

Le script, **idempotent** :

1. crée `data/annuaire.db` si absente ;
2. inscrit SDE001 « Santé des extrêmes », Douala, téléphone du président
   (`PRESIDENT_TELEPHONE`) ;
3. **copie** `data/sde.db` → `data/associations/SDE001.db` — une copie, pas un
   déplacement : l'original reste intact, c'est la sauvegarde la moins coûteuse ;
4. applique le schéma du LOT 7 sur la copie ;
5. reprend les codes du `.env` dans `roles_codes`, **hachés**, avec leur rôle et
   leur titulaire, puis **supprime les lignes du `.env`** (un secret en
   commentaire reste un secret sur le disque) ;
6. compte et affiche, **avant et après** : membres, cotisations, total encaissé,
   total impayés. En cas d'écart, il sort en erreur et refuse de valider.

Une seconde exécution ne recopie pas la base — ce qui écraserait les écritures
faites depuis la première — et ne duplique aucun code.

**Les codes déjà distribués au bureau continuent de fonctionner à l'identique.**
Aucun membre du bureau n'a à être prévenu ni à changer de code. Filet
supplémentaire dans `src/middleware/auth.js` : si le script n'a pas tourné, un
code encore présent dans le `.env` est accepté **pour la seule association
historique** (`ASSOCIATION_HISTORIQUE`, défaut `SDE001`) et repris en base à sa
première utilisation. La borne est essentielle : sans elle, les codes du `.env`
ouvriraient n'importe quelle association.

---

## 7. Côté application

| Écran | Rôle |
|---|---|
`accueil_association_screen.dart` | premier lancement : rejoindre / créer |
`creation_association_screen.dart` | formulaire + remise des deux codes, une fois |
`code_personnel_screen.dart` | imposé par un code temporaire, sans bouton retour |
`codes_perdus_screen.dart` | parcours SMS, et l'attente du contre-seing |
`roles_screen.dart` | président : attribuer, renouveler, révoquer, contresigner |
`parametres_screen.dart` | président : barème, séance, postes de dépense |

`AssociationService` mémorise le code dans `shared_preferences` et l'envoie dans
`X-Association` à **chaque** appel, lectures publiques comprises. Le nom affiché
vient de l'API : plus aucun écran n'écrit « Santé des extrêmes » en dur.

Deux pièges corrigés au passage, invisibles mais bloquants :

- le champ de saisie du code n'accepte plus **six chiffres** mais 6 à 12
  caractères alphanumériques. Laisser `digitsOnly` aurait rendu l'application
  inutilisable pour tout le monde, sans le moindre message — le clavier aurait
  simplement refusé les lettres ;
- `X-Association` a été ajouté à `allowedHeaders` du CORS et aux téléchargements
  d'export. Sans cela, la version web recevait 400 sur toute route métier.
