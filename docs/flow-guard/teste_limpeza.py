import os, sqlite3, subprocess, sys, tempfile, time, threading
d = tempfile.mkdtemp(); db = os.path.join(d, "flow.db")
c = sqlite3.connect(db)
c.execute("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, tstamp INTEGER, ip TEXT, raw_json TEXT)")
c.execute("CREATE INDEX idx_events_tstamp ON events(tstamp)")
agora = int(time.time())
velhos = [(agora - 30*86400 + i, "1.1.1.1", "x"*50) for i in range(23000)]
novos = [(agora - 3600 + i, "2.2.2.2", "y") for i in range(1000)]
c.executemany("INSERT INTO events (tstamp, ip, raw_json) VALUES (?,?,?)", velhos + novos); c.commit(); c.close()

# escritor simulando a API durante a limpeza (timeout de 5 s como a API)
erros = []
def escritor():
    w = sqlite3.connect(db, timeout=5)
    for i in range(60):
        try:
            w.execute("INSERT INTO events (tstamp, ip, raw_json) VALUES (?,?,?)", (agora, "3.3.3.3", "z")); w.commit()
        except Exception as e:
            erros.append(str(e))
        time.sleep(0.02)
t = threading.Thread(target=escritor); t.start()
env = dict(os.environ, LOTE="1000", PAUSA="0.05")
r = subprocess.run([sys.executable, sys.argv[1], db], capture_output=True, text=True, env=env)
t.join()
c = sqlite3.connect(db)
ok = True
def checa(rot, cond, det=""):
    global ok; print(("  ✓ " if cond else "  ✗ ") + rot + ("" if cond else f"  {det}")); ok &= cond
checa("apagou os 23.000 antigos", c.execute("SELECT COUNT(*) FROM events WHERE tstamp < ?", (agora - 7*86400,)).fetchone()[0] == 0, r.stdout)
checa("manteve os 1.000 recentes", c.execute("SELECT COUNT(*) FROM events WHERE ip='2.2.2.2'").fetchone()[0] == 1000)
checa("gravações simultâneas não falharam", not erros and c.execute("SELECT COUNT(*) FROM events WHERE ip='3.3.3.3'").fetchone()[0] == 60, erros[:2])
checa("log final informa o total", "23000 apagados" in r.stdout, r.stdout + r.stderr)
print("OK" if ok else "FALHOU")
