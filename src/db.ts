import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';

export type TaskStatus = 'pending' | 'solved' | 'timeout' | 'failed';

export interface CaptchaTask {
  id: string;
  client: string;
  status: TaskStatus;
  /** base64 картинки капчи. */
  image: string;
  hint: string | null;
  /** Что за процесс просит и зачем — уходит в подпись сообщения в Telegram. */
  context: string | null;
  /** Порядок решателей для этой задачи. */
  solvers: string[];
  /** Индекс решателя, который сейчас пробуют. */
  solverIndex: number;
  answer: string | null;
  /** Кто дал текущий ответ. */
  answeredBy: string | null;
  /** message_id сообщения в Telegram — по нему матчится реплай. */
  telegramMessageId: number | null;
  /** Сообщение Павла с ответом: на нём живёт реакция-статус. */
  telegramReplyMessageId: number | null;
  createdAt: number;
  expiresAt: number;
}

interface TaskRow {
  id: string;
  client: string;
  status: TaskStatus;
  image: string;
  hint: string | null;
  context: string | null;
  solvers: string;
  solver_index: number;
  answer: string | null;
  answered_by: string | null;
  telegram_message_id: number | null;
  telegram_reply_message_id: number | null;
  created_at: number;
  expires_at: number;
}

/**
 * Хранилище задач. SQLite, а не память: рестарт службы не должен терять
 * незакрытый запрос — клиент на другом конце всё ещё ждёт ответа.
 */
export class TaskStore {
  /** Соединение отдаётся наружу: на той же базе живут запросы секретов. */
  readonly db: Database.Database;

  constructor(path = config.databasePath) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        status TEXT NOT NULL,
        image TEXT NOT NULL,
        hint TEXT,
        context TEXT,
        solvers TEXT NOT NULL,
        solver_index INTEGER NOT NULL DEFAULT 0,
        answer TEXT,
        answered_by TEXT,
        telegram_message_id INTEGER,
        telegram_reply_message_id INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
      CREATE INDEX IF NOT EXISTS idx_tasks_tg_message ON tasks (telegram_message_id);

      -- Аудит попыток: по нему видно реальную точность каждого решателя
      -- и можно решить, стоит ли ступень своих денег.
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        solver TEXT NOT NULL,
        outcome TEXT NOT NULL,
        answer TEXT,
        message TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts (task_id);
    `);

    // База уже могла быть создана до появления колонки: CREATE TABLE IF NOT
    // EXISTS её не добавит, поэтому доливаем отдельно.
    const columns = this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === 'telegram_reply_message_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN telegram_reply_message_id INTEGER');
    }
  }

  create(task: CaptchaTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, client, status, image, hint, context, solvers,
                            solver_index, answer, answered_by, telegram_message_id,
                            telegram_reply_message_id, created_at, expires_at)
         VALUES (@id, @client, @status, @image, @hint, @context, @solvers,
                 @solverIndex, @answer, @answeredBy, @telegramMessageId,
                 @telegramReplyMessageId, @createdAt, @expiresAt)`,
      )
      .run({ ...task, solvers: JSON.stringify(task.solvers) });
  }

  get(id: string): CaptchaTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    return row ? this.toTask(row) : null;
  }

  /** Поиск задачи по сообщению, на которое ответил человек. */
  findByTelegramMessage(messageId: number): CaptchaTask | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE telegram_message_id = ?')
      .get(messageId) as TaskRow | undefined;
    return row ? this.toTask(row) : null;
  }

  update(id: string, patch: Partial<CaptchaTask>): void {
    const columns: Record<keyof CaptchaTask, string> = {
      id: 'id',
      client: 'client',
      status: 'status',
      image: 'image',
      hint: 'hint',
      context: 'context',
      solvers: 'solvers',
      solverIndex: 'solver_index',
      answer: 'answer',
      answeredBy: 'answered_by',
      telegramMessageId: 'telegram_message_id',
      telegramReplyMessageId: 'telegram_reply_message_id',
      createdAt: 'created_at',
      expiresAt: 'expires_at',
    };

    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key as keyof CaptchaTask];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(key === 'solvers' ? JSON.stringify(value) : value);
    }

    if (assignments.length === 0) return;

    values.push(id);
    this.db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...(values as never[]));
  }

  /** Задачи, у которых вышло время ожидания. */
  findExpired(now = Date.now()): CaptchaTask[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'pending' AND expires_at <= ?")
      .all(now) as TaskRow[];
    return rows.map((row) => this.toTask(row));
  }

  logAttempt(entry: {
    taskId: string;
    solver: string;
    outcome: 'solved' | 'failed' | 'rejected' | 'timeout';
    answer?: string | null;
    message?: string | null;
    durationMs?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attempts (task_id, solver, outcome, answer, message, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.taskId,
        entry.solver,
        entry.outcome,
        entry.answer ?? null,
        entry.message ?? null,
        entry.durationMs ?? null,
        Date.now(),
      );
  }

  /** Точность решателей: сколько ответов приняли, сколько отвергли. */
  solverStats(): Array<{ solver: string; outcome: string; count: number }> {
    return this.db
      .prepare(
        `SELECT solver, outcome, COUNT(*) AS count
         FROM attempts GROUP BY solver, outcome ORDER BY solver`,
      )
      .all() as Array<{ solver: string; outcome: string; count: number }>;
  }

  close(): void {
    this.db.close();
  }

  private toTask(row: TaskRow): CaptchaTask {
    return {
      id: row.id,
      client: row.client,
      status: row.status,
      image: row.image,
      hint: row.hint,
      context: row.context,
      solvers: JSON.parse(row.solvers) as string[],
      solverIndex: row.solver_index,
      answer: row.answer,
      answeredBy: row.answered_by,
      telegramMessageId: row.telegram_message_id,
      telegramReplyMessageId: row.telegram_reply_message_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
}
