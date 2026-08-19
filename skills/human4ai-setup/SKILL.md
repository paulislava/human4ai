---
name: human4ai-setup
description: "Развернуть службу human4ai на этой машине с нуля: собрать нужные данные (токен Telegram-бота, chat_id, OAuth-токен Яндекса), заполнить .env, поднять контейнер одной командой, поставить автозапуск и подключить MCP. Использовать, когда просят «поставь human4ai», «разверни службу вопросов/капчи», «настрой заново на другом компьютере»."
---

# Развернуть human4ai с нуля

Служба делает две вещи: разгадывает капчу (каскад GigaChat → Claude → человек) и
задаёт вопросы человеку — в Telegram и голосом на Яндекс-Станции. Всё живёт в
одном docker-контейнере.

**Главное правило: не настраивай руками то, что делает `./start.sh`.** Скрипт
идемпотентный, его можно запускать сколько угодно раз; твоя задача — добыть
данные, которых у него нет, и проверить результат.

## Порядок

1. **Репозиторий и Docker.**
   ```bash
   git clone https://github.com/paulislava/human4ai.git && cd human4ai
   docker info >/dev/null && echo "docker готов"
   ```
   Нет Docker → macOS `brew install --cask docker`, Linux
   `curl -fsSL https://get.docker.com | sh`, Windows
   `winget install Docker.DockerDesktop`. Docker Desktop нужно запустить.

2. **Telegram-бот.** Если бота ещё нет — попроси человека создать: `@BotFather`
   → `/newbot` → имя → username → он пришлёт токен вида `123456:AA…`.
   Токен **не печатай в ответ**: сразу отдай его скрипту флагом.

3. **chat_id.** Человек должен написать боту любое сообщение, после чего:
   ```bash
   node scripts/telegram-chat-id.mjs      # или bash scripts/telegram-chat-id.sh
   ```
   Если ответ пустой — служба уже забрала обновления: останови её
   (`docker compose stop`), повтори, потом снова запусти.

4. **Токен Яндекса** — только если нужна озвучка на колонке. См. скилл
   `human4ai-alice` или `docs/ALICE.md`: там способы получить OAuth-токен со
   скоупом «Умный дом» и как проверить, что он годится.

5. **Один запуск.**
   ```bash
   ./start.sh --telegram-token=<токен> --chat-id=<id> --yandex-token=<токен>
   # Windows: powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1 …
   ```
   Скрипт: сгенерирует секреты (`CLIENT_TOKENS`, `MCP_TOKEN`,
   `VOICE_ALICE_SECRET`), найдёт колонки в локальной сети, поднимет контейнер,
   дождётся `/api/health`, поставит автозапуск (systemd / launchd / планировщик)
   и подключит MCP в Claude Code, Codex и OpenClaw.

   Флаги на всякий случай: `--non-interactive`, `--skip-mcp`, `--skip-service`,
   `--skip-stations`, `--port=4020`, `--public-url=https://…`, `--rebuild`.

6. **Проверить.**
   ```bash
   curl -s http://127.0.0.1:4020/api/health          # solvers, asks, voice, mcp
   T=$(sed -n 's/^CLIENT_TOKENS=\([^:]*\).*/\1/p' .env)
   curl -s -H "X-Token: $T" http://127.0.0.1:4020/api/voice/stations   # колонки
   curl -s -H "X-Token: $T" -H 'Content-Type: application/json' \
     -X POST http://127.0.0.1:4020/api/voice/say -d '{"text":"проверка"}'
   ```
   Вопрос человеку целиком (уйдёт в Telegram, ответ вернётся):
   ```bash
   curl -s -H "X-Token: $T" -H 'Content-Type: application/json' \
     -X POST http://127.0.0.1:4020/api/ask/solve \
     -d '{"question":"Проверка связи — ответь любым словом","timeout_ms":300000}'
   ```

## Что скрипт сделать не может

- **Публичный адрес.** Вебхук навыка Алисы Яндекс дёргает извне, значит нужен
  домен с валидным TLS, смотрящий на порт службы (nginx + туннель/frp/Cloudflare
  — на выбор). Передай его как `--public-url=…`; в `.env` он попадёт в
  `PUBLIC_URL`, и оттуда же берётся адрес MCP для агентов.
- **Регистрация навыка** в консоли Диалогов — скилл `human4ai-alice`.
- **Ступень Claude в каскаде.** По умолчанию она выключена: CLI в образе нет.
  Если на хосте есть авторизованный `claude`, подними шим —
  `bash hostshim/install.sh` — и положи в `.env` напечатанные им
  `CLAUDE_SHIM_URL` / `CLAUDE_SHIM_TOKEN`.
- **Ступень GigaChat** требует `GPT2GIGA_BASE_URL` (свой gpt2giga-proxy).

## Правила

- Секреты из `.env` и токены **никогда не печатай** в ответ пользователю: только
  передавай их скриптам и командам.
- Ничего не «доделывай» руками поверх `.env`, если можно передать флагом:
  повторный `./start.sh` перезапишет ожидания.
- Проверяй результат командами выше, а не по факту «скрипт не упал»: в health
  видно, какие ступени и каналы реально работают.
- Порт занят или нужен другой — `--port=`, а не правка compose-файла.
