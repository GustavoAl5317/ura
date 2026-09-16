import json, os, sys, threading, time, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

base = Path(tempfile.mkdtemp())
arq = base / "flows.json"
arq.write_bytes(b'{"antigo": 1}\n' * 50)      # backlog antigo: não deve ser enviado

recebidos, pedidos = [], {"n": 0, "falhar": 2}
class API(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        corpo = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        pedidos["n"] += 1
        ok_auth = self.headers.get("Authorization") == "Bearer TOKEN-TESTE"
        if pedidos["falhar"] > 0:
            pedidos["falhar"] -= 1
            self.send_response(500); self.end_headers(); self.wfile.write(b"erro"); return
        if ok_auth:
            recebidos.extend(corpo["events"])
        self.send_response(200 if ok_auth else 401); self.end_headers(); self.wfile.write(b'{"inserted":1}')
srv = ThreadingHTTPServer(("127.0.0.1", 0), API)
threading.Thread(target=srv.serve_forever, daemon=True).start()

os.environ["FLOW_FILE"] = str(arq)
os.environ["FLOW_API_URL"] = f"http://127.0.0.1:{srv.server_port}/api/events/bulk"
os.environ["FLOW_BATCH_SIZE"] = "100"
src = (Path(sys.argv[1]) / "collector.py").read_text(encoding="utf-8").replace("__TOKEN__", "TOKEN-TESTE")
mod = {"__name__": "coletor"}
exec(compile(src, "collector.py", "exec"), mod)
threading.Thread(target=mod["main"], daemon=True).start()
time.sleep(1)

escritos = []
def escrever(n, inicio):
    with arq.open("ab") as f:
        for i in range(n):
            ns = (1789580000 + inicio + i) * 1_000_000_000
            d = {"src_addr": f"100.64.0.{i % 250}", "dst_addr": "8.8.8.8", "bytes": 100, "proto": "UDP", "time_received_ns": ns, "sampler_address": "10.11.0.254"}
            linha = json.dumps(d) + "\n"
            # escreve metade da linha, espera, e o resto: simula gravação parcial
            if i % 97 == 0:
                f.write(linha[:10].encode()); f.flush(); time.sleep(0.01); f.write(linha[10:].encode())
            else:
                f.write(linha.encode())
            f.flush()
            escritos.append(1789580000 + inicio + i)
            if i % 50 == 0: time.sleep(0.02)

escrever(1500, 0)
time.sleep(6)
fase1 = len(recebidos)
# esvazia o arquivo como o agendamento fará
with arq.open("r+b") as f: f.truncate(0)
time.sleep(1)
escrever(700, 10000)
time.sleep(6)

ok = True
def checa(r, c, d=""):
    global ok
    print(("  ✓ " if c else "  ✗ ") + r + ("" if c else f"   {d}")); ok &= c
checa("antes de esvaziar: todos os 1500 fluxos novos enviados (backlog antigo ignorado)", fase1 == 1500, fase1)
checa("depois de esvaziar: os 700 novos também", len(recebidos) == 2200, len(recebidos))
checa("nenhum fluxo duplicado", len({(e["tstamp"], e["src_ip"]) for e in recebidos}) == len(recebidos))
checa("tstamp é a hora do fluxo, não a do envio", sorted(e["tstamp"] for e in recebidos) == sorted(escritos))
checa("sem o campo raw", all("raw" not in e for e in recebidos))
checa("falha 500 foi repetida, nada descartado", mod["stats"]["descartados"] == 0 and mod["stats"]["falhas"] == 2, mod["stats"])
checa("linha gravada pela metade não gerou erro de leitura", mod["stats"]["parse"] == 0, mod["stats"])
print("OK" if ok else "FALHOU")
