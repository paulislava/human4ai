import { TelegramClient } from '../telegram';
import { CaptchaSolver, SolveInput } from './types';

/**
 * Последняя ступень: спросить человека.
 *
 * Отправляет картинку в Telegram и ждёт реплай. Ожидание — настоящее: промис
 * резолвится, когда придёт ответ, либо когда истечёт срок задачи.
 */
export class HumanSolver implements CaptchaSolver {
  readonly name = 'human';

  /** taskId → как разбудить ожидающий вызов solve(). */
  private readonly waiting = new Map<
    string,
    { resolve: (answer: string | null) => void; timer: NodeJS.Timeout }
  >();

  /** message_id в Telegram → taskId. */
  private readonly byMessage = new Map<number, string>();

  constructor(private readonly telegram: TelegramClient) {}

  isAvailable(): boolean {
    return this.telegram.isConfigured();
  }

  async solve(input: SolveInput): Promise<string | null> {
    const messageId = await this.telegram.sendCaptcha({
      image: input.image,
      caption: this.buildCaption(input),
    });

    this.byMessage.set(messageId, input.taskId);

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.forget(input.taskId, messageId);
        resolve(null);
      }, input.timeoutMs);

      this.waiting.set(input.taskId, { resolve, timer });
    });
  }

  /** Вызывается из Telegram-поллера, когда пришёл реплай. */
  handleReply(messageId: number, text: string): boolean {
    const taskId = this.byMessage.get(messageId);
    if (!taskId) {
      return false;
    }

    const pending = this.waiting.get(taskId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.forget(taskId, messageId);
    pending.resolve(text);
    return true;
  }

  /** taskId ожидающей задачи по сообщению — нужно серверу для матчинга. */
  taskIdForMessage(messageId: number): string | null {
    return this.byMessage.get(messageId) ?? null;
  }

  /** Задачу отменили (например, клиент прислал reject) — снимаем ожидание. */
  cancel(taskId: string): void {
    const pending = this.waiting.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.waiting.delete(taskId);
    for (const [messageId, id] of this.byMessage) {
      if (id === taskId) {
        this.byMessage.delete(messageId);
      }
    }
    pending.resolve(null);
  }

  private forget(taskId: string, messageId: number): void {
    this.waiting.delete(taskId);
    this.byMessage.delete(messageId);
  }

  private buildCaption(input: SolveInput): string {
    const lines = ['🔐 Нужно разгадать капчу — ответьте реплаем на это сообщение.'];

    if (input.context) {
      lines.push(`Кто просит: ${input.context}`);
    }
    if (input.hint) {
      lines.push(`Формат: ${input.hint}`);
    }

    const minutes = Math.round(input.timeoutMs / 60_000);
    lines.push(`Жду ${minutes} мин.`);

    return lines.join('\n');
  }
}
