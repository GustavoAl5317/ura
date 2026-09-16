import os, sys
os.environ["FLOW_COLLECTOR_API_KEY"] = "COLETOR"
os.environ["FLOW_READONLY_API_KEY"] = "LEITURA"
sys.path.insert(0, os.path.dirname(__file__))
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
import auth
app = FastAPI()
@app.get("/api/netflow/summary")
def s(u: dict = Depends(auth.get_current_user)): return u
@app.post("/api/events/bulk")
def b(u: dict = Depends(auth.get_current_user)): return u
@app.delete("/api/ip-blocks/1")
def d(u: dict = Depends(auth.get_current_user)): return u
c = TestClient(app)
H = lambda k: {"Authorization": f"Bearer {k}"}
jwt_admin = auth.create_access_token({"sub": "admin", "role": "admin"})
casos = [
  ("leitura faz GET", c.get("/api/netflow/summary", headers=H("LEITURA")).status_code == 200),
  ("leitura NÃO faz POST", c.post("/api/events/bulk", headers=H("LEITURA")).status_code == 403),
  ("leitura NÃO faz DELETE", c.delete("/api/ip-blocks/1", headers=H("LEITURA")).status_code == 403),
  ("coletor continua gravando", c.post("/api/events/bulk", headers=H("COLETOR")).status_code == 200),
  ("login do painel (JWT) continua com acesso total", c.delete("/api/ip-blocks/1", headers=H(jwt_admin)).status_code == 200),
  ("chave errada continua 401", c.get("/api/netflow/summary", headers=H("ERRADA")).status_code == 401),
  ("sem chave continua 401", c.get("/api/netflow/summary").status_code == 401),
]
for r, ok in casos: print(("  ✓ " if ok else "  ✗ ") + r)
print("OK" if all(ok for _, ok in casos) else "FALHOU")
