import Database from 'better-sqlite3';
import express from 'express';
import { AskService, AskStore } from './asks';
import { TelegramClient } from './telegram';
import { VoiceService } from './voice/voice.service';
import { createAliceRouter } from './alice';
import { createMcpRouter } from './mcp';
import { config } from './config';

/** Колонки в тестах нет: запоминаем, что «прозвучало». */
function fakeVoice() {
  const said: string[] = [];
  const voice = {
    isAvailable: () => true,
    stations: async () => [],
    phrase: (input: { question: string }) => `вопрос: ${input.question}`,
    speak: async (text: string) => {
      said.push(text);
      return { ok: true, detail: 'тест' };
    },
  } as unknown as VoiceService;

  return { voice, said };
}

function fakeTelegram() {
  const sent: string[] = [];
  const reactions: number[] = [];
  let nextMessageId = 100;

  const telegram = {
    isConfigured: () => true,
    sendQuestion: async ({ text }: { text: string }) => {
      sent.push(text);
      return (nextMessageId += 1);
    },
    sendPoll: async () => ({ messageId: (nextMessageId += 1), pollId: `poll-${nextMessageId}` }),
    setReaction: async (messageId: number) => {
      reactions.push(messageId);
    },
  } as unknown as TelegramClient;

  return { telegram, sent, reactions };
}

function makeSetup(timeoutMs = 5_000) {
  const store = new AskStore(new Database(':memory:'));
  const { voice, said } = fakeVoice();
  const { telegram, sent, reactions } = fakeTelegram();
  const service = new AskService(store, telegram, timeoutMs, voice);
  return { store, service, voice, said, sent, reactions, asks: { store, service } };
}

/** Мини-сервер только с голосовыми роутерами — без капчи и её зависимостей. */
function makeApp(setup: ReturnType<typeof makeSetup>) {
  const app = express();
  app.use(express.json());
  app.use(createAliceRouter(setup.asks));
  app.use(createMcpRouter(setup.asks, setup.voice));
  return app;
}

/** Простой вызов роутера без сети: express как функция (req/res-заглушки). */
async function callJson(
  app: express.Express,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const SECRET = 'test-secret';
const MCP_TOKEN = 'test-mcp-token';

beforeEach(() => {
  config.voice.aliceSecret = SECRET;
  config.voice.allowedUsers = [];
  config.mcp.token = MCP_TOKEN;
  config.mcp.maxWaitMs = 2_000;
});

function utterance(text: string, extra: Record<string, unknown> = {}) {
  return {
    request: { command: text },
    session: { session_id: 's1', user: { user_id: 'u1' }, application: { application_id: 'a1' }, ...extra },
  };
}

describe('голосовой канал', () => {
  it('озвучивает только первый вопрос очереди', async () => {
    const setup = makeSetup();
    const first = setup.service.create({ client: 'alpha', channel: 'voice', question: 'первый?' });
    const second = setup.service.create({ client: 'beta', channel: 'voice', question: 'второй?' });

    void setup.service.run(first.id);
    void setup.service.run(second.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(setup.said).toEqual(['вопрос: первый?']);
    expect(setup.store.voiceHead()!.id).toBe(first.id);
  });

  it('ответ голосом уходит тому, кто спросил раньше', async () => {
    const setup = makeSetup();
    const first = setup.service.create({ client: 'alpha', channel: 'voice', question: 'первый?' });
    const second = setup.service.create({ client: 'beta', channel: 'voice', question: 'второй?' });

    const running = Promise.all([setup.service.run(first.id), setup.service.run(second.id)]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    setup.service.answerVoiceHead('ответ первому');
    setup.service.answerVoiceHead('ответ второму');

    const [a, b] = await running;
    expect([a.status, a.answer]).toEqual(['answered', 'ответ первому']);
    expect([b.status, b.answer]).toEqual(['answered', 'ответ второму']);
  });

  it('телеграмные вопросы в голосовую очередь не попадают', async () => {
    const setup = makeSetup();
    setup.service.create({ client: 'alpha', question: 'в телеграм' });
    expect(setup.store.voicePending()).toHaveLength(0);
  });

  it('пропуск снимает вопрос и отдаёт клиенту skipped', async () => {
    const setup = makeSetup();
    const ask = setup.service.create({ client: 'alpha', channel: 'voice', question: 'пропустить?' });
    const running = setup.service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(setup.service.skipVoiceHead()!.id).toBe(ask.id);
    expect((await running).status).toBe('skipped');
  });

  it('истёкшие вопросы не держат очередь', () => {
    const setup = makeSetup();
    // Срок задаём явно: голосовой вопрос по умолчанию живёт сутки, а не
    // defaultTimeoutMs — он ждёт, пока Павел подойдёт к колонке.
    setup.service.create({
      client: 'alpha',
      channel: 'voice',
      question: 'устарел?',
      timeoutMs: -1,
    });
    expect(setup.store.voiceHead()).toBeNull();
  });

  it('дублирует вопрос в Telegram и закрывается тем, кто ответил первым', async () => {
    const setup = makeSetup();
    const ask = setup.service.create({ client: 'alpha', channel: 'voice', question: 'мержить?' });
    const running = setup.service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Ушло и на колонку, и в Telegram — с подсказкой про голосовой ответ.
    expect(setup.said).toEqual(['вопрос: мержить?']);
    expect(setup.sent[0]).toContain('звучит на колонке');
    const messageId = setup.store.get(ask.id)!.telegramMessageId!;

    // Ответ реплаем в Telegram закрывает вопрос и убирает его из очереди.
    expect(setup.service.handleReply(messageId, 'да, мержь', 900)).toBe(true);
    expect((await running).answer).toBe('да, мержь');
    expect(setup.store.voiceHead()).toBeNull();
  });

  it('второй ответ на уже закрытый вопрос игнорируется', async () => {
    const setup = makeSetup();
    const ask = setup.service.create({ client: 'alpha', channel: 'voice', question: 'мержить?' });
    const running = setup.service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Быстрее оказался голос — реплай в Telegram приходит уже на закрытый вопрос.
    setup.service.answerVoiceHead('ответ голосом');
    const messageId = setup.store.get(ask.id)!.telegramMessageId!;
    expect(setup.service.handleReply(messageId, 'ответ реплаем', 901)).toBe(true);

    expect((await running).answer).toBe('ответ голосом');
  });

  it('ответ голосом помечает дубль в Telegram', async () => {
    const setup = makeSetup();
    const ask = setup.service.create({ client: 'alpha', channel: 'voice', question: 'мержить?' });
    void setup.service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const messageId = setup.store.get(ask.id)!.telegramMessageId!;
    setup.service.answerVoiceHead('да');
    expect(setup.reactions).toContain(messageId);
  });

  it('по умолчанию голосовой вопрос живёт сутки', () => {
    const setup = makeSetup(60_000);
    const ask = setup.service.create({ client: 'alpha', channel: 'voice', question: 'долгий?' });
    expect(ask.expiresAt - ask.createdAt).toBe(24 * 60 * 60 * 1000);
  });
});

describe('вебхук навыка Алисы', () => {
  it('без секрета отдаёт 403', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(app, 'POST', '/alice/wrong', utterance('да'));
    expect(res.status).toBe(403);
  });

  it('срезает обёртку «ответь коду» и передаёт ответ первому', async () => {
    const setup = makeSetup();
    const app = makeApp(setup);
    const first = setup.service.create({ client: 'NoSmoke', channel: 'voice', question: 'мержить?' });
    const second = setup.service.create({ client: 'assistant', channel: 'voice', question: 'деплоить?' });
    void setup.service.run(first.id);
    void setup.service.run(second.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await callJson(app, 'POST', `/alice/${SECRET}`, utterance('алиса ответь коду да, мержь'));
    expect(res.body.response.text).toContain('Передал NoSmoke');
    expect(res.body.response.text).toContain('деплоить?');
    expect(setup.store.get(first.id)!.answer).toBe('да, мержь');
    expect(setup.store.get(second.id)!.status).toBe('pending');
  });

  it('«повтори» читает вопрос, не списывая его', async () => {
    const setup = makeSetup();
    const app = makeApp(setup);
    const ask = setup.service.create({ client: 'alpha', channel: 'voice', question: 'что дальше?' });
    void setup.service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await callJson(app, 'POST', `/alice/${SECRET}`, utterance('ответь коду повтори'));
    expect(res.body.response.text).toContain('что дальше?');
    expect(setup.store.get(ask.id)!.status).toBe('pending');
  });

  it('«сколько вопросов» считает очередь', async () => {
    const setup = makeSetup();
    const app = makeApp(setup);
    setup.service.create({ client: 'alpha', channel: 'voice', question: 'раз?' });
    setup.service.create({ client: 'beta', channel: 'voice', question: 'два?' });

    const res = await callJson(app, 'POST', `/alice/${SECRET}`, utterance('ответь коду сколько вопросов'));
    expect(res.body.response.text).toContain('В очереди 2');
  });

  it('на пустой очереди сообщает, что отвечать некому', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(app, 'POST', `/alice/${SECRET}`, utterance('ответь коду да'));
    expect(res.body.response.text).toContain('некому передать');
  });

  it('чужого пользователя не пускает', async () => {
    config.voice.allowedUsers = ['owner'];
    const app = makeApp(makeSetup());
    const res = await callJson(
      app,
      'POST',
      `/alice/${SECRET}`,
      utterance('ответь коду да', { user: { user_id: 'stranger' }, application: { application_id: 'dev' } }),
    );
    expect(res.body.response.text).toContain('только владельцу');
  });
});

describe('MCP', () => {
  const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
  const auth = { authorization: `Bearer ${MCP_TOKEN}` };

  it('без токена не отвечает', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(app, 'POST', '/mcp', rpc('tools/list'));
    expect(res.status).toBe(401);
  });

  it('перечисляет инструменты', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(app, 'POST', '/mcp', rpc('tools/list'), auth);
    expect(res.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'ask_user',
      'wait_answer',
      'cancel_ask',
      'queue_status',
    ]);
  });

  it('уведомление получает 202 без тела', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(app, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    expect(res.status).toBe(202);
  });

  it('ask_user ставит вопрос, ответ голосом забирается wait_answer', async () => {
    const setup = makeSetup();
    const app = makeApp(setup);

    const asked = await callJson(
      app,
      'POST',
      '/mcp',
      rpc('tools/call', {
        name: 'ask_user',
        arguments: { question: 'мержить?', context: 'NoSmoke', wait: 0, timeout: 5 },
      }),
      auth,
    );
    const data = asked.body.result.structuredContent;
    expect(data.status).toBe('pending');

    await callJson(app, 'POST', `/alice/${SECRET}`, utterance('ответь коду да'));

    const answered = await callJson(
      app,
      'POST',
      '/mcp',
      rpc('tools/call', { name: 'wait_answer', arguments: { id: data.id, wait: 0 } }),
      auth,
    );
    expect(answered.body.result.structuredContent).toEqual({
      status: 'answered',
      id: data.id,
      answer: 'да',
    });
  });

  it('queue_status показывает порядок', async () => {
    const setup = makeSetup();
    const app = makeApp(setup);
    setup.service.create({ client: 'claude-code', channel: 'voice', question: 'раз?', context: 'alpha' });
    setup.service.create({ client: 'claude-code', channel: 'voice', question: 'два?', context: 'beta' });

    const res = await callJson(app, 'POST', '/mcp', rpc('tools/call', { name: 'queue_status' }), auth);
    const pending = res.body.result.structuredContent.pending;
    expect(pending.map((p: { position: number; question: string }) => [p.position, p.question])).toEqual([
      [1, 'раз?'],
      [2, 'два?'],
    ]);
  });

  it('cancel_ask снимает вопрос с очереди', async () => {
    const setup = makeSetup();
    const app = makeApp(setup);
    const ask = setup.service.create({
      client: 'claude-code',
      channel: 'voice',
      question: 'снять?',
      timeoutMs: 5_000,
    });
    void setup.service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await callJson(
      app,
      'POST',
      '/mcp',
      rpc('tools/call', { name: 'cancel_ask', arguments: { id: ask.id } }),
      auth,
    );
    expect(res.body.result.structuredContent.status).toBe('cancelled');
    expect(setup.store.voiceHead()).toBeNull();
  });

  it('пустой вопрос — ошибка инструмента', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(
      app,
      'POST',
      '/mcp',
      rpc('tools/call', { name: 'ask_user', arguments: { question: '  ' } }),
      auth,
    );
    expect(res.body.result.isError).toBe(true);
  });

  it('неизвестный метод — -32601', async () => {
    const app = makeApp(makeSetup());
    const res = await callJson(app, 'POST', '/mcp', rpc('does/not/exist'), auth);
    expect(res.body.error.code).toBe(-32601);
  });
});
