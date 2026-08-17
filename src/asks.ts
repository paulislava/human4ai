import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config';
import { REACTIONS, TelegramClient } from './telegram';
import { VoiceService } from './voice/voice.service';

/**
 * `secret` и `code` — значения, которые нельзя оставлять на диске:
 * отдаются один раз. `text` — обычный вопрос, ответ читается сколько нужно.
 */
export type AskKind = 'secret' | 'code' | 'text';
export type AskStatus = 'pending' | 'answered' | 'timeout' | 'taken' | 'skipped';
/**
 * Куда уходит вопрос: реплаем в Telegram или голосом на Яндекс-Станцию.
 * Голосовой канал строго FIFO — вслух звучит только первый вопрос очереди,
 * и ответ Павла достаётся тому, кто спросил раньше.
 */
export type AskChannel = 'telegram' | 'voice';

export interface Ask {
  id: string;
  client: string;
  channel: AskChannel;
  kind: AskKind;
  /** Что именно спрашиваем: «токен от BotFather», «код со страницы входа». */
  question: string;
  /** Зачем спрашиваем — попадает в сообщение, чтобы вопрос не выглядел фишингом. */
  context: string | null;
  /** Ссылка, которую нужно открыть перед ответом (вход, страница с кодом). */
  link: string | null;
  /** Варианты ответа: Павел может ответить номером вместо текста. */
  options: string[];
  status: AskStatus;
  answer: string | null;
  telegramMessageId: number | null;
  /** id опроса, если вопрос отправлен с вариантами. */
  telegramPollId: string | null;
  telegramReplyMessageId: number | null;
  /** Колонка для голосового вопроса: номер, имя или device_id. */
  station: string | null;
  /** Когда вопрос прозвучал — чтобы не проговаривать его дважды. */
  spokenAt: number | null;
  createdAt: number;
  expiresAt: number;
}

interface AskRow {
  id: string;
  client: string;
  channel: AskChannel | null;
  kind: AskKind;
  question: string;
  context: string | null;
  link: string | null;
  options: string | null;
  status: AskStatus;
  answer: string | null;
  telegram_message_id: number | null;
  telegram_poll_id: string | null;
  telegram_reply_message_id: number | null;
  station: string | null;
  spoken_at: number | null;
  created_at: number;
  expires_at: number;
}

/**
 * Вопросы человеку: секрет, одноразовый код или что угодно ещё.
 *
 * Для секретов и кодов действует отдельное правило: ответ нигде не логируется и
 * стирается из базы сразу после того, как клиент его забрал — значение живёт
 * ровно столько, сколько нужно, чтобы доехать до клиента.
 */
export class AskStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        kind TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        link TEXT,
        options TEXT,
        status TEXT NOT NULL,
        answer TEXT,
        telegram_message_id INTEGER,
        telegram_poll_id TEXT,
        telegram_reply_message_id INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_asks_status ON asks (status);
      CREATE INDEX IF NOT EXISTS idx_asks_tg_message ON asks (telegram_message_id);
      CREATE INDEX IF NOT EXISTS idx_asks_tg_poll ON asks (telegram_poll_id);
    `);

    // Голосовой канал добавлен позже: у базы, созданной прежней версией, этих
    // колонок нет. Пустой channel читается как 'telegram' (см. toAsk).
    for (const [column, definition] of [
      ['channel', 'TEXT'],
      ['station', 'TEXT'],
      ['spoken_at', 'INTEGER'],
    ]) {
      const exists = (
        this.db.prepare('SELECT * FROM pragma_table_info(?)').all('asks') as Array<{
          name: string;
        }>
      ).some((c) => c.name === column);
      if (!exists) this.db.exec(`ALTER TABLE asks ADD COLUMN ${column} ${definition}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_asks_channel ON asks (channel, status)');
  }

  create(ask: Ask): void {
    this.db
      .prepare(
        `INSERT INTO asks (id, client, channel, kind, question, context, link, options,
                           status, answer, telegram_message_id, telegram_poll_id,
                           telegram_reply_message_id, station, spoken_at,
                           created_at, expires_at)
         VALUES (@id, @client, @channel, @kind, @question, @context, @link, @options,
                 @status, @answer, @telegramMessageId, @telegramPollId,
                 @telegramReplyMessageId, @station, @spokenAt,
                 @createdAt, @expiresAt)`,
      )
      .run({ ...ask, options: JSON.stringify(ask.options) });
  }

  get(id: string): Ask | null {
    const row = this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as
      | AskRow
      | undefined;
    return row ? toAsk(row) : null;
  }

  byTelegramMessage(messageId: number): Ask | null {
    const row = this.db
      .prepare('SELECT * FROM asks WHERE telegram_message_id = ?')
      .get(messageId) as AskRow | undefined;
    return row ? toAsk(row) : null;
  }

  byPollId(pollId: string): Ask | null {
    const row = this.db
      .prepare('SELECT * FROM asks WHERE telegram_poll_id = ?')
      .get(pollId) as AskRow | undefined;
    return row ? toAsk(row) : null;
  }

  /**
   * Первый неотвеченный голосовой вопрос — им и «говорит» очередь.
   * Просроченные пропускаем: их клиенты уже перестали ждать.
   */
  voiceHead(now = Date.now()): Ask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM asks
          WHERE channel = 'voice' AND status = 'pending' AND expires_at > ?
          ORDER BY rowid LIMIT 1`,
      )
      .get(now) as AskRow | undefined;
    return row ? toAsk(row) : null;
  }

  /** Вся голосовая очередь по порядку — для «сколько вопросов» и статуса. */
  voicePending(now = Date.now()): Ask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM asks
          WHERE channel = 'voice' AND status = 'pending' AND expires_at > ?
          ORDER BY rowid`,
      )
      .all(now) as AskRow[];
    return rows.map(toAsk);
  }

  update(id: string, patch: Partial<Ask>): void {
    const columns: Record<string, string> = {
      status: 'status',
      answer: 'answer',
      telegramMessageId: 'telegram_message_id',
      telegramPollId: 'telegram_poll_id',
      telegramReplyMessageId: 'telegram_reply_message_id',
      station: 'station',
      spokenAt: 'spoken_at',
      expiresAt: 'expires_at',
    };

    const sets: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (column) {
        sets.push(`${column} = @${key}`);
        values[key] = value ?? null;
      }
    }

    if (sets.length === 0) return;
    this.db.prepare(`UPDATE asks SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  /**
   * Отдаёт ответ клиенту.
   *
   * Секрет и код стираются сразу после выдачи: незачем держать их на диске
   * после того, как они доехали до клиента, повторное чтение вернёт `taken`
   * без значения. Обычный вопрос (`text`) так не стирается — его ответ можно
   * прочитать сколько угодно раз.
   */
  takeAnswer(id: string): Ask | null {
    const ask = this.get(id);
    if (!ask) return null;
    if (ask.status !== 'answered') return ask;

    if (ask.kind !== 'text') {
      this.update(id, { status: 'taken', answer: null });
    }

    return ask;
  }
}

function toAsk(row: AskRow): Ask {
  return {
    id: row.id,
    client: row.client,
    // Записи, созданные до появления голосового канала, — телеграмные.
    channel: row.channel ?? 'telegram',
    kind: row.kind,
    question: row.question,
    context: row.context,
    link: row.link,
    options: row.options ? (JSON.parse(row.options) as string[]) : [],
    status: row.status,
    answer: row.answer,
    telegramMessageId: row.telegram_message_id,
    telegramPollId: row.telegram_poll_id,
    telegramReplyMessageId: row.telegram_reply_message_id,
    station: row.station,
    spokenAt: row.spoken_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface CreateAskInput {
  client: string;
  question: string;
  channel?: AskChannel;
  kind?: AskKind;
  context?: string | null;
  link?: string | null;
  options?: string[];
  /** Колонка для голосового вопроса: номер, имя или device_id. */
  station?: string | null;
  timeoutMs?: number;
}

/**
 * Спрашивает Павла в Telegram и ждёт реплай.
 *
 * Годится и для секретов, и для любого другого вопроса: `kind` меняет только
 * заголовок сообщения и то, стирается ли ответ после выдачи.
 *
 * Несколько вопросов одновременно не путаются: ответ привязывается к своему
 * вопросу через `reply_to_message`, как и в капче.
 */
export class AskService {
  /** id вопроса → как разбудить ожидающий вызов. */
  private readonly waiting = new Map<
    string,
    { resolve: (answer: string | null) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly store: AskStore,
    private readonly telegram: TelegramClient,
    private readonly defaultTimeoutMs: number,
    /** Голосовой канал; без него доступен только Telegram. */
    private readonly voice?: VoiceService,
  ) {}

  isAvailable(channel: AskChannel = 'telegram'): boolean {
    return channel === 'voice'
      ? Boolean(this.voice?.isAvailable())
      : this.telegram.isConfigured();
  }

  create(input: CreateAskInput): Ask {
    const now = Date.now();
    const ask: Ask = {
      id: `ask_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      client: input.client,
      channel: input.channel ?? 'telegram',
      // По умолчанию это обычный вопрос: секретная семантика (одноразовая
      // выдача, стирание с диска) включается явным kind.
      kind: input.kind ?? 'text',
      question: input.question,
      context: input.context ?? null,
      link: input.link ?? null,
      options: input.options ?? [],
      status: 'pending',
      answer: null,
      telegramMessageId: null,
      telegramPollId: null,
      telegramReplyMessageId: null,
      station: input.station ?? null,
      spokenAt: null,
      createdAt: now,
      expiresAt:
        now +
        (input.timeoutMs ??
          // Голосовой вопрос ждёт долго: Павел подойдёт к колонке когда сможет.
          (input.channel === 'voice' ? config.voice.ttlMs : this.defaultTimeoutMs)),
    };

    this.store.create(ask);
    return ask;
  }

  /** Отправляет вопрос и ждёт ответ до истечения срока. */
  async run(askId: string): Promise<Ask> {
    const ask = this.store.get(askId);
    if (!ask) throw new Error(`Вопрос ${askId} не найден`);

    const remaining = ask.expiresAt - Date.now();
    if (remaining <= 0) {
      this.store.update(askId, { status: 'timeout' });
      return this.store.get(askId)!;
    }

    if (ask.channel === 'voice') return this.runVoice(ask, remaining);

    // Варианты отправляем опросом — ответ одним тапом. Секрет и код в опрос
    // не превратить, да и незачем: их набирают руками.
    if (ask.options.length > 0 && ask.kind === 'text') {
      const poll = await this.telegram.sendPoll({
        question: this.buildPollQuestion(ask),
        options: ask.options,
      });
      this.store.update(askId, {
        telegramMessageId: poll.messageId,
        telegramPollId: poll.pollId,
      });
    } else {
      const messageId = await this.telegram.sendQuestion({
        text: this.buildText(ask),
      });
      this.store.update(askId, { telegramMessageId: messageId });
    }

    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(askId);
        resolve(null);
      }, remaining);
      // Ждать ответ — не повод держать event loop: у сервера есть свои handle'ы,
      // а в тестах и скриптах такой таймер (у голоса — сутки) вешал процесс.
      timer.unref?.();

      this.waiting.set(askId, { resolve, timer });
    });

    if (answer === null) {
      this.store.update(askId, { status: 'timeout' });
    } else {
      this.store.update(askId, { status: 'answered', answer });
    }

    return this.store.get(askId)!;
  }

  /**
   * Голосовой вопрос: ждём, пока Павел ответит через навык Алисы.
   *
   * Озвучиваем только голову очереди — иначе колонка тараторила бы все вопросы
   * подряд. Остальные прозвучат, когда до них дойдёт ход (после ответа,
   * пропуска или истечения предыдущего).
   */
  private async runVoice(ask: Ask, remaining: number): Promise<Ask> {
    this.speakHead();

    // Дубль в Telegram: колонку можно не услышать, телефон почти всегда рядом.
    // Кто ответит первым — тот и закрывает вопрос (см. deliver): второй ответ
    // придёт уже на закрытый вопрос и будет проигнорирован.
    if (config.voice.alsoTelegram && this.telegram.isConfigured()) {
      try {
        const messageId = await this.telegram.sendQuestion({ text: this.buildText(ask) });
        this.store.update(ask.id, { telegramMessageId: messageId });
      } catch (error) {
        console.error(`[ask] ${ask.id}: дубль в Telegram не ушёл:`, (error as Error).message);
      }
    }

    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(ask.id);
        resolve(null);
      }, remaining);
      timer.unref?.();

      this.waiting.set(ask.id, { resolve, timer });
    });

    // Ответ и пропуск проставляют статус сами, синхронно — иначе следующий
    // ответ успел бы прийти на тот же вопрос, пока этот ход ещё «просыпается».
    const current = this.store.get(ask.id)!;
    if (current.status !== 'pending') return current;

    this.store.update(ask.id, { status: 'timeout' });
    this.speakHead();
    return this.store.get(ask.id)!;
  }

  /** Проговорить первый вопрос очереди, если он ещё не звучал. */
  speakHead(): void {
    if (!this.voice) return;

    const head = this.store.voiceHead();
    if (!head || head.spokenAt) return;

    const queueLength = this.store.voicePending().length;
    // Пометку ставим заранее: пока идёт отправка (сеть, прокси, колонка),
    // второй вопрос успел бы позвать speakHead и проговорить то же самое.
    this.store.update(head.id, { spokenAt: Date.now() });
    void this.voice
      .speak(
        this.voice.phrase({
          question: head.question,
          client: head.client,
          context: head.context,
          options: head.options,
          queueLength,
        }),
        head.station,
      )
      .then(({ ok, detail }) => {
        console.log(`[ask] ${head.id}: озвучен=${ok} (${detail})`);
        // Не получилось — снимаем пометку, чтобы вопрос можно было проговорить
        // снова (по «повтори» или когда прокси вернётся).
        if (!ok) this.store.update(head.id, { spokenAt: null });
      });
  }

  /**
   * Ответ голосом уходит первому вопросу в очереди: у навыка Алисы нет способа
   * указать, какой именно вопрос имеется в виду, поэтому порядок и решает.
   * -> закрытый вопрос или null, если очередь пуста.
   */
  answerVoiceHead(text: string): Ask | null {
    const head = this.store.voiceHead();
    if (!head) return null;

    const closed = this.deliver(head, text, 'голосом');
    return closed ?? this.store.get(head.id);
  }

  /**
   * Закрыть вопрос ответом. Возвращает null, если вопрос уже закрыт — так
   * отсекается второй ответ, когда вопрос ушёл сразу в два канала (колонка и
   * Telegram) и Павел ответил в оба.
   *
   * Статус ставим синхронно, до пробуждения ожидающего хода: иначе следующий
   * ответ успел бы прийти на тот же вопрос.
   */
  private deliver(ask: Ask, text: string, how: string): Ask | null {
    const current = this.store.get(ask.id);
    if (!current || current.status !== 'pending') return null;

    const answer = this.resolveOption(current, text.trim());
    this.store.update(current.id, { status: 'answered', answer });

    const pending = this.waiting.get(current.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.waiting.delete(current.id);
      pending.resolve(answer);
    }

    if (how === 'голосом' && current.telegramMessageId) {
      void this.telegram.setReaction(current.telegramMessageId, REACTIONS.taken);
    }

    // Секрет в лог не пишем — ни значение, ни его длину.
    console.log(`[ask] ${current.id}: ответ получен ${how} (${current.kind})`);
    return this.store.get(current.id);
  }

  /** «Пропусти»: снимаем голову очереди, клиент уходит в терминальный фолбэк. */
  skipVoiceHead(): Ask | null {
    const head = this.store.voiceHead();
    if (!head) return null;

    this.store.update(head.id, { status: 'skipped' });

    const pending = this.waiting.get(head.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.waiting.delete(head.id);
      pending.resolve(null);
    }

    console.log(`[ask] ${head.id}: пропущен голосом`);
    return this.store.get(head.id);
  }

  /** Клиент передумал ждать: снять вопрос с очереди. */
  cancel(askId: string): Ask | null {
    const ask = this.store.get(askId);
    if (!ask || ask.status !== 'pending') return null;

    this.store.update(askId, { status: 'timeout' });

    const pending = this.waiting.get(askId);
    if (pending) {
      clearTimeout(pending.timer);
      this.waiting.delete(askId);
      pending.resolve(null);
    }

    if (ask.channel === 'voice') this.speakHead();
    return this.store.get(askId);
  }

  /**
   * Реплай из Telegram. Возвращает `true`, если ответ относился к вопросу —
   * так поллер понимает, что сообщение уже разобрано.
   */
  handleReply(replyToMessageId: number, text: string, replyMessageId?: number): boolean {
    const ask = this.store.byTelegramMessage(replyToMessageId);
    if (!ask) return false;

    if (replyMessageId !== undefined) {
      this.store.update(ask.id, { telegramReplyMessageId: replyMessageId });
      void this.telegram.setReaction(replyMessageId, REACTIONS.taken);
    }

    // Вопрос мог быть уже закрыт голосом: реплай всё равно «наш» (сообщение
    // разобрано), но ответ второй раз не применяем.
    const closed = this.deliver(ask, text, 'реплаем');
    if (!closed && ask.channel === 'voice') {
      console.log(`[ask] ${ask.id}: реплай пришёл на уже закрытый вопрос`);
    }
    return true;
  }

  /**
   * Выбор варианта в опросе. Возвращает `true`, если опрос относился к вопросу.
   *
   * Реакцию ставим на само сообщение с опросом: у выбора в опросе своего
   * сообщения нет, и ответить реакцией больше некуда.
   */
  handlePollAnswer(pollId: string, optionIds: number[]): boolean {
    const ask = this.store.byPollId(pollId);
    if (!ask) return false;

    const pending = this.waiting.get(ask.id);
    if (!pending) return false;

    // Выбор отозвали — ждём дальше, вопрос ещё открыт.
    if (optionIds.length === 0) return true;

    const answer = ask.options[optionIds[0]];
    if (answer === undefined) return true;

    clearTimeout(pending.timer);
    this.waiting.delete(ask.id);

    if (ask.telegramMessageId) {
      this.store.update(ask.id, { telegramReplyMessageId: ask.telegramMessageId });
      void this.telegram.setReaction(ask.telegramMessageId, REACTIONS.taken);
    }

    console.log(`[ask] ${ask.id}: выбран вариант в опросе`);
    pending.resolve(answer);
    return true;
  }

  /** Клиент сообщил, что значение не подошло: спрашиваем заново. */
  async retry(askId: string): Promise<Ask> {
    const ask = this.store.get(askId);
    if (!ask) throw new Error(`Вопрос ${askId} не найден`);

    if (ask.telegramReplyMessageId) {
      void this.telegram.setReaction(ask.telegramReplyMessageId, REACTIONS.rejected);
    }

    this.store.update(askId, {
      status: 'pending',
      answer: null,
      telegramPollId: null,
      // Срок продлеваем: иначе повтор упирался бы в остаток от первой попытки.
      expiresAt: Date.now() + this.defaultTimeoutMs,
    });

    return this.run(askId);
  }

  /** Клиент подтвердил, что значение подошло. */
  confirm(askId: string): void {
    const ask = this.store.get(askId);
    if (ask?.telegramReplyMessageId) {
      void this.telegram.setReaction(ask.telegramReplyMessageId, REACTIONS.accepted);
    }
  }

  /**
   * Ответ номером варианта разворачивается в сам вариант: с телефона проще
   * набрать «2», чем переписывать формулировку целиком.
   */
  private resolveOption(ask: Ask, answer: string): string {
    if (ask.options.length === 0) return answer;

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= ask.options.length) {
      return ask.options[index - 1];
    }

    return answer;
  }

  /** У опроса вместо подписи один вопрос — контекст вклеиваем в него же. */
  private buildPollQuestion(ask: Ask): string {
    return ask.context ? `${ask.question} (${ask.context})` : ask.question;
  }

  private buildText(ask: Ask): string {
    const heading =
      ask.kind === 'code'
        ? '🔑 Нужен код'
        : ask.kind === 'text'
          ? '❓ Вопрос'
          : '🔒 Нужен секрет';

    const lines = [`${heading} — ответьте реплаем на это сообщение.`, '', ask.question];

    if (ask.options.length > 0) {
      lines.push('', ...ask.options.map((option, i) => `${i + 1}. ${option}`));
      lines.push('', 'Можно ответить номером.');
    }
    if (ask.context) {
      lines.push('', `Кто просит: ${ask.context}`);
    }
    if (ask.link) {
      lines.push('', `Ссылка: ${ask.link}`);
    }

    if (ask.channel === 'voice') {
      lines.push('', 'Этот вопрос сейчас звучит на колонке — можно ответить голосом:');
      lines.push('«Алиса, ответь коду …». Кто первый, тот и закрывает вопрос.');
    }

    const minutes = Math.round((ask.expiresAt - Date.now()) / 60_000);
    lines.push(
      '',
      minutes > 90 ? `Жду ${Math.round(minutes / 60)} ч.` : `Жду ${minutes} мин.`,
    );

    return lines.join('\n');
  }
}
