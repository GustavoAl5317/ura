"""Tráfego por interface (link) — rotas SOMENTE LEITURA da Flow Guard API.

Adicionadas para o assistente de observabilidade (16/09/2026): o roteador que
exporta o NetFlow (NE20E-AQUI-VS-BGP) está com SNMP fora, então o NetFlow é a
única visão de tráfego por link. Os volumes são AMOSTRADOS (1:N), como no resto
da API: quem consome multiplica pelo fator.

Ligadas ao app por uma linha no fim do main.py:
    from rota_interfaces import router as rota_interfaces; app.include_router(rota_interfaces)
"""
import time

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from database import get_db

router = APIRouter()


def _janela(epoch_begin, epoch_end, padrao_seg=3600):
    fim = int(epoch_end or time.time())
    ini = int(epoch_begin or fim - padrao_seg)
    return ini, fim


@router.get("/api/netflow/interfaces-trafego")
def trafego_por_interface(
    epoch_begin: int | None = None,
    epoch_end: int | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    user: dict = Depends(get_current_user),
) -> dict:
    """Volume por par (interface de entrada, interface de saída) na janela."""
    ini, fim = _janela(epoch_begin, epoch_end)
    with get_db() as conn:
        linhas = conn.execute(
            """SELECT in_if, out_if, SUM(bytes) AS bytes, SUM(packets) AS packets, COUNT(*) AS flows
               FROM events
               WHERE source = 'goflow2' AND tstamp >= ? AND tstamp < ?
               GROUP BY in_if, out_if
               ORDER BY bytes DESC
               LIMIT ?""",
            (ini, fim, limit),
        ).fetchall()
    return {"epoch_begin": ini, "epoch_end": fim, "records": [dict(r) for r in linhas]}


@router.get("/api/netflow/interface-timeseries")
def serie_da_interface(
    ifindex: int,
    epoch_begin: int | None = None,
    epoch_end: int | None = None,
    bucket_seconds: int = Query(default=300, ge=60, le=86400),
    user: dict = Depends(get_current_user),
) -> dict:
    """Série de uma interface: bytes que entraram e que saíram por ela, por intervalo."""
    ini, fim = _janela(epoch_begin, epoch_end)
    b = bucket_seconds
    with get_db() as conn:
        linhas = conn.execute(
            """SELECT (tstamp / ?) * ? AS bucket,
                      SUM(CASE WHEN in_if = ? THEN bytes ELSE 0 END) AS in_bytes,
                      SUM(CASE WHEN out_if = ? THEN bytes ELSE 0 END) AS out_bytes,
                      COUNT(*) AS flows
               FROM events
               WHERE source = 'goflow2' AND tstamp >= ? AND tstamp < ?
                 AND (in_if = ? OR out_if = ?)
               GROUP BY bucket
               ORDER BY bucket""",
            (b, b, ifindex, ifindex, ini, fim, ifindex, ifindex),
        ).fetchall()
    return {"ifindex": ifindex, "epoch_begin": ini, "epoch_end": fim, "bucket_seconds": b,
            "records": [dict(r) for r in linhas]}
