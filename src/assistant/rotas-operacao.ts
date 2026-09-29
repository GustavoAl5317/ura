// Rotas de operação (Bloco 4): alertas, chamadas da URA, monitores e stream ao vivo.

import { Rota, json, lerJson, ator, ErroHttp } from './http-util';
import { db } from './store/db';
import { assinar, eventosRecentes } from './eventos';
import { listar as listarAlertas, reconhecer } from './alertas';
import { receberEventoUra, listarChamadas, EventoUra } from './monitors/ura';
import { estadoMonitores } from './monitors/base';
import { diagnosticoSla } from './monitors/sla';
import { montarResumo, enviarResumoManual } from './resumo-diario';
import {
  EstadoIncidente, ROTULO_ESTADO, ROTULO_SEVERIDADE, alertasDoIncidente, assumir, comentar,
  duracaoSeg, linhaDoTempo, listar as listarIncidentes, mudarEstado, porId as incidentePorId,
  tempoAteReconhecer,
} from './incidentes';
import { cadeia, plantaoAgora } from './plantao';
import { MARCOS, ROTULO_MARCO, listarRegras, situacao } from './sla-incidente';
import { cadeiaDoIncidente } from './roteamento';
import { enviosDoAlerta } from './destinos-alerta';
import { obter } from './config-dinamica';

/** Como cada mensagem deste incidente terminou: enviada, entregue, vista, reconhecida. */
function entregasDoIncidente(id: string) {
  const alertas = db().prepare(`SELECT alerta_id FROM incidente_alerta WHERE incidente_id = ?`).all(id) as Array<{ alerta_id: string }>;
  return alertas.flatMap((a) => enviosDoAlerta(a.alerta_id));
}

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

  // ── Incidentes ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/incidentes') {
    const lista = listarIncidentes({
      abertos: url.searchParams.get('abertos') === '1',
      estado: url.searchParams.get('estado') || undefined,
      severidade: url.searchParams.get('severidade') || undefined,
      limite: Number(url.searchParams.get('limite')) || 100,
    });
    json(res, 200, {
      incidentes: lista.map((i) => ({
        ...i,
        duracao_seg: duracaoSeg(i),
        reconhecer_seg: tempoAteReconhecer(i),
        sla: situacao(i),
      })),
      estados: ROTULO_ESTADO,
      severidades: ROTULO_SEVERIDADE,
      marcos: ROTULO_MARCO,
      regras_sla: listarRegras(),
    });
    return true;
  }

  const mInc = p.match(/^\/api\/incidentes\/([A-Za-z0-9-]+)(\/(assumir|estado|comentario))?$/);
  if (mInc) {
    const id = mInc[1];
    const inc = incidentePorId(id);
    if (!inc) throw new ErroHttp(404, 'incidente não encontrado');
    try {
      if (!mInc[3] && req.method === 'GET') {
        const ligados = alertasDoIncidente(inc.id);
        json(res, 200, {
          incidente: { ...inc, duracao_seg: duracaoSeg(inc), reconhecer_seg: tempoAteReconhecer(inc) },
          linha_do_tempo: linhaDoTempo(inc.id),
          alertas: ligados,
          sla: situacao(inc),
          marcos: MARCOS.map((m) => ({ marco: m, rotulo: ROTULO_MARCO[m] })),
          cadeia: cadeiaDoIncidente(inc),
          entregas: entregasDoIncidente(inc.id),
        });
        return true;
      }
      if (mInc[3] === 'assumir' && req.method === 'POST') {
        const b = await lerJson<{ quem?: string; equipe?: string }>(req);
        json(res, 200, { ok: true, incidente: assumir(inc.id, b.quem?.trim() || ator(req), b.equipe ?? null) });
        return true;
      }
      if (mInc[3] === 'estado' && req.method === 'POST') {
        const b = await lerJson<{ estado?: string; nota?: string }>(req);
        json(res, 200, { ok: true, incidente: mudarEstado(inc.id, b.estado as EstadoIncidente, ator(req), b.nota) });
        return true;
      }
      if (mInc[3] === 'comentario' && req.method === 'POST') {
        const b = await lerJson<{ texto?: string }>(req);
        comentar(inc.id, String(b.texto ?? ''), ator(req));
        json(res, 200, { ok: true, linha_do_tempo: linhaDoTempo(inc.id) });
        return true;
      }
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
  }

  // ── Plantão ───────────────────────────────────────────────────────────────
  // Leitura para qualquer papel: saber quem chamar não é privilégio de admin.
  if (req.method === 'GET' && p === '/api/plantao') {
    const q = url.searchParams.get('quando');
    const quando = q && !Number.isNaN(Date.parse(q)) ? new Date(q) : new Date();
    json(res, 200, {
      ativo: obter<boolean>('plantao.ativo'),
      agora: quando.toISOString(),
      equipes: plantaoAgora(quando).map((e) => ({ ...e, cadeia: cadeia(e.equipe.id, quando) })),
    });
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
