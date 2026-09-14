// Rotas de operação (Bloco 4): alertas, chamadas da URA, monitores e stream ao vivo.

import { Rota, json, lerJson, ator, ErroHttp } from './http-util';
import { assinar, eventosRecentes } from './eventos';
import { listar as listarAlertas, reconhecer } from './alertas';
import { receberEventoUra, listarChamadas, EventoUra } from './monitors/ura';
import { estadoMonitores } from './monitors/base';
import { diagnosticoSla } from './monitors/sla';
import { montarResumo, enviarResumoManual } from './resumo-diario';

export const rotasOperacao: Rota = async (req, res, url, p) => {
  // ── Stream ao vivo do painel ──────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/eventos/stream') {
    assinar(req, res);
    return true;
  }

  if (req.method === 'GET' && p === '/api/eventos/recentes') {
    json(res, 200, { eventos: eventosRecentes(Number(url.searchParams.get('limite')) || 50) });
    return true;
  }

  // ── Eventos empurrados pela URA ───────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/eventos/ura') {
    const corpo = await lerJson<EventoUra>(req);
    const r = await receberEventoUra(corpo);
    json(res, r.ok ? 202 : 400, r);
    return true;
  }

  if (req.method === 'GET' && p === '/api/chamadas') {
    json(res, 200, { chamadas: listarChamadas(Number(url.searchParams.get('limite')) || 50) });
    return true;
  }

  // ── Alertas ───────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/alertas') {
    json(res, 200, {
      alertas: listarAlertas({
        limite: Number(url.searchParams.get('limite')) || 100,
        origem: url.searchParams.get('origem') || undefined,
        abertos: url.searchParams.get('abertos') === '1',
      }),
    });
    return true;
  }

  const mRec = p.match(/^\/api\/alertas\/([^/]+)\/reconhecer$/);
  if (req.method === 'POST' && mRec) {
    const ok = reconhecer(mRec[1], ator(req));
    if (!ok) throw new ErroHttp(404, 'alerta não encontrado ou já reconhecido');
    json(res, 200, { ok: true });
    return true;
  }

  // ── Monitores ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/monitores') {
    json(res, 200, { monitores: estadoMonitores() });
    return true;
  }

  // ── Resumo diário ─────────────────────────────────────────────────────────
  // Prévia não envia nem grava nada: é para conferir os números antes de ligar.
  if (req.method === 'GET' && p === '/api/resumo/previa') {
    json(res, 200, await montarResumo());
    return true;
  }

  if (req.method === 'POST' && p === '/api/resumo/enviar') {
    const a = await enviarResumoManual(ator(req));
    json(res, 200, {
      ok: true,
      enviado: !!a?.enviado_em,
      motivo: a?.envio_erro ?? null,
    });
    return true;
  }

  if (req.method === 'GET' && p === '/api/monitores/sla/diagnostico') {
    try {
      json(res, 200, await diagnosticoSla());
    } catch (err) {
      json(res, 502, { ok: false, erro: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
};
