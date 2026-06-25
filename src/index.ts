import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { startSidecar } from './http/sidecar';
import { startAudioSocketServer } from './audiosocket/server';

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

function main() {
  logger.info('══════════════════════════════════════════');
  logger.info(`  URA AI — ${config.company.name}`);
  logger.info(`  Agente : ${config.company.agentName}`);
  logger.info(`  TTS    : ${config.tts.provider}`);
  logger.info(`  VAD    : ${config.vad.type} / ${config.vad.eagerness} | interrupt=${config.vad.interruptResponse ? 'on' : 'off'} | manual_response`);
  logger.info(`  Audio  : ring=${config.audio.inputRingMs}ms pre=${config.audio.preBufferMs}ms mute=${config.audio.inputMuteMs}ms`);
  logger.info('══════════════════════════════════════════');

  startSidecar();
  startAudioSocketServer();
}

main();
