#!/usr/bin/env bash
# start.sh — единственная команда, которая нужна, чтобы поднять human4ai с нуля.
#
#   ./start.sh
#
# Скрипт идемпотентный: запускай сколько угодно раз. Он сам разберётся, что уже
# сделано, а что нет:
#
#   1. проверит Docker и подскажет, как поставить, если его нет;
#   2. создаст .env (секреты сгенерирует, недостающее спросит);
#   3. найдёт колонки в локальной сети и подставит их в .env;
#   4. соберёт и поднимет контейнер, дождётся здоровья службы;
#   5. поставит автозапуск как службу ОС (systemd / launchd);
#   6. подключит MCP в Claude Code, Codex и OpenClaw;
#   7. напечатает, что осталось сделать руками (навык Алисы).
#
# Неинтерактивно (для CI и повторной настройки):
#   ./start.sh --non-interactive --telegram-token=… --chat-id=… --yandex-token=…
#
# Только подключить агентов к уже работающей службе (на ноутбуке, где службы нет):
#   ./start.sh --only-agents --public-url=https://human4ai.example.com --mcp-token=…
#
# Каких агентов настраивать, спрашивается в консоли; можно задать заранее:
#   ./start.sh --agents=claude,codex,sokrat        (или --agents=all / --agents=none)
#
# Полезные флаги: --port=4020 --public-url=https://human4ai.example.com
#                 --skip-mcp --skip-service --skip-stations --rebuild --help

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
INTERACTIVE=1
SKIP_MCP=0
SKIP_SERVICE=0
SKIP_STATIONS=0
REBUILD=0
ONLY_AGENTS=0
PORT=""
PUBLIC_URL=""
TELEGRAM_TOKEN=""
CHAT_ID=""
YANDEX_TOKEN=""
MCP_TOKEN_ARG=""
AGENTS_ARG=""

# ── аргументы ─────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --non-interactive) INTERACTIVE=0 ;;
    --skip-mcp) SKIP_MCP=1 ;;
    --skip-service) SKIP_SERVICE=1 ;;
    --skip-stations) SKIP_STATIONS=1 ;;
    --only-agents) ONLY_AGENTS=1 ;;
    --mcp-token=*) MCP_TOKEN_ARG="${arg#*=}" ;;
    --agents=*) AGENTS_ARG="${arg#*=}" ;;
    --rebuild) REBUILD=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    --public-url=*) PUBLIC_URL="${arg#*=}" ;;
    --telegram-token=*) TELEGRAM_TOKEN="${arg#*=}" ;;
    --chat-id=*) CHAT_ID="${arg#*=}" ;;
    --yandex-token=*) YANDEX_TOKEN="${arg#*=}" ;;
    --help|-h) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Неизвестный аргумент: $arg (см. --help)"; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m! %s\033[0m\n' "$*"; }

secret() { openssl rand -hex "${1:-16}"; }

# Запустить команду с ограничением по времени. Свой сторож, а не `timeout`:
# на macOS GNU-coreutils может не быть, а зависший `docker info` (демон ещё
# поднимается или сломан) иначе вешает установку намертво.
with_timeout() {
  local seconds="$1"; shift
  "$@" & local pid=$!
  ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null ) & local watcher=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill -TERM "$watcher" 2>/dev/null || true
  return "$rc"
}

# Значение из .env (пустая строка, если файла или ключа нет).
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\(.*\)$/\1/p" "$ENV_FILE" | head -1 || true; }

# Записать ключ в .env, не задев остальные строки.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ] && grep -q "^$key=" "$ENV_FILE"; then
    # Значение может содержать что угодно, поэтому меняем строку не sed'ом по
    # шаблону, а построчным переписыванием.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$key="*) printf '%s=%s\n' "$key" "$value" >> "$tmp" ;;
        *) printf '%s\n' "$line" >> "$tmp" ;;
      esac
    done < "$ENV_FILE"
  else
    [ -f "$ENV_FILE" ] && cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Спросить значение, если его ещё нет. В неинтерактивном режиме молча пропустить.
ask_if_missing() {
  local key="$1" prompt="$2" preset="${3:-}" current
  current="$(env_get "$key")"
  [ -n "$current" ] && return 0
  if [ -n "$preset" ]; then env_set "$key" "$preset"; return 0; fi
  if [ "$INTERACTIVE" = "0" ]; then env_set "$key" ""; return 0; fi

  printf '\n%s\n' "$prompt"
  printf '    %s: ' "$key"
  read -r value < /dev/tty || value=""
  env_set "$key" "$value"
}

# ── 1. Docker ─────────────────────────────────────────────────────
# В режиме --only-agents служба не наша забота: она уже где-то работает, здесь
# нужно лишь прописать её агентам.

if [ "$ONLY_AGENTS" = "0" ]; then
say "Проверяю Docker"
if ! command -v docker >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) warn "Docker не найден. Поставь Docker Desktop: brew install --cask docker" ;;
    Linux) warn "Docker не найден. Поставь: curl -fsSL https://get.docker.com | sh" ;;
    *) warn "Docker не найден — поставь Docker Desktop." ;;
  esac
  exit 1
fi
if ! with_timeout 25 docker info >/dev/null 2>&1; then
  warn "Docker установлен, но демон не отвечает (или ещё стартует)."
  warn 'Запусти Docker, дождись, пока docker info отвечает, и повтори.'
  exit 1
fi
with_timeout 15 docker compose version >/dev/null 2>&1 \
  || { warn "Нужен docker compose v2 (docker compose version)"; exit 1; }
info "Docker на месте: $(docker --version | cut -d, -f1)"
fi

# ── 2. .env ───────────────────────────────────────────────────────

if [ "$ONLY_AGENTS" = "0" ]; then
say "Готовлю .env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "создан из .env.example"
else
  info "уже есть — дополняю только пустые значения"
fi

# Секреты генерируем сами: их незачем придумывать руками.
[ -n "$(env_get CLIENT_TOKENS)" ] || env_set CLIENT_TOKENS "$(secret 20):local"
[ -n "$(env_get MCP_TOKEN)" ] || env_set MCP_TOKEN "$(secret 24)"
[ -n "$(env_get VOICE_ALICE_SECRET)" ] || env_set VOICE_ALICE_SECRET "$(secret 16)"
[ -n "$PORT" ] && env_set HOST_PORT "$PORT"
[ -n "$(env_get HOST_PORT)" ] || env_set HOST_PORT 4020
[ -n "$PUBLIC_URL" ] && env_set PUBLIC_URL "$PUBLIC_URL"

ask_if_missing TELEGRAM_CAPTCHA_BOT_TOKEN \
  "Токен Telegram-бота (создать: @BotFather -> /newbot; можно оставить пустым — тогда вопросы в Telegram выключены)" \
  "$TELEGRAM_TOKEN"
ask_if_missing TELEGRAM_CHAT_ID \
  "Твой chat_id (напиши боту любое сообщение и запусти: ./start.sh --chat-id=\$(scripts/telegram-chat-id.sh))" \
  "$CHAT_ID"
ask_if_missing VOICE_YANDEX_TOKEN \
  "OAuth-токен Яндекса со скоупом «Умный дом» — нужен только для озвучки на колонке (см. docs/ALICE.md)" \
  "$YANDEX_TOKEN"
fi

# ── 3. Колонки ────────────────────────────────────────────────────

if [ "$ONLY_AGENTS" = "0" ] && [ "$SKIP_STATIONS" = "0" ] && [ -n "$(env_get VOICE_YANDEX_TOKEN)" ]; then
  say "Ищу колонки в локальной сети"
  if command -v node >/dev/null 2>&1; then
    if found="$(node "$ROOT/scripts/find-stations.mjs" --env 2>/dev/null)"; then
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        env_set "${line%%=*}" "${line#*=}"
        info "${line%%=*} заполнено"
      done <<< "$found"
    else
      warn "колонок не нашлось — озвучка будет ходить через прокси (VOICE_PC_PROXY) или молчать"
    fi
  else
    warn "нет node на хосте: пропускаю поиск колонок (можно задать VOICE_STATIONS вручную)"
  fi
fi

# ── 4. Контейнер ──────────────────────────────────────────────────

if [ "$ONLY_AGENTS" = "0" ]; then
say "Поднимаю контейнер"
if [ "$REBUILD" = "1" ]; then
  docker compose build --no-cache
fi
docker compose up -d --build

HOST_PORT="$(env_get HOST_PORT)"
info "жду, пока служба ответит на http://127.0.0.1:$HOST_PORT/api/health"
for i in $(seq 1 20); do
  if health="$(curl -fs -m 3 "http://127.0.0.1:$HOST_PORT/api/health" 2>/dev/null)"; then
    info "здорова: $health"
    break
  fi
  sleep 2
  [ "$i" = "20" ] && { warn "служба не ответила, логи: docker compose logs --tail=50"; exit 1; }
done
fi

# ── 5. Автозапуск как служба ОС ───────────────────────────────────
# Сам контейнер поднимается политикой restart: unless-stopped. Служба ОС нужна
# для случая, когда Docker стартует позже пользователя (Linux) или не стартует
# сам (macOS): она просто делает `docker compose up -d` при входе/загрузке.

install_service_linux() {
  command -v systemctl >/dev/null 2>&1 || { warn "нет systemd — пропускаю службу"; return; }
  local unit=/etc/systemd/system/human4ai.service
  local sudo_cmd=""
  [ "$(id -u)" = "0" ] || sudo_cmd="sudo"

  $sudo_cmd tee "$unit" >/dev/null <<UNIT
[Unit]
Description=human4ai — служба вопросов человеку и разгадывания капчи
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=/usr/bin/env docker compose up -d
ExecStop=/usr/bin/env docker compose stop

[Install]
WantedBy=multi-user.target
UNIT
  $sudo_cmd systemctl daemon-reload
  $sudo_cmd systemctl enable --now human4ai.service >/dev/null 2>&1 || true
  info "systemd: human4ai.service включён"
}

install_service_macos() {
  local plist="$HOME/Library/LaunchAgents/ai.human4ai.compose.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.human4ai.compose</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>cd $ROOT &amp;&amp; docker compose up -d</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/human4ai-compose.log</string>
  <key>StandardErrorPath</key><string>/tmp/human4ai-compose.log</string>
</dict></plist>
PLIST
  # bootout + enable + bootstrap: launchctl unload помечает лейбл disabled, и
  # следующий запуск падает с «Input/output error».
  launchctl bootout "gui/$(id -u)/ai.human4ai.compose" 2>/dev/null || true
  launchctl enable "gui/$(id -u)/ai.human4ai.compose" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
  info "launchd: ai.human4ai.compose установлен"
}

if [ "$ONLY_AGENTS" = "0" ] && [ "$SKIP_SERVICE" = "0" ]; then
  say "Ставлю автозапуск"
  case "$(uname -s)" in
    Linux) install_service_linux ;;
    Darwin) install_service_macos ;;
    *) warn "неизвестная ОС — автозапуск пропущен (на Windows используй start.ps1)" ;;
  esac
fi

# ── 6. MCP в агентов ──────────────────────────────────────────────

# Скилы — обычные каталоги с SKILL.md: «установка» это копирование в каталог,
# который агент читает. Кладём только тем агентам, которые на машине есть.
copy_skills() {
  local target="$1" name
  mkdir -p "$target"
  for skill in "$ROOT"/skills/*/; do
    name="$(basename "$skill")"
    rm -rf "$target/$name"
    cp -R "$skill" "$target/$name"
  done
  info "скилы -> $target"
}

# Токен MCP держим и в переменной окружения: Codex умеет bearer только так, да и
# ручные вызовы curl потом удобнее. Записываем в профиль, чтобы жил после
# перезапуска терминала.
export_token_to_profile() {
  local token="$1" profile="$HOME/.zshrc"
  [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ] && profile="$HOME/.bashrc"

  if grep -q 'HUMAN4AI_MCP_TOKEN=' "$profile" 2>/dev/null; then
    # Токен мог смениться (пересоздали .env) — обновляем строку, а не плодим.
    local tmp; tmp="$(mktemp)"
    sed "s|^export HUMAN4AI_MCP_TOKEN=.*|export HUMAN4AI_MCP_TOKEN=$token|" "$profile" > "$tmp"
    mv "$tmp" "$profile"
  else
    printf '\nexport HUMAN4AI_MCP_TOKEN=%s\n' "$token" >> "$profile"
  fi

  export HUMAN4AI_MCP_TOKEN="$token"
  info "токен в $profile как HUMAN4AI_MCP_TOKEN"
}

# Все агенты, которых умеем настраивать. Порядок = порядок в меню.
AGENT_IDS="claude codex sokrat openclaw"
SOKRAT_HOME="${SOKRAT_HOME:-$HOME/.sokrat}"
SOKRAT_BIN="${SOKRAT_BIN:-sokrat}"

agent_label() {
  case "$1" in
    claude) printf 'Claude Code' ;;
    codex) printf 'Codex' ;;
    sokrat) printf 'Sokrat (обёртка над Codex)' ;;
    openclaw) printf 'OpenClaw' ;;
  esac
}

agent_available() {
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 ;;
    codex) command -v codex >/dev/null 2>&1 ;;
    # Sokrat ставится и как свой бинарник, и просто своим каталогом-домом.
    sokrat) command -v "${SOKRAT_BIN:-sokrat}" >/dev/null 2>&1 || [ -d "${SOKRAT_HOME:-$HOME/.sokrat}" ] ;;
    openclaw) command -v openclaw >/dev/null 2>&1 ;;
  esac
}

# Спросить, кому прописывать. Пусто -> все найденные, 0 -> никому.
choose_agents() {
  local found="" missing="" id n=0 line reply chosen=""

  for id in $AGENT_IDS; do
    if agent_available "$id"; then
      found="$found $id"
    else
      missing="$missing $id"
    fi
  done

  # Заранее заданный список важнее меню: так работает и CI, и повторный запуск.
  if [ -n "$AGENTS_ARG" ]; then
    case "$AGENTS_ARG" in
      all) printf '%s' "$found"; return ;;
      none) return ;;
      *) printf '%s' "$(printf '%s' "$AGENTS_ARG" | tr ',' ' ')"; return ;;
    esac
  fi

  [ -z "$found" ] && return
  if [ "$INTERACTIVE" = "0" ]; then printf '%s' "$found"; return; fi

  printf '\n    Кому прописать MCP и скилы:\n' >&2
  for id in $found; do
    n=$((n + 1))
    printf '      %d) %s\n' "$n" "$(agent_label "$id")" >&2
  done
  for id in $missing; do
    printf '         %s — не найден\n' "$(agent_label "$id")" >&2
  done
  printf '    Номера через запятую (Enter — все, 0 — никому): ' >&2
  read -r reply < /dev/tty || reply=""

  agents_from_reply "$reply" "$found"
}

# Ответ на меню -> список агентов. Отдельной функцией, чтобы её можно было
# проверить без терминала: пусто — все, 0 — никого, «1,3» или «1 3» — по номерам.
agents_from_reply() {
  local reply="$1" found="$2" chosen="" id n num

  case "$reply" in
    "") printf '%s' "$found"; return ;;
    0|none|нет) return ;;
  esac

  for num in $(printf '%s' "$reply" | tr ',' ' '); do
    n=0
    for id in $found; do
      n=$((n + 1))
      [ "$num" = "$n" ] && chosen="$chosen $id"
    done
  done
  printf '%s' "$chosen"
}

if [ "$SKIP_MCP" = "0" ]; then
  say "Подключаю агентов: MCP и скилы"
  MCP_TOKEN="${MCP_TOKEN_ARG:-$(env_get MCP_TOKEN)}"
  BASE_URL="${PUBLIC_URL:-$(env_get PUBLIC_URL)}"
  [ -n "$BASE_URL" ] || BASE_URL="http://127.0.0.1:${HOST_PORT:-$(env_get HOST_PORT)}"

  if [ -z "$MCP_TOKEN" ]; then
    warn "нет MCP_TOKEN: передай --mcp-token=… (его печатает установка службы) или запусти рядом с .env"
    exit 1
  fi
  MCP_URL="${BASE_URL%/}/mcp"
  export_token_to_profile "$MCP_TOKEN"
  agents=0

  SELECTED="$(choose_agents)"
  if [ -z "$SELECTED" ]; then
    info "агенты не выбраны — MCP и скилы никуда не ставлю"
    SKIP_MCP=1
  fi

  # Отмечен ли агент в выборе.
  chosen() { case " $SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

  # Claude Code
  if chosen claude; then
    claude mcp remove human4ai --scope user >/dev/null 2>&1 || true
    if claude mcp add --scope user --transport http human4ai "$MCP_URL" \
        --header "Authorization: Bearer $MCP_TOKEN" >/dev/null 2>&1; then
      info "Claude Code: MCP подключён"
    else
      warn "Claude Code: подключить MCP не удалось (claude mcp add)"
    fi
    copy_skills "$HOME/.claude/skills"
    agents=$((agents + 1))
  fi

  # Codex
  if chosen codex; then
    codex mcp remove human4ai >/dev/null 2>&1 || true
    if codex mcp add human4ai --url "$MCP_URL" \
        --bearer-token-env-var HUMAN4AI_MCP_TOKEN >/dev/null 2>&1; then
      info "Codex: MCP подключён"
    else
      warn "Codex: подключить MCP не удалось (codex mcp add)"
    fi
    copy_skills "$HOME/.codex/skills"
    agents=$((agents + 1))
  fi

  # OpenClaw
  if chosen openclaw; then
    openclaw mcp remove human4ai >/dev/null 2>&1 || true
    if openclaw mcp add human4ai --url "$MCP_URL" --transport streamable-http \
        --header "Authorization=Bearer $MCP_TOKEN" >/dev/null 2>&1; then
      info "OpenClaw: MCP подключён"
    else
      warn "OpenClaw: подключить MCP не удалось (openclaw mcp add)"
    fi
    agents=$((agents + 1))
  fi

  # Sokrat — обёртка над Codex, поэтому настраивается тем же CLI: у него свой
  # дом (CODEX_HOME), а формат конфига codex'овый. Пробуем два пути: свой
  # бинарник, если он умеет `mcp add`, иначе codex с домом sokrat'а.
  if chosen sokrat; then
    sokrat_done=0

    if command -v "$SOKRAT_BIN" >/dev/null 2>&1; then
      "$SOKRAT_BIN" mcp remove human4ai >/dev/null 2>&1 || true
      if "$SOKRAT_BIN" mcp add human4ai --url "$MCP_URL" \
          --bearer-token-env-var HUMAN4AI_MCP_TOKEN >/dev/null 2>&1; then
        info "Sokrat: MCP подключён ($SOKRAT_BIN mcp add)"
        sokrat_done=1
      fi
    fi

    if [ "$sokrat_done" = "0" ] && command -v codex >/dev/null 2>&1 && [ -d "$SOKRAT_HOME" ]; then
      CODEX_HOME="$SOKRAT_HOME" codex mcp remove human4ai >/dev/null 2>&1 || true
      if CODEX_HOME="$SOKRAT_HOME" codex mcp add human4ai --url "$MCP_URL" \
          --bearer-token-env-var HUMAN4AI_MCP_TOKEN >/dev/null 2>&1; then
        info "Sokrat: MCP подключён (codex с CODEX_HOME=$SOKRAT_HOME)"
        sokrat_done=1
      fi
    fi

    [ "$sokrat_done" = "1" ] || warn "Sokrat: подключить MCP не удалось — см. docs/MCP.md"
    copy_skills "${SOKRAT_SKILLS_DIR:-$SOKRAT_HOME/skills}"
    agents=$((agents + 1))
  fi

  [ "$agents" = "0" ] && warn "ни один агент не настроен"
fi

# ── 7. Что осталось руками ────────────────────────────────────────

say "Готово"
if [ "$ONLY_AGENTS" = "1" ]; then
  info "агенты подключены к $BASE_URL"
  exit 0
fi
info "служба:   http://127.0.0.1:$HOST_PORT/api/health"
info "логи:     docker compose logs -f"
info "остановить: docker compose stop   |  обновить: git pull && ./start.sh"

if [ -z "$(env_get TELEGRAM_CHAT_ID)" ]; then
  warn "TELEGRAM_CHAT_ID пуст: напиши боту сообщение и запусти bash scripts/telegram-chat-id.sh"
fi
if [ -n "$(env_get VOICE_YANDEX_TOKEN)" ]; then
  webhook="$(env_get PUBLIC_URL)"
  [ -n "$webhook" ] || webhook="https://<твой-публичный-адрес>"
  info "навык Алисы: webhook ${webhook%/}/alice/$(env_get VOICE_ALICE_SECRET)"
  info "как зарегистрировать навык — docs/ALICE.md (или скилл human4ai-alice)"
fi
