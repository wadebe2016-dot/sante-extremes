#!/usr/bin/env python3
# Import des membres et cotisations 2026 (janv..août) dans la base SQLite de prod
# Usage : python3 import_sde.py ./data/sde.db
import sqlite3, sys
D = """
Joseph Helmut ESSONO|10,0,0,0,0,0,0,0
David WANGUE|10,10,0,0,0,0,0,0
Guy Roger EBONGUE|10,10,10,10,0,0,0,0
Noureddine AHMADOU|10,10,10,10,0,0,0,0
Andy ONGOLO|0,0,10,10,10,10,0,0
Eric MABINGO|5,0,0,0,0,0,0,0
Adama BEGAM|10,10,10,10,10,0,0,0
Gabriel NJOMO|10,10,10,10,10,0,0,0
Anthony KOTTO|5,5,5,5,0,0,0,0
Bradley KWAMOU|5,5,5,5,0,0,0,0
Fries Roussel SOBZE|10,10,10,10,10,10,5,0
Emmanuel SOCTCHE|5,5,5,5,5,0,0,0
Richard BYANA|5,5,5,5,5,0,0,0
Adrien DJIMEFO|5,5,5,5,5,0,0,0
Gérald FOUTH|10,10,10,10,10,10,10,0
Armand BOADE|10,10,10,10,10,10,10,0
Franck KIARI|10,10,10,10,10,10,10,5
Samuel MASSANG|5,5,5,5,5,5,5,0
Jean Philippe TJOKO|5,5,5,5,5,5,5,0
Jean Bosco NGEND|5,5,5,5,5,5,5,0
Boniface MBELECK|5,5,5,5,5,5,5,0
Christian NKOUM|10,10,10,10,10,10,10,10
Merveille BADJECK|10,10,10,10,10,10,10,10
Lejeune MOUYEME|5,5,5,5,5,5,5,5
Emmanuel BELLA|10,10,10,10,10,10,10,10
Olivier DZOU|10,10,10,10,10,10,10,10
Stéphane DOOGNE|0,0,0,0,0,10,10,10
Thomas MENGUE|10,10,10,10,10,10,10,10
Vanex MBEUNANG|10,10,10,10,10,10,10,10
Barthelemy NGUEFEU|10,10,10,10,10,10,10,10
Christian MOUYEME|10,10,10,10,10,10,10,10
NOUBISSE|0,0,0,0,0,0,0,10
Anthony FOUDA|0,0,0,0,0,0,0,10
Jordan LUOUCDOM|5,5,5,5,5,5,5,10
Edouard ATSAFACK|10,10,10,10,10,10,10,10
Rameaux TCHAMBIA|5,5,5,5,5,5,5,5
Christophe WADEBE|10,10,10,10,10,10,10,10
Junior JIDJOU|10,10,10,10,10,10,10,10
"""
db = sys.argv[1] if len(sys.argv) > 1 else "./data/sde.db"
c = sqlite3.connect(db); cur = c.cursor()
nm = nc = total = 0
for line in D.strip().splitlines():
    name, months = line.split("|")
    cur.execute("INSERT OR IGNORE INTO members (name, created_at) VALUES (?, datetime('now'))", (name,))
    nm += cur.rowcount
    mid = cur.execute("SELECT id FROM members WHERE name=?", (name,)).fetchone()[0]
    for i, v in enumerate(months.split(","), start=1):
        if int(v):
            montant = int(v) * 1000
            date = f"2026-{i:02d}-05T12:00:00Z"
            if not cur.execute("SELECT 1 FROM cotisations WHERE member_id=? AND date_paiement=?", (mid, date)).fetchone():
                cur.execute("INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url, date_paiement) VALUES (?,?,?,NULL,?)",
                            (mid, montant, "Espèce", date))
                nc += 1; total += montant
c.commit(); c.close()
print(f"{nm} membres ajoutés, {nc} cotisations ajoutées, total {total:,} XAF".replace(",", " "))
