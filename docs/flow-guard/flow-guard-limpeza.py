#!/usr/bin/env python3
"""Apaga eventos da Flow Guard mais antigos que RETENCAO_DIAS (padrão 7).

Apaga em lotes pequenos, com pausa entre eles: a API grava no mesmo banco o
tempo todo e espera no máximo 5 s por uma trava. Lote grande seguraria o
banco e o coletor perderia envios. O arquivo não encolhe — o SQLite reaproveita
o espaço liberado para os eventos novos.

Uso: flow-guard-limpeza.py [caminho do flow.db]   (cron diário)
"""
import os
import sqlite3
import sys
import time

DB = sys.argv[1] if len(sys.argv) > 1 else "/home/flow/flow-ntop/backend/flow.db"
DIAS = int(os.getenv("RETENCAO_DIAS", "7"))
LOTE = int(os.getenv("LOTE", "5000"))
PAUSA = float(os.getenv("PAUSA", "0.3"))


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def main():
    corte = int(time.time()) - DIAS * 86400
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout = 30000")
    total, t0 = 0, time.time()
    log(f"limpeza: apagando eventos anteriores a {time.strftime('%Y-%m-%d %H:%M', time.localtime(corte))} ({DIAS} dias)")
    while True:
        cur = c.execute(
            "DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE tstamp < ? LIMIT ?)",
            (corte, LOTE),
        )
        c.commit()
        n = cur.rowcount
        total += n
        if n < LOTE:
            break
        if total % (LOTE * 100) == 0:
            log(f"limpeza: {total} apagados até agora")
        time.sleep(PAUSA)
    restantes = c.execute("SELECT COUNT(*) FROM events WHERE tstamp < ?", (corte,)).fetchone()[0]
    log(f"limpeza: fim — {total} apagados em {time.time() - t0:.0f}s; antigos restantes: {restantes}")
    c.close()


if __name__ == "__main__":
    main()
