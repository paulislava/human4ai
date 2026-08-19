#!/usr/bin/env bash
# Узнать свой chat_id: напиши боту любое сообщение и запусти этот скрипт.
#
#   bash scripts/telegram-chat-id.sh            # берёт токен из .env
#   TELEGRAM_CAPTCHA_BOT_TOKEN=… bash scripts/telegram-chat-id.sh
#
# Осторожно: getUpdates забирает обновления. Если служба уже запущена, она их
# читает сама — останови её на минуту (docker compose stop), иначе увидишь пусто.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN="${TELEGRAM_CAPTCHA_BOT_TOKEN:-$(sed -n 's/^TELEGRAM_CAPTCHA_BOT_TOKEN=\(.*\)$/\1/p' "$ROOT/.env" 2>/dev/null | head -1)}"

[ -n "$TOKEN" ] || { echo "Нет токена бота: заполни TELEGRAM_CAPTCHA_BOT_TOKEN в .env" >&2; exit 1; }

chat_id="$(curl -fs "https://api.telegram.org/bot$TOKEN/getUpdates" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const u=JSON.parse(s).result||[];
      const ids=[...new Set(u.map(x=>x.message&&x.message.chat&&x.message.chat.id).filter(Boolean))];
      if(!ids.length){process.exit(2)} console.log(ids[ids.length-1]);})')" || {
  echo "Обновлений нет. Напиши боту сообщение и повтори (служба должна быть остановлена)." >&2
  exit 1
}

echo "$chat_id"
