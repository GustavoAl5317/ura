"""Flow Guard - coletor GoFlow2 -> API (v2, 16/09/2026).

Mudancas em relacao a v1, e por que:
- tstamp = hora do FLUXO (time_received_ns), nao a hora do envio. Com a v1
  atrasada, trafego de horas atras entrava como se fosse de agora.
- sem o campo "raw": a API grava o evento inteiro em raw_json, que nunca e
  lido; o fluxo bruto ia duplicado e cada linha ocupava ~2,2 KB.
- lotes de 500, sem pausa fixa: a v1 enviava no maximo ~50 fluxos/s e o
  roteador manda ~170/s.
- percebe quando o flows.json e esvaziado ou trocado e volta ao inicio.
- repete o envio que falhou (ate 3 vezes) e registra o atraso a cada minuto.
"""

import json
import os
import time
from pathlib import Path

import requests

FLOW_FILE = Path(os.getenv("FLOW_FILE", "/flows/flows.json"))
API_URL = os.getenv("FLOW_API_URL", "http://127.0.0.1:8000/api/events/bulk")
API_TOKEN = "__TOKEN__"

BATCH_SIZE = int(os.getenv("FLOW_BATCH_SIZE", "500"))
MAX_WAIT_S = 2.0          # lote parcial sai depois disso
TIMEOUT_S = 30
TENTATIVAS = 3
STATS_S = 60

stats = {"enviados": 0, "falhas": 0, "descartados": 0, "parse": 0}


def ts_do_fluxo(flow):
    for chave in ("time_received_ns", "time_flow_end_ns", "time_received"):
        v = flow.get(chave)
        if v:
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
            return v // 1_000_000_000 if v > 10**12 else v
    return int(time.time())


def convert_flow(flow):
    return {
        "tstamp": ts_do_fluxo(flow),
        "source": "goflow2",
        "alert_id": 90001,
        "sampler": flow.get("sampler_address"),
        "src_ip": flow.get("src_addr"),
        "dst_ip": flow.get("dst_addr"),
        "src_port": flow.get("src_port"),
        "dst_port": flow.get("dst_port"),
        "protocol": flow.get("proto"),
        "bytes": flow.get("bytes", 0),
        "packets": flow.get("packets", 0),
        "src_as": flow.get("src_as"),
        "dst_as": flow.get("dst_as"),
        "src_net": flow.get("src_net"),
        "dst_net": flow.get("dst_net"),
        "in_if": flow.get("in_if"),
        "out_if": flow.get("out_if"),
        "next_hop": flow.get("next_hop"),
        "flow_start_ns": flow.get("time_flow_start_ns"),
        "flow_end_ns": flow.get("time_flow_end_ns"),
        "received_ns": flow.get("time_received_ns"),
    }


class Leitor:
    """Acompanha o arquivo como um tail -F: sobrevive a truncate e a troca."""

    def __init__(self, path):
        self.path = path
        self.f = None
        self.inode = None
        self.resto = b""

    def abrir(self, do_fim):
        if self.f:
            self.f.close()
        self.f = self.path.open("rb")
        self.inode = os.fstat(self.f.fileno()).st_ino
        self.resto = b""
        if do_fim:
            self.f.seek(0, 2)

    def atraso_bytes(self):
        try:
            return max(0, self.path.stat().st_size - self.f.tell())
        except FileNotFoundError:
            return 0

    def linhas(self, maximo):
        pedaco = self.f.read(256 * 1024)
        if not pedaco:
            self._conferir_arquivo()
            return []
        dados = self.resto + pedaco
        partes = dados.split(b"\n")
        self.resto = partes.pop()        # linha incompleta fica para depois
        return [p for p in partes if p.strip()]

    def _conferir_arquivo(self):
        try:
            st = self.path.stat()
        except FileNotFoundError:
            return
        if st.st_ino != self.inode:
            print("flows.json foi trocado; abrindo o novo do inicio", flush=True)
            self.abrir(do_fim=False)
        elif st.st_size < self.f.tell():
            print("flows.json foi esvaziado; lendo do inicio", flush=True)
            self.f.seek(0)
            self.resto = b""


def send_batch(sessao, batch):
    for tentativa in range(1, TENTATIVAS + 1):
        try:
            r = sessao.post(API_URL, json={"events": batch}, timeout=TIMEOUT_S)
            if r.status_code == 200:
                stats["enviados"] += len(batch)
                return
            erro = f"status={r.status_code} body={r.text[:200]}"
        except Exception as e:  # noqa: BLE001
            erro = f"send_error={e}"
        stats["falhas"] += 1
        print(f"falha no envio (tentativa {tentativa}/{TENTATIVAS}): {erro}", flush=True)
        time.sleep(2 * tentativa)
    stats["descartados"] += len(batch)


def main():
    print("Flow Guard GoFlow2 collector v2 started", flush=True)
    sessao = requests.Session()
    sessao.headers.update({"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"})

    while not FLOW_FILE.exists():
        print("waiting for flows.json...", flush=True)
        time.sleep(2)

    leitor = Leitor(FLOW_FILE)
    leitor.abrir(do_fim=True)
    batch = []
    primeiro_em = None
    ultimo_stats = time.monotonic()

    while True:
        novas = leitor.linhas(BATCH_SIZE)
        for linha in novas:
            try:
                batch.append(convert_flow(json.loads(linha)))
            except Exception:  # noqa: BLE001
                stats["parse"] += 1
                continue
            if primeiro_em is None:
                primeiro_em = time.monotonic()
            if len(batch) >= BATCH_SIZE:
                send_batch(sessao, batch)
                batch, primeiro_em = [], None

        if batch and primeiro_em is not None and time.monotonic() - primeiro_em >= MAX_WAIT_S:
            send_batch(sessao, batch)
            batch, primeiro_em = [], None

        agora = time.monotonic()
        if agora - ultimo_stats >= STATS_S:
            print(
                f"stats enviados={stats['enviados']} falhas={stats['falhas']} "
                f"descartados={stats['descartados']} parse_error={stats['parse']} "
                f"atraso_kb={leitor.atraso_bytes() // 1024}",
                flush=True,
            )
            ultimo_stats = agora

        if not novas:
            time.sleep(0.2)


if __name__ == "__main__":
    main()
