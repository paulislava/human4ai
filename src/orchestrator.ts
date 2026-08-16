import { randomUUID } from 'node:crypto';
import { config, DEFAULT_SOLVER_ORDER } from './config';
import { CaptchaTask, TaskStore } from './db';
import { ClaudeSolver } from './solvers/claude.solver';
import { GigaChatSolver } from './solvers/gigachat.solver';
import { HumanSolver } from './solvers/human.solver';
import { CaptchaSolver } from './solvers/types';
import { TelegramClient } from './telegram';

export interface CreateTaskInput {
  client: string;
  image: string;
  hint?: string | null;
  context?: string | null;
  /** Ограничить каскад: например ["human"] — спросить сразу человека. */
  solvers?: string[];
  timeoutMs?: number;
}

/**
 * Каскад разгадывания капчи.
 *
 * Ключевая деталь: «решённой» капчу делает не модель, а сайт, который принял
 * ответ. Поэтому задача не закрывается после первого ответа — клиент может
 * вызвать reject(), и мы переходим к следующей ступени вместо того, чтобы
 * начинать всё сначала.
 */
export class CaptchaOrchestrator {
  private readonly solvers: Map<string, CaptchaSolver>;
  readonly human: HumanSolver;

  constructor(
    private readonly store: TaskStore,
    telegram: TelegramClient,
  ) {
    this.human = new HumanSolver(telegram);
    this.solvers = new Map<string, CaptchaSolver>(
      [new GigaChatSolver(), new ClaudeSolver(), this.human].map((solver) => [
        solver.name,
        solver,
      ]),
    );
  }

  createTask(input: CreateTaskInput): CaptchaTask {
    const requested = input.solvers?.length
      ? input.solvers
      : [...DEFAULT_SOLVER_ORDER];

    // Недоступные ступени (нет ключа, не настроен бот) выпадают сразу, иначе
    // каскад тратил бы попытки на заведомо неработающие решатели.
    const available = requested.filter((name) =>
      this.solvers.get(name)?.isAvailable(),
    );

    const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
    const now = Date.now();

    const task: CaptchaTask = {
      id: `cap_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      client: input.client,
      status: 'pending',
      image: input.image,
      hint: input.hint ?? null,
      context: input.context ?? null,
      solvers: available,
      solverIndex: 0,
      answer: null,
      answeredBy: null,
      telegramMessageId: null,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    this.store.create(task);
    return task;
  }

  /**
   * Прогон каскада с текущей ступени до первого ответа.
   * Ошибка одной ступени не роняет задачу — просто переходим к следующей.
   */
  async run(taskId: string): Promise<CaptchaTask> {
    let task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Задача ${taskId} не найдена`);
    }

    for (let index = task.solverIndex; index < task.solvers.length; index += 1) {
      const solver = this.solvers.get(task.solvers[index]);
      if (!solver) continue;

      this.store.update(taskId, { solverIndex: index });

      const remaining = task.expiresAt - Date.now();
      if (remaining <= 0) {
        this.store.update(taskId, { status: 'timeout' });
        this.store.logAttempt({ taskId, solver: solver.name, outcome: 'timeout' });
        return this.store.get(taskId)!;
      }

      const startedAt = Date.now();
      try {
        const answer = await solver.solve({
          taskId,
          image: task.image,
          hint: task.hint,
          context: task.context,
          timeoutMs: remaining,
        });

        const durationMs = Date.now() - startedAt;

        if (answer) {
          this.store.update(taskId, {
            status: 'solved',
            answer,
            answeredBy: solver.name,
          });
          this.store.logAttempt({
            taskId,
            solver: solver.name,
            outcome: 'solved',
            answer,
            durationMs,
          });
          return this.store.get(taskId)!;
        }

        this.store.logAttempt({
          taskId,
          solver: solver.name,
          outcome: solver.name === this.human.name ? 'timeout' : 'failed',
          durationMs,
        });
      } catch (error) {
        this.store.logAttempt({
          taskId,
          solver: solver.name,
          outcome: 'failed',
          message: (error as Error).message,
          durationMs: Date.now() - startedAt,
        });
      }

      task = this.store.get(taskId)!;
      if (task.status !== 'pending') {
        return task;
      }
    }

    // Ступени кончились. Разделяем «истёк срок» и «никто не смог»: клиенту
    // это разные ситуации — в первой имеет смысл повторить, во второй нет.
    const finalStatus = Date.now() >= task.expiresAt ? 'timeout' : 'failed';
    this.store.update(taskId, { status: finalStatus });
    return this.store.get(taskId)!;
  }

  /**
   * Клиент сообщил, что ответ не подошёл: сайт его отклонил.
   * Переводим задачу на следующую ступень и прогоняем каскад дальше.
   */
  async reject(taskId: string): Promise<CaptchaTask> {
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Задача ${taskId} не найдена`);
    }

    this.store.logAttempt({
      taskId,
      solver: task.solvers[task.solverIndex] ?? 'unknown',
      outcome: 'rejected',
      answer: task.answer,
    });

    this.human.cancel(taskId);

    this.store.update(taskId, {
      status: 'pending',
      answer: null,
      answeredBy: null,
      solverIndex: task.solverIndex + 1,
    });

    return this.run(taskId);
  }

  /** Реплай из Telegram: находим задачу по сообщению и отдаём ответ ожидающему. */
  handleTelegramReply(messageId: number, text: string): void {
    const taskId = this.human.taskIdForMessage(messageId);
    if (taskId) {
      this.store.update(taskId, { telegramMessageId: messageId });
    }
    this.human.handleReply(messageId, text);
  }

  /** Список доступных ступеней — для /health и диагностики конфигурации. */
  availableSolvers(): string[] {
    return [...this.solvers.values()]
      .filter((solver) => solver.isAvailable())
      .map((solver) => solver.name);
  }
}
