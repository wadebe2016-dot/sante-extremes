#!/usr/bin/env python3
# Rapprochement du bilan financier BAV du 25/09/2026 avec la base de production.
# Ajoute le membre manquant et les cotisations absentes (janvier -> septembre 2026).
# Idempotent : relancer ne crée aucun doublon.
# Usage : python3 rapprochement_bilan.py ./data/sde.db
import sqlite3, sys

MEMBRE_NOUVEAU = [("Jordan OSIRIS", 5000, "2026-09")]

# nom en base ; mois AAAA-MM ; montant
ECARTS = """
Andy ONGOLO|2026-07|10000
Andy ONGOLO|2026-08|10000
Bradley KWAMOU|2026-05|5000
Bradley KWAMOU|2026-06|5000
Gérald FOUTH|2026-08|10000
Gérald FOUTH|2026-09|10000
Barthelemy NGUEFEU|2026-09|10000
Olivier DZOU|2026-09|10000
NOUBISSE|2026-09|10000
Jean Bosco NGEND|2026-08|5000
Jean Philippe TJOKO|2026-08|5000
Samuel MASSANG|2026-08|5000
Jordan OSIRIS|2026-09|5000
"""

# corrections de montant sur une cotisation déjà présente : nom ; mois ; ancien ; nouveau
CORRECTIONS = """
Franck KIARI|2026-08|5000|10000
Franck KIARI|2026-09|5000|10000
"""

db = sys.argv[1] if len(sys.argv) > 1 else "./data/sde.db"
c = sqlite3.connect(db); cur = c.cursor()

nm = nc = ncor = 0
for nom, contrib, adhesion in MEMBRE_NOUVEAU:
    if not cur.execute("SELECT 1 FROM members WHERE name=?", (nom,)).fetchone():
        cur.execute("INSERT INTO members (name, contribution, date_adhesion, statut, created_at) "
                    "VALUES (?,?,?,'actif',datetime('now'))", (nom, contrib, adhesion + "-01"))
        nm += 1
        print(f"  membre créé : {nom} ({contrib}/mois, adhésion {adhesion})")

for ligne in ECARTS.strip().splitlines():
    nom, mois, montant = ligne.split("|")
    r = cur.execute("SELECT id FROM members WHERE name=?", (nom,)).fetchone()
    if not r:
        print(f"  !! membre introuvable : {nom}"); continue
    mid = r[0]
    date = f"{mois}-05T12:00:00Z"
    if cur.execute("SELECT 1 FROM cotisations WHERE member_id=? AND date_paiement=? AND statut='validee'",
                   (mid, date)).fetchone():
        continue
    cur.execute("INSERT INTO cotisations (member_id, montant, moyen, fichier_s3_url, date_paiement, "
                "date_versement, statut, valide_par, date_validation) "
                "VALUES (?,?,?,NULL,?,?, 'validee','Reprise bilan BAV', datetime('now'))",
                (mid, int(montant), "Espèce", date, date))
    nc += 1
    print(f"  cotisation ajoutée : {nom} {mois} {montant}")

for ligne in CORRECTIONS.strip().splitlines():
    nom, mois, ancien, nouveau = ligne.split("|")
    r = cur.execute("SELECT id FROM members WHERE name=?", (nom,)).fetchone()
    if not r: continue
    mid = r[0]; date = f"{mois}-05T12:00:00Z"
    n = cur.execute("UPDATE cotisations SET montant=? WHERE member_id=? AND date_paiement=? "
                    "AND statut='validee' AND montant=?",
                    (int(nouveau), mid, date, int(ancien))).rowcount
    if n:
        ncor += n
        print(f"  montant corrigé : {nom} {mois} {ancien} -> {nouveau}")

c.commit()
total = cur.execute("SELECT sum(montant) FROM cotisations WHERE statut='validee'").fetchone()[0]
nbm = cur.execute("SELECT count(*) FROM members").fetchone()[0]
print(f"\n{nm} membre(s), {nc} cotisation(s), {ncor} correction(s)")
print(f"{nbm} membres | total validé : {int(total):,} XAF".replace(",", " "))
c.close()
