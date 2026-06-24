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
  tz: opt('TZ', 'America/Fortaleza'),

  audiosocket: {
    port: optInt('AUDIOSOCKET_PORT', 9019),
  },

  sidecar: {
    port: optInt('SIDECAR_PORT', 9020),
  },

  openai: {
    apiKey: req('OPENAI_API_KEY'),
    realtimeModel: opt('REALTIME_MODEL', 'gpt-4o-realtime-preview'),
    realtimeSchema: opt('OPENAI_REALTIME_SCHEMA', 'ga'),
    voice: opt('OPENAI_VOICE', 'shimmer'),
    temperature: optFloat('TEMPERATURE', 0.65),
    maxTokens: optInt('MAX_TOKENS', 768),
  },

  tts: {
    provider: opt('TTS_PROVIDER', 'openai') as 'openai' | 'elevenlabs',
    elevenlabs: {
      apiKey: opt('ELEVENLABS_API_KEY'),
      voiceId: opt('ELEVENLABS_VOICE_ID'),
      modelId: opt('ELEVENLABS_MODEL_ID', 'eleven_turbo_v2_5'),
    },
  },

  audio: {
    startBufferMs: optInt('START_BUFFER_MS', 500),
    targetBufferMs: optInt('TARGET_BUFFER_MS', 400),
    minBufferMs: optInt('MIN_BUFFER_MS', 220),
    maxBufferMs: optInt('MAX_BUFFER_MS', 1000),
    endPauseMs: optInt('END_PAUSE_MS', 450),
  },

  vad: {
    type: opt('TURN_DETECTION_TYPE', 'semantic_vad') as 'semantic_vad' | 'server_vad',
    eagerness: opt('TURN_DETECTION_EAGERNESS', 'medium') as 'low' | 'medium' | 'high',
    threshold: optFloat('TURN_DETECTION_THRESHOLD', 0.65),
    silenceMs: optInt('TURN_DETECTION_SILENCE_MS', 700),
    speechStopDelayMs: optInt('SPEECH_STOP_DELAY_MS', 1500),
    deferAudioWhileUserSpeaks: optBool('DEFER_ASSISTANT_AUDIO_WHILE_USER_SPEAKS', true),
    interruptResponse: optBool('REALTIME_INTERRUPT_RESPONSE', true),
  },

  sgp: {
    baseUrl: req('SGP_BASE_URL'),
    app: opt('SGP_APP'),
    token: req('SGP_TOKEN'),
    timeoutMs: optInt('SGP_TIMEOUT_MS', 8000),
    retries: optInt('SGP_RETRIES', 1),
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
