#!/usr/bin/env node
/**
 * claude-shim — тонкая прослойка к `claude` CLI, живущая на самом хосте.
 *
 * Зачем она есть: CLI авторизован на хосте (интерактивный вход уже сделан), а
 * служба human4ai работает в контейнере. Тащить авторизацию внутрь контейнера
 * значит держать там долгоживущий токен и обходить отказ CLI работать под root
 * — вместо этого контейнер просто просит хост выполнить один вызов.
 *
 * Наружу шим не смотрит: слушает 127.0.0.1, доступ — по общему токену
 * (`X-Token`), а из docker-сети до него пускает отдельное правило фаервола.
 *
 * По проводу идёт **только картинка**: промпт зашит здесь и наружу не
 * настраивается. Так вызывающая сторона не может подменить инструкцию модели —
 * снаружи приходит лишь то, что нужно прочитать.
 *
 * Конфиг — переменные окружения:
 *   SHIM_TOKEN    общий секрет с контейнером (обязателен)
 *   SHIM_PORT     порт (по умолчанию 4021)
 *   SHIM_BIND     интерфейс (по умолчанию 0.0.0.0: сюда ходит docker-мост)
 *   CLAUDE_BIN    путь к CLI (по умолчанию /usr/bin/claude)
 *   CLAUDE_MODEL  модель (по умолчанию claude-opus-5)
 *   SHIM_TIMEOUT_MS  предел на вызов CLI (по умолчанию 90 с)
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.SHIM_TOKEN ?? '';
const PORT = Number(process.env.SHIM_PORT ?? 4021);
const BIND = process.env.SHIM_BIND ?? '0.0.0.0';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/usr/bin/claude';
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5';
const TIMEOUT_MS = Number(process.env.SHIM_TIMEOUT_MS ?? 90_000);
const MAX_BODY = 12 * 1024 * 1024; // картинка капчи в base64

/**
 * Промпт зашит намеренно: снаружи приходит только картинка.
 *
 * Текст должен совпадать с `buildPrompt` в human4ai (src/solvers/prompt.ts):
 * ступени GigaChat и Claude сравниваются по точности в статистике, а разные
 * промпты сравнивать бессмысленно.
 */
const CAPTCHA_PROMPT =
  'На картинке — капча. Прочитай символы и верни ТОЛЬКО их, ' +
  'без кавычек, пояснений и знаков препинания. ' +
  'Регистр сохраняй как на картинке. Если прочитать невозможно, ответь ровно: UNREADABLE';

if (!TOKEN) {
  console.error('claude-shim: не задан SHIM_TOKEN');
  process.exit(1);
}

function authorized(req) {
  const got = req.headers['x-token'] ?? '';
  const want = TOKEN;
  return (
    got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
  );
}

/** Один вызов CLI: промпт через stdin, картинка — файлом рядом. */
function runCli({ prompt, model, timeoutMs, dir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        '--print',
        '--model',
        model,
        // Кроме чтения картинки инструменты не нужны: ни писать, ни ходить в
        // сеть, ни запускать команды эта ступень не должна.
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
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI вышел с кодом ${code}: ${stderr.trim().slice(0, 300)}`));
    });

    // Промпт только через stdin: `--add-dir` вариадический и съел бы его,
    // будь он позиционным аргументом.
    child.stdin.end(prompt);
  });
}

const server = createServer((req, res) => {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  };

  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });

  if (req.method !== 'POST' || req.url !== '/solve') {
    return send(404, { error: 'только POST /solve и GET /health' });
  }
  if (!authorized(req)) return send(401, { error: 'неверный токен' });

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      send(413, { error: 'слишком большое тело' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      return send(400, { error: 'тело не разобралось как JSON' });
    }

    const image = String(input.image ?? '').trim();
    if (!image) return send(400, { error: 'нужна картинка (image, base64)' });

    // Каталог свой на каждый вызов: параллельные капчи не видят картинки друг
    // друга, а CLI получает доступ только к нему.
    const dir = await mkdtemp(join(tmpdir(), 'claude-shim-'));
    try {
      const imagePath = join(dir, `${randomUUID().slice(0, 8)}.png`);
      await writeFile(imagePath, Buffer.from(image, 'base64'));

      const stdout = await runCli({
        prompt: `${CAPTCHA_PROMPT}\n\nКартинка: ${imagePath}`,
        model: MODEL,
        // Клиент может попросить меньше, но не больше: длинный вызов держит
        // процесс CLI на хосте.
        timeoutMs: Math.min(Number(input.timeout_ms ?? TIMEOUT_MS), TIMEOUT_MS),
        dir,
      });

      console.log(`[shim] вызов выполнен (${stdout.length} символов)`);
      send(200, { stdout });
    } catch (error) {
      console.error(`[shim] ${error.message}`);
      send(502, { error: error.message });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

server.listen(PORT, BIND, () => {
  console.log(`claude-shim на http://${BIND}:${PORT} (CLI: ${CLAUDE_BIN})`);
});
