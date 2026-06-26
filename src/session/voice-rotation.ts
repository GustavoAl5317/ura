import { config } from '../config';
import { logger } from '../logger';

export interface AgentVoice {
  name: string;
  voiceId: string;
  gender: 'f' | 'm';
}

let nextIsMale = false;

/** Alterna feminino/masculino a cada nova chamada (Ana ↔ João). */
export function assignAgentVoice(): AgentVoice {
  const female: AgentVoice = {
    name: config.company.agentName,
    voiceId: config.tts.elevenlabs.voiceId,
    gender: 'f',
  };
  const maleId = config.tts.elevenlabs.voiceIdMale;
  const male: AgentVoice = {
    name: config.company.agentNameMale,
    voiceId: maleId,
    gender: 'm',
  };

  if (!config.tts.elevenlabs.alternateVoices || !maleId) {
    return female;
  }

  if (maleId === config.tts.elevenlabs.voiceId) {
    logger.warn('ELEVENLABS_VOICE_ID_MALE igual à voz feminina — João soará como Ana');
  }

  const picked = nextIsMale ? male : female;
  nextIsMale = !nextIsMale;
  return picked;
}

export function logVoiceRotationConfig(): void {
  if (!config.tts.elevenlabs.alternateVoices) return;
  if (!config.tts.elevenlabs.voiceIdMale) {
    logger.warn('VOICE_ALTERNATE=1 mas ELEVENLABS_VOICE_ID_MALE vazio — usando só voz feminina');
    return;
  }
  logger.info(
    `  Vozes  : alternância ${config.company.agentName} ↔ ${config.company.agentNameMale} (ElevenLabs)`,
  );
}
