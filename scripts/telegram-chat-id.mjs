#!/usr/bin/env node
/**
 * Узнать свой chat_id: напиши боту любое сообщение и запусти этот скрипт.
 * Кроссплатформенная версия telegram-chat-id.sh — работает и на Windows.
 *
 *   node scripts/telegram-chat-id.mjs
 *
 * Осторожно: getUpdates забирает обновления. Если служба запущена, она читает их
 * сама — останови её на минуту (docker compose stop), иначе список будет пуст.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const data = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).then((r) => r.json());
const ids = [
  ...new Set((data.result ?? []).map((u) => u.message?.chat?.id).filter(Boolean)),
];

if (ids.length === 0) {
  console.error(
    'Обновлений нет. Напиши боту любое сообщение и повтори.\n' +
      'Если служба запущена — она забирает обновления себе: docker compose stop, потом снова.',
  );
  process.exit(1);
}

// Последний, кто писал — почти всегда сам владелец.
console.log(ids[ids.length - 1]);
