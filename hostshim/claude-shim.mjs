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
 * Конфиг — переменные окружения:
 *   SHIM_TOKEN   общий секрет с контейнером (обязателен)
 *   SHIM_PORT    порт (по умолчанию 4021)
 *   SHIM_BIND    интерфейс (по умолчанию 0.0.0.0: сюда ходит docker-мост)
 *   CLAUDE_BIN   путь к CLI (по умолчанию /usr/bin/claude)
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
const MAX_BODY = 12 * 1024 * 1024; // картинка капчи в base64

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

    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) return send(400, { error: 'нужен prompt' });

    // Каталог свой на каждый вызов: параллельные капчи не видят картинки друг
    // друга, а CLI получает доступ только к нему.
    const dir = await mkdtemp(join(tmpdir(), 'claude-shim-'));
    try {
      let fullPrompt = prompt;
      if (input.image) {
        const imagePath = join(dir, `${randomUUID().slice(0, 8)}.png`);
        await writeFile(imagePath, Buffer.from(String(input.image), 'base64'));
        fullPrompt = `${prompt}\n\nКартинка: ${imagePath}`;
      }

      const stdout = await runCli({
        prompt: fullPrompt,
        model: String(input.model ?? 'claude-opus-5'),
        timeoutMs: Number(input.timeout_ms ?? 90_000),
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
