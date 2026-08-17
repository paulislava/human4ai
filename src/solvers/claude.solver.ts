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
 * Ходим не по API, а через локальный `claude` CLI: у Павла он уже авторизован,
 * так что отдельный `ANTHROPIC_API_KEY` держать и продлевать не нужно.
 * Картинка передаётся файлом — CLI читает её сам инструментом Read.
 */
export class ClaudeSolver implements CaptchaSolver {
  readonly name = 'claude';

  isAvailable(): boolean {
    // Пустой токен — это не «ступень сломалась», а «её нет»: CLI без
    // авторизации отвечает «Not logged in», и ждать от него нечего.
    return Boolean(config.claude.cliPath && config.claude.oauthToken);
  }

  async solve(input: SolveInput): Promise<string | null> {
    // Каталог свой на каждую задачу: параллельные капчи не должны видеть
    // картинки друг друга, а CLI получает доступ только к нему.
    const dir = await mkdtemp(join(tmpdir(), 'human4ai-'));
    const imagePath = join(dir, `${input.taskId}.png`);

    try {
      await writeFile(imagePath, Buffer.from(input.image, 'base64'));

      const stdout = await this.runCli(
        `${buildPrompt(input.hint)}\n\nКартинка: ${imagePath}`,
        dir,
        Math.min(input.timeoutMs, config.claude.timeoutMs),
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
