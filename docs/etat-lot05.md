# État du LOT 5 — Demandes à plusieurs postes

Deux dépôts modifiés :

| Dépôt | Branche | Contenu |
| --- | --- | --- |
| `sante-extremes` (backend Express) | `master` | Table `demande_lignes`, bascule de `decaissements` sur la ligne, routes de décision poste par poste, trésorerie, exports et journal alignés |
| `sante-extremes-flutter` (application) | `main` | Écran Dépenses : formulaire à postes multiples, carte à deux étages, actions du trésorier par poste |

---

## Demandes à plusieurs postes

### Le geste qu'il fallait rendre possible

Un samedi, l'intendant engage plusieurs postes à la fois : eau, kiné, location du stade, lavage des
chasubles. Il devait jusqu'ici créer **une demande par poste**, donc autant d'approbations et autant
de décaissements — quatre allers-retours pour une seule sortie sur le terrain.

Il exprime désormais **un besoin à plusieurs postes en une seule saisie**. Mais le trésorier garde la
main **poste par poste** : c'est lui qui engage l'argent, il doit pouvoir approuver l'eau et refuser
le kiné. C'est tout l'équilibre du lot — la saisie se regroupe, la décision jamais.

### Modèle

Migration **additive** (`src/db.js` ▸ `migrerLignesDeDemande`, `src/models/schema.sql`) :

```
demande_lignes(id, demande_id → demandes ON DELETE CASCADE, categorie, libelle,
               montant_estime, statut, motif_refus, approuve_par, date_decision)
```

Chaque demande existante reçoit **une ligne**, copie exacte de ses propres colonnes — catégorie,
libellé, montant, statut, motif, décideur, date de décision. Le `NOT EXISTS` rend la reprise
rejouable : une demande déjà reprise n'est jamais dupliquée.

`decaissements.demande_id` devient **`decaissements.ligne_id`**, et la contrainte `UNIQUE` porte
désormais sur la ligne : **un poste ne peut être décaissé qu'une fois**. SQLite ne sait ni renommer
une contrainte ni changer une clé étrangère, la table est donc reconstruite — lignes recopiées une à
une, dans une transaction, clés étrangères désactivées le temps de l'échange. **Les identifiants sont
préservés** : un justificatif déjà servi par `/api/decaissements/:id/justificatif` garde son adresse.
C'est la seule opération du projet qui réécrive une table de mouvements, d'où la sauvegarde
recommandée avant `migrate`.

Le statut d'une demande n'est plus saisi, il est **calculé** :

| Règle | Statut agrégé |
| --- | --- |
| au moins une ligne en attente | `en_attente` |
| sinon, toutes les lignes non refusées sont payées | `payee` |
| sinon, au moins une ligne approuvée | `approuvee` |
| sinon, toutes les lignes sont refusées | `refusee` |

Les colonnes de `demandes` restent en place et **reflètent l'agrégat** : elles sont réalignées après
chaque décision (`recalculerDemande`), pour que les lectures qui ne joignent pas les lignes — filtre
par statut, reprise d'une base ancienne — restent justes.

### Routes

| Route | Rôle | Effet |
| --- | --- | --- |
| `POST /api/demandes` | intendant, secrétaire, compétitions, admin | `lignes: [{categorie, libelle, montant_estime}]`, de **1 à 10 postes** ; devis joint à la demande entière |
| `GET /api/demandes` | public | chaque demande avec son tableau `lignes`, son statut agrégé, `total_estime` et `total_decaisse` |
| `POST /api/demandes/:id/lignes/:ligneId/approuver` | trésorier | ligne `approuvee` |
| `POST /api/demandes/:id/lignes/:ligneId/refuser` | trésorier | `{ motif }` → ligne `refusee` |
| `POST /api/demandes/:id/lignes/:ligneId/decaisser` | trésorier | **409** si la ligne n'est pas `approuvee` ; passe la ligne en `payee` |
| `POST /api/demandes/:id/approuver` | trésorier | **tous les postes en attente** — le geste rapide quand tout est accepté d'un bloc |
| `POST /api/demandes/:id/refuser` | trésorier | idem, motif obligatoire |
| ~~`POST /api/demandes/:id/decaisser`~~ | — | **supprimée** : on décaisse une ligne, jamais une demande |

**Rétrocompatibilité** : une requête portant les anciens champs plats (`categorie`, `libelle`,
`montant_estime`) crée une demande à une ligne, et la réponse continue de servir ces mêmes champs
plus un `decaissement` au premier niveau. Une version antérieure de l'application reste installée sur
les téléphones le jour du déploiement : elle ne doit pas casser.

Les règles en vigueur sont intactes : le trésorier ne peut pas créer de demande (sauf admin), ni se
désigner bénéficiaire d'un décaissement.

### Lectures alignées sur la ligne

- `/api/tresorerie` : répartition par catégorie et relevé de mouvements joignent `demande_lignes` ;
  **« engagé » = somme des lignes approuvées non payées**. Compter la demande entière gonflerait
  l'engagé d'un montant que personne ne sortira jamais.
- **Exports** (Excel et PDF) : la feuille « Dépenses » liste **une ligne par poste** — date,
  catégorie, libellé, montant, bénéficiaire, payé par — avec une colonne **« Demande »** portant le
  numéro d'origine, qui relie les postes d'un même samedi.
- **Journal** : « Besoin exprimé — 3 postes, 18 000 estimés », puis **un événement par ligne**
  approuvée, refusée ou payée.

### Écran Dépenses

- **Exprimer un besoin** : formulaire à postes multiples. Un poste = catégorie (puces), libellé,
  montant. « Ajouter un poste » jusqu'à 10, suppression d'un poste **par glissement** (le poste
  unique ne se retire pas : un besoin sans poste n'existe pas). Devis facultatif pour l'ensemble.
  **Total estimé affiché en bas, mis à jour à la saisie.** Le bouton d'envoi reste fermé tant qu'un
  poste est incomplet.
- **Carte d'une demande** : en-tête avec le demandeur, la date, le total estimé et le statut agrégé ;
  en dessous, la liste des postes avec leur propre statut et leur montant. Pour le trésorier, chaque
  poste porte ses actions — Approuver, Refuser (motif), Décaisser — et l'en-tête porte
  **« Tout approuver »** dès que **deux** postes attendent.
- **Couleurs de statut inchangées** : en attente `#EF9F27`, approuvée `#378ADD`, payée `#1D9E75`,
  refusée `#D8262E`. Bandeau, filtres et badge conservés — le bandeau compte désormais des **postes**,
  l'unité que le trésorier traite.

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| Demande à 3 postes créée par un intendant | 201, agrégat `en_attente`, 3 lignes | OK — `total_estime` 18 000 |
| Approuver le poste 1, refuser le poste 2 | agrégat `en_attente` tant que le poste 3 attend | OK |
| Décision sur le poste 3 (approbation) | agrégat `approuvee` | OK |
| 1 poste refusé, les 2 autres payés | agrégat `payee` | OK — le refus ne bloque pas |
| Tous les postes refusés | agrégat `refusee`, motif remonté | OK |
| Décaisser un poste `en_attente` | 409 | OK — aucun décaissement écrit |
| Décaisser deux fois le même poste | 409 | OK — `UNIQUE (ligne_id)`, un seul décaissement en base |
| Décaisser un poste refusé | 409 | OK |
| `POST /api/demandes/:id/decaisser` | route supprimée | OK — 404 |
| Poste emprunté à une autre demande | 404 | OK — l'appartenance est vérifiée |
| « Tout approuver » | les postes en attente passent approuvés, les refusés ne bougent pas | OK — motif intact ; rejouer → 409 |
| Ancienne forme plate | demande à une ligne, champs plats servis | OK |
| Poste sans libellé, montant nul, 11 postes | 400 | OK — rien n'est écrit, le message nomme le poste fautif |
| Trésorier créant une demande | 401 | OK — l'admin, lui, cumule (201) |
| Bénéficiaire = trésorier connecté | 403 | OK — casse et espaces ignorés ; au bénéfice d'un autre, 201 |
| Migration sur base au schéma précédent | demandes et décaissements préservés, rattachés à leur ligne | OK — 4 demandes → 4 lignes, décaissement `#7` conservé |
| `/api/tresorerie` avant/après migration | chiffres identiques | OK — solde, dépenses, engagé, en attente, par catégorie |
| Migration rejouée | aucune ligne dupliquée | OK |
| Trésorerie, 1 poste refusé + 2 approuvés | engagé = 8 000, puis 2 000 après paiement de l'eau | OK |
| Journal | 1 « Besoin exprimé — 3 postes », puis 1 événement par décision | OK — approbation, refus, décaissement, au libellé du poste |
| Retrait d'une demande | possible tant qu'aucun poste n'est tranché | OK — 409 après la première décision, lignes supprimées en cascade |

`node --check` sur les six fichiers backend modifiés (`db.js`, `demandes.js`, `decaissements.js`,
`tresorerie.js`, `export.js`, `journal.js`) : OK. `npm test` : **93 tests verts** — 68 d'avant, 20
dans `tests/lot05-demandes-lignes.test.js`, 5 dans `tests/migration-demande-lignes.test.js`. Export
Excel et PDF régénérés sur un jeu à deux postes : la feuille « Dépenses » porte bien une ligne par
poste et la colonne « Demande ». `flutter analyze` : **0 erreur, 0 avertissement** (115 `info` de
style, conformes à l'usage du projet — un import inutile de `seance_screen.dart`, hors périmètre, a
été retiré pour tenir le zéro avertissement). `flutter test` : **60 tests verts** — 54 d'avant, 6
dans `test/carte_demande_test.dart`. APK release arm64 construit en local, libellés vérifiés dans
l'artefact (`Ajouter un poste`, `Tout approuver`, `Total estimé`, `glisser pour retirer`,
`Refuser ce poste`).

---

## Résumé pour l'architecte

1. **Un besoin, plusieurs postes.** L'intendant saisit l'eau, le kiné, le stade et les chasubles en
   une fois ; le trésorier approuve, refuse et décaisse **poste par poste**. La saisie se regroupe,
   la décision jamais.
2. Nouvelle table **`demande_lignes`** : la décision et le paiement y vivent. Les colonnes de
   `demandes` restent et **reflètent l'agrégat**, recalculé après chaque décision.
3. **`decaissements.demande_id` → `decaissements.ligne_id`**, `UNIQUE` sur la ligne : un poste ne se
   paie qu'une fois. Table reconstruite en transaction, **identifiants préservés**.
4. **Sauvegarder `data/sde.db` avant `npm run migrate`** : c'est la seule migration du projet qui
   réécrive une table de mouvements (`decaissements`). La reprise est rejouable et s'interrompt sans
   rien toucher si un décaissement était orphelin.
5. L'ancienne route de décaissement **au niveau demande est supprimée** ; celles d'approbation et de
   refus restent et s'appliquent à tous les postes en attente (« Tout approuver »).
6. **Rétrocompatibilité assurée** : les anciens champs plats créent une demande à un poste et sont
   toujours servis en lecture — l'application non mise à jour continue de fonctionner.
7. « Engagé » de `/api/tresorerie` = **lignes approuvées non payées** ; la feuille « Dépenses » liste
   une ligne par poste avec le numéro de la demande d'origine.
8. Déploiement :
   `cd ~/sante-extremes/backend && git pull && npm install && npm run migrate && sudo systemctl restart sde-api`
9. **Aucune variable d'environnement à changer.**
10. Test après déploiement :
    `curl -s https://sde-api.atlastech.cm/api/demandes | head -c 400` — chaque demande doit porter un
    tableau `lignes` non vide, et `/api/tresorerie` le même solde qu'avant la migration.
