import axios from 'axios';
import { config } from './config';

export interface IncomingReply {
  /** message_id сообщения с капчей, на которое ответили. */
  replyToMessageId: number;
  text: string;
}

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
              onReply({ replyToMessageId: replyTo, text: text.trim() });
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

  private apiUrl(): string {
    return `https://api.telegram.org/bot${config.telegram.botToken}`;
  }
}
