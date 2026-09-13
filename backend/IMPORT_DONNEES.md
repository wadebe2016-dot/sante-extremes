# 📥 IMPORT DES DONNÉES — Santé des extrêmes

**3 fichiers livrés :**
1. `sante-extremes-cotisations.xlsx` — Données Excel (exemple)
2. `import_cotisations.py` — Script d'import SQLite
3. `IMPORT_DONNEES.md` — Cette doc

---

## 🚀 Étape 1 : Préparer les données

### Option A — Utiliser le fichier Excel fourni
L'Excel `sante-extremes-cotisations.xlsx` contient des données d'exemple :
- 5 membres (Alice, Bob, Charlie, Diana, Eve)
- Cotisations mensuelles (Sept, Oct, Nov, Dec, etc.)
- Montants de 10,000 XAF chacun

**Vous pouvez l'éditer :** ajouter/modifier les lignes comme vous voulez.

### Option B — Vos propres données
1. Créez un Excel avec cette structure :

```
| ID | Nom | Sept | Oct | Nov | Dec | ... | Total | Remarques |
|----|-----|------|-----|-----|-----|-----|-------|-----------|
| 1  | Alice | 10000 | 10000 | 10000 | ... |
```

---

## 🚀 Étape 2 : Exécuter l'import

### Sur Windows (PowerShell)

```powershell
# Aller dans le dossier backend
cd C:\Users\wadeb\sante-extremes\backend

# Copier les fichiers
Copy-Item "C:\Users\wadeb\Downloads\Compressed\sante-extremes-cotisations.xlsx" -Destination .
Copy-Item "C:\Users\wadeb\Downloads\Compressed\import_cotisations.py" -Destination .

# Exécuter l'import
python import_cotisations.py sante-extremes-cotisations.xlsx ./data/sde.db
```

### Résultat attendu

```
📥 Importation depuis sante-extremes-cotisations.xlsx
📦 Base de données : ./data/sde.db

✓ Membre ajouté : Alice Dupont
  → Cotisation Sept : 10000 XAF
  → Cotisation Oct : 10000 XAF
  → Cotisation Nov : 10000 XAF
✓ Membre ajouté : Bob Martin
  → Cotisation Sept : 10000 XAF
  → Cotisation Oct : 10000 XAF
...

✅ Import terminé !
  • 5 membres ajoutés
  • 14 cotisations ajoutées
```

---

## 🔄 Étape 3 : Vérifier les données

### Via SQLite

```powershell
# Lancer SQLite
sqlite3 ./data/sde.db

# Vérifier les membres
sqlite> SELECT * FROM members;

# Vérifier les cotisations
sqlite> SELECT * FROM cotisations;

# Quitter
sqlite> .exit
```

### Via l'app Flutter

1. Redémarrez le backend : `npm start`
2. L'app affiche automatiquement les membres + statut paiement ✅

---

## ⚙️ Format du fichier Excel

**Colonnes obligatoires :**
- **A** : ID (1, 2, 3, ...)
- **B** : Nom (Alice, Bob, ...)
- **C+** : Montants par mois

**Montants :**
- Valeurs numériques (10000, 5000, etc.)
- Laisser vide si pas de paiement ce mois
- Les montants sont cumulés dans "Total annuel"

**Remarques :**
- La colonne "Remarques" n'est pas importée (à titre informatif)

---

## 🛠️ Personnaliser l'import

Si vous avez besoin de modifier le script :

**Fichier :** `import_cotisations.py`

**Modifier les mois :**
```python
months_columns = {
    "Sept": 3,    # Colonne C
    "Oct": 4,     # Colonne D
    ...
}
```

**Modifier le moyen de paiement par défaut :**
```python
cursor.execute(
    "INSERT INTO cotisations (...) VALUES (...)",
    (..., "Mobile Money", ...)  # Changer "Espèce" en "Mobile Money"
)
```

---

## 📋 Checklist

- [ ] Fichier Excel préparé (`sante-extremes-cotisations.xlsx`)
- [ ] Script Python copié dans le dossier backend
- [ ] Backend arrêté (`Ctrl+C` si `npm start` en cours)
- [ ] Import exécuté : `python import_cotisations.py ...`
- [ ] ✅ Import réussi (message "Import terminé !")
- [ ] Backend redémarré : `npm start`
- [ ] App Flutter ouverte
- [ ] Tableau public affiche les membres ✓

---

## 🚨 Problèmes courants

| Problème | Solution |
|----------|----------|
| `ModuleNotFoundError: No module named 'openpyxl'` | `pip install openpyxl` |
| `No such table: members` | Vérifier que le backend a bien créé les tables : `npm run migrate` |
| `database is locked` | Arrêter le backend avant l'import |
| Les données n'apparaissent pas dans l'app | Redémarrer le backend après l'import |

---

## 💡 Tips

- **Sauvegardez votre Excel** avant chaque import
- **Testez avec un petit jeu de données d'abord** (2-3 membres)
- **Re-exécutez l'import** si vous modifiez l'Excel (attention aux doublons)

---

**Questions ?** Consultez le README du backend ou le script Python directement.

Bon import ! 🚀
