import { config } from '../config';
import { logger } from '../logger';

export interface AgentVoice {
  name: string;
  voiceId: string;
}

let nextIsMale = false;

/** Alterna feminino/masculino a cada nova chamada (Ana ↔ João). */
export function assignAgentVoice(): AgentVoice {
  const female: AgentVoice = {
    name: config.company.agentName,
    voiceId: config.tts.elevenlabs.voiceId,
  };
  const maleId = config.tts.elevenlabs.voiceIdMale;
  const male: AgentVoice = {
    name: config.company.agentNameMale,
    voiceId: maleId,
  };

  if (!config.tts.elevenlabs.alternateVoices || !maleId) {
    return female;
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
