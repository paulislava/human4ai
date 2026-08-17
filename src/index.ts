import { config } from './config';
import { TaskStore } from './db';
import { CaptchaOrchestrator } from './orchestrator';
import { createServer } from './server';
import { TelegramClient } from './telegram';

function main(): void {
  const store = new TaskStore();
  const telegram = new TelegramClient();
  const orchestrator = new CaptchaOrchestrator(store, telegram);

  telegram.startPolling(({ replyToMessageId, messageId, text }) => {
    orchestrator.handleTelegramReply(replyToMessageId, text, messageId);
  });

  const server = createServer(store, orchestrator).listen(config.port, () => {
    console.log(`human4captcha слушает :${config.port}`);
    console.log(`Доступные решатели: ${orchestrator.availableSolvers().join(', ') || 'нет'}`);
  });

  const shutdown = (): void => {
    telegram.stopPolling();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
