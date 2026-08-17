import axios from 'axios';
import { config } from './config';

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
  startPolling(onReply: (reply: IncomingReply) => void): void {
    if (this.polling || !this.isConfigured()) {
      return;
    }
    this.polling = true;

    const loop = async (): Promise<void> => {
      while (this.polling) {
        try {
          const response = await axios.get(`${this.apiUrl()}/getUpdates`, {
            params: { offset: this.offset, timeout: 30, allowed_updates: ['message'] },
            timeout: 40_000,
          });

          for (const update of response.data?.result ?? []) {
            this.offset = update.update_id + 1;

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

  private apiUrl(): string {
    return `https://api.telegram.org/bot${config.telegram.botToken}`;
  }
}
