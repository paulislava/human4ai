import axios from 'axios';
import { config } from './config';

export interface IncomingPollAnswer {
  pollId: string;
  /** Индексы выбранных вариантов; пустой массив — выбор отозвали. */
  optionIds: number[];
}

export interface IncomingReply {
  /** message_id сообщения с капчей, на которое ответили. */
  replyToMessageId: number;
  /** message_id самого ответа: на нём живёт реакция-статус. */
  messageId: number;
  text: string;
}

/**
 * Реакции-статусы на ответ человека. Telegram принимает не любую эмодзи, а
 * только из своего набора, поэтому «галочки» и «крестика» здесь нет.
 */
export const REACTIONS = {
  /** Ответ забрали в работу. */
  taken: '\u{1F440}',
  /** Ответ подошёл. */
  accepted: '\u{1F44D}',
  /** Ответ не подошёл — сайт его отклонил. */
  rejected: '\u{1F44E}',
  /**
   * Вопрос закрыт — ставится на сообщение самого бота, чтобы отметка была видна
   * даже когда ответ Павла удалён (секрет). Именно 👌, а не ✅: галочку Telegram
   * реакцией не принимает — отвечает REACTION_INVALID.
   */
  done: '\u{1F44C}',
} as const;

/**
 * Клиент Telegram-бота: отправка капчи и приём ответов.
 *
 * Ответ забирается через ForceReply + reply_to_message: так ответ однозначно
 * привязывается к своей задаче, и несколько параллельных капч не перепутаются.
 */
export class TelegramClient {
  private offset = 0;
  private polling = false;
  /** Кэш «чат — супергруппа-форум»: тип чата не меняется. */
  private forum: boolean | null = null;
  /** Темы в этом чате недоступны — не дёргаем createForumTopic на каждый вопрос. */
  private topicsUnsupported = false;

  isConfigured(): boolean {
    return Boolean(config.telegram.botToken && config.telegram.chatId);
  }

  /** Отправляет картинку капчи и возвращает message_id для матчинга ответа. */
  async sendCaptcha(params: {
    image: string;
    caption: string;
  }): Promise<number> {
    const form = new FormData();
    form.append('chat_id', config.telegram.chatId);
    form.append('caption', params.caption);
    // ForceReply открывает у Павла поле ответа сразу — не нужно выбирать
    // «ответить» вручную, а без реплая мы не знаем, к какой задаче ответ.
    form.append('reply_markup', JSON.stringify({ force_reply: true }));
    form.append(
      'photo',
      new Blob([Buffer.from(params.image, 'base64')], { type: 'image/png' }),
      'captcha.png',
    );

    const response = await axios.post(
      `${this.apiUrl()}/sendPhoto`,
      form,
      { timeout: 30_000 },
    );

    const messageId = response.data?.result?.message_id;
    if (typeof messageId !== 'number') {
      throw new Error('Telegram не вернул message_id');
    }

    return messageId;
  }

  /**
   * Сообщение вопроса. Возвращает message_id — по нему реплай привязывается к
   * своей задаче, как и в капче.
   *
   * `forceReply` открывает поле ответа сразу, но у такого сообщения есть важное
   * ограничение: **его нельзя отредактировать** (Bot API отвечает «message can't
   * be edited»). Поэтому вопрос отправляется двумя сообщениями: обычный
   * пост-заголовок, который потом правится в «✅ Ответ принят», и короткое
   * приглашение с `force_reply` реплаем под ним — оно же образует тред.
   *
   * `replyToMessageId` вешает сообщение в тред к заголовку.
   */
  async sendQuestion(params: {
    text: string;
    forceReply?: boolean;
    replyToMessageId?: number;
    threadId?: number;
  }): Promise<number> {
    const response = await axios.post(
      `${this.apiUrl()}/sendMessage`,
      {
        chat_id: config.telegram.chatId,
        text: params.text,
        ...(params.threadId ? { message_thread_id: params.threadId } : {}),
        // Ссылку в вопросе не разворачиваем: превью страницы входа бесполезно.
        disable_web_page_preview: true,
        ...(params.forceReply ? { reply_markup: { force_reply: true } } : {}),
        ...(params.replyToMessageId
          ? {
              reply_parameters: {
                message_id: params.replyToMessageId,
                // Заголовок мог быть удалён — сообщение всё равно должно уйти.
                allow_sending_without_reply: true,
              },
            }
          : {}),
      },
      { timeout: 30_000 },
    );

    const messageId = response.data?.result?.message_id;
    if (typeof messageId !== 'number') {
      throw new Error('Telegram не вернул message_id');
    }

    return messageId;
  }

  /**
   * Вопрос с вариантами — настоящим опросом Telegram: тыкнуть кнопку с телефона
   * быстрее и надёжнее, чем набирать текст реплаем.
   *
   * Опрос неанонимный: только по таким боту приходят `poll_answer`.
   */
  async sendPoll(params: {
    question: string;
    options: string[];
    replyToMessageId?: number;
    threadId?: number;
  }): Promise<{ messageId: number; pollId: string }> {
    const response = await axios.post(
      `${this.apiUrl()}/sendPoll`,
      {
        chat_id: config.telegram.chatId,
        ...(params.threadId ? { message_thread_id: params.threadId } : {}),
        ...(params.replyToMessageId
          ? {
              reply_parameters: {
                message_id: params.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
        // У Telegram лимиты: вопрос до 300 символов, вариант до 100, до 10 штук.
        question: params.question.slice(0, 300),
        options: params.options.slice(0, 10).map((option) => option.slice(0, 100)),
        is_anonymous: false,
        allows_multiple_answers: false,
      },
      { timeout: 30_000 },
    );

    const messageId = response.data?.result?.message_id;
    const pollId = response.data?.result?.poll?.id;
    if (typeof messageId !== 'number' || typeof pollId !== 'string') {
      throw new Error('Telegram не вернул опрос');
    }

    return { messageId, pollId };
  }

  async sendMessage(text: string): Promise<void> {
    await axios.post(
      `${this.apiUrl()}/sendMessage`,
      { chat_id: config.telegram.chatId, text },
      { timeout: 15_000 },
    );
  }

  /**
   * Long polling входящих ответов. Держится на одном соединении: у Telegram
   * либо polling, либо webhook — второй потребитель отбирал бы обновления.
   */
  startPolling(
    onReply: (reply: IncomingReply) => void,
    onPollAnswer?: (answer: IncomingPollAnswer) => void,
  ): void {
    if (this.polling || !this.isConfigured()) {
      return;
    }
    this.polling = true;

    const loop = async (): Promise<void> => {
      while (this.polling) {
        try {
          const response = await axios.get(`${this.apiUrl()}/getUpdates`, {
            params: {
              offset: this.offset,
              timeout: 30,
              // poll_answer нужен для вопросов с вариантами: выбор в опросе
              // приходит отдельным типом обновления, а не сообщением.
              allowed_updates: ['message', 'poll_answer'],
            },
            timeout: 40_000,
          });

          for (const update of response.data?.result ?? []) {
            this.offset = update.update_id + 1;

            const pollAnswer = update.poll_answer;
            if (pollAnswer?.poll_id && onPollAnswer) {
              onPollAnswer({
                pollId: pollAnswer.poll_id,
                optionIds: pollAnswer.option_ids ?? [],
              });
              continue;
            }

            const message = update.message;
            const replyTo = message?.reply_to_message?.message_id;
            const text: string | undefined = message?.text;

            if (typeof replyTo === 'number' && text) {
              onReply({
                replyToMessageId: replyTo,
                messageId: message.message_id,
                text: text.trim(),
              });
            }
          }
        } catch (error) {
          // Сеть моргнула — ждём и продолжаем: обрыв polling молча оставил бы
          // все ожидающие задачи без ответов.
          console.error('Telegram polling:', (error as Error).message);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    };

    void loop();
  }

  stopPolling(): void {
    this.polling = false;
  }

  /**
   * Ставит единственную реакцию на сообщение — так статус ответа виден прямо в
   * переписке, без дополнительных сообщений от бота. `null` снимает реакцию.
   *
   * Ошибку глотаем: реакция — это индикатор, а не часть протокола. Если
   * Telegram её не принял, задача всё равно должна дорешаться.
   */
  async setReaction(messageId: number, emoji: string | null): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      await axios.post(
        `${this.apiUrl()}/setMessageReaction`,
        {
          chat_id: config.telegram.chatId,
          message_id: messageId,
          reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      console.error('Telegram setMessageReaction:', (error as Error).message);
    }
  }

  /**
   * Удаляет сообщение. Нужно для секретов: ответ Павла — это само значение, и
   * после выдачи клиенту ему незачем оставаться в переписке.
   *
   * Ошибку глотаем: Telegram не даёт удалять сообщения старше 48 часов, а
   * задача из-за этого проваливаться не должна.
   */
  async deleteMessage(messageId: number): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      await axios.post(
        `${this.apiUrl()}/deleteMessage`,
        { chat_id: config.telegram.chatId, message_id: messageId },
        { timeout: 15_000 },
      );
    } catch (error) {
      console.error('Telegram deleteMessage:', (error as Error).message);
    }
  }

  /**
   * Переписывает текст своего сообщения — так вопрос в переписке превращается в
   * отметку «ответ принят», а не остаётся висеть с полем для ответа.
   */
  async editMessageText(messageId: number, text: string): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      await axios.post(
        `${this.apiUrl()}/editMessageText`,
        {
          chat_id: config.telegram.chatId,
          message_id: messageId,
          text,
          disable_web_page_preview: true,
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      console.error('Telegram editMessageText:', (error as Error).message);
    }
  }

  /**
   * Чат — супергруппа-форум? Проверяем только для закрытия темы: `closeForumTopic`
   * работает лишь там, а вот **создавать** темы можно и в личке — Telegram
   * научился темам в личных чатах, и `createForumTopic` там отвечает `ok`.
   *
   * Ответ кэшируем: тип чата не меняется, а `getChat` лишний раз дёргать незачем.
   */
  async isForum(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (this.forum !== null) return this.forum;

    try {
      const response = await axios.get(`${this.apiUrl()}/getChat`, {
        params: { chat_id: config.telegram.chatId },
        timeout: 15_000,
      });
      this.forum = Boolean(response.data?.result?.is_forum);
    } catch (error) {
      console.error('Telegram getChat:', (error as Error).message);
      this.forum = false;
    }

    return this.forum;
  }

  /**
   * Отдельная тема под вопрос. Возвращает `message_thread_id` или `null`, если
   * темы в этом чате недоступны — тогда тредом работает цепочка реплаев.
   *
   * Тип чата заранее не проверяем: в личных чатах `getChat` не сообщает ничего
   * про темы, но `createForumTopic` там работает. Проще попробовать и запомнить
   * отказ, чем угадывать по признакам.
   */
  async createTopic(name: string): Promise<number | null> {
    if (!this.isConfigured() || this.topicsUnsupported) return null;

    try {
      const response = await axios.post(
        `${this.apiUrl()}/createForumTopic`,
        // Лимит Telegram — 128 символов.
        { chat_id: config.telegram.chatId, name: name.slice(0, 128) },
        { timeout: 15_000 },
      );

      const threadId = response.data?.result?.message_thread_id;
      if (typeof threadId === 'number') return threadId;

      this.topicsUnsupported = true;
      return null;
    } catch (error) {
      // Темы в этом чате не поддерживаются или боту не разрешены — больше не
      // пробуем, работаем цепочкой реплаев.
      this.topicsUnsupported = true;
      console.error('Telegram createForumTopic:', (error as Error).message);
      return null;
    }
  }

  /**
   * Закрыть тему отвеченного вопроса, чтобы список ветвей не разрастался.
   * Работает только в супергруппе-форуме: в личке Telegram отвечает «the chat is
   * not a supergroup forum», поэтому там даже не пытаемся.
   */
  async closeTopic(threadId: number): Promise<void> {
    if (!this.isConfigured() || !(await this.isForum())) return;

    try {
      await axios.post(
        `${this.apiUrl()}/closeForumTopic`,
        { chat_id: config.telegram.chatId, message_thread_id: threadId },
        { timeout: 15_000 },
      );
    } catch (error) {
      console.error('Telegram closeForumTopic:', (error as Error).message);
    }
  }

  private apiUrl(): string {
    return `https://api.telegram.org/bot${config.telegram.botToken}`;
  }
}
