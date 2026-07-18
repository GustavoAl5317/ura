// Entrypoint DEDICADO ao atendente de chat do WhatsApp.
//
// Sobe SOMENTE o webhook de chat (porta CHAT_WEBHOOK_PORT). NÃO inicia os
// servidores da URA de voz (audiosocket / sidecar / admin), então roda como um
// processo totalmente separado e NÃO impacta a URA existente.
//
//   Desenvolvimento:  npm run dev:chat
//   Produção:         npm run build && npm run start:chat

import 'dotenv/config';
import { config } from './config';
import { logger } from './logger';
import { startChatServer } from './chat/webhook';
import { BUILD_ID } from './build';

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (chat)', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection (chat)', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

function main(): void {
  logger.info('══════════════════════════════════════════');
  logger.info(`  Atendente de Chat — ${config.company.name}  [build ${BUILD_ID}]`);
  logger.info(`  Agente : ${config.company.agentName}`);
  logger.info(`  Modelo : ${config.chat.model}`);
  logger.info(`  Webhook: porta ${config.chat.webhookPort}  (POST /webhook)`);
  logger.info(`  WhatsApp: ${config.whatsapp.apiUrl || '(não configurado)'} / instância ${config.whatsapp.instance || '?'}`);
  logger.info('══════════════════════════════════════════');

  if (!config.chat.enabled) {
    logger.warn('CHAT_ENABLED=0 — nada a fazer. Defina CHAT_ENABLED=1 para este processo.');
    return;
  }
  startChatServer();
}

main();
