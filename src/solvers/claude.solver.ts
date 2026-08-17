import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';
import { buildPrompt, normalizeHomoglyphs, parseAnswer } from './prompt';
import { CaptchaSolver, SolveInput } from './types';

/**
 * Вторая ступень: Claude. Дороже GigaChat, но заметно лучше читает искажённый
 * текст — вызывается только когда первая ступень не справилась.
 *
 * Ходим не по API, а через `claude` CLI: он уже авторизован, так что отдельный
 * `ANTHROPIC_API_KEY` держать и продлевать не нужно. Картинка передаётся
 * файлом — CLI читает её сам инструментом Read.
 *
 * На сервере CLI живёт **на хосте**, а служба в контейнере: внутрь образа
 * авторизацию не тащим (там root, чужой профиль и вечный токен), а просим хост
 * выполнить один вызов через `hostshim/claude-shim.mjs`. Локально, когда шим не
 * задан, CLI запускается напрямую.
 */
export class ClaudeSolver implements CaptchaSolver {
  readonly name = 'claude';

  isAvailable(): boolean {
    // Либо есть шим на хосте, либо локальный CLI с токеном. Пустая авторизация
    // — это не «ступень сломалась», а «её нет»: CLI без неё отвечает
    // «Not logged in», и ждать от него нечего.
    if (config.claude.shimUrl && config.claude.shimToken) return true;
    return Boolean(config.claude.cliPath && config.claude.oauthToken);
  }

  async solve(input: SolveInput): Promise<string | null> {
    // Каталог свой на каждую задачу: параллельные капчи не должны видеть
    // картинки друг друга, а CLI получает доступ только к нему.
    const dir = await mkdtemp(join(tmpdir(), 'human4ai-'));
    const imagePath = join(dir, `${input.taskId}.png`);

    try {
      await writeFile(imagePath, Buffer.from(input.image, 'base64'));
      const timeoutMs = Math.min(input.timeoutMs, config.claude.timeoutMs);

      const stdout = config.claude.shimUrl
        ? await this.runOnHost(input.image, timeoutMs)
        : await this.runCli(
            `${buildPrompt(input.hint)}\n\nКартинка: ${imagePath}`,
            dir,
            timeoutMs,
          );

      const answer = parseAnswer(stdout);
      return answer && normalizeHomoglyphs(answer, input.hint);
    } catch (error) {
      // Таймаут или упавший CLI — это «не справился», а не поломка службы:
      // каскад просто идёт на следующую ступень.
      console.error(`[claude] не смог прочитать капчу: ${(error as Error).message}`);
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Вызов CLI на хосте через шим: отдаём **только картинку**. Промпт зашит в
   * самом шиме — снаружи инструкцию модели подменить нельзя, а текст там
   * совпадает с `buildPrompt`, чтобы статистика ступеней осталась сравнимой.
   */
  private async runOnHost(image: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    // Запас над таймаутом CLI: шим должен успеть ответить своей ошибкой, а не
    // оборваться на нашей стороне.
    const timer = setTimeout(() => controller.abort(), timeoutMs + 15_000);

    try {
      const response = await fetch(`${config.claude.shimUrl.replace(/\/+$/, '')}/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': config.claude.shimToken },
        body: JSON.stringify({ image, timeout_ms: timeoutMs }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as
        | { stdout?: string; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(`шим ответил ${response.status}: ${payload?.error ?? ''}`.trim());
      }
      return payload?.stdout ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Запуск CLI с промптом через stdin.
   *
   * Аргументом промпт передавать нельзя: `--add-dir` объявлен вариадическим и
   * съедает следующий позиционный аргумент, после чего CLI жалуется, что
   * промпта нет вовсе.
   */
  private runCli(prompt: string, dir: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        config.claude.cliPath,
        [
          '--print',
          '--model',
          config.claude.model,
          // Кроме чтения картинки инструментов не нужно: ни писать, ни ходить
          // в сеть, ни запускать команды эта ступень не должна.
          '--allowed-tools',
          'Read',
          '--add-dir',
          dir,
        ],
        { cwd: dir },
      );

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI не ответил за ${timeoutMs} мс`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`CLI вышел с кодом ${code}: ${stderr.trim().slice(0, 300)}`));
        }
      });

      child.stdin.end(prompt);
    });
  }
}
