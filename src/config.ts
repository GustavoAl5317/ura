import dotenv from 'dotenv';
dotenv.config({ override: true });

function req(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  return val;
}

const opt = (key: string, def = '') => process.env[key] ?? def;
const optInt = (key: string, def: number) => {
  const v = process.env[key];
  return v ? parseInt(v, 10) : def;
};
const optFloat = (key: string, def: number) => {
  const v = process.env[key];
  return v ? parseFloat(v) : def;
};
const optBool = (key: string, def = false) => {
  const v = process.env[key];
  if (v === undefined) return def;
  return v === '1' || v === 'true';
};

export const config = {
  defaultUf: process.env.DEFAULT_UF || "CE",
  tz: opt('TZ', 'America/Fortaleza'),

  audiosocket: {
    port: optInt('AUDIOSOCKET_PORT', 9019),
  },

  sidecar: {
    port: optInt('SIDECAR_PORT', 9020),
  },

  admin: {
    enabled: optBool('ADMIN_ENABLED', true),
    port: optInt('ADMIN_PORT', 9021),
    apiKey: opt('ADMIN_API_KEY', '').trim(),
    uraEnabledDefault: optBool('URA_ENABLED', true),
    openaiOrgId: opt('OPENAI_ORG_ID', ''),
    openaiAdminKey: opt('OPENAI_ADMIN_KEY', ''),
    openaiPrepaidUsd: optFloat('OPENAI_PREPAID_USD', 0),
    openaiBudgetUsd: optFloat('OPENAI_BUDGET_USD', 0),
    openaiAlertThresholdPct: optInt('OPENAI_ALERT_THRESHOLD_PCT', 20),
    openaiPollMs: optInt('OPENAI_POLL_MS', 300_000),
    openaiAuditMonitor: optBool('OPENAI_AUDIT_MONITOR', true),
    openaiAuditPollMs: optInt('OPENAI_AUDIT_POLL_MS', 300_000),
    alertWebhookUrl: opt('ADMIN_ALERT_WEBHOOK_URL', ''),
    /** Celular (DDD) ou grupo @g.us — alertas internos via Evolution */
    alertWhatsapp: opt('ADMIN_ALERT_WHATSAPP', ''),
  },

  openai: {
    apiKey: req('OPENAI_API_KEY'),
    realtimeModel: opt('REALTIME_MODEL', 'gpt-realtime-2025-08-28'),
    realtimeSchema: opt('OPENAI_REALTIME_SCHEMA', 'ga'),
    transcriptionModel: opt('OPENAI_TRANSCRIPTION_MODEL', 'gpt-realtime-whisper'),
    transcriptionDelay: opt('OPENAI_TRANSCRIPTION_DELAY', 'low') as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh',
    voice: opt('OPENAI_VOICE', 'marin'),
    voiceMale: opt('OPENAI_VOICE_MALE', 'cedar'),
    temperature: optFloat('TEMPERATURE', 0.65),
    maxTokens: optInt('MAX_TOKENS', 768),
  },

  tts: {
    provider: opt('TTS_PROVIDER', 'openai') as 'openai' | 'elevenlabs',
    /** Modelo HTTP para fallback (só se OPENAI_SPEECH_FALLBACK=1) */
    openaiSpeechModel: opt('OPENAI_SPEECH_MODEL', 'gpt-4o-mini-tts'),
    /**
     * 1 = tenta /v1/audio/speech antes do áudio nativo Realtime.
     * 0 (padrão) = ElevenLabs cai → vai direto para voz nativa (evita 403 em muitas contas).
     */
    openaiSpeechFallback: optBool('OPENAI_SPEECH_FALLBACK', false),
    elevenlabs: {
      apiKey: opt('ELEVENLABS_API_KEY'),
      voiceId: opt('ELEVENLABS_VOICE_ID'),
      voiceIdMale: opt('ELEVENLABS_VOICE_ID_MALE'),
      alternateVoices: optBool('VOICE_ALTERNATE', false),
      modelId: opt('ELEVENLABS_MODEL_ID', 'eleven_multilingual_v2'),
      outputFormat: opt('ELEVENLABS_OUTPUT_FORMAT', 'pcm_16000'),
      stability: optFloat('ELEVENLABS_STABILITY', 0.68),
      similarityBoost: optFloat('ELEVENLABS_SIMILARITY', 0.68),
      speakerBoost: optBool('ELEVENLABS_SPEAKER_BOOST', false),
    },
  },

  audio: {
    preBufferMs: optInt('PRE_BUFFER_MS', 60),
    maxBufferMs: optInt('MAX_BUFFER_MS', 3000),
    endPauseMs: optInt('END_PAUSE_MS', 450),
    inputMuteMs: optInt('INPUT_MUTE_MS', 1500),
    inputRingMs: optInt('INPUT_RING_MS', 10_000),
    startBufferMs: optInt('START_BUFFER_MS', 0),
    targetBufferMs: optInt('TARGET_BUFFER_MS', 0),
    minBufferMs: optInt('MIN_BUFFER_MS', 0),
    /** Caminho local para WAV de espera (PCM 16-bit). Ex.: assets/wait-typing.wav */
    waitSoundPath: opt('WAIT_SOUND_PATH', ''),
    /** 0 = teclado imediato ao consultar; >0 atrasa o início */
    toolTypingDelayMs: optInt('TOOL_TYPING_DELAY_MS', 0),
    /** URL de WAV para baixar na inicialização (alternativa ao arquivo local) */
    waitSoundUrl: opt('WAIT_SOUND_URL', ''),
    /** Volume do som de espera (1.0 = normal, 0.3 = 30% do original) */
    waitSoundVolume: optFloat('WAIT_SOUND_VOLUME', 0.3),
  },

  vad: {
    type: opt('TURN_DETECTION_TYPE', 'server_vad') as 'semantic_vad' | 'server_vad',
    eagerness: opt('TURN_DETECTION_EAGERNESS', 'low') as 'low' | 'medium' | 'high',
    threshold: optFloat('TURN_DETECTION_THRESHOLD', 0.8),
    silenceMs: optInt('TURN_DETECTION_SILENCE_MS', 1000),
    speechStopDelayMs: optInt('SPEECH_STOP_DELAY_MS', 300),
    /** Mais longo enquanto coleta CPF (cliente pausa entre grupos de dígitos) */
    speechStopDelayCollectingMs: optInt('SPEECH_STOP_DELAY_COLLECTING_MS', 800),
    /** Ignora speechStop mais curto que isso (ruído de linha / eco) */
    minSpeechMs: optInt('MIN_SPEECH_MS', 450),
    /** Só interrompe a Ana após o cliente falar por esse tempo (evita ruído) */
    interruptArmMs: optInt('INTERRUPT_ARM_MS', 400),
    deferAudioWhileUserSpeaks: optBool('DEFER_ASSISTANT_AUDIO_WHILE_USER_SPEAKS', true),
    interruptResponse: optBool('REALTIME_INTERRUPT_RESPONSE', false),
  },

  sgp: {
    baseUrl: req('SGP_BASE_URL'),
    app: opt('SGP_APP'),
    token: req('SGP_TOKEN'),
    timeoutMs: optInt('SGP_TIMEOUT_MS', 8000),
    retries: optInt('SGP_RETRIES', 1),
    toolSlowdownMs: optInt('TOOL_SLOWDOWN_MS', 3500),
    /** 1 = traz ONU/conexão (mais lento). 0 = consulta mais rápida; ONU buscada só quando precisar. */
    exibirConexao: optBool('SGP_EXIBIR_CONEXAO', false),
    /** 1 = dados completos de serviços no CPF (mais lento) */
    servicosDados: optBool('SGP_SERVICOS_DADOS', false),
  },

  geosite: {
    enabled: optBool('GEOSITE_ENABLED'),
    baseUrl: opt('GEOSITE_BASE_URL'),
    username: opt('GEOSITE_USERNAME'),
    password: opt('GEOSITE_PASSWORD'),
    raioMetros: optInt('GEOSITE_RAIO_METROS', 600),
    timeoutMs: optInt('GEOSITE_TIMEOUT_MS', 12000),
    useGeositeOnly: optBool('COVERAGE_USE_GEOSITE_ONLY'),
  },

  whatsapp: {
    apiUrl: opt('WHATSAPP_API_URL'),
    instance: opt('WHATSAPP_INSTANCE'),
    apiKey: opt('WHATSAPP_API_KEY'),
    salesGroupId: opt('WHATSAPP_SALES_GROUP_ID'),
  },

  chat: {
    /** Liga o atendente de chat do WhatsApp (webhook Evolution + loop OpenAI). */
    enabled: optBool('CHAT_ENABLED', true),
    /**
     * Subir o chat DENTRO do processo da URA de voz (index.ts). Padrão: false —
     * a URA de voz NÃO é afetada. Rode o chat como processo separado (chat-only.ts).
     */
    inMain: optBool('CHAT_IN_MAIN', false),
    /** Porta do webhook que recebe eventos da Evolution API (messages.upsert). */
    webhookPort: optInt('CHAT_WEBHOOK_PORT', 9022),
    /** Token opcional exigido no header/query do webhook (?token= ou apikey). */
    webhookToken: opt('CHAT_WEBHOOK_TOKEN', '').trim(),
    /** Modelo OpenAI de texto que conduz o atendimento (function calling). */
    model: opt('CHAT_MODEL', 'gpt-4o'),
    temperature: optFloat('CHAT_TEMPERATURE', 0.4),
    maxTokens: optInt('CHAT_MAX_TOKENS', 700),
    /** Máx. de rodadas de ferramentas por mensagem (proteção contra loop). */
    maxToolRounds: optInt('CHAT_MAX_TOOL_ROUNDS', 8),
    /** Minutos de inatividade até a sessão do cliente ser descartada. */
    sessionIdleMin: optInt('CHAT_SESSION_IDLE_MIN', 30),
    /** Também atende mensagens vindas de grupos (@g.us). Padrão: só conversas 1:1. */
    atenderGrupos: optBool('CHAT_ATENDER_GRUPOS', false),
    /** Grupo/nº (@g.us ou DDD) que recebe avisos de transferência p/ humano. */
    handoffGroupId: opt('CHAT_HANDOFF_GROUP_ID', '').trim(),
  },

  ami: {
    host: opt('AST_AMI_HOST', '127.0.0.1'),
    port: optInt('AST_AMI_PORT', 5038),
    user: opt('AST_AMI_USER', 'ura'),
    password: opt('AST_AMI_PASS', ''),
    transferExten: opt('AST_AMI_TRANSFER_EXTEN', '8000'),
    transferContext: opt('AST_AMI_TRANSFER_CONTEXT', 'from-internal'),
  },

  company: {
    name: opt('COMPANY_NAME', 'Aquitelecom'),
    agentName: opt('AGENT_NAME', 'Ana'),
    agentNameMale: opt('AGENT_NAME_MALE', 'João'),
  },

  plans: {
    // Whitelist de IDs dos planos comerciais (prioridade máxima).
    // Padrão = catálogo atual Aquitelecom: 400MB(79), 500MB(81), 700MB(82), 1GB(83)
    ids: opt('PLANOS_COMERCIAIS_IDS', '79,81,82,83')
      .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
    // Heurística (quando não há whitelist): faixa de preço válida e limite
    precoMin: optFloat('PLANOS_PRECO_MIN', 0.01),
    precoMax: optFloat('PLANOS_PRECO_MAX', 200),
    max: optInt('PLANOS_MAX', 6),
  },

  zabbix: {
    enabled: optBool('ZABBIX_ENABLED', false),
    /** 1 = lê zabbix-mocks/{cenário}.json (teste sem API real) */
    mock: optBool('ZABBIX_MOCK', false),
    /** Cenário: cto_off | pppoe_off | pop_off | fibra | link | energia | energia_cliente | equipamento_cliente | poe */
    mockScenario: opt('ZABBIX_MOCK_SCENARIO', 'cto_off'),
    /** Base sem path — ex: https://zabbix.aquitelecom.com */
    baseUrl: opt('ZABBIX_URL', ''),
    username: opt('ZABBIX_USER', ''),
    password: opt('ZABBIX_PASSWORD', ''),
    timeoutMs: optInt('ZABBIX_TIMEOUT_MS', 12_000),
    problemLimit: optInt('ZABBIX_PROBLEM_LIMIT', 30),
    /** Padrões de busca em problem.get (nome do trigger), separados por | */
    searchPatterns: opt(
      'ZABBIX_SEARCH_PATTERNS',
      'Queda de Clientes na CTO|Queda de sessões na CTO| - OFFLINE|Queda total no número de sessões PPPoE|ALERTA: cto off|Queda da Interface|POP|PoE|Energia|Power|DSE|Link|Roteador|ONU|Equipamento',
    ).split('|').map((s) => s.trim()).filter(Boolean),
    includeOutros: optBool('ZABBIX_INCLUDE_OUTROS', false),
  },

  features: {
    chamado: optBool('FEATURE_CHAMADO', true),
    chamadoOcorrenciaTipo: optInt('CHAMADO_OCORRENCIA_TIPO', 5),
    chamadoTipoClassificacoes: optInt('CHAMADO_TIPO_CLASSIFICACOES', 5),
  },

  debug: {
    tx: optBool('DEBUG_TX'),
    asr: optBool('DEBUG_ASR'),
    logLevel: opt('LOG_LEVEL', 'info'),
  },
};

export type Config = typeof config;
