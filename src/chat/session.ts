// Sessão de atendimento por chat: uma por número de WhatsApp. Mantém o contexto
// (CallContext, reaproveitado da URA), o histórico de mensagens e o registry de
// ferramentas. Roda o loop agêntico (OpenAI Chat Completions + function calling).
//
// Supervisão humana (painel): cada sessão tem um modo —
//   'ia'     → a IA responde sozinha (padrão)
//   'humano' → atendente assumiu; mensagens do cliente são registradas mas a IA
//              não responde. O que a atendente enviar entra no histórico como
//              fala do assistente, então ao devolver para a IA ela continua
//              exatamente de onde a conversa parou.

import { createContext, type CallContext } from '../session/context';
import { registerTools } from '../tools/handlers';
import { whatsapp } from '../integrations/whatsapp';
import { whatsappCloud } from '../integrations/whatsapp-cloud';
import { config } from '../config';
import { logger } from '../logger';
import { ChatToolRegistry } from './tool-registry';
import { registerChatOverrides, ajustarArgsWhatsapp } from './overrides';
import { buildChatSystemPrompt } from './prompt';
import { notaDeNumerosDitados } from './numeros-falados';
import { buildChatTools } from './definitions';
import { chatCompletion, type ChatMessage, type ChatToolFunction } from './openai';
import { salvarConversa, salvarEvento, conversasParaRetomar, buscarConversaParaReabrir } from './repo';
import { sintetizarParaWhatsapp, type Genero } from './voz';
import { montarDossie } from './dossie';
import { salvarArquivo } from './arquivos';
import { estaNoHorarioComercial } from '../utils/horario-comercial';

const TOOLS: ChatToolFunction[] = buildChatTools();

/** Até quanto tempo depois de encerrada uma conversa ainda vale reabrir com o histórico. */
const JANELA_REABERTURA_MS = 6 * 60 * 60 * 1000;

export type ChatMode = 'ia' | 'humano';

/** Envia texto ao cliente pelo canal da conversa (Evolution ou Cloud API). */
export type EnviarTexto = (numero: string, texto: string) => Promise<{ enviado: boolean; motivo?: string }>;

/** Envia uma mensagem de voz (OGG/Opus) — usado só na resposta em áudio. */
export type EnviarAudio = (numero: string, ogg: Buffer) => Promise<{ enviado: boolean; motivo?: string }>;

export interface PanelEvent {
  id: number;
  ts: number;
  /** cliente = msg recebida · ia = resposta da IA · atendente = humano via painel ·
   *  tool = consulta executada · sistema = troca de modo/avisos */
  tipo: 'cliente' | 'ia' | 'atendente' | 'tool' | 'sistema';
  texto?: string;
  /** Nome da atendente que escreveu (eventos do tipo 'atendente'). */
  autor?: string;
  tool?: { name: string; args: Record<string, unknown>; resultado: string };
  /** Documento/imagem trocado nesta mensagem — link de download no painel. */
  arquivo?: { id: string; nome: string; mimetype: string; tamanho: number };
}

export class ChatSession {
  readonly ctx: CallContext;
  private readonly registry = new ChatToolRegistry();
  private history: ChatMessage[] = [];
  readonly eventos: PanelEvent[] = [];
  modo: ChatMode = 'ia';
  /** Quem está com a conversa quando modo = 'humano'. */
  atendenteId?: string;
  atendenteNome?: string;
  pushName?: string;
  lastActivity = Date.now();
  startedAt = Date.now();
  /** Último texto vindo DO CLIENTE — lastActivity também sobe quando nós enviamos. */
  ultimoContatoCliente = Date.now();
  /** A última mensagem do cliente foi áudio: responder no mesmo formato. */
  responderEmAudio = false;
  /**
   * Gênero da voz. A persona é escolhida pela IA no texto (Ana/Bruna x Alex),
   * então é detectada na primeira apresentação e mantida até o fim — trocar a
   * voz no meio soaria como outra pessoa atendendo.
   */
  private genero: Genero = 'feminino';
  private generoDefinido = false;
  /** Transporte de voz; sem ele a resposta sai em texto. */
  enviarAudio?: EnviarAudio;
  /** Quando perguntamos "ainda está aí?"; undefined = ainda não perguntamos. */
  private pingInatividadeEm?: number;
  private chain: Promise<void> = Promise.resolve();

  /** Transporte de envio; se não injetado, cai na Evolution (compatível com o que já existia). */
  private readonly enviar: EnviarTexto;

  constructor(
    readonly remoteJid: string,
    readonly numero: string,
    readonly instance?: string,
    enviar?: EnviarTexto,
  ) {
    this.ctx = createContext(remoteJid, numero);
    this.ctx.canal = 'chat';
    this.ctx.agentName = config.company.agentName;
    // Responde/entrega pela MESMA instância que recebeu a mensagem.
    this.ctx.whatsappInstance = instance;
    // No chat já sabemos o WhatsApp do cliente (é o remetente): pré-confirmado.
    this.ctx.celularWhatsApp = numero;
    this.ctx.celularWhatsAppConfirmado = true;

    this.enviar = enviar ?? ((n, t) => whatsapp.enviarTexto(n, t, instance));
    // Handlers (fatura/protocolo) enviam ao cliente pelo mesmo canal da conversa.
    this.ctx.enviarTextoCliente = this.enviar;

    registerTools(this.registry, this.ctx);   // MESMOS handlers da URA
    registerChatOverrides(this.registry, this.ctx);
  }

  get key(): string {
    return `${this.instance ?? ''}:${this.remoteJid}`;
  }

  get encerrada(): boolean {
    return this.ctx.pendingHangup === true;
  }

  // ── Eventos (timeline do painel) ─────────────────────────────────────────

  private record(ev: Omit<PanelEvent, 'id' | 'ts'>): void {
    const completo = { ts: Date.now(), ...ev };
    let id = 0;
    try {
      id = salvarEvento(this.key, completo);          // id vem do banco
    } catch (err) {
      logger.error('[chat] falha ao gravar evento', { err: String(err) });
      id = -Date.now();                                // segue em memória
    }
    this.eventos.push({ id, ...completo });
    if (this.eventos.length > 300) this.eventos.splice(0, this.eventos.length - 300);
    this.persistir();
  }

  /** Salva o estado (contexto + histórico) para sobreviver a um restart. */
  persistir(): void {
    try {
      salvarConversa({
        chave: this.key,
        numero: this.numero,
        instancia: this.instance,
        pushName: this.pushName,
        modo: this.modo,
        atendenteId: this.atendenteId,
        atendenteNome: this.atendenteNome,
        encerrada: this.encerrada,
        iniciadaEm: this.startedAt,
        ultimaAtividade: this.lastActivity,
        ctx: this.ctx,
        history: this.history,
      });
    } catch (err) {
      logger.error('[chat] falha ao salvar conversa', { err: String(err) });
    }
  }

  /** Recarrega uma conversa vinda do banco (após restart do serviço). */
  restaurar(dados: {
    pushName?: string; modo: 'ia' | 'humano';
    atendenteId?: string; atendenteNome?: string;
    iniciadaEm: number; ultimaAtividade: number;
    ctx: Partial<CallContext>; history: unknown[]; eventos: PanelEvent[];
  }): void {
    this.pushName = dados.pushName;
    this.modo = dados.modo;
    this.atendenteId = dados.atendenteId;
    this.atendenteNome = dados.atendenteNome;
    this.startedAt = dados.iniciadaEm;
    this.lastActivity = dados.ultimaAtividade;
    Object.assign(this.ctx, dados.ctx);
    this.history = dados.history as ChatMessage[];
    this.eventos.push(...dados.eventos);
  }

  /**
   * Cliente escreveu de novo depois que a conversa já tinha sido encerrada
   * (por inatividade, pela IA ou por atendente). Mantém a identificação e o
   * histórico — não faz o cliente repetir CPF nem se apresentar de novo — mas
   * refaz as consultas de negócio: financeiro/ONU/massiva podem ter mudado
   * desde então, então essas flags voltam a "não consultado ainda".
   */
  reabrir(): void {
    this.ctx.pendingHangup = false;
    this.ctx.consultaFinanceiraFeita = false;
    this.ctx.consultaMassivaFeita = false;
    this.ctx.consultaPlanosFeita = false;
    this.ctx.onu = undefined;
    this.ctx.titulos = undefined;
    this.ultimoContatoCliente = Date.now();
    this.pingInatividadeEm = undefined;
    this.record({ tipo: 'sistema', texto: 'Cliente voltou a escrever — atendimento retomado do histórico.' });
    logger.info(`[${this.ctx.callId}] painel: conversa reaberta após encerramento (${this.numero})`);
  }

  // ── Controle do painel ───────────────────────────────────────────────────

  /** Atendente assume a conversa: IA para de responder até retomar(). */
  intervir(atendente: { id: string; nome: string }): void {
    if (this.modo === 'humano' && this.atendenteId === atendente.id) return;

    const anterior = this.modo === 'humano' ? this.atendenteNome : null;
    const veioDaFila = this.ctx.pendingTransfer === true;
    const horaAssumiu = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    this.modo = 'humano';
    this.atendenteId = atendente.id;
    this.atendenteNome = atendente.nome;
    // Sai da fila (e do escalonamento de alertas) assim que alguém assume —
    // sem isso o "transferir" ficava preso pra sempre (nada limpava esse
    // estado) e o sweep continuaria mandando aviso de fila parada.
    this.ctx.pendingTransfer = false;
    this.ctx.filaTipo = undefined;
    this.ctx.filaEntradaEm = undefined;
    this.ctx.filaNivelEnviado = undefined;
    this.record({
      tipo: 'sistema',
      texto: anterior
        ? `${atendente.nome} assumiu a conversa de ${anterior}`
        : veioDaFila
        ? `${atendente.nome} assumiu às ${horaAssumiu} (estava na fila) — IA pausada`
        : `${atendente.nome} assumiu a conversa — IA pausada`,
    });
    logger.info(`[${this.ctx.callId}] painel: ${atendente.nome} assumiu (${this.numero})`);
  }

  /** Devolve para a IA. Se houver mensagem do cliente sem resposta, a IA responde já. */
  retomar(porQuem?: string): void {
    if (this.modo === 'ia') return;
    this.modo = 'ia';
    this.atendenteId = undefined;
    this.atendenteNome = undefined;
    this.record({ tipo: 'sistema', texto: `${porQuem ? porQuem + ' devolveu' : 'Devolvida'} para a IA` });
    logger.info(`[${this.ctx.callId}] painel: conversa devolvida à IA (${this.numero})`);

    const last = [...this.history].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
    if (last?.role === 'user') {
      // Sem isto a IA não tem como saber que quem respondeu por último foi um
      // humano — ela só vê texto puro no histórico — e podia se apresentar de
      // novo ou mudar de tom no meio do assunto, como se fosse outra pessoa
      // entrando na conversa.
      this.history.push({
        role: 'system',
        content: '[SISTEMA] Um atendente humano conduziu parte desta conversa e acabou de devolver '
          + 'para você. NÃO se apresente de novo, NÃO cumprimente como se fosse o início da conversa '
          + 'e NÃO troque de tom — continue exatamente o assunto de onde ele parou, como se você e o '
          + 'atendente fossem a mesma pessoa.',
      });
      this.chain = this.chain.catch(() => undefined).then(() => this.run());
    }
  }

  /** Mensagem digitada pela atendente no painel: envia ao cliente e entra no
   *  histórico como fala do assistente (a IA continua a partir dela). */
  async enviarComoAtendente(texto: string, autor?: string): Promise<{ enviado: boolean; motivo?: string }> {
    const t = texto.trim();
    if (!t) return { enviado: false, motivo: 'texto_vazio' };
    if (this.modo !== 'humano') return { enviado: false, motivo: 'modo_ia' };

    const r = await this.enviar(this.numero, t);
    if (r.enviado) {
      this.history.push({ role: 'assistant', content: t });
      this.record({ tipo: 'atendente', texto: t, autor: autor ?? this.atendenteNome });
      this.trimHistory();
      this.lastActivity = Date.now();
    }
    return { enviado: r.enviado, motivo: r.motivo };
  }

  /**
   * Envia um arquivo ao cliente em nome da atendente. Escolhe o canal pela
   * instância da conversa: phone_number_id numérico = Cloud API, senão Evolution.
   */
  async enviarArquivoComoAtendente(
    arq: { nome: string; mimetype: string; buffer: Buffer; legenda?: string },
    autor?: string,
  ): Promise<{ enviado: boolean; motivo?: string }> {
    if (!arq.buffer?.length) return { enviado: false, motivo: 'arquivo_vazio' };
    if (this.modo !== 'humano') return { enviado: false, motivo: 'modo_ia' };

    const inst = this.instance ?? '';
    const ehCloud = config.cloud.enabled
      && (/^\d{10,}$/.test(inst) || config.cloud.allowedPhoneIds.includes(inst));

    const r = ehCloud
      ? await whatsappCloud.enviarMidia(inst, this.numero, arq)
      : await whatsapp.enviarMidia(this.numero, arq, this.instance);

    if (r.enviado) {
      // A IA precisa saber que um arquivo foi enviado para não repetir a oferta.
      const descricao = arq.legenda
        ? `[arquivo enviado: ${arq.nome}] ${arq.legenda}`
        : `[arquivo enviado: ${arq.nome}]`;
      this.history.push({ role: 'assistant', content: descricao });
      // Guarda o arquivo em disco pra sobrar um link de download na timeline —
      // sem isso só ficava a descrição em texto, sem como reabrir o que foi mandado.
      const salvo = salvarArquivo(this.key, 'saida', arq.nome, arq.mimetype, arq.buffer);
      this.record({
        tipo: 'atendente', texto: descricao, autor: autor ?? this.atendenteNome,
        arquivo: salvo,
      });
      this.trimHistory();
      this.lastActivity = Date.now();
    }
    return { enviado: r.enviado, motivo: r.motivo };
  }

  /**
   * Cliente sumiu no meio da conversa: pergunta uma vez se ainda está aí e,
   * sem resposta, encerra com o resumo e os protocolos.
   *
   * Chamado pela varredura do store. Retorna true quando encerrou, para o
   * store tirar a sessão da memória.
   */
  async verificarInatividade(agora: number): Promise<boolean> {
    const pingMs = config.chat.inatividadePingMin * 60_000;
    const fecharMs = config.chat.inatividadeFecharMin * 60_000;
    if (!pingMs) return false;                       // 0 desliga o recurso
    if (this.modo === 'humano') return false;        // atendente decide a hora de fechar
    if (this.encerrada) return false;
    // Conversa que nunca passou de uma mensagem nossa não merece cobrança.
    if (!this.eventos.some((e) => e.tipo === 'cliente')) return false;

    const parado = agora - this.ultimoContatoCliente;

    if (this.pingInatividadeEm === undefined) {
      if (parado < pingMs) return false;
      this.pingInatividadeEm = agora;
      const r = await this.enviarTextoOuAudio(
        'Você ainda está aí? 😊 Se precisar de mais alguma coisa, é só me chamar.',
      );
      if (r.enviado) {
        this.record({ tipo: 'sistema', texto: 'Aviso de inatividade enviado ao cliente.' });
      }
      this.persistir();
      return false;
    }

    if (agora - this.pingInatividadeEm < fecharMs) return false;

    // Sem resposta: encerra com o que foi resolvido e os protocolos gerados.
    const protocolos = this.ctx.protocolos ?? [];
    const linhas = ['Como não tive retorno, vou encerrar nosso atendimento por aqui. 😊'];
    if (protocolos.length === 1) {
      linhas.push('', `📄 Protocolo do atendimento: *${protocolos[0]}*`);
    } else if (protocolos.length > 1) {
      linhas.push('', '📄 Protocolos do atendimento:');
      for (const p of protocolos) linhas.push(`• *${p}*`);
    }
    linhas.push('', 'Qualquer coisa, é só mandar mensagem que eu te atendo de novo.');

    const canais: string[] = [];
    if (config.company.phoneDisplay) canais.push(`📞 ${config.company.phoneDisplay}`);
    if (config.company.site) canais.push(`🌐 ${config.company.site}`);
    if (config.company.instagram) canais.push(`📸 Instagram: ${config.company.instagram}`);
    if (config.company.appLink) canais.push(`📱 App: ${config.company.appLink}`);
    if (canais.length) linhas.push('', 'Outros canais:', ...canais);

    linhas.push('', `${config.company.name} agradece o contato! 🚀`);

    await this.enviarTextoOuAudio(linhas.join('\n'));
    this.record({
      tipo: 'sistema',
      texto: `Atendimento encerrado por inatividade${
        protocolos.length ? ` — protocolo(s): ${protocolos.join(', ')}` : ' (sem protocolo)'}.`,
    });
    this.ctx.pendingHangup = true;
    this.persistir();
    logger.info(`[chat] encerrado por inatividade: ${this.numero}`, { protocolos });
    return true;
  }

  /**
   * Escalonamento da fila de atendimento humano (Atendimento ou Adesão):
   * aos 3/5/8 minutos sem ninguém assumir, reforça o aviso pro cliente e, no
   * nível crítico (8min), avisa o grupo de alertas. Chamado pela varredura
   * do store — independe de qualquer turno de IA rolando, por isso os
   * avisos são mandados direto por aqui, não pelo texto que a IA escreveria.
   *
   * Sem `verificarInatividade`: aqui a pausa é do ATENDENTE, não do cliente —
   * então não olha `ultimoContatoCliente`, só o relógio desde a entrada na fila.
   */
  async verificarFilaAtendimento(agora: number): Promise<void> {
    if (!this.ctx.pendingTransfer || !this.ctx.filaEntradaEm) return;
    if (this.modo === 'humano') return;                 // já foi assumido
    if (this.encerrada) return;
    if (!estaNoHorarioComercial()) return;               // fora do expediente não escala sozinho

    const decorridoMin = (agora - this.ctx.filaEntradaEm) / 60_000;
    const nivel = this.ctx.filaNivelEnviado ?? 1;

    if (nivel < 2 && decorridoMin >= 3) {
      await this.enviar(
        this.numero,
        'Seu atendimento já está na fila da nossa equipe. Em breve um atendente continuará com você.',
      );
      this.ctx.filaNivelEnviado = 2;
      this.record({ tipo: 'sistema', texto: 'Fila: 3min sem atendente — cliente avisado de novo (nível 2).' });
      this.persistir();
      return;
    }

    if (nivel < 3 && decorridoMin >= 5) {
      await this.enviar(
        this.numero,
        'Ainda estamos direcionando um atendente para você. Seu atendimento continua em nossa fila '
        + 'e será iniciado o mais breve possível.',
      );
      this.ctx.filaNivelEnviado = 3;
      this.record({ tipo: 'sistema', texto: 'Fila: 5min sem atendente — cliente avisado de novo (nível 3).' });
      this.persistir();
      return;
    }

    if (nivel < 4 && decorridoMin >= 8) {
      this.ctx.filaNivelEnviado = 4;
      this.record({ tipo: 'sistema', texto: '🚨 Fila: 8min sem atendente — PRIORIDADE CRÍTICA.' });
      logger.warn(`[chat] fila crítica (8min sem atendente): ${this.numero}`, {
        tipo: this.ctx.filaTipo, setor: this.ctx.transferSetor,
      });
      if (config.chat.handoffGroupId) {
        const nome = this.ctx.cliente?.nome ?? this.pushName ?? 'Cliente não identificado';
        const texto = [
          '🚨 *ATENDIMENTO CRÍTICO*',
          `Cliente: ${nome}`,
          `Setor: ${this.ctx.transferSetor ?? 'não identificado'}`,
          'Tempo de espera: 8 minutos',
          'Status: Aguardando atendente',
          'Motivo: Atendimento humano ainda não assumido.',
        ].join('\n');
        await whatsapp.enviarGrupo(config.chat.handoffGroupId, texto, this.ctx.whatsappInstance);
      }
      this.persistir();
    }
  }

  // ── Fluxo de mensagens ───────────────────────────────────────────────────

  /** Enfileira o processamento de uma mensagem (garante ordem por cliente). */
  handle(
    userText: string,
    pushName?: string,
    opts?: { deAudio?: boolean; arquivo?: PanelEvent['arquivo'] },
  ): Promise<void> {
    if (pushName?.trim()) this.pushName = pushName.trim();
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => this.process(userText, opts?.deAudio === true, opts?.arquivo));
    return this.chain;
  }

  private async process(userText: string, deAudio = false, arquivo?: PanelEvent['arquivo']): Promise<void> {
    this.lastActivity = Date.now();
    // Cliente respondeu: zera o ciclo de inatividade.
    this.ultimoContatoCliente = Date.now();
    this.pingInatividadeEm = undefined;
    this.ctx.lastClientSpeech = userText;

    // Documento sem legenda: sem isso o histórico levaria uma mensagem 'user'
    // vazia pra API. O balão no painel mostra só o anexo (texto fica undefined).
    const conteudoParaIA = userText || (arquivo ? `[cliente enviou um arquivo: ${arquivo.nome}]` : '');
    this.history.push({ role: 'user', content: conteudoParaIA });
    this.record({
      tipo: 'cliente',
      texto: deAudio ? `🎙️ ${userText}` : (userText || undefined),
      arquivo,
    });

    if (arquivo) {
      this.history.push({
        role: 'system',
        content: `[SISTEMA] O cliente anexou um arquivo nesta mensagem: "${arquivo.nome}" (${arquivo.mimetype}). `
          + 'Você não consegue abrir o conteúdo, mas ele já ficou registrado e disponível pra atendente '
          + 'baixar no painel. Reconheça o recebimento; se não estiver claro do que se trata, pergunte.',
      });
    }

    // Áudio: entrega os números já convertidos. Sem isso o modelo tenta fazer a
    // conta de cabeça na transcrição e erra o CEP/CPF do cliente.
    if (deAudio) {
      const nota = notaDeNumerosDitados(userText);
      if (nota) {
        this.history.push({ role: 'system', content: nota });
        logger.info(`[${this.ctx.callId}] números extraídos do áudio`, {
          numero: this.numero,
          nota: nota.replace(/\n/g, ' | '),
        });
      }
    }

    // Atendente no comando: só registra — quem responde é o humano pelo painel.
    if (this.modo === 'humano') return;

    await this.run();
  }

  /** Roda o loop agêntico sobre o histórico atual e entrega a resposta. */
  private async run(): Promise<void> {
    let round = 0;
    while (round < config.chat.maxToolRounds) {
      round += 1;

      const messages: ChatMessage[] = [
        { role: 'system', content: buildChatSystemPrompt(this.ctx) },
        ...this.history,
      ];

      let result;
      try {
        result = await chatCompletion(messages, TOOLS);
      } catch {
        await this.entregar('Tive uma instabilidade aqui no sistema 😕 pode repetir, por favor?');
        return;
      }

      // Sem ferramentas: resposta final ao cliente.
      if (!result.toolCalls.length) {
        const texto = (result.content ?? '').trim();
        this.history.push({ role: 'assistant', content: texto || null });
        this.trimHistory();
        if (texto) await this.entregar(texto);
        return;
      }

      // Registra a decisão do modelo (assistant com tool_calls) e executa cada tool.
      this.history.push({
        role: 'assistant',
        content: result.content ?? null,
        tool_calls: result.toolCalls,
      });

      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch { /* args inválidos → objeto vazio */ }

        args = ajustarArgsWhatsapp(call.function.name, args, this.ctx);

        logger.info(`[${this.ctx.callId}] chat tool: ${call.function.name}`, args);
        let toolResult: unknown;
        try {
          toolResult = await this.registry.dispatch(call.function.name, args);
        } catch (err: unknown) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }
        logger.info(`[${this.ctx.callId}] chat tool ${call.function.name} →`, toolResult);

        const resultadoStr = JSON.stringify(toolResult ?? {});
        this.record({
          tipo: 'tool',
          tool: {
            name: call.function.name,
            args,
            resultado: resultadoStr.length > 2500 ? resultadoStr.slice(0, 2500) + '…' : resultadoStr,
          },
        });

        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultadoStr,
        });
      }
      // Volta ao topo do while para o modelo responder com base nos resultados.
    }

    // Estourar rodadas quase sempre é a IA repetindo a mesma consulta sem sair
    // do lugar. Dizer "adiantei verificações" esconde isso do cliente e dele
    // não sai nada útil — melhor assumir e pedir o dado que destrava.
    logger.warn(`[${this.ctx.callId}] chat: limite de rodadas de ferramentas atingido`, {
      numero: this.numero,
    });
    await this.entregar(
      'Desculpa, me embolei aqui nas consultas 😅 Pode me dizer com suas palavras o que '
      + 'você precisa agora? Se preferir, digo que chamo uma atendente para te ajudar.',
    );
  }

  /**
   * Descobre a persona pela apresentação da IA ("Sou o Alex, do suporte").
   * Só a primeira vale: a partir daí a voz fica fixa na conversa.
   */
  private detectarPersona(texto: string): void {
    if (this.generoDefinido) return;
    if (/\bAlex\b/i.test(texto)) {
      this.genero = 'masculino';
      this.generoDefinido = true;
    } else if (/\bAna\b|\bBruna\b/i.test(texto)) {
      this.genero = 'feminino';
      this.generoDefinido = true;
    }
  }

  /**
   * Manda um texto ao cliente, em áudio quando a última mensagem dele foi
   * áudio (mesma regra das respostas da IA) — usado também pelos avisos de
   * inatividade, pra não quebrar o formato da conversa no meio.
   */
  private async enviarTextoOuAudio(texto: string): Promise<{ enviado: boolean; motivo?: string }> {
    if (this.responderEmAudio && this.enviarAudio) {
      const ogg = await sintetizarParaWhatsapp(texto, this.genero).catch(() => null);
      if (ogg) {
        const r = await this.enviarAudio(this.numero, ogg);
        if (r.enviado) return r;
        logger.warn('[chat] envio de áudio falhou, caindo para texto', { motivo: r.motivo });
      }
    }
    return this.enviar(this.numero, texto);
  }

  /**
   * Entrega a resposta da IA. Responde em áudio só quando a última mensagem do
   * cliente foi áudio — e o texto é sempre registrado na timeline, para a
   * atendente ler no painel sem precisar ouvir.
   */
  private async entregar(texto: string): Promise<void> {
    logger.info(`[chat] ⬆️  [${this.instance ?? 'padrão'}] ${this.numero}: ${texto}`);
    this.record({ tipo: 'ia', texto });
    this.detectarPersona(texto);
    await this.enviarTextoOuAudio(texto);
  }

  // ── Snapshot para o painel ───────────────────────────────────────────────

  resumo() {
    const ultimo = [...this.eventos].reverse().find((e) => e.tipo !== 'tool' && e.tipo !== 'sistema');
    return {
      key: this.key,
      numero: this.numero,
      instance: this.instance ?? config.whatsapp.instance,
      pushName: this.pushName ?? null,
      clienteNome: this.ctx.cliente?.nome ?? null,
      modo: this.modo,
      atendenteId: this.atendenteId ?? null,
      atendenteNome: this.atendenteNome ?? null,
      encerrada: this.encerrada,
      pendingTransfer: this.ctx.pendingTransfer,
      filaTipo: this.ctx.filaTipo ?? null,
      filaEntradaEm: this.ctx.filaEntradaEm ?? null,
      filaNivel: this.ctx.filaNivelEnviado ?? null,
      transferSetor: this.ctx.transferSetor ?? null,
      ultimaMsg: ultimo?.texto ?? null,
      ultimaTs: ultimo?.ts ?? this.lastActivity,
      lastActivity: this.lastActivity,
    };
  }

  detalhe() {
    return {
      ...this.resumo(),
      startedAt: this.startedAt,
      ...montarDossie(this.ctx),
      eventos: this.eventos,
    };
  }

  /** Mantém o histórico enxuto (system é reconstruído a cada turno). */
  private trimHistory(): void {
    const MAX = 40;
    if (this.history.length <= MAX) return;
    this.history = this.history.slice(this.history.length - MAX);
    // Não pode começar por 'tool' (a API exige o assistant/tool_call antes).
    while (this.history.length && this.history[0].role === 'tool') {
      this.history.shift();
    }
  }
}

export class ChatSessionStore {
  private sessions = new Map<string, ChatSession>();

  constructor() {
    const idleMs = config.chat.sessionIdleMin * 60_000;
    setInterval(() => {
      const agora = Date.now();
      for (const [key, s] of this.sessions) {
        // Sai da memória por inatividade — o registro fica no banco (auditoria).
        if (agora - s.lastActivity > idleMs) {
          s.persistir();
          this.sessions.delete(key);
          continue;
        }
        // Cliente calado: avisa e, persistindo o silêncio, encerra com protocolo.
        void s.verificarInatividade(agora)
          .then((encerrou) => { if (encerrou) this.sessions.delete(key); })
          .catch((err) => logger.error('[chat] falha na varredura de inatividade', {
            key, err: err instanceof Error ? err.message : String(err),
          }));
        // Fila de atendimento humano parada: reforça aviso ao cliente e, no
        // nível crítico, avisa o grupo de alertas.
        void s.verificarFilaAtendimento(agora)
          .catch((err) => logger.error('[chat] falha na varredura da fila de atendimento', {
            key, err: err instanceof Error ? err.message : String(err),
          }));
      }
    }, 60_000).unref?.();
  }

  /** Recarrega do banco as conversas ativas — chamado no boot do serviço.
   *  `resolveEnviar(instancia)` escolhe o transporte (Evolution x Cloud API). */
  retomarDoBanco(resolveEnviar?: (instancia?: string) => EnviarTexto | undefined): number {
    const idleMs = config.chat.sessionIdleMin * 60_000;
    let n = 0;
    try {
      for (const c of conversasParaRetomar(idleMs)) {
        const remoteJid = c.chave.slice(c.chave.indexOf(':') + 1);
        const s = new ChatSession(remoteJid, c.numero, c.instancia, resolveEnviar?.(c.instancia));
        s.restaurar(c);
        this.sessions.set(c.chave, s);
        n++;
      }
      if (n) logger.info(`[chat] ${n} conversa(s) retomada(s) do banco após reinício`);
    } catch (err) {
      logger.error('[chat] falha ao retomar conversas', { err: String(err) });
    }
    return n;
  }

  get(remoteJid: string, numero: string, instance?: string, enviar?: EnviarTexto): ChatSession {
    const key = `${instance ?? ''}:${remoteJid}`;
    let s = this.sessions.get(key);
    if (s && s.encerrada) {
      this.sessions.delete(key);
      s = undefined;
    }
    if (!s) {
      s = this.tentarReabrir(key, remoteJid, numero, instance, enviar);
      if (s) {
        logger.info(`[chat] conversa reaberta para ${numero} (${remoteJid}) — histórico recuperado do banco`);
      } else {
        s = new ChatSession(remoteJid, numero, instance, enviar);
        logger.info(`[chat] Nova sessão para ${numero} (${remoteJid}) via instância ${instance ?? '(padrão)'}`);
      }
      this.sessions.set(key, s);
    }
    return s;
  }

  /**
   * Cliente escreveu de novo e a sessão já não está na memória (foi encerrada
   * — por inatividade, IA ou atendente — ou descartada por idle). Sem isto,
   * toda vez cairia numa sessão vazia e o cliente teria que se identificar de
   * novo. Só reabre dentro de uma janela recente: reviver uma conversa de
   * dias atrás confunde mais do que ajuda, e os dados de financeiro/ONU já
   * ficariam velhos demais pra confiar.
   */
  private tentarReabrir(
    key: string, remoteJid: string, numero: string, instance?: string, enviar?: EnviarTexto,
  ): ChatSession | undefined {
    try {
      const dados = buscarConversaParaReabrir(key);
      if (!dados) return undefined;
      if (Date.now() - dados.ultimaAtividade > JANELA_REABERTURA_MS) return undefined;
      const s = new ChatSession(remoteJid, numero, instance, enviar);
      s.restaurar(dados);
      s.reabrir();
      return s;
    } catch (err) {
      logger.error('[chat] falha ao tentar reabrir conversa', { key, err: String(err) });
      return undefined;
    }
  }

  find(key: string): ChatSession | undefined {
    return this.sessions.get(key);
  }

  list(): ChatSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  drop(remoteJid: string, instance?: string): void {
    this.sessions.delete(`${instance ?? ''}:${remoteJid}`);
  }
}
