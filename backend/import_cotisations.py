#!/usr/bin/env python3
"""
Script d'import des cotisations dans SQLite
Usage: python import_cotisations.py <path_to_excel> <path_to_db>
"""

import sqlite3
import openpyxl
import sys
from datetime import datetime

def import_cotisations(excel_file, db_path):
    """Importe les données Excel dans la base SQLite"""
    
    # Connexion à la base
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Charger le fichier Excel
    wb = openpyxl.load_workbook(excel_file)
    ws = wb.active
    
    # Mappage des mois aux colonnes
    months_columns = {
        "Sept": 3,   # Colonne C
        "Oct": 4,    # Colonne D
        "Nov": 5,    # Colonne E
        "Dec": 6,
        "Jan": 7,
        "Fev": 8,
        "Mars": 9,
        "Avr": 10,
        "Mai": 11,
        "Juin": 12,
        "Juil": 13,
        "Aout": 14,
        "Sept(2)": 15,
    }
    
    # Lire les données
    members_added = 0
    cotisations_added = 0
    
    for row_num in range(2, ws.max_row + 1):
        member_id = ws.cell(row=row_num, column=1).value
        member_name = ws.cell(row=row_num, column=2).value
        
        if not member_name:
            continue
        
        # Ajouter le membre
        try:
            cursor.execute(
                "INSERT INTO members (id, name, created_at) VALUES (?, ?, ?)",
                (member_id, member_name, datetime.now().isoformat())
            )
            members_added += 1
            print(f"✓ Membre ajouté : {member_name}")
        except sqlite3.IntegrityError:
            print(f"⚠ Membre déjà existant : {member_name}")
        
        # Ajouter les cotisations pour chaque mois
        for month_name, col_num in months_columns.items():
            montant = ws.cell(row=row_num, column=col_num).value
            
            if montant and montant > 0:
                # Déterminer la date approximative du paiement
                # (1er du mois, mais peut être ajusté)
                date_paiement = datetime.now().isoformat()
                
                try:
                    cursor.execute(
                        "INSERT INTO cotisations (member_id, montant, moyen, date_paiement, created_at) VALUES (?, ?, ?, ?, ?)",
                        (member_id, montant, "Espèce", date_paiement, datetime.now().isoformat())
                    )
                    cotisations_added += 1
                    print(f"  → Cotisation {month_name} : {montant} XAF")
                except Exception as e:
                    print(f"  ✗ Erreur cotisation : {e}")
    
    # Commit et fermer
    conn.commit()
    conn.close()
    
    print(f"\n✅ Import terminé !")
    print(f"  • {members_added} membres ajoutés")
    print(f"  • {cotisations_added} cotisations ajoutées")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python import_cotisations.py <excel_file> <db_path>")
        print("\nExemple:")
        print("  python import_cotisations.py sante-extremes-cotisations.xlsx ./data/sde.db")
        sys.exit(1)
    
    excel_file = sys.argv[1]
    db_path = sys.argv[2]
    
    print(f"📥 Importation depuis {excel_file}")
    print(f"📦 Base de données : {db_path}\n")
    
    import_cotisations(excel_file, db_path)
