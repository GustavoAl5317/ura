"""Teste das rotas de tráfego por interface com banco e login simulados.

Uso (na pasta docs/flow-guard, com fastapi e python-jose instalados):
    python teste_rota_interfaces.py
"""
import os
import sqlite3
import sys
import tempfile
import time
import types
from contextlib import contextmanager

os.environ["FLOW_READONLY_API_KEY"] = "LEITURA"
DB = os.path.join(tempfile.mkdtemp(), "flow.db")

# ── módulos "auth" e "database" como os da Flow Guard ─────────────────────────
from fastapi import HTTPException, Request  # noqa: E402

auth = types.ModuleType("auth")


def get_current_user(request: Request):
    if request.headers.get("authorization") != "Bearer LEITURA":
        raise HTTPException(status_code=401)
    if request.method not in ("GET", "HEAD"):
        raise HTTPException(status_code=403)
    return {"username": "assistente", "role": "readonly"}


auth.get_current_user = get_current_user
sys.modules["auth"] = auth

database = types.ModuleType("database")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


database.get_db = get_db
sys.modules["database"] = database

c = sqlite3.connect(DB)
c.execute("""CREATE TABLE events (id INTEGER PRIMARY KEY, tstamp INTEGER, source TEXT, bytes INTEGER,
             packets INTEGER, in_if INTEGER, out_if INTEGER)""")
agora = int(time.time())
linhas = []
for i in range(600):                       # última hora: IX (156) → cliente (500)
    linhas.append((agora - 3000 + i, "goflow2", 1000, 1, 156, 500))
for i in range(200):                       # Angola (488) → cliente (500)
    linhas.append((agora - 3000 + i, "goflow2", 500, 1, 488, 500))
for i in range(100):                       # upload do cliente para o IX
    linhas.append((agora - 1000 + i, "goflow2", 300, 1, 500, 156))
linhas.append((agora - 90000, "goflow2", 999999, 1, 156, 500))     # fora da janela
linhas.append((agora - 100, "ntopng", 999999, 1, 156, 500))        # outra origem
c.executemany("INSERT INTO events (tstamp, source, bytes, packets, in_if, out_if) VALUES (?,?,?,?,?,?)", linhas)
c.commit()
c.close()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from rota_interfaces import router  # noqa: E402

app = FastAPI()
app.include_router(router)
cli = TestClient(app)
H = {"Authorization": "Bearer LEITURA"}

ok = True


def checa(rot, cond, det=""):
    global ok
    print(("  ✓ " if cond else "  ✗ ") + rot + ("" if cond else f"   {det}"))
    ok &= bool(cond)


r = cli.get(f"/api/netflow/interfaces-trafego?epoch_begin={agora-3600}&epoch_end={agora+1}", headers=H)
rec = r.json()["records"]
checa("responde 200", r.status_code == 200, r.text)
checa("par mais volumoso primeiro (IX → cliente, 600 000 bytes)", rec[0] == {"in_if": 156, "out_if": 500, "bytes": 600000, "packets": 600, "flows": 600}, rec[:1])
checa("três pares na janela, sem o antigo e sem outra origem", len(rec) == 3 and sum(x["bytes"] for x in rec) == 600000 + 100000 + 30000, rec)

r = cli.get(f"/api/netflow/interface-timeseries?ifindex=156&epoch_begin={agora-3600}&epoch_end={agora+1}&bucket_seconds=3600", headers=H)
s = r.json()["records"]
checa("série da interface separa entrada e saída", sum(x["in_bytes"] for x in s) == 600000 and sum(x["out_bytes"] for x in s) == 30000, s)
checa("não mistura tráfego de outra interface", all(x["flows"] <= 700 for x in s), s)

checa("sem chave: 401", cli.get("/api/netflow/interfaces-trafego").status_code == 401)
checa("limite máximo validado", cli.get("/api/netflow/interfaces-trafego?limit=9999", headers=H).status_code == 422)
checa("ifindex obrigatório na série", cli.get("/api/netflow/interface-timeseries", headers=H).status_code == 422)
print("OK" if ok else "FALHOU")
sys.exit(0 if ok else 1)
