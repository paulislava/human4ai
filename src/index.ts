import { AskService, AskStore } from './asks';
import { config } from './config';
import { TaskStore } from './db';
import { CaptchaOrchestrator } from './orchestrator';
import { createServer } from './server';
import { TelegramClient } from './telegram';

function main(): void {
  const store = new TaskStore();
  const telegram = new TelegramClient();
  const orchestrator = new CaptchaOrchestrator(store, telegram);

  // Запросы секретов живут на той же базе и том же боте, что капча.
  const askStore = new AskStore(store.db);
  const askService = new AskService(askStore, telegram, config.defaultTimeoutMs);

  telegram.startPolling(
    ({ replyToMessageId, messageId, text }) => {
      // Один поллер на два вида задач: сначала пробуем вопрос человеку, потом
      // капчу. Разбирается по reply_to_message, поэтому перепутать нельзя.
      if (askService.handleReply(replyToMessageId, text, messageId)) {
        return;
      }
      orchestrator.handleTelegramReply(replyToMessageId, text, messageId);
    },
    ({ pollId, optionIds }) => {
      askService.handlePollAnswer(pollId, optionIds);
    },
  );

  const server = createServer(store, orchestrator, {
    store: askStore,
    service: askService,
  }).listen(config.port, () => {
    console.log(`human4captcha слушает :${config.port}`);
    console.log(`Доступные решатели: ${orchestrator.availableSolvers().join(', ') || 'нет'}`);
    console.log(`Запросы секретов: ${askService.isAvailable() ? 'доступны' : 'нет Telegram'}`);
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
