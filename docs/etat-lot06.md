# État du LOT 6 — Version web

Deux dépôts modifiés :

| Dépôt | Branche | Contenu |
| --- | --- | --- |
| `sante-extremes` (backend Express) | `master` | `CORS_ORIGINS` documenté pour l'origine web, tests de politique d'origine |
| `sante-extremes-flutter` (application) | `main` | Cible web activée, pièces jointes et téléchargements rendus portables, habillage et installation sur l'écran d'accueil, `deploy/web-app.sh`, `web-build/` |

---

## Version web

### Pourquoi

Les membres sur iPhone ne peuvent pas installer l'APK. La même application
Flutter est donc publiée en version web sur **https://app.santedesextremes.com**,
déjà pointé en A vers l'instance (35.180.204.241, DNS only chez Cloudflare).

**Rien ne change côté Android** : même code métier, mêmes écrans, même API
`https://sde-api.atlastech.cm/api`, aucune rediffusion d'APK. L'APK release
arm64 a été reconstruit à l'identique pour le vérifier (18,7 Mo).

### Choix technique : une seule base de code, des implantations conditionnelles

Quatre greffons ne fonctionnent pas de la même façon dans un navigateur. Aucun
écran n'a été dupliqué : la différence est confinée à des fichiers
d'implantation, choisis **à la compilation** par `import … if (dart.library.io)`.

| Sujet | Téléphone | Navigateur | Où vit la différence |
| --- | --- | --- | --- |
| Aperçu d'une pièce | `Image.file` | `Image.network` sur l'URL `blob:` | `widgets/apercu_piece_{natif,web}.dart` |
| Remise d'un fichier | écriture puis `open_filex`, partage à défaut | ancre `download` sur l'adresse d'origine | `utils/remise_fichier_{natif,web}.dart` |
| Partage d'une liste | feuille de partage du système | `navigator.share` s'il existe, sinon presse-papiers | `utils/partage_{natif,web}.dart` |
| Choix d'un fichier | chemin sur le disque | contenu en mémoire | rien — `XFile` porte les deux |

**Le pivot est `XFile`.** Les pièces jointes circulaient jusqu'ici sous forme de
chemins (`String`) ; un navigateur n'en a pas. Elles circulent désormais en
`XFile` — le type que `image_picker` renvoie déjà, que `file_picker` sait
produire (`PlatformFile.xFile`), et qui porte indifféremment un chemin, une URL
`blob:` ou un contenu en mémoire, avec son nom d'origine. `ApiService._piece`
lit donc des **octets** au lieu d'ouvrir un fichier, et `dart:io` a disparu de
tout `lib/` sauf des deux implantations natives.

Conséquence heureuse : le type réel de la pièce est désormais déduit des octets
d'en-tête même quand le nom ne dit rien — ce qui est le cas de toute pièce
choisie dans un navigateur, où l'URL `blob:` est un identifiant et non un nom.
Le serveur, lui, détectait déjà le type réel : les deux contrôles concordent.

### Ce qui change pour l'utilisateur, en web

- **image_picker** : « Photographier le reçu » et « Ajouter un reçu » ouvrent le
  sélecteur du navigateur. Sur iOS Safari, `ImageSource.camera` pose l'attribut
  `capture` sur le champ de fichier, et c'est l'appareil photo qui s'ouvre.
- **file_picker** : le règlement intérieur, les fiches santé et les devis
  passent par le sélecteur du navigateur. Le nom d'origine du fichier est
  conservé — c'est lui que les membres voient sur le règlement publié.
- **open_filex** est inopérant : il n'y a ni dossier de documents ni lecteur
  système. Les exports, le règlement et les justificatifs déclenchent un
  **téléchargement du navigateur**. L'ancre pointe sur l'adresse d'origine et
  non sur des octets rapatriés : les justificatifs vivent sur S3 derrière des
  URL pré-signées, et les lire en JavaScript exigerait une politique CORS sur le
  compartiment — une navigation n'en demande aucune. Une ressource protégée par
  un code de rôle, elle, est bien rapatriée puis remise sous forme d'objet blob.
- **share_plus** : `navigator.share` est interrogé avant d'être appelé. Absent —
  Chrome et Firefox sur ordinateur — la liste est copiée dans le presse-papiers
  et l'application affiche **« Liste copiée, collez-la dans WhatsApp »**.

### Habillage et installation sur l'écran d'accueil

`web/index.html` : titre « Santé des extrêmes », `lang="fr"`, description
courte, `theme-color` `#1C1B1A`, `viewport-fit=cover` — sans lui, l'encoche et
la barre d'accueil des iPhone laissent deux bandes blanches.

Quatre balises Apple donnent une vraie icône plein écran : `apple-touch-icon`,
`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`
(`black-translucent`), `apple-mobile-web-app-title`. Sans elles, Safari propose
une capture d'écran en guise d'icône et rouvre l'application dans un onglet.

`web/manifest.json` : name « Santé des extrêmes », short_name « SDE »,
`display: standalone`, `background_color` `#F7F5F2`, `theme_color` `#1C1B1A`,
`start_url` `/`.

Icônes engendrées depuis `assets/logo.jpg` — un paysage de 742 × 541 posé au
centre d'un carré du crème de la charte, le même que le `background_color` pour
qu'aucune bordure ne se voie au lancement : 192, 512, deux **maskables** (le
logo y est réduit à 58 % de la largeur, seuls les 80 % centraux étant à l'abri
du rognage d'Android et d'iOS), un `apple-touch-icon` de 180 et un favicon de
32.

**Écran de chargement** : fond crème et logo centré, avec un trait rouge qui
va et vient. Le premier démarrage télécharge le moteur Flutter — quelques
secondes sur une connexion mobile, pendant lesquelles une page blanche donne
l'impression d'un site cassé. Il s'efface sur l'événement `flutter-first-frame`,
et non après un délai deviné.

### Déploiement

`deploy/web-app.sh`, à exécuter sur l'instance. Il copie `web-build/` vers
`/var/www/sde-web` (`rsync --delete` : les fichiers d'une construction
précédente doivent disparaître), pose
`/etc/nginx/conf.d/app-santedesextremes.conf`, vérifie par `nginx -t`, recharge,
puis traite le certificat.

La configuration nginx : `try_files $uri $uri/ /index.html` (un rechargement de
page ne doit pas tomber sur un 404), gzip sur le JavaScript et le wasm — 3 Mo de
`main.dart.js` contre moins d'un tiers une fois comprimés —, un an de cache sur
`/assets/` et `/canvaskit/`, et **aucun cache** sur `index.html`,
`flutter_service_worker.js` et `version.json` : mis en cache, ils enfermeraient
les membres dans la version précédente, parfois pour des semaines.

**Idempotence.** Le script réécrit la configuration à chaque passage, ce qui
efface le bloc 443 ajouté par certbot. Il le repose donc aussitôt, mais par deux
chemins distincts : `certbot install --nginx --cert-name …` quand le certificat
existe déjà — aucune sollicitation de Let's Encrypt, donc aucun risque de butter
sur ses quotas — et la demande complète seulement au tout premier déploiement.
Relancer le script met à jour les fichiers sans rien redemander.

**Transit par git.** `web-build/` est la construction versionnée dans le dépôt
Flutter : l'instance la reçoit par `git pull`, sans chaîne de construction à
installer. 33 Mo, dont 31 pour CanvasKit. Les fichiers `*.symbols` (6,4 Mo) en
sont retirés : ce sont des tables de symboles de débogage, que nginx ne sert
jamais et qu'aucun fichier du paquet ne référence — vérifié sur
`flutter_bootstrap.js`, `flutter.js`, `index.html` et `canvaskit.js`.

### Backend

`CORS_ORIGINS` acceptait déjà une liste ; rien n'a été modifié dans le code, la
ligne à poser dans le `.env` de l'instance est documentée dans `.env.example` :

```
CORS_ORIGINS=https://app.santedesextremes.com
```

Sans barre oblique finale, protocole compris. Une origine absente de la liste
n'est pas *refusée* : la réponse part sans l'en-tête, et c'est le navigateur qui
la jette — vu du serveur la requête aboutit, d'où des tests qui vérifient
l'**en-tête** et non le code de retour.

### Limites connues sur iOS Safari

- **`navigator.share` exige HTTPS et un geste de l'utilisateur.** Il est présent
  sur Safari iOS ; sur Chrome et Firefox d'ordinateur il ne l'est pas, et le
  repli presse-papiers s'applique.
- **Le nom de fichier proposé au téléchargement n'est pas garanti.** L'attribut
  `download` n'impose le nom que sur une adresse de même origine ; l'API et S3
  sont ailleurs. Le nom vient alors de l'en-tête `Content-Disposition` du
  serveur, ce qui donne le même résultat pour les exports. Sur iOS, un PDF
  s'ouvre le plus souvent dans l'onglet au lieu d'être enregistré : c'est le
  comportement de Safari, pas un défaut de l'application.
- **L'installation sur l'écran d'accueil est manuelle sur iOS** : Safari ne
  propose pas de bandeau d'installation, il faut passer par le bouton Partager.
- **Le stockage d'un site ajouté à l'écran d'accueil peut être purgé** par iOS
  après plusieurs semaines sans ouverture. Le code de rôle mémorisé serait alors
  à ressaisir — une gêne, pas une perte de données.
- **Premier démarrage plus lourd qu'une application installée** : le moteur
  Flutter et CanvasKit pèsent quelques mégaoctets, mis en cache ensuite par
  nginx pour un an.

### Vérifications

| Cas | Attendu | Résultat |
| --- | --- | --- |
| `flutter create --platforms=web .` | `web/` créé, `android/` et `ios/` intacts | OK — 7 fichiers écrits, aucun diff sous `android/` |
| `flutter build web --release --base-href /` | construction complète | OK — `index.html`, `manifest.json`, icônes, `main.dart.js` (3,1 Mo), CanvasKit |
| Balises dans l'**artefact produit** (`build/web/index.html`) | manifeste et quatre balises Apple | OK — les dix contrôles passent, `base href="/"` réécrit |
| `manifest.json` produit | name, short_name, standalone, couleurs, `start_url` | OK — quatre icônes dont deux maskables |
| Message de repli du partage dans le paquet | présent | OK — « Liste copiée, collez-la dans WhatsApp » (échappé `\xe9` par dart2js) |
| Adresse de l'API dans le paquet | inchangée | OK — `sde-api.atlastech.cm` |
| Greffons web résolus | `image_picker_for_web`, `file_picker`, `share_plus`, `url_launcher_web`, `shared_preferences_web` | OK |
| Cinq onglets sur un viewport de 390 px | aucun débordement | OK — `test/viewport_web_test.dart` |
| Cinq onglets sur un écran large (1280 px) | aucun débordement | OK — idem, et navigation d'onglet en onglet aux deux largeurs |
| `flutter analyze` | 0 erreur, 0 avertissement | OK — 119 `info` de style, conformes à l'usage du projet |
| `flutter test` | tests existants toujours verts | OK — **64 verts**, 60 d'avant + 4 nouveaux |
| `flutter build apk --release --target-platform android-arm64` | Android compile encore | OK — 18,7 Mo, aucun écran modifié |
| `bash -n deploy/web-app.sh` | syntaxe correcte | OK |
| Bloc nginx | structure correcte | OK — 1 bloc `server`, 8 `location`, accolades équilibrées, directives terminées, `try_files` / gzip / `no-store` présents. Le `nginx -t` qui fait foi tourne **sur l'instance**, dans le script, avant tout rechargement |
| CORS, origine déclarée | en-tête servi | OK — `Access-Control-Allow-Origin: https://app.santedesextremes.com` |
| CORS, origine tierce | pas d'en-tête | OK — la requête aboutit, l'en-tête est absent |
| CORS, requête préalable `OPTIONS` | `POST` et `authorization` autorisés | OK — sans quoi aucune écriture ne partirait du navigateur |
| CORS, plusieurs origines / défaut `*` | liste honorée, `*` laisse tout passer | OK |
| `npm test` | suite backend verte | OK — **98 verts**, 93 d'avant + 5 dans `tests/lot06-cors-web.test.js` |

**Un défaut corrigé au passage**, révélé par les tests de mise en page :
`setState(() => _donnees = ApiService.getX())` renvoyait un `Future` depuis le
rappel de `setState`, ce qui lève une assertion en mode debug et laisse l'erreur
d'API s'échapper sans porteur. Quatre écrans étaient concernés — Impayés,
Historique, Sanctions, Séance — sur Android comme en web. Corrigé par un corps
de bloc.

### Ce qui ne peut pas être vérifié sans navigateur

Ces points relèvent du contrôle à faire après le déploiement, sur un vrai
appareil. Ils sont écrits ici pour ne pas être oubliés :

- **Déclaration de paiement avec photo** : que le sélecteur s'ouvre, que
  l'appareil photo se déclenche sur iOS Safari, et que la pièce arrive bien sur
  S3. Ce qui est vérifié de ce côté : la pièce est lue en octets et son type est
  déduit de son en-tête, le serveur refusant de toute façon un fichier qui n'est
  pas une image ou un PDF (`verifierTypeReel`, inchangé).
- **Export PDF et Excel** : que le téléchargement se déclenche et que le fichier
  porte le nom servi par l'API. Ce qui est vérifié : les routes d'export sont
  publiques, l'ancre pointe dessus, et les exports eux-mêmes sont couverts par
  la suite backend.
- **Publication du règlement intérieur** : que le sélecteur du navigateur rende
  bien le nom d'origine. Ce qui est vérifié : `PlatformFile.xFile` le porte, et
  `_nomPiece` ne substitue un nom que lorsqu'il n'y en a aucun.
- Le rendu réel des polices, l'icône sur l'écran d'accueil iOS, et le
  comportement de `navigator.share` sur un iPhone.

---

## Résumé pour l'architecte

1. **Même application, deux cibles.** La version web est le même code Flutter,
   même API `https://sde-api.atlastech.cm/api` : rien ne change pour Android,
   aucune rediffusion d'APK.
2. Sur l'instance, **backend** — ajouter la ligne au `.env` puis redémarrer :
   `cd ~/sante-extremes && git pull`, puis dans `backend/.env` :
   `CORS_ORIGINS=https://app.santedesextremes.com`, puis
   `sudo systemctl restart sde-api`.
3. Sur l'instance, **application web** :
   `cd ~/sante-extremes-flutter && git pull && sudo bash deploy/web-app.sh`
   (cloner le dépôt la première fois). Le script est rejouable à chaque livraison.
4. Il copie `web-build/` — la construction versionnée — vers `/var/www/sde-web`,
   pose la configuration nginx, vérifie, recharge, et ne demande le certificat
   qu'au premier passage.
5. **Consigne aux membres iPhone** : ouvrir **https://app.santedesextremes.com**
   dans **Safari** (pas Chrome), toucher le bouton **Partager** en bas de
   l'écran, puis **« Sur l'écran d'accueil »** et **Ajouter**. L'icône Santé des
   extrêmes apparaît alors comme une application, qui s'ouvre en plein écran.
6. Sur Android, le même geste existe dans Chrome (menu ⋮ → « Installer
   l'application »), mais l'APK reste préférable.
7. Aucune autre variable d'environnement à changer ; l'API et sa configuration
   nginx ne sont pas touchées.
8. Contrôle après déploiement :
   `curl -sI https://app.santedesextremes.com | head -3`, puis
   `curl -s -H "Origin: https://app.santedesextremes.com" -D - -o /dev/null https://sde-api.atlastech.cm/api/stats | grep -i access-control`
   — l'en-tête doit apparaître.
9. À la prochaine livraison web : reconstruire en local
   (`flutter build web --release --base-href /`), recopier dans `web-build/`,
   committer, puis rejouer le script sur l'instance.
10. Limites iOS connues : installation manuelle par Safari, nom de fichier des
    téléchargements laissé au serveur, stockage local purgeable après plusieurs
    semaines sans ouverture — le code de rôle serait à ressaisir.
