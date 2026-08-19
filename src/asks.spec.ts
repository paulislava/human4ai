import Database from 'better-sqlite3';
import { AskService, AskStore } from './asks';
import { REACTIONS, TelegramClient } from './telegram';

/** Телеграм подменяем: тесты не должны никуда ходить и никого спрашивать. */
function fakeTelegram() {
  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  const deleted: number[] = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 100;

  const telegram = {
    isConfigured: () => true,
    sendQuestion: async () => (nextMessageId += 1),
    sendPoll: async () => {
      nextMessageId += 1;
      return { messageId: nextMessageId, pollId: `poll-${nextMessageId}` };
    },
    setReaction: async (messageId: number, emoji: string | null) => {
      reactions.push({ messageId, emoji });
    },
    deleteMessage: async (messageId: number) => {
      deleted.push(messageId);
    },
    editMessageText: async (messageId: number, text: string) => {
      edited.push({ messageId, text });
    },
  } as unknown as TelegramClient;

  return { telegram, reactions, deleted, edited };
}

function makeService(timeoutMs = 5_000) {
  const store = new AskStore(new Database(':memory:'));
  const { telegram, reactions, deleted, edited } = fakeTelegram();
  return {
    store,
    reactions,
    deleted,
    edited,
    service: new AskService(store, telegram, timeoutMs),
  };
}

/** Ждём микрозадачи: приборка в чате идёт фоном, ответ клиенту её не ждёт. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('AskService', () => {
  it('отдаёт ответ, пришедший реплаем на свой вопрос', async () => {
    const { store, service } = makeService();
    const ask = service.create({ client: 'test', question: 'Токен от BotFather?' });

    const running = service.run(ask.id);
    // Ждём отправки вопроса: до неё message_id ещё не известен.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const messageId = store.get(ask.id)!.telegramMessageId!;
    expect(service.handleReply(messageId, '  секрет-значение  ', 500)).toBe(true);

    const finished = await running;
    expect(finished.status).toBe('answered');
    expect(store.get(ask.id)!.answer).toBe('секрет-значение');
  });

  it('не путает два одновременных вопроса', async () => {
    const { store, service } = makeService();
    const first = service.create({ client: 'test', question: 'Первый?' });
    const second = service.create({ client: 'test', question: 'Второй?' });

    const running = Promise.all([service.run(first.id), service.run(second.id)]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const firstMessage = store.get(first.id)!.telegramMessageId!;
    const secondMessage = store.get(second.id)!.telegramMessageId!;

    // Отвечаем в обратном порядке — ответ должен уйти своему вопросу.
    service.handleReply(secondMessage, 'ответ-второго', 501);
    service.handleReply(firstMessage, 'ответ-первого', 502);

    await running;
    expect(store.get(first.id)!.answer).toBe('ответ-первого');
    expect(store.get(second.id)!.answer).toBe('ответ-второго');
  });

  it('реплай на чужое сообщение не считается ответом', async () => {
    const { service } = makeService();
    expect(service.handleReply(999_999, 'мимо', 503)).toBe(false);
  });

  it('секрет отдаётся один раз и стирается из базы', async () => {
    const { store, service } = makeService();
    const ask = service.create({ client: 'test', kind: 'secret', question: 'Пароль?' });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.handleReply(store.get(ask.id)!.telegramMessageId!, 'p@ssw0rd', 504);
    await running;

    expect(store.takeAnswer(ask.id)!.answer).toBe('p@ssw0rd');

    // Второе чтение значения уже не отдаёт: на диске его нет.
    const again = store.takeAnswer(ask.id)!;
    expect(again.status).toBe('taken');
    expect(again.answer).toBeNull();
  });

  it('без ответа в срок закрывается таймаутом', async () => {
    const { service } = makeService(30);
    const ask = service.create({ client: 'test', question: 'Молчание?' });

    const finished = await service.run(ask.id);
    expect(finished.status).toBe('timeout');
    expect(finished.answer).toBeNull();
  });

  it('ставит реакции: взял ответ, подтвердили, отклонили', async () => {
    const { store, reactions, service } = makeService();
    const ask = service.create({ client: 'test', question: 'Код?' });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.handleReply(store.get(ask.id)!.telegramMessageId!, '123456', 777);
    await running;

    service.confirm(ask.id);
    expect(reactions.map((r) => r.messageId)).toEqual([777, 777]);
    expect(reactions[0].emoji).toBe('\u{1F440}');
    expect(reactions[1].emoji).toBe('\u{1F44D}');
  });
});

describe('AskService: любой вопрос, не только секрет', () => {
  it('ответ на обычный вопрос не стирается после чтения', async () => {
    const { store, service } = makeService();
    const ask = service.create({
      client: 'test',
      kind: 'text',
      question: 'Какой домен использовать?',
    });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.handleReply(store.get(ask.id)!.telegramMessageId!, 'captcha.example', 601);
    await running;

    expect(store.takeAnswer(ask.id)!.answer).toBe('captcha.example');
    // В отличие от секрета, обычный ответ читается повторно.
    expect(store.takeAnswer(ask.id)!.answer).toBe('captcha.example');
  });

  it('текстовый ответ номером разворачивается в вариант', async () => {
    const { store, service } = makeService();
    const ask = service.create({
      client: 'test',
      kind: 'text',
      question: 'Куда деплоить?',
      options: ['сервер', 'локально', 'никуда'],
    });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.handleReply(store.get(ask.id)!.telegramMessageId!, '2', 602);
    await running;

    expect(store.get(ask.id)!.answer).toBe('локально');
  });

  it('номер вне списка остаётся текстом как есть', async () => {
    const { store, service } = makeService();
    const ask = service.create({
      client: 'test',
      kind: 'text',
      question: 'Сколько ретраев?',
      options: ['один', 'два'],
    });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.handleReply(store.get(ask.id)!.telegramMessageId!, '7', 603);
    await running;

    expect(store.get(ask.id)!.answer).toBe('7');
  });
});

describe('AskService: вопрос опросом', () => {
  it('варианты уходят опросом, а выбор возвращается ответом', async () => {
    const polls: Array<{ question: string; options: string[] }> = [];
    const reactions: Array<{ messageId: number; emoji: string | null }> = [];
    const store = new AskStore(new Database(':memory:'));
    const telegram = {
      isConfigured: () => true,
      sendQuestion: async () => 1,
      sendPoll: async (params: { question: string; options: string[] }) => {
        polls.push(params);
        return { messageId: 900, pollId: 'poll-1' };
      },
      setReaction: async (messageId: number, emoji: string | null) => {
        reactions.push({ messageId, emoji });
      },
    } as unknown as TelegramClient;
    const service = new AskService(store, telegram, 5_000);

    const ask = service.create({
      client: 'test',
      kind: 'text',
      question: 'Куда деплоить?',
      context: 'проверка',
      options: ['сервер', 'локально'],
    });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(polls).toHaveLength(1);
    expect(polls[0].question).toBe('Куда деплоить? (проверка)');
    expect(service.handlePollAnswer('poll-1', [1])).toBe(true);

    const finished = await running;
    expect(finished.status).toBe('answered');
    expect(store.get(ask.id)!.answer).toBe('локально');
    // Реакция ставится на сообщение с опросом: у выбора своего сообщения нет.
    expect(reactions[0]).toEqual({ messageId: 900, emoji: '\u{1F440}' });
  });

  it('отозванный выбор оставляет вопрос открытым', async () => {
    const store = new AskStore(new Database(':memory:'));
    const telegram = {
      isConfigured: () => true,
      sendPoll: async () => ({ messageId: 901, pollId: 'poll-2' }),
      setReaction: async () => undefined,
    } as unknown as TelegramClient;
    const service = new AskService(store, telegram, 60);

    const ask = service.create({
      client: 'test',
      kind: 'text',
      question: 'Так или иначе?',
      options: ['так', 'иначе'],
    });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(service.handlePollAnswer('poll-2', [])).toBe(true);
    // Вопрос не закрылся — досиживает до таймаута.
    expect((await running).status).toBe('timeout');
  });

  it('секрет с вариантами всё равно спрашивается текстом', async () => {
    const store = new AskStore(new Database(':memory:'));
    let pollsSent = 0;
    const telegram = {
      isConfigured: () => true,
      sendQuestion: async () => 902,
      sendPoll: async () => {
        pollsSent += 1;
        return { messageId: 903, pollId: 'poll-3' };
      },
      setReaction: async () => undefined,
    } as unknown as TelegramClient;
    const service = new AskService(store, telegram, 5_000);

    const ask = service.create({
      client: 'test',
      kind: 'secret',
      question: 'Пароль?',
      options: ['а', 'б'],
    });

    const running = service.run(ask.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.handleReply(902, 'секрет', 904);
    await running;

    expect(pollsSent).toBe(0);
    expect(store.get(ask.id)!.answer).toBe('секрет');
  });
});

describe('приборка в переписке после выдачи ответа', () => {
  async function answered(kind: 'secret' | 'text') {
    const setup = makeService();
    const ask = setup.service.create({ client: 'test', kind, question: 'Токен от BotFather?' });
    const running = setup.service.run(ask.id);
    await flush();

    const questionMessageId = setup.store.get(ask.id)!.telegramMessageId!;
    setup.service.handleReply(questionMessageId, 'значение-ответа', 777);
    await running;

    return { ...setup, ask, questionMessageId };
  }

  it('ответ на секрет удаляется из чата, вопрос помечается принятым', async () => {
    const setup = await answered('secret');

    const taken = setup.service.takeAnswer(setup.ask.id);
    expect(taken!.answer).toBe('значение-ответа');
    await flush();

    // Сообщение Павла — это само значение: в переписке ему делать нечего.
    expect(setup.deleted).toEqual([777]);
    expect(setup.edited).toHaveLength(1);
    expect(setup.edited[0].messageId).toBe(setup.questionMessageId);
    expect(setup.edited[0].text).toContain('✅ Ответ принят');
    expect(setup.edited[0].text).toContain('удалён из чата');
  });

  it('на обычном вопросе ответ не удаляют, а помечают принятым', async () => {
    const setup = await answered('text');

    setup.service.takeAnswer(setup.ask.id);
    await flush();

    expect(setup.deleted).toEqual([]);
    // Отметка «принято» появляется именно сейчас — когда клиент забрал значение.
    expect(setup.reactions).toEqual([
      { messageId: 777, emoji: REACTIONS.taken },
      { messageId: 777, emoji: REACTIONS.accepted },
    ]);
    expect(setup.edited[0].text).toContain('✅ Ответ принят');
  });

  it('повторное чтение обычного ответа переписку не правит', async () => {
    const setup = await answered('text');

    setup.service.takeAnswer(setup.ask.id);
    await flush();
    setup.service.takeAnswer(setup.ask.id);
    await flush();

    expect(setup.edited).toHaveLength(1);
  });

  it('неотвеченный вопрос переписку не трогает', async () => {
    const setup = makeService();
    const ask = setup.service.create({ client: 'test', question: 'Ждём?' });

    expect(setup.service.takeAnswer(ask.id)!.status).toBe('pending');
    await flush();
    expect([setup.edited, setup.deleted]).toEqual([[], []]);
  });
});
