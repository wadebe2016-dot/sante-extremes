# État du LOT 4 — Arriérés, feuille de séance, mesures du mois

Deux dépôts modifiés :

| Dépôt | Branche | Contenu |
| --- | --- | --- |
| `sante-extremes` (backend Express) | `master` | Date d'adhésion, contribution, statut du membre, `/api/arrieres`, `/api/seance`, `/api/mesures`, bloc `raccourcis` de `/api/stats` |
| `sante-extremes-flutter` (application) | `main` | Écrans Arriérés, Séance, Mesures du mois ; raccourcis sur l'écran État ; adhésion, contribution et mise à l'écart sur l'écran Membres |

Décisions du bureau exécutif traduites en code :

- la cotisation du mois M se verse **entre le 25 de M-1 et le 5 de M** ; au-delà du 5, le membre est
  en retard ;
- **la cotisation n'est pas uniforme** : certains membres sont à 5 000, d'autres à 10 000 (colonne
  « Contribution attendue » de la feuille d'origine) ;
- **plus de crédit** : pour fouler le terrain, la cotisation du mois doit être versée **et validée**
  avant le coup d'envoi ;
- 1 mois de retard → **1 000** ; 2 mois → **2 000** ; 3 mois ou plus → **mise à l'écart**, sans
  pénalité en plus ;
- le terme employé partout est **« mis à l'écart »**, jamais « radié » ;
- les mesures ne sont applicables qu'**à partir du 6 octobre 2026** ; l'état des arriérés, lui, est
  disponible dès le déploiement ;
- **l'application propose, un responsable confirme** : aucune tâche planifiée, aucune application
  silencieuse.

---

## A. Date d'adhésion

Le défaut corrigé réclamait de l'argent à des gens qui ne le devaient pas : les mois dus étaient
comptés depuis janvier, si bien qu'un membre entré en mai se voyait attribuer huit mois d'arriérés
au lieu de trois.

### Migration

Strictement additive (`src/db.js` ▸ `COLONNES_AJOUTEES.members`, `src/models/schema.sql`) :

```
members(… , date_adhesion DATE, statut TEXT NOT NULL DEFAULT 'actif',
            date_statut DATETIME, motif_statut TEXT)
```

`date_adhesion` est remplie **une seule fois**, au moment même de l'ajout de la colonne :

```sql
UPDATE members SET date_adhesion = COALESCE(
  (SELECT substr(MIN(c.date_paiement), 1, 7) || '-01'
     FROM cotisations c WHERE c.member_id = members.id AND c.statut = 'validee'),
  substr(created_at, 1, 7) || '-01')
```

La première cotisation **validée** prouve que le membre était là ce mois-là ; à défaut, la création
de sa fiche fait foi. `substr` plutôt que `strftime` : la valeur de départ ne doit dépendre d'aucune
tolérance de format sur les dates déjà écrites. Le mois est stocké au 1ᵉʳ — on n'adhère pas « le 17 ».

Le `CHECK` sur `statut` vit dans `schema.sql`, pour les bases neuves seulement : SQLite ne sait pas
ajouter une contrainte à une table existante, et la liste fermée est tenue par `src/routes/admin.js`,
qui refuse en 400 toute autre valeur. C'est la leçon tirée de `demandes.categorie` au LOT 3 ter.

### Routes

| Route | Rôle | Effet |
| --- | --- | --- |
| `POST /api/admin/members` | secrétaire | `date_adhesion` facultative (AAAA-MM), **mois en cours par défaut** |
| `PATCH /api/admin/members/:id` | secrétaire | corrige `date_adhesion` |
| `GET /api/admin/members` | secrétaire | expose `date_adhesion`, `statut`, `date_statut`, `motif_statut` |

Aucun recalcul différé : les arriérés se déduisent à chaque lecture, corriger l'adhésion les efface
immédiatement.

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Adhérent en mai, à jour de mai et juin, au 30 septembre | 3 mois dus (juil., août, sept.) | OK — `mois_dus = ['2026-07','2026-08','2026-09']`, pas 8 |
| Correction de l'adhésion janvier → mai | recalcul immédiat | OK — 9 mois dus avant le `PATCH`, 5 après |
| Migration sur base d'avant le LOT 4 | adhésion déduite de la 1ʳᵉ cotisation validée | OK — 3 lignes initialisées, cotisation de février → `2026-02-01` |
| Membre sans aucune cotisation | repli sur le mois de création | OK — créé le 20 juillet → `2026-07-01` |
| `POST` sans `date_adhesion` | mois en cours | OK |
| `POST` avec un mois à venir | refus 400 | OK — « ne peut pas être dans le futur » |
| Migration rejouée | aucune colonne réécrite | OK — second passage silencieux, données intactes |

---

## A bis. Contribution mensuelle

Second défaut de surestimation, de même nature que le premier : le calcul appliquait **10 000 à tout
le monde**. Les membres à 5 000 se voyaient réclamer le double de ce qu'ils devaient.

### Migration

Additive, comme le reste (`src/db.js` ▸ `COLONNES_AJOUTEES.members`) :

```
members(… , contribution REAL NOT NULL DEFAULT 10000)
```

Remplissage **une seule fois**, au moment de l'ajout de la colonne :

```sql
UPDATE members SET contribution = COALESCE(
  (SELECT c.montant FROM cotisations c
    WHERE c.member_id = members.id AND c.statut = 'validee' AND c.montant > 0
    GROUP BY c.montant
    ORDER BY COUNT(*) DESC, MAX(c.date_paiement) DESC
    LIMIT 1),
  10000)
```

Ce qu'un membre verse d'habitude est la meilleure preuve de ce qu'on attend de lui : on retient le
montant **le plus fréquent** parmi ses cotisations validées. À égalité de fréquence, le **plus
récemment versé** l'emporte — c'est l'attente en vigueur, pas celle d'il y a deux ans. Sans aucune
cotisation, le barème de base s'applique.

Le `CHECK (contribution > 0)` vit dans `schema.sql` pour les bases neuves ; sur une base existante,
`lireContribution` dans `src/routes/admin.js` refuse en 400 tout montant nul, négatif ou supérieur à
1 000 000. Même dispositif que pour `statut`, et pour la même raison : SQLite ne sait pas ajouter une
contrainte à une table déjà là.

### Portée

**Tous** les calculs de montant dû passent par `members.contribution` — `construireSituation` dans
`src/services/arrieres.js` la lit une fois, et `/api/arrieres`, `/api/seance`, `/api/mesures` et la
feuille Excel en héritent. `COTISATION_MENSUELLE` n'est plus qu'un repli : contribution d'un membre
créé sans montant, et valeur de secours si la colonne est vide.

La **pénalité reste forfaitaire** — 1 000 pour un mois, 2 000 pour deux — quelle que soit la
contribution. Le bureau sanctionne le retard, pas le montant.

| Route | Rôle | Effet |
| --- | --- | --- |
| `POST /api/admin/members` | secrétaire | `contribution` facultative, barème de base par défaut |
| `PATCH /api/admin/members/:id` | secrétaire | corrige `date_adhesion` **et/ou** `contribution` |
| `GET /api/admin/members`, `/api/stats`, `/api/arrieres` | public/secrétaire | exposent `contribution` |

Le `PATCH` valide **les deux champs avant la moindre écriture** : une requête portant une adhésion
correcte et une contribution aberrante ne modifie rien du tout, plutôt que la moitié.

Application : l'écran Membres affiche « 5 000/mois · adhésion mai 2026 » sous chaque nom et propose
la correction dans la feuille du membre ; le montant se choisit aussi à la création. L'écran Arriérés
affiche « 5 000/mois » sous le nom — deux membres à trois mois de retard doivent 15 000 et 30 000, et
sans ce rappel l'écart paraîtrait être une erreur. Le dialogue de saisie propose les deux montants en
vigueur d'emblée, le champ libre servant aux exceptions.

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Deux membres, 3 mois dus, 5 000 et 10 000 | 15 000 et 30 000 | OK — un barème uniforme annonçait 30 000 pour les deux |
| Total des arriérés sur contributions mixtes | somme réelle | OK — 15 000, et non 20 000 |
| Migration : 4 versements dont 3 à 5 000 | contribution 5 000 | OK |
| Migration : toujours 5 000 / toujours 10 000 | 5 000 / 10 000 | OK |
| Migration : aucune cotisation | barème de base | OK — 10 000 |
| Feuille de séance, membre à 5 000, 4 mois dus | `montant_du` 20 000 | OK |
| Mesures, membre à 5 000 et membre à 10 000 | pénalité **1 000 pour les deux** | OK — forfaitaire |
| Mesures, montants dus | 5 000 et 10 000 | OK |
| `POST` avec `contribution: 5000` | acceptée | OK |
| `POST` sans contribution | barème de base | OK |
| `POST` avec 0, négatif, texte, 99 999 999 | refus 400 | OK sur les quatre |
| `PATCH` contribution 10 000 → 5 000 | montant dû 30 000 → 15 000 | OK — immédiat |
| `PATCH` des deux champs d'un coup | adhésion **et** contribution corrigées | OK |
| `PATCH` vide | refus 400 | OK |
| `PATCH` adhésion valide + contribution nulle | refus 400, **rien n'est écrit** | OK — fiche intacte |
| `/api/stats` | porte la contribution de chaque membre | OK |
| Feuille Excel « Impayés » | colonne « Contribution » | OK |

---

## B. Statut du membre

`POST /api/admin/members/:id/statut` (secrétaire ou admin) bascule entre `actif` et `ecarte`. Le
motif est **obligatoire** pour une mise à l'écart, facultatif pour une réintégration.

Chaque bascule est consignée dans la table nouvelle `evenements_membres(member_id, type, motif,
acteur, mois, date_evenement)` et remonte dans `/api/journal` sous les types `membre_ecarte` et
`membre_reintegre`. `members.statut` dit l'état courant, **pas l'histoire** : sans cette table, une
réintégration effaçait toute trace de la mise à l'écart qui l'avait précédée, et la décision devenait
injustifiable en assemblée.

**Ce qu'une mise à l'écart change, et ce qu'elle ne change pas** — la distinction est le cœur du
lot :

| | Écarté | Supprimé (`DELETE`) |
| --- | --- | --- |
| Éligibles d'une séance | sort | sort |
| Total « X/38 à jour » (`/api/stats`) | sort | sort |
| `/api/historique`, exports Excel et PDF | **reste** | effacé |
| Cotisations, sanctions, fiche santé | **conservées** | effacées en cascade |
| Réversible | **oui** | non |

Dans l'application : le balayage vers la gauche supprime — c'est l'opération d'erreur de saisie ;
l'appui sur la ligne ouvre la feuille, qui propose la mise à l'écart. Les deux textes de confirmation
disent explicitement ce qui est conservé.

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Membre écarté | absent de `/api/stats` | OK — `total_members` passe de 2 à 1, `membres_ecartes: 1` |
| Membre écarté | présent dans `/api/historique` | OK |
| Membre écarté | présent dans l'export Excel | OK — classeur produit, HTTP 200 |
| `POST /statut` sans motif (écart) | refus 400 | OK |
| Deux fois le même statut | refus 409 | OK |
| Écart puis réintégration | deux événements au journal | OK — `membre_ecarte` **et** `membre_reintegre` coexistent |
| `POST /statut` sans code | refus 401 | OK |

---

## C. Arriérés

`GET /api/arrieres?mois=AAAA-MM` — **public**, mois en cours par défaut. Disponible dès le
déploiement : cette route ne dépend d'aucune date d'effet.

Un mois est dû s'il est **postérieur ou égal au mois d'adhésion**, **antérieur ou égal au mois
demandé**, et **sans cotisation validée**. Les membres à jour ne figurent que dans le résumé ; la
liste est triée par nombre de mois dus décroissant, l'ordre alphabétique départageant.

```json
{ "mois":"2026-09", "cotisation_mensuelle":10000,
  "membres":[ { "id":7, "name":"…", "adhesion":"2026-05", "mois_dus":["2026-07","2026-09"],
                "nb_mois":2, "montant_du":20000, "penalites_dues":0, "total_du":20000,
                "dernier_versement":"2026-08-12", "statut":"actif" } ],
  "resume":{ "membres_a_jour":21, "membres_en_retard":14, "total_arrieres":185000,
             "par_anciennete":{ "1_mois":8, "2_mois":4, "3_mois_et_plus":2 } } }
```

Chaque ligne porte la `contribution` du membre : le montant dû est `nb_mois × contribution`, et non
un barème uniforme.

`total_arrieres` ne compte **que** les cotisations : les pénalités restent une comptabilité
distincte, annoncées à part dans `penalites_dues` et `total_du`. Les mêmes chiffres alimentent la
feuille « Impayés » du classeur Excel — elle appelle la fonction de la route, elle ne refait pas le
calcul.

Le barème de base (10 000 XAF) vit dans `src/services/arrieres.js`, surchargeable par
`COTISATION_MENSUELLE`. Il ne s'applique qu'aux membres sans contribution propre : voir la section
A bis. **Rien à poser en production.**

**L'écran s'appelle « Impayés »** — le terme retenu par l'association. Il nomme le bandeau, la carte
de l'onglet Plus, le raccourci de l'écran État, le texte du bouton Partager et la feuille Excel.

Le CODE, lui, garde « arrieres » partout : route `/api/arrieres`, fichiers `arrieres_screen.dart` et
`routes/arrieres.js`, fonction `construireArrieres`, clé JSON `total_arrieres`. Renommer l'un sans
l'autre aurait cassé l'API pour un mot ; les deux vocabulaires cohabitent sans se gêner, celui de
l'interface et celui du code.

Application — écran « Impayés » (onglet Plus, lecture publique) : bandeau avec le total et la
répartition 1 / 2 / 3 mois et plus ; liste par membre avec les mois dus en puces, le montant dû, la
**contribution et la date d'adhésion en petit** (« 5 000/mois · adhésion mai 2026 ») — ce sont elles
qui expliquent pourquoi l'un doit 15 000 et l'autre 80 000 — et la date du dernier versement ;
filtres d'ancienneté ; « Partager » (texte brut, collé dans
le groupe) et « Exporter » (Excel, feuille « Impayés »).

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Total des arriérés | somme des montants dus des membres en retard | OK — égalité vérifiée ligne à ligne |
| Membres à jour | absents de la liste, comptés au résumé | OK |
| Tri | nombre de mois dus décroissant | OK — « Trois Mois » avant « Un Mois » |
| Pénalité due de 1 000 | hors de `total_arrieres`, dans `total_du` | OK — 10 000 / 1 000 / 11 000 |
| Sans code | HTTP 200 | OK |
| `?mois=septembre` | refus 400 | OK |
| Feuille Excel « Impayés » | mêmes chiffres que l'écran | OK — même fonction de construction |

---

## D. Feuille de séance

`GET /api/seance?date=AAAA-MM-JJ` — **public**, aujourd'hui par défaut. Aucun code : les censeurs
contrôlent à l'entrée du terrain, et réclamer un code à quelqu'un qui tient déjà un ballon et une
liste de présence, c'est garantir qu'il ne s'en servira pas.

Règles d'éligibilité, **dans cet ordre** — le premier motif rencontré l'emporte :

| Ordre | Condition | Résultat |
| --- | --- | --- |
| a | suspension active (terme non échu) | non éligible — « suspendu jusqu'au JJ/MM » |
| b | membre mis à l'écart | non éligible — « mis à l'écart » |
| c | cotisation du mois validée | **éligible** |
| d | déclaration en attente de validation | non éligible — « déclaration en attente de validation » |
| e | adhésion postérieure au mois de la séance | non éligible — « adhésion à partir de … » |
| f | sinon | non éligible — « cotisation de \<mois\> non versée » |

L'ordre n'est pas indifférent : une suspension **prime** sur une cotisation à jour. À l'inverse, les
**pénalités dues n'empêchent pas de jouer** : elles sont signalées sur la ligne, jamais bloquantes —
le bureau sanctionne le retard de cotisation, pas le retard de règlement d'une pénalité.

Le cas (e) n'était pas au cahier des charges et a été ajouté : sans lui, un membre inscrit en
novembre apparaissait « cotisation d'octobre non versée » pour une séance d'octobre, alors qu'il
n'était pas encore là.

Application — écran « Séance » (onglet Plus, et bouton ballon dans le bandeau de l'écran État) :
surtitre « Séance », titre « Samedi 3 octobre » (date sélectionnable), chiffre héro « 21 peuvent
jouer », sous-ligne « 17 non éligibles · 38 membres » ; deux sections repliables, avatars verts et
rouges, motif en clair ; **recherche par nom en tête de liste** — c'est la question qu'on pose ici ;
« Partager la liste » (share_plus).

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Cotisation d'octobre validée | éligible, montant et date du versement | OK |
| Déclaration en attente | non éligible, motif exact | OK — « déclaration en attente de validation » |
| Rien versé, adhérent en août | non éligible, 3 mois dus, 30 000 | OK |
| Suspension active **et** cotisation à jour | non éligible | OK — « suspendu jusqu'au 20/10 », la suspension prime |
| Suspension dont le terme tombe le jour de la séance | non éligible ce jour-là, éligible le lendemain | OK |
| Membre mis à l'écart | non éligible, absent des éligibles | OK — « mis à l'écart » |
| Pénalité due de 1 000, cotisation à jour | **éligible**, pénalité signalée | OK |
| Versement du 28 septembre pour octobre | éligible à la séance du 3 octobre | OK — `date_versement: 2026-09-28` |
| `resume` | éligibles + non éligibles = total | OK — 1 + 4 = 5 |
| `?date=2026-02-31` | refus 400 | OK — jour inexistant démasqué |
| Sans code | HTTP 200 | OK |

---

## E. Cycle de cotisation et mesures du mois

### Fenêtre de versement

La cotisation du mois M est « dans les délais » si sa date de versement tombe **entre le 25 de M-1 et
le 5 de M inclus**. La règle vit en deux exemplaires volontairement jumeaux :
`src/services/arrieres.js` ▸ `fenetreVersement` côté serveur, `lib/utils/cycle_cotisation.dart` côté
application. Le serveur refuse ; l'application ne propose pas.

**Une correction rendue nécessaire par la fenêtre** : `POST /api/cotisations` refusait tout mois à
venir. Or à partir du 25 septembre, ce qu'on règle est la cotisation d'**octobre** — le refus sec
rendait donc impossible le versement le plus vertueux qui soit, celui fait dans les délais.
`convertirMoisEnDate` accepte désormais le mois suivant **pendant la fenêtre**, et lui seul : hors
fenêtre, le refus tient.

Côté application, deux conséquences :

- l'écran État porte un bandeau « Période de cotisation ouverte — échéance le 5 \<mois\> » du 25 au
  5, « Échéance dépassée depuis le 5 \<mois\> » du 6 au 24 ;
- le champ « Mois concerné » propose le mois suivant entre le 25 et la fin du mois, le mois en cours
  à partir du 1ᵉʳ — à la déclaration du membre comme à la saisie du trésorier. Le mois est désormais
  **toujours** transmis au serveur : le laisser deviner datait la cotisation de l'instant présent, et
  une saisie du 28 septembre au titre d'octobre aurait été rangée en septembre.

### Mesures proposées

`GET /api/mesures?mois=AAAA-MM` — **public en lecture**.

```json
{ "mois":"2026-10", "date_effet":"2026-10-06", "applicable":true,
  "a_penaliser":[ { "id":3, "mois_de_retard":1, "penalite_proposee":1000, "deja_penalise":false } ],
  "a_ecarter":[ { "id":9, "mois_de_retard":3, "mois_dus":["…"], "montant_du":30000 } ],
  "peuvent_jouer":[ { "id":1, "date_versement":"2026-10-02" } ],
  "resume":{ "a_jour":21, "a_penaliser":9, "a_ecarter":5, "ecartes_deja":3, "penalises_deja":2 } }
```

`applicable` vaut **faux avant le 6 octobre 2026** : les listes sont calculées et consultables — le
bureau voulait voir venir — mais les `POST` sont refusés en **409**, et l'écran affiche « Mesures
applicables à partir du 6 octobre 2026 », boutons inactifs. Double barrière assumée.

Un membre à trois mois ou plus n'apparaît **jamais** dans `a_penaliser` : la mise à l'écart remplace
la pénalité, elle ne s'y ajoute pas. Un membre déjà pénalisé pour ce mois n'est plus proposé et est
compté dans `resume.penalises_deja` (champ ajouté au cahier des charges, sans quoi la liste paraît
trop courte sans explication). Un membre déjà écarté ne figure que dans le résumé.

### Application des mesures

| Route | Rôle | Effet |
| --- | --- | --- |
| `POST /api/mesures/penalites` | censeur ou admin | crée les pénalités dans `sanctions`, `mois_concerne` et `inflige_par` renseignés |
| `POST /api/mesures/ecarts` | secrétaire ou admin | passe en `statut = 'ecarte'`, consigne dans `evenements_membres` |

Trois garde-fous :

1. **Le barème vient du serveur, jamais du client.** Le nombre de mois dus et le montant sont
   recalculés ; une application bricolée ne peut pas infliger 50 000 à la place de 1 000. Idem pour
   le seuil d'écart : on n'écarte pas quelqu'un qui doit un mois parce que le client l'a mal classé.
2. **Idempotence.** Un membre déjà pénalisé pour ce mois, ou déjà écarté, est ignoré sans erreur ; la
   réponse indique `applique` et `ignore`, avec le motif de chaque exclusion. Indispensable sur une
   connexion mobile, où un envoi part parfois deux fois.
3. **La protection `CENSEUR_MEMBRES` s'applique ici aussi.** Les mesures du mois n'ouvrent pas une
   porte dérobée : un membre protégé est ignoré, code administrateur requis.

Aucune tâche planifiée. Aucune application silencieuse.

Application — écran « Mesures du mois » (onglet Plus ; rappel sur l'écran État à partir du 6 :
« 9 membres à pénaliser · 5 à mettre à l'écart ») : trois sections, cases à cocher, **tout
sélectionné par défaut**, décochage ligne à ligne ; « Appliquer les pénalités » demande le code
censeur, « Mettre à l'écart » le code secrétaire, chacun avec récapitulatif chiffré et confirmation ;
« Partager » (texte brut).

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Versement du 28 septembre pour octobre | dans les délais | OK — `dansLesDelais('2026-10','2026-09-28')` vrai |
| Versement du 6 octobre pour octobre | en retard | OK |
| Fenêtre au 28 septembre | mois proposé = octobre, ouverte | OK |
| Fenêtre au 12 octobre | échéance dépassée | OK |
| Versement en avance | éligible **et** absent des mesures | OK — 0 à pénaliser, 0 à écarter |
| Avant le 6 octobre 2026 | `applicable: false`, listes calculées | OK — 1 membre listé malgré tout |
| Avant le 6 octobre 2026 | `POST` pénalités → 409 | OK |
| Avant le 6 octobre 2026 | `POST` écarts → 409 | OK |
| Au 6 octobre, 1 mois de retard | `a_penaliser`, 1 000 | OK |
| Au 6 octobre, 2 mois de retard | `a_penaliser`, 2 000 | OK |
| Au 6 octobre, 3 mois de retard | `a_ecarter`, **absent** de `a_penaliser` | OK |
| Deux fois la même liste de pénalités | 2 appliquées / 0 ignorées, puis 0 / 2 | OK — 2 lignes en base, pas 4 |
| Deux fois la même liste d'écarts | 1 appliquée puis 0 / 1 ignorée | OK |
| Membre déjà pénalisé, mois suivant | de nouveau proposable | OK — la pénalité porte un mois |
| `montant: 50000` envoyé par le client | ignoré, 2 000 enregistrés | OK |
| Écart demandé sur 1 mois de retard | ignoré, « seuil non atteint » | OK — statut resté `actif` |
| Mise à l'écart | `motif_statut`, `date_statut`, événement au journal | OK — acteur `secretaire`, mois `2026-10` |
| `GET` `/seance`, `/arrieres`, `/mesures` sans code | HTTP 200 | OK |
| `POST` mesures avec code trésorier | refus 401 | OK |
| Censeur sur les pénalités | HTTP 200 | OK |
| Secrétaire sur les écarts | HTTP 200 | OK |
| Censeur sur les écarts | refus 401 | OK |

---

## F. Raccourcis de l'écran État

Les trois écrans du lot vivaient dans l'onglet Plus, à deux gestes de l'accueil. Une rangée de trois
cartes s'intercale désormais **entre le bandeau sombre et le champ de recherche**.

Ce sont des raccourcis, mais ils portent chacun **leur chiffre** : on apprend qu'il y a 670 000
d'arriérés sans ouvrir l'écran. C'est ce qui les distingue de trois boutons.

| Carte | Icône | Chiffre | Libellé | Destination |
| --- | --- | --- | --- | --- |
| Séance | ballon | éligibles du jour | « peuvent jouer » | écran Séance |
| Impayés | alerte | total formaté (« 670 000 ») | « Impayés » | écran Impayés |
| Mesures | balance | à pénaliser + à écarter | « mesures à appliquer » | écran Mesures |

**Avant la date d'effet**, la carte Mesures affiche un tiret grisé et « à partir du 6 oct » : rien
n'est applicable, et un chiffre noir inviterait à une action que le serveur refuserait en 409. Elle
reste tapable — le bureau veut voir venir. **Après**, une pastille orange signale qu'il y a à
traiter, et disparaît quand le compte tombe à zéro : une pastille à zéro n'est que du bruit.

Charte : cartes blanches, bord `#E6E3DD`, rayon 16, chiffre Manrope 600 en 18, libellé 11 px gris.
Hauteur 72 px, **défilement horizontal** — sur 360 px, trois colonnes de 108 px couperaient « peuvent
jouer » en deux ; mieux vaut laisser la troisième dépasser, elle invite au geste qui la révèle.

Aucun code requis, visibles de tous. **Les entrées de l'onglet Plus restent en place** : les
raccourcis s'ajoutent à la navigation, ils ne la remplacent pas.

### Un seul appel réseau

Les chiffres viennent d'un bloc `raccourcis` ajouté à `GET /api/stats` :

```json
{ "raccourcis": { "eligibles_aujourdhui": 21, "total_arrieres": 670000,
                  "mesures_en_attente": 14, "mesures_a_penaliser": 9,
                  "mesures_a_ecarter": 5, "mesures_applicable": true,
                  "date_effet_mesures": "2026-10-06", "total_membres_seance": 38 } }
```

Trois appels supplémentaires au premier rendu auraient été trois allers-retours de trop sur des
téléphones où la connexion est le facteur limitant. Le bloc dérive d'**une seule** construction de la
situation, et l'ancien second appel à `/api/mesures` depuis l'écran État a disparu avec lui.

Pour que les raccourcis ne deviennent pas un second jeu de chiffres, deux fonctions de domaine ont
été remontées dans `src/services/arrieres.js` :

- `motifInegibilite(membre, mois)` — la cascade d'éligibilité, désormais partagée par `/api/seance`
  et `/api/stats` ;
- `classerMesures(situation)` — la répartition à pénaliser / à écarter / à jour, partagée par
  `/api/mesures` et `/api/stats`.

Les routes n'en gardent que la mise en forme. Un test vérifie explicitement que chaque raccourci
annonce **le même chiffre que l'écran qu'il ouvre**.

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| `/api/stats` | porte le bloc `raccourcis` | OK |
| 3 membres, 1 à jour / 1 à 1 mois / 1 à 5 mois | 1 éligible, 55 000 dus, 1 + 1 mesure | OK — contributions mixtes comprises |
| Raccourci vs `/api/seance` | même nombre d'éligibles | OK |
| Raccourci vs `/api/arrieres` | même total | OK |
| Raccourci vs `/api/mesures` | mêmes comptes | OK |
| Membre écarté à jour de sa cotisation | hors des éligibles | OK — 1 sur 2 |
| Base sans membre | zéros, jamais `null` | OK |
| Avant la date d'effet | `mesures_applicable: false` | OK |
| Après | `true` | OK |
| Carte à 72 px, trois libellés réels | aucun débordement | OK — testé au pixel |
| Chiffre démesuré (999 999 999) | tronqué, largeur tenue | OK |
| Carte grisée | chiffre en gris, **toujours tapable** | OK |
| Pastille orange | absente à zéro, présente sinon | OK |

---

## G. État des vérifications automatiques

Backend — `npm test` : **65 tests, 65 verts, 0 échec** (20 du LOT 3 ter inchangés, 45 dans
`tests/lot04-arrieres.test.js`). `node --check` passé sur tous les fichiers modifiés :
`src/db.js`, `src/index.js`, `src/services/arrieres.js`, `src/routes/{admin,arrieres,seance,mesures,
stats,journal,cotisations,export}.js`.

Migration éprouvée deux fois sur des bases reconstruites au schéma d'avant le lot :

- base simple : 7 colonnes ajoutées, adhésions et contributions initialisées, cotisations et
  sanctions préservées, second passage sans effet ;
- base à montants mixtes : contributions déduites correctement — toujours 5 000 → 5 000, toujours
  10 000 → 10 000, majorité 5 000 (3 contre 1) → 5 000, aucune cotisation → barème de base.

Application — `flutter analyze` : **0 erreur, 0 avertissement** (111 infos de style, de même nature
que les 94 d'avant : `prefer_expression_function_bodies` sur les `build`, conformes à l'usage du
projet). `flutter test` : **42 tests verts** — 18 d'avant, 18 dans
`test/cycle_cotisation_test.dart`, 6 dans `test/carte_raccourci_test.dart`, ces derniers montant la
carte dans la hauteur exacte que lui impose la rangée. APK release arm64 construit en local.

---

## Résumé pour l'architecte

1. **Deux surestimations corrigées.** Les arriérés partaient de janvier et non de
   `members.date_adhesion` ; et le montant dû appliquait 10 000 à tous, au lieu de
   `members.contribution` — 5 000 pour une partie de l'effectif.
2. Trois routes **publiques en lecture** : `/api/arrieres` (disponible dès le déploiement),
   `/api/seance` (les censeurs contrôlent au bord du terrain), `/api/mesures`. Leurs trois chiffres
   remontent dans le bloc `raccourcis` de `/api/stats`, affiché en tête de l'écran d'accueil.
3. **Les mesures ne s'appliquent qu'à partir du 6 octobre 2026** : avant, listes consultables et
   `POST` refusés en 409. Écriture réservée — pénalités au censeur, mises à l'écart au secrétaire.
4. **Idempotence** sur les deux `POST` : rejouer une liste n'inflige rien deux fois. Le barème et le
   seuil sont recalculés côté serveur, jamais repris du client.
5. **« Mis à l'écart », jamais « radié »** : le membre sort des séances et du total « à jour », il
   reste dans l'historique, les exports et le journal. Réversible.
6. Migration **strictement additive** : 5 colonnes sur `members` (dont `contribution`, déduite du
   montant le plus fréquent de chaque membre), 2 sur `sanctions`, 1 table `evenements_membres`.
   Remplissage unique des lignes existantes, rejouable sans effet.
7. Une correction hors périmètre, imposée par la fenêtre : `POST /api/cotisations` accepte le mois
   suivant **pendant** la fenêtre du 25 au 5. Sans elle, verser à l'heure était impossible.
8. Déploiement :
   `cd ~/sante-extremes/backend && git pull && npm install && npm run migrate && sudo systemctl restart sde-api`
9. **Aucune variable d'environnement à changer.** `COTISATION_MENSUELLE` (défaut 10 000, simple
   repli depuis que chaque membre porte la sienne) et `DATE_EFFET_MESURES` (défaut 2026-10-06)
   existent mais ne doivent pas être posées.
10. Test après déploiement : `curl -s https://sde-api.atlastech.cm/api/arrieres | head -c 400` —
    chaque membre doit porter sa `contribution` (5 000 ou 10 000) et un `montant_du` qui en est le
    multiple. Puis `/api/seance` et `/api/mesures` : les trois répondent **200 sans code**, et
    `/api/mesures` annonce `"applicable": false` jusqu'au 6 octobre. **Vérifier la liste des
    contributions déduites** (écran Membres) avant la première application de mesures : la migration
    devine, le secrétariat tranche.
