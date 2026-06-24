import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { startSidecar } from './http/sidecar';
import { startAudioSocketServer } from './audiosocket/server';

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err: err.message });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

function main() {
  logger.info('══════════════════════════════════════════');
  logger.info(`  URA AI — ${config.company.name}`);
  logger.info(`  Agente : ${config.company.agentName}`);
  logger.info(`  TTS    : ${config.tts.provider}`);
  logger.info(`  VAD    : ${config.vad.type} / ${config.vad.eagerness}`);
  logger.info('══════════════════════════════════════════');

  startSidecar();
  startAudioSocketServer();
}

main();
