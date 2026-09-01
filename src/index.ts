import { AskService, AskStore } from './asks';
import { config } from './config';
import { TaskStore } from './db';
import { CaptchaOrchestrator } from './orchestrator';
import { createServer } from './server';
import { TelegramClient } from './telegram';
import { VoiceService } from './voice/voice.service';
import { BridgeServer } from './bridge/server';

function main(): void {
  const store = new TaskStore();
  const telegram = new TelegramClient();
  const bridge = new BridgeServer(config.bridge.tokens);
  const orchestrator = new CaptchaOrchestrator(store, telegram);

  // Запросы секретов живут на той же базе и том же боте, что капча.
  const askStore = new AskStore(store.db);
  // Голосовой канал: тот же вопрос, но озвучивается на колонке, а ответ приходит
  // из навыка Алисы.
  const voice = new VoiceService();
  const askService = new AskService(askStore, telegram, config.defaultTimeoutMs, voice);

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

  const server = createServer(
    store,
    orchestrator,
    { store: askStore, service: askService },
    voice,
  ).listen(config.port, () => {
    console.log(`human4ai слушает :${config.port}`);
    console.log(`Доступные решатели: ${orchestrator.availableSolvers().join(', ') || 'нет'}`);
    console.log(`Вопросы в Telegram: ${askService.isAvailable() ? 'доступны' : 'нет Telegram'}`);
    console.log(
      `Вопросы голосом: ${askService.isAvailable('voice') ? 'доступны' : 'нет токена/секрета'}`,
    );
    console.log(`MCP: ${config.mcp.token ? '/mcp включён' : 'нет MCP_TOKEN'}`);
  });
  bridge.attach(server);

  // После рестарта в очереди могли остаться неотвеченные голосовые вопросы:
  // напоминаем о первом, иначе он молча висел бы до истечения срока.
  askService.speakHead();

  const shutdown = (): void => {
    telegram.stopPolling();
    bridge.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
