// Espelho local da base do SGP.
//
// POR QUE ISSO EXISTE: /api/ura/clientes/ só filtra por telefone, CPF, login e
// contrato. Não há busca por nome nem por SN da ONU — que é exatamente como o
// técnico identifica o cliente em campo. A listagem paginada, porém, devolve
// tudo (3.6k clientes), incluindo serial da ONU, CTO, OLT/PON, RX/TX e o bloco
// de conexão. Então espelhamos a base uma vez por noite e resolvemos a busca
// localmente.
//
// LIMITE DELIBERADO: o espelho serve para MAPEAR (nome/SN/CTO → contrato).
// RX/TX e status de conexão gravados aqui são do último sync e por isso vêm
// sempre acompanhados de `atualizadoEm`. Valor vivo se consulta na hora, via
// sgp.onuDoContrato(). Quem responde "o sinal está em -19" com cache de 12 h
// está inventando com passos extras.

import { randomUUID } from 'crypto';
import { config } from '../../config';
import { logger } from '../../logger';
import { sgp, SgpClienteBruto } from '../../integrations/sgp';
import { db } from './db';

export interface ResultadoBusca {
  clienteId: number;
  nome: string;
  cpfcnpj: string | null;
  contratoId: number;
  contratoStatus: string | null;
  planoDesc: string | null;
  login: string | null;
  sn: string | null;
  ctoNome: string | null;
  oltNome: string | null;
  slot: number | null;
  pon: number | null;
  endereco: string | null;
  /** Do último sync — NÃO é valor vivo. */
  rxUltimoSync: number | null;
  txUltimoSync: number | null;
  conexaoUltimoSync: string | null;
  atualizadoEm: string;
  /**
   * Como o termo casou. Os exatos ('sn', 'cpf', 'login', 'contrato', 'mac',
   * 'ip', 'cto') identificam o registro sem ambiguidade; 'texto' é busca
   * textual (nome, CTO ou endereço) e pode trazer homônimo — quem responde
   * precisa confirmar qual é antes de afirmar algo sobre o cliente.
   */
  casouPor: 'sn' | 'cpf' | 'login' | 'contrato' | 'mac' | 'ip' | 'cto' | 'texto';
}

// ─── Sync ────────────────────────────────────────────────────────────────────

let sincronizando = false;

export function estaSincronizando(): boolean {
  return sincronizando;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function enderecoLinha(e?: { logradouro?: string; numero?: number | string; bairro?: string; cidade?: string }): string | null {
  if (!e) return null;
  const partes = [e.logradouro, e.numero, e.bairro, e.cidade].filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

/**
 * Indexa um lote de clientes crus, em uma transação. Usado pelo sync noturno e
 * também para refrescar um cliente específico após uma consulta viva.
 */
export function indexar(
  clientes: SgpClienteBruto[],
  agora = new Date().toISOString(),
): { clientes: number; servicos: number } {
  const d = db();

  const insCliente = d.prepare(`
    INSERT INTO sgp_cliente (cliente_id, nome, cpfcnpj, tipo, data_cadastro,
      logradouro, numero, bairro, cidade, uf, cep, latitude, longitude, atualizado_em)
    VALUES (@cliente_id,@nome,@cpfcnpj,@tipo,@data_cadastro,
      @logradouro,@numero,@bairro,@cidade,@uf,@cep,@latitude,@longitude,@atualizado_em)
    ON CONFLICT(cliente_id) DO UPDATE SET
      nome=excluded.nome, cpfcnpj=excluded.cpfcnpj, tipo=excluded.tipo,
      data_cadastro=excluded.data_cadastro, logradouro=excluded.logradouro,
      numero=excluded.numero, bairro=excluded.bairro, cidade=excluded.cidade,
      uf=excluded.uf, cep=excluded.cep, latitude=excluded.latitude,
      longitude=excluded.longitude, atualizado_em=excluded.atualizado_em
  `);

  const insContrato = d.prepare(`
    INSERT INTO sgp_contrato (contrato_id, cliente_id, status, motivo_status,
      pop_id, vencimento, forma_cobranca, data_cadastro, atualizado_em)
    VALUES (@contrato_id,@cliente_id,@status,@motivo_status,
      @pop_id,@vencimento,@forma_cobranca,@data_cadastro,@atualizado_em)
    ON CONFLICT(contrato_id) DO UPDATE SET
      cliente_id=excluded.cliente_id, status=excluded.status,
      motivo_status=excluded.motivo_status, pop_id=excluded.pop_id,
      vencimento=excluded.vencimento, forma_cobranca=excluded.forma_cobranca,
      data_cadastro=excluded.data_cadastro, atualizado_em=excluded.atualizado_em
  `);

  const insServico = d.prepare(`
    INSERT INTO sgp_servico (servico_id, contrato_id, tipo, status, grupo,
      plano_id, plano_desc, login, mac, onu_id, sn, rx, tx,
      olt_id, olt_nome, slot, pon, vlan, cto_nome, cto_porta, cto_id,
      conexao_status, conexao_ip, conexao_desde, conexao_ate, atualizado_em)
    VALUES (@servico_id,@contrato_id,@tipo,@status,@grupo,
      @plano_id,@plano_desc,@login,@mac,@onu_id,@sn,@rx,@tx,
      @olt_id,@olt_nome,@slot,@pon,@vlan,@cto_nome,@cto_porta,@cto_id,
      @conexao_status,@conexao_ip,@conexao_desde,@conexao_ate,@atualizado_em)
    ON CONFLICT(servico_id) DO UPDATE SET
      contrato_id=excluded.contrato_id, tipo=excluded.tipo, status=excluded.status,
      grupo=excluded.grupo, plano_id=excluded.plano_id, plano_desc=excluded.plano_desc,
      login=excluded.login, mac=excluded.mac, onu_id=excluded.onu_id, sn=excluded.sn,
      rx=excluded.rx, tx=excluded.tx, olt_id=excluded.olt_id, olt_nome=excluded.olt_nome,
      slot=excluded.slot, pon=excluded.pon, vlan=excluded.vlan,
      cto_nome=excluded.cto_nome, cto_porta=excluded.cto_porta, cto_id=excluded.cto_id,
      conexao_status=excluded.conexao_status, conexao_ip=excluded.conexao_ip,
      conexao_desde=excluded.conexao_desde, conexao_ate=excluded.conexao_ate,
      atualizado_em=excluded.atualizado_em
  `);

  const delBusca = d.prepare(`DELETE FROM sgp_busca WHERE contrato_id = ?`);
  const insBusca = d.prepare(`
    INSERT INTO sgp_busca (nome, cpfcnpj, login, sn, cto, endereco, cliente_id, contrato_id)
    VALUES (?,?,?,?,?,?,?,?)
  `);

  let nCli = 0;
  let nSrv = 0;

  const tx_ = d.transaction((lista: SgpClienteBruto[]) => {
    for (const c of lista) {
      if (!c?.id || !c.nome) continue;
      const e = c.endereco;
      insCliente.run({
        cliente_id: c.id,
        nome: c.nome,
        cpfcnpj: txt(c.cpfcnpj),
        tipo: txt(c.tipo),
        data_cadastro: txt(c.dataCadastro),
        logradouro: txt(e?.logradouro),
        numero: txt(e?.numero),
        bairro: txt(e?.bairro),
        cidade: txt(e?.cidade),
        uf: txt(e?.uf),
        cep: txt(e?.cep),
        latitude: num(e?.latitude),
        longitude: num(e?.longitude),
        atualizado_em: agora,
      });
      nCli++;

      for (const ct of c.contratos ?? []) {
        if (!ct?.id) continue;
        insContrato.run({
          contrato_id: ct.id,
          cliente_id: c.id,
          status: txt(ct.status),
          motivo_status: txt(ct.motivo_status),
          pop_id: ct.pop_id ?? null,
          vencimento: ct.vencimento ?? null,
          forma_cobranca: txt(ct.formaCobranca),
          data_cadastro: txt(ct.dataCadastro),
          atualizado_em: agora,
        });

        const logins: string[] = [];
        const sns: string[] = [];
        const ctos: string[] = [];

        for (const s of ct.servicos ?? []) {
          if (!s?.id) continue;
          const o = s.onu ?? undefined;
          const cx = o?.conexao ?? undefined;
          insServico.run({
            servico_id: s.id,
            contrato_id: ct.id,
            tipo: txt(s.tipo),
            status: txt(s.status),
            grupo: txt(s.grupo),
            plano_id: s.plano?.id ?? null,
            plano_desc: txt(s.plano?.descricao),
            login: txt(s.login),
            mac: txt(s.mac)?.toUpperCase() ?? null,
            onu_id: o?.id ?? null,
            sn: txt(o?.serial),
            rx: num(o?.rx),
            tx: num(o?.tx),
            olt_id: o?.olt_id ?? null,
            olt_nome: txt(o?.olt_nome),
            slot: o?.slot ?? null,
            pon: o?.pon ?? null,
            vlan: o?.vlan ?? null,
            cto_nome: txt(o?.splitter?.nome),
            cto_porta: o?.splitter?.porta ?? null,
            cto_id: o?.splitter?.id ?? null,
            conexao_status: txt(cx?.status),
            conexao_ip: txt(cx?.ip),
            conexao_desde: txt(cx?.data_conexao),
            conexao_ate: txt(cx?.data_desconexao),
            atualizado_em: agora,
          });
          nSrv++;

          if (s.login) logins.push(String(s.login));
          if (o?.serial) sns.push(String(o.serial));
          if (o?.splitter?.nome) ctos.push(String(o.splitter.nome));
        }

        delBusca.run(ct.id);
        insBusca.run(
          c.nome,
          txt(c.cpfcnpj) ?? '',
          logins.join(' '),
          sns.join(' '),
          ctos.join(' '),
          enderecoLinha(ct.endereco ?? e) ?? '',
          c.id,
          ct.id,
        );
      }
    }
  });

  tx_(clientes);
  return { clientes: nCli, servicos: nSrv };
}

export interface ResumoSync {
  ok: boolean;
  /** true = parou antes do fim por limite pedido; o espelho está INCOMPLETO. */
  parcial: boolean;
  paginas: number;
  clientes: number;
  servicos: number;
  duracaoMs: number;
  erro?: string;
}

export interface OpcoesSync {
  /**
   * Para depois de N páginas. Serve para validar o laço sem 25 min de carga no
   * SGP de produção, e para retomar um sync interrompido junto com `offsetInicial`.
   * O resultado sai marcado como parcial — não substitui o sync completo.
   */
  maxPaginas?: number;
  offsetInicial?: number;
  /**
   * Continua de onde o último sync parou, em vez de refazer a base inteira.
   * Só faz sentido depois de uma falha: o sync gasta ~20 min, e recomeçar do
   * zero por causa de uma página lenta joga fora o que já foi gravado.
   */
  retomar?: boolean;
}

/** Trava considerada abandonada depois disto (o sync inteiro leva ~20 min). */
const LOCK_EXPIRA_MS = 90 * 60_000;

/**
 * Trava de sync entre PROCESSOS.
 *
 * A flag `sincronizando` em memória só vale dentro de um processo, e o sync pode
 * ser disparado pelo CLI, pela API e pelo agendador. Em produção dois rodaram
 * juntos e duplicaram 20 min de trabalho no mesmo banco. Aqui a trava vive na
 * tabela, com PID e horário: se o dono morreu ou a trava envelheceu, é tomada.
 */
function tentarTravar(): { ok: true } | { ok: false; dono: number; desde: string } {
  const d = db();
  const atual = d.prepare(`SELECT lock_pid, lock_em FROM sgp_sync WHERE id = 1`)
    .get() as { lock_pid: number | null; lock_em: string | null } | undefined;

  if (atual?.lock_pid && atual.lock_em) {
    const idade = Date.now() - new Date(atual.lock_em).getTime();
    let donoVivo = false;
    try {
      // Sinal 0 não mata: só pergunta se o processo existe.
      process.kill(atual.lock_pid, 0);
      donoVivo = true;
    } catch {
      donoVivo = false;   // morreu sem liberar (kill -9, queda da VM)
    }
    if (donoVivo && idade < LOCK_EXPIRA_MS && atual.lock_pid !== process.pid) {
      return { ok: false, dono: atual.lock_pid, desde: atual.lock_em };
    }
    if (!donoVivo) {
      logger.warn(`SGP índice: trava órfã do PID ${atual.lock_pid} — assumindo`);
    }
  }

  d.prepare(
    `INSERT INTO sgp_sync (id, lock_pid, lock_em) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET lock_pid = excluded.lock_pid, lock_em = excluded.lock_em`,
  ).run(process.pid, new Date().toISOString());
  return { ok: true };
}

function liberarTrava(): void {
  try {
    db().prepare(`UPDATE sgp_sync SET lock_pid = NULL, lock_em = NULL WHERE id = 1`).run();
  } catch {
    // Falhar ao liberar não pode derrubar o sync; a trava expira sozinha.
  }
}

/** Sync completo. ~20 min para 3,6k clientes — rode fora do horário de pico. */
export async function sincronizar(opts: OpcoesSync = {}): Promise<ResumoSync> {
  if (sincronizando) {
    return { ok: false, parcial: false, paginas: 0, clientes: 0, servicos: 0, duracaoMs: 0, erro: 'sync_em_andamento' };
  }

  const trava = tentarTravar();
  if (!trava.ok) {
    const msg = `outro processo (PID ${trava.dono}) já está sincronizando desde ${trava.desde}`;
    logger.warn(`SGP índice: ${msg}`);
    return { ok: false, parcial: false, paginas: 0, clientes: 0, servicos: 0, duracaoMs: 0, erro: msg };
  }

  sincronizando = true;

  const inicio = Date.now();
  const iniciadoEm = new Date().toISOString();
  const limit = config.sgpIndex.pageSize;

  let offset = opts.offsetInicial ?? 0;
  if (opts.retomar && opts.offsetInicial === undefined) {
    const ultimo = db().prepare(`SELECT offset_atual, ok FROM sgp_sync WHERE id = 1`)
      .get() as { offset_atual: number | null; ok: number } | undefined;
    if (ultimo && !ultimo.ok && ultimo.offset_atual) {
      offset = ultimo.offset_atual;
      logger.info(`SGP índice: retomando do offset ${offset} (último sync falhou aí)`);
    }
  }
  let paginas = 0;
  let totClientes = 0;
  let totServicos = 0;
  let total = 0;
  let parcial = false;
  let erro: string | undefined;

  db().prepare(
    `INSERT INTO sgp_sync (id, iniciado_em, concluido_em, paginas, clientes, servicos, ok, erro, lock_pid, lock_em)
     VALUES (1,?,NULL,0,0,0,0,NULL,?,?)
     ON CONFLICT(id) DO UPDATE SET iniciado_em=excluded.iniciado_em,
       concluido_em=NULL, paginas=0, clientes=0, servicos=0, ok=0, erro=NULL`,
  ).run(iniciadoEm, process.pid, new Date().toISOString());

  logger.info('SGP índice: sync iniciado');

  /**
   * Busca uma página com retentativa. Uma página lenta não pode custar o sync
   * inteiro: em produção a página 9 estourou o timeout e derrubou 7 minutos de
   * trabalho já feito. O SGP é uma consulta pesada e ocasionalmente demora mais.
   */
  const buscarPagina = async (off: number) => {
    let ultimoErro: Error | null = null;
    for (let tentativa = 1; tentativa <= config.sgpIndex.tentativas; tentativa++) {
      try {
        return await sgp.listarPaginaBruta(off, limit, config.sgpIndex.timeoutMs);
      } catch (err) {
        ultimoErro = err instanceof Error ? err : new Error(String(err));
        const espera = tentativa * 10_000;
        logger.warn(
          `SGP índice: página offset ${off} falhou (tentativa ${tentativa}/${config.sgpIndex.tentativas})` +
          `${tentativa < config.sgpIndex.tentativas ? `, nova tentativa em ${espera / 1000}s` : ''}`,
          { err: ultimoErro.message },
        );
        if (tentativa < config.sgpIndex.tentativas) {
          await new Promise((r) => setTimeout(r, espera));
        }
      }
    }
    throw ultimoErro ?? new Error('falha desconhecida ao buscar página');
  };

  try {
    for (;;) {
      const pagina = await buscarPagina(offset);
      if (!pagina) throw new Error('SGP devolveu resposta vazia');

      total = pagina.total || total;
      if (!pagina.clientes.length) break;

      const agora = new Date().toISOString();
      const r = indexar(pagina.clientes, agora);
      totClientes += r.clientes;
      totServicos += r.servicos;
      paginas++;
      offset += limit;

      db().prepare(`UPDATE sgp_sync SET offset_atual = ? WHERE id = 1`).run(offset);

      logger.info(
        `SGP índice: ${totClientes}/${total || '?'} clientes (${paginas} pág, ${Math.round((Date.now() - inicio) / 1000)}s)`,
      );

      if (total && offset >= total) break;
      if (opts.maxPaginas && paginas >= opts.maxPaginas) {
        parcial = true;
        logger.info(`SGP índice: parando em ${paginas} página(s) por limite pedido (sync PARCIAL)`);
        break;
      }
      if (paginas > 500) throw new Error('limite de páginas excedido — abortado por segurança');

      await new Promise((r2) => setTimeout(r2, config.sgpIndex.pausaEntrePaginasMs));
    }
  } catch (err) {
    erro = err instanceof Error ? err.message : String(err);
    logger.error('SGP índice: sync falhou', { erro, paginas, totClientes });
  }

  const duracaoMs = Date.now() - inicio;
  db().prepare(
    `UPDATE sgp_sync SET concluido_em=?, paginas=?, clientes=?, servicos=?, ok=?, erro=? WHERE id=1`,
  ).run(
    new Date().toISOString(), paginas, totClientes, totServicos,
    erro || parcial ? 0 : 1,
    erro ?? (parcial ? 'sync parcial: espelho incompleto' : null),
  );

  sincronizando = false;
  liberarTrava();

  if (!erro) {
    logger.info(
      `SGP índice: sync concluído — ${totClientes} clientes, ${totServicos} serviços em ${Math.round(duracaoMs / 1000)}s`,
    );
  }
  return { ok: !erro, parcial, paginas, clientes: totClientes, servicos: totServicos, duracaoMs, erro };
}

export interface StatusIndice {
  disponivel: boolean;
  clientes: number;
  servicos: number;
  comSn: number;
  ultimoSync: string | null;
  ultimoSyncOk: boolean;
  idadeHoras: number | null;
  sincronizando: boolean;
}

export function statusIndice(): StatusIndice {
  const d = db();
  const s = d.prepare(`SELECT * FROM sgp_sync WHERE id = 1`).get() as
    | { concluido_em: string | null; ok: number; erro: string | null }
    | undefined;
  const clientes = (d.prepare(`SELECT COUNT(*) n FROM sgp_cliente`).get() as { n: number }).n;
  const servicos = (d.prepare(`SELECT COUNT(*) n FROM sgp_servico`).get() as { n: number }).n;
  const comSn = (d.prepare(`SELECT COUNT(*) n FROM sgp_servico WHERE sn IS NOT NULL`).get() as { n: number }).n;

  const ultimo = s?.concluido_em ?? null;
  const idadeHoras = ultimo ? (Date.now() - new Date(ultimo).getTime()) / 3_600_000 : null;

  return {
    disponivel: clientes > 0,
    clientes,
    servicos,
    comSn,
    ultimoSync: ultimo,
    ultimoSyncOk: s?.ok === 1,
    idadeHoras: idadeHoras === null ? null : Math.round(idadeHoras * 10) / 10,
    sincronizando,
  };
}

// ─── Busca ───────────────────────────────────────────────────────────────────

const SELECT_BASE = `
  SELECT c.cliente_id, c.nome, c.cpfcnpj,
         ct.contrato_id, ct.status AS contrato_status,
         s.plano_desc, s.login, s.sn, s.cto_nome, s.olt_nome, s.slot, s.pon,
         s.rx, s.tx, s.conexao_status, s.atualizado_em,
         TRIM(COALESCE(c.logradouro,'') || ', ' || COALESCE(c.numero,'') || ' - '
              || COALESCE(c.bairro,'') || ', ' || COALESCE(c.cidade,'')) AS endereco
  FROM sgp_cliente c
  JOIN sgp_contrato ct ON ct.cliente_id = c.cliente_id
  LEFT JOIN sgp_servico s ON s.contrato_id = ct.contrato_id
`;

interface LinhaBusca {
  cliente_id: number; nome: string; cpfcnpj: string | null;
  contrato_id: number; contrato_status: string | null;
  plano_desc: string | null; login: string | null; sn: string | null;
  cto_nome: string | null; olt_nome: string | null;
  slot: number | null; pon: number | null;
  rx: number | null; tx: number | null;
  conexao_status: string | null; atualizado_em: string; endereco: string | null;
}

function mapear(l: LinhaBusca, casouPor: ResultadoBusca['casouPor']): ResultadoBusca {
  return {
    clienteId: l.cliente_id,
    nome: l.nome,
    cpfcnpj: l.cpfcnpj,
    contratoId: l.contrato_id,
    contratoStatus: l.contrato_status,
    planoDesc: l.plano_desc,
    login: l.login,
    sn: l.sn,
    ctoNome: l.cto_nome,
    oltNome: l.olt_nome,
    slot: l.slot,
    pon: l.pon,
    endereco: l.endereco,
    rxUltimoSync: l.rx,
    txUltimoSync: l.tx,
    conexaoUltimoSync: l.conexao_status,
    atualizadoEm: l.atualizado_em,
    casouPor,
  };
}

/** Escapa o termo para a sintaxe do FTS5 (evita erro de sintaxe com aspas/hífen). */
function termoFts(termo: string): string {
  return termo
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Resolve um termo livre (SN, nome, CPF, login, MAC, IP ou contrato) em
 * candidatos. Retorna [] quando não acha — quem chama NÃO deve inventar.
 */
export function buscar(termo: string, limite = 8): ResultadoBusca[] {
  const d = db();
  const bruto = termo.trim();
  if (!bruto) return [];

  const digitos = bruto.replace(/\D/g, '');
  const rodar = (sql: string, params: unknown[], casouPor: ResultadoBusca['casouPor']): ResultadoBusca[] =>
    (d.prepare(sql).all(...params) as LinhaBusca[]).map((l) => mapear(l, casouPor));

  // SN da ONU — formato típico 4 letras + hex (ex.: RCMG19c050ca). Case-insensitive.
  if (/^[A-Za-z]{2,6}[0-9A-Fa-f]{6,12}$/.test(bruto)) {
    const r = rodar(`${SELECT_BASE} WHERE s.sn = ? COLLATE NOCASE LIMIT ?`, [bruto, limite], 'sn');
    if (r.length) return r;
  }

  // MAC
  if (/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(bruto)) {
    const mac = bruto.replace(/-/g, ':').toUpperCase();
    const r = rodar(`${SELECT_BASE} WHERE s.mac = ? LIMIT ?`, [mac, limite], 'mac');
    if (r.length) return r;
  }

  // IP da conexão
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bruto)) {
    const r = rodar(`${SELECT_BASE} WHERE s.conexao_ip = ? LIMIT ?`, [bruto, limite], 'ip');
    if (r.length) return r;
  }

  // CPF (11) ou CNPJ (14) — o espelho guarda com pontuação, então compara sem ela.
  if (digitos.length === 11 || digitos.length === 14) {
    const r = rodar(
      `${SELECT_BASE} WHERE REPLACE(REPLACE(REPLACE(COALESCE(c.cpfcnpj,''),'.',''),'-',''),'/','') = ? LIMIT ?`,
      [digitos, limite],
      'cpf',
    );
    if (r.length) return r;
  }

  // ID de contrato puro
  if (/^\d{1,7}$/.test(bruto)) {
    const r = rodar(`${SELECT_BASE} WHERE ct.contrato_id = ? LIMIT ?`, [Number(bruto), limite], 'contrato');
    if (r.length) return r;
  }

  // Login PPPoE (uma palavra, sem espaço)
  if (/^[A-Za-z0-9._-]{3,40}$/.test(bruto)) {
    const r = rodar(`${SELECT_BASE} WHERE s.login = ? COLLATE NOCASE LIMIT ?`, [bruto, limite], 'login');
    if (r.length) return r;
  }

  // Nome (ou CTO / endereço) via FTS5, ranqueado. Casamento aproximado:
  // rotulado 'texto' justamente porque pode trazer homônimo.
  try {
    const ids = d.prepare(
      `SELECT contrato_id FROM sgp_busca WHERE sgp_busca MATCH ? ORDER BY rank LIMIT ?`,
    ).all(termoFts(bruto), limite) as Array<{ contrato_id: number }>;
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      return rodar(
        `${SELECT_BASE} WHERE ct.contrato_id IN (${marks}) LIMIT ?`,
        [...ids.map((i) => i.contrato_id), limite],
        'texto',
      );
    }
  } catch (err) {
    logger.warn('SGP índice: busca FTS falhou', { termo: bruto, err: String(err) });
  }

  return [];
}

/** Todos os serviços de uma CTO — base para "quais CTOs estão ruins". */
export function servicosPorCto(cto: string, limite = 200): ResultadoBusca[] {
  return (db().prepare(`${SELECT_BASE} WHERE s.cto_nome = ? COLLATE NOCASE LIMIT ?`)
    .all(cto, limite) as LinhaBusca[]).map((l) => mapear(l, 'cto'));
}

// ─── Agendamento ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

function msAteProximoSync(): number {
  const agora = new Date();
  const alvo = new Date(agora);
  alvo.setHours(config.sgpIndex.syncHora, config.sgpIndex.syncMinuto, 0, 0);
  if (alvo <= agora) alvo.setDate(alvo.getDate() + 1);
  return alvo.getTime() - agora.getTime();
}

export function agendarSync(): void {
  if (!config.sgpIndex.enabled) {
    logger.info('SGP índice: desabilitado (SGP_INDEX_ENABLED=0)');
    return;
  }

  const agendar = () => {
    const ms = msAteProximoSync();
    timer = setTimeout(() => {
      void sincronizar().finally(agendar);
    }, ms);
    // Não segura o processo vivo só por causa do agendamento.
    timer.unref?.();
    logger.info(
      `SGP índice: próximo sync em ${Math.round(ms / 60_000)} min ` +
      `(${String(config.sgpIndex.syncHora).padStart(2, '0')}:${String(config.sgpIndex.syncMinuto).padStart(2, '0')})`,
    );
  };
  agendar();

  const st = statusIndice();
  if (config.sgpIndex.syncAoIniciar || !st.disponivel) {
    logger.info(
      st.disponivel
        ? 'SGP índice: sync no boot (SGP_INDEX_SYNC_BOOT=1)'
        : 'SGP índice: vazio — rodando primeiro sync agora',
    );
    void sincronizar();
  }
}

export function pararSync(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** Rótulo honesto da idade do espelho, para o assistente citar. */
export function idadeEspelho(): string {
  const st = statusIndice();
  if (!st.disponivel) return 'espelho do SGP ainda não sincronizado';
  if (st.idadeHoras === null) return 'espelho do SGP de idade desconhecida';
  if (st.idadeHoras < 1) return 'espelho do SGP sincronizado há menos de 1 h';
  return `espelho do SGP sincronizado há ${Math.round(st.idadeHoras)} h`;
}

export function novoId(): string {
  return randomUUID();
}
