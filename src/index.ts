import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { startSidecar } from './http/sidecar';
import { startAudioSocketServer } from './audiosocket/server';
import { startAdminServer } from './admin/server';
import { initWaitSound } from './audio/wait-sound';
import { logVoiceRotationConfig } from './session/voice-rotation';
import { BUILD_ID } from './build';

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

async function main() {
  await initWaitSound();

  logger.info('══════════════════════════════════════════');
  logger.info(`  URA AI — ${config.company.name}  [build ${BUILD_ID}]`);
  logger.info(`  Agente : ${config.company.agentName}${config.tts.elevenlabs.alternateVoices ? ` / ${config.company.agentNameMale} (alternado)` : ''}`);
  logVoiceRotationConfig();
  if (config.zabbix.enabled) {
    logger.info(`  Zabbix : ${config.zabbix.baseUrl || '(URL não definida)'}`);
  }
  logger.info(`  TTS    : ${config.tts.provider}`);
  logger.info(`  VAD    : ${config.vad.type} / ${config.vad.eagerness} | interrupt=${config.vad.interruptResponse ? 'on' : 'off'} | manual_response`);
  const bufStart = Math.max(config.audio.preBufferMs, config.audio.startBufferMs);
  logger.info(
    `  Audio  : ring=${config.audio.inputRingMs}ms start=${bufStart}ms min=${config.audio.minBufferMs}ms max=${config.audio.maxBufferMs}ms mute=${config.audio.inputMuteMs}ms`,
  );
  logger.info(`  Admin  : ${config.admin.enabled ? `porta ${config.admin.port}` : 'desabilitado'}`);
  logger.info('══════════════════════════════════════════');

  startSidecar();
  startAudioSocketServer();
  startAdminServer();
}

main().catch((err) => {
  logger.error('Falha ao iniciar URA', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
