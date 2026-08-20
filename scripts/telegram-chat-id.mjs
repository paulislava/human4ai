#!/usr/bin/env node
/**
 * Узнать свой chat_id: скрипт подключается к боту и ждёт, пока ему напишут.
 *
 *   node scripts/telegram-chat-id.mjs              # ждать до 3 минут
 *   node scripts/telegram-chat-id.mjs --wait=600   # ждать дольше
 *
 * В stdout уходит только сам id — чтобы результат можно было подставить в .env;
 * подсказки и статус идут в stderr.
 *
 * Если Telegram из этой сети закрыт, задай прокси: TELEGRAM_PROXY (или в .env).
 *
 * Осторожно: getUpdates забирает обновления. Если служба запущена, она читает их
 * сама, и здесь будет пусто — установщик поэтому останавливает контейнер на
 * время определения.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const waitArg = process.argv.find((a) => a.startsWith('--wait='));
const waitSec = Number(waitArg?.split('=')[1] ?? 180);

function fromEnvFile(key) {
  try {
    const line = readFileSync(join(root, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : '';
  } catch {
    return '';
  }
}

const token = process.env.TELEGRAM_CAPTCHA_BOT_TOKEN || fromEnvFile('TELEGRAM_CAPTCHA_BOT_TOKEN');
if (!token) {
  console.error('Нет токена бота: заполни TELEGRAM_CAPTCHA_BOT_TOKEN в .env');
  process.exit(1);
}

const api = `https://api.telegram.org/bot${token}`;
// Прокси: в RU-сегменте api.telegram.org часто закрыт. Берём из TELEGRAM_PROXY
// (или из общих HTTPS_PROXY/ALL_PROXY), формат http://user:pass@host:port.
const proxy =
  process.env.TELEGRAM_PROXY ||
  fromEnvFile('TELEGRAM_PROXY') ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.ALL_PROXY ||
  '';

/**
 * Запрос к Bot API через curl, а не fetch: curl есть на macOS, Linux и Windows 10+,
 * и умеет прокси одним флагом — встроенному fetch пришлось бы тащить undici-агент.
 */
function call(method, query = '') {
  const args = ['-s', '-m', '40'];
  if (proxy) args.push('-x', proxy);
  args.push(`${api}/${method}${query}`);

  const out = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (out.error) return { ok: false, description: `curl не запустился: ${out.error.message}` };
  if (out.status !== 0) return { ok: false, description: `curl вышел с кодом ${out.status}` };

  try {
    return JSON.parse(out.stdout);
  } catch {
    return { ok: false, description: 'ответ не разобрался как JSON (прокси отдал своё?)' };
  }
}

/** Кто мы: имя бота нужно, чтобы человек знал, кому писать. */
const me = call('getMe');
if (!me.ok) {
  console.error(`Telegram недоступен или токен не принят: ${me.description ?? 'без описания'}`);
  if (!proxy) console.error('Если сеть RU — задай TELEGRAM_PROXY=http://user:pass@host:port');
  process.exit(1);
}

console.error(
  `Напиши любое сообщение боту @${me.result.username} — жду до ${waitSec} с…` +
    (proxy ? ' (через прокси)' : ''),
);

const deadline = Date.now() + waitSec * 1000;
let offset = 0;

while (Date.now() < deadline) {
  // Долгий поллинг: до 25 с на запрос, чтобы не долбить API в цикле.
  const left = Math.max(1, Math.min(25, Math.round((deadline - Date.now()) / 1000)));
  const data = call('getUpdates', `?timeout=${left}&offset=${offset}&allowed_updates=%5B%22message%22%5D`);

  for (const update of data?.result ?? []) {
    offset = update.update_id + 1;
    const chat = update.message?.chat;
    if (!chat?.id) continue;

    const who = chat.username ? `@${chat.username}` : (chat.first_name ?? chat.id);
    console.error(`Написал ${who} — беру этот chat_id.`);
    console.log(chat.id);
    process.exit(0);
  }
}

console.error('Никто не написал. Запусти снова или задай TELEGRAM_CHAT_ID вручную.');
process.exit(2);
