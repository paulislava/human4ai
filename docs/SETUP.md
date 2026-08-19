# Развернуть human4ai на любой машине

Одна команда, один контейнер, дальше — служба, которая поднимается сама после
перезагрузки.

## Коротко

```bash
git clone https://github.com/paulislava/human4ai.git
cd human4ai
./start.sh                     # Windows: powershell -File start.ps1
```

Скрипт идемпотентный: запускай сколько нужно. Он проверит Docker, создаст `.env`
(секреты сгенерирует сам, недостающее спросит), найдёт колонки в локальной сети,
поднимет контейнер, дождётся `/api/health`, поставит автозапуск и подключит MCP
в Claude Code, Codex и OpenClaw.

Неинтерактивно:

```bash
./start.sh --non-interactive \
  --telegram-token=123456:AA… --chat-id=318445470 --yandex-token=y0_… \
  --public-url=https://human4ai.example.com --port=4020
```

| Флаг | Зачем |
|---|---|
| `--non-interactive` | ничего не спрашивать (CI, повторная настройка) |
| `--port=` | другой порт на хосте (по умолчанию 4020) |
| `--public-url=` | публичный адрес: нужен вебхуку Алисы и MCP с других машин |
| `--skip-mcp` | не трогать конфиги агентов |
| `--skip-service` | не ставить автозапуск |
| `--skip-stations` | не искать колонки |
| `--rebuild` | пересобрать образ с нуля |

## Что нужно приготовить

| Что | Зачем | Где взять |
|---|---|---|
| Docker | всё живёт в контейнере | Desktop (macOS/Windows) или `get.docker.com` |
| Токен Telegram-бота | вопросы человеку и капча | `@BotFather` → `/newbot` |
| `chat_id` | куда писать | написать боту, затем `node scripts/telegram-chat-id.mjs` |
| OAuth-токен Яндекса | озвучка на колонке | [docs/ALICE.md](ALICE.md) |
| Публичный HTTPS-адрес | вебхук навыка Алисы | свой домен + nginx/туннель |

Без Telegram-токена служба работает как разгадыватель капчи и голосовой канал;
без токена Яндекса — только Telegram. Ничто из этого не обязательно для старта.

## Проверить, что живо

```bash
curl -s http://127.0.0.1:4020/api/health
# {"status":"ok","solvers":[…],"asks":true,"voice":true,"voiceQueue":0,"mcp":true}

T=$(sed -n 's/^CLIENT_TOKENS=\([^:]*\).*/\1/p' .env)
curl -s -H "X-Token: $T" http://127.0.0.1:4020/api/voice/stations
curl -s -H "X-Token: $T" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:4020/api/voice/say -d '{"text":"проверка"}'
```

## Управление

```bash
docker compose logs -f          # логи
docker compose stop             # остановить
docker compose up -d            # поднять
git pull && ./start.sh          # обновить и перезапустить
```

Автозапуск: Linux — `systemctl status human4ai`, macOS — launchd-агент
`ai.human4ai.compose`, Windows — задача планировщика `human4ai`. Сам контейнер
живёт с политикой `restart: unless-stopped`, служба ОС нужна для случая, когда
Docker стартует позже пользователя.

## Ступени каскада капчи

| Ступень | Что нужно |
|---|---|
| `gigachat` | `GPT2GIGA_BASE_URL` — свой gpt2giga-proxy |
| `claude` | авторизованный `claude` CLI **на хосте** + `bash hostshim/install.sh`, затем `CLAUDE_SHIM_URL`/`CLAUDE_SHIM_TOKEN` в `.env` |
| `human` | токен бота и `chat_id` |

Каждая ступень независима: чего нет — то просто выпадает из каскада, и это видно
в `/api/health`.

## Если служба не в домашней сети

Колонки доступны только по LAN. Когда служба стоит на VPS, доступ в домашнюю сеть
даёт прокси на домашней машине (`pcproxy/`, переменная `VOICE_PC_PROXY`) — см.
[docs/ALICE.md](ALICE.md).
