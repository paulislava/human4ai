# Raspberry Pi Voice Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести рабочий исходящий голосовой клиент human4ai с Windows на Raspberry Pi `PaulIslavaTV` и сделать Pi единственным активным домашним узлом озвучки.

**Architecture:** Существующий `dist/voice/client.js` запускается пользовательской systemd-службой на Pi и подключается к текущему `/api/bridge`. Станции обнаруживаются локально по mDNS и сохраняются в защищённом `.env`; Windows-службы отключаются только после двух успешных живых проверок через Pi.

**Tech Stack:** Node.js 20, TypeScript build artifacts, systemd user services, WSS, mDNS/DNS-SD, Raspbian 13 armv7l.

**Spec:** `docs/superpowers/specs/2026-09-13-raspberry-pi-voice-client-design.md`

## Global Constraints

- Bridge-токен и Yandex OAuth-токен нельзя печатать в терминал, логи или ответы.
- Runtime на Pi: `/home/paulislava/.local/share/human4ai-client`.
- Конфигурация на Pi: `.env` с режимом `0600`.
- Служба: пользовательская `human4ai-client.service`; `Linger=yes` уже включён.
- Default: device id алиаса `кабинет` из прод-переменной `VOICE_STATION`.
- Windows-службы не удаляются; rollback — `Set-Service human4ai-client -StartupType Automatic`, `Start-Service human4ai-client`, `Set-Service lan-proxy -StartupType Automatic`, `Start-Service lan-proxy`.

---

### Task 1: Воспроизводимые Linux runtime-файлы

**Files:**
- Create: `client/runtime-package.json`
- Create: `client/human4ai-client.service`
- Modify: `client/README.md`

**Interfaces:**
- Consumes: сборку `dist/voice/client.js` и конфигурацию `.env` в runtime-каталоге.
- Produces: минимальные npm-зависимости и systemd unit для запуска клиента на Linux.

- [x] **Step 1: Добавить минимальный runtime package**

Создать `client/runtime-package.json` с `private: true`, CommonJS и
runtime-зависимостями `axios@^1.12.2`, `dotenv@^17.2.3`, `ws@^8.21.3`.

- [x] **Step 2: Добавить user systemd unit**

Создать unit с `WorkingDirectory=%h/.local/share/human4ai-client`, командой
`/usr/bin/node dist/voice/client.js`, `Restart=always`, `RestartSec=5` и
зависимостью от `network-online.target`.

- [x] **Step 3: Дополнить документацию клиента**

Описать пути runtime, `.env`, установку npm-зависимостей, mDNS discovery,
копирование unit и команды `systemctl --user enable --now`/`status`.

- [x] **Step 4: Проверить артефакты**

Run: `node -e "JSON.parse(require('fs').readFileSync('client/runtime-package.json','utf8'))"`

Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add client/runtime-package.json client/human4ai-client.service client/README.md
git commit -m "Добавляем Linux-рантайм голосового клиента"
```

### Task 2: Подготовка Raspberry Pi

**Files:**
- Deploy: `/home/paulislava/.local/share/human4ai-client/dist/`
- Deploy: `/home/paulislava/.local/share/human4ai-client/scripts/find-stations.mjs`
- Deploy: `/home/paulislava/.local/share/human4ai-client/package.json`
- Deploy: `/home/paulislava/.local/share/human4ai-client/.env`
- Deploy: `/home/paulislava/.config/systemd/user/human4ai-client.service`

**Interfaces:**
- Consumes: bridge/Yandex secrets из действующего prod-контейнера без вывода и mDNS-ответы домашней LAN.
- Produces: активное WSS-соединение Pi с capability `voice` и списком станций.

- [x] **Step 1: Установить Node.js 20**

Получить sudo-пароль через secret-вопрос human4ai и выполнить на Pi
`sudo apt-get update && sudo apt-get install -y nodejs`. Пароль передать
только через stdin `sudo -S` и сразу удалить временный файл.

- [x] **Step 2: Собрать и скопировать runtime**

Локально выполнить `npm run build`. Создать runtime-каталоги на Pi, затем через
`rsync` скопировать `dist/`, `scripts/find-stations.mjs` и
`client/runtime-package.json` как `package.json`.

- [x] **Step 3: Установить runtime-зависимости**

На машине с npm выполнить `npm install --omit=dev --ignore-scripts` для
`client/runtime-package.json`, затем скопировать готовый `node_modules` на Pi.

- [x] **Step 4: Обнаружить станции**

На Pi выполнить `node scripts/find-stations.mjs --env` и сохранить полученный
`VOICE_STATIONS` без изменения device id/host/port/platform.

- [x] **Step 5: Сформировать защищённый `.env`**

Без вывода создать отдельный bridge-токен Pi, добавить его в серверный
`VOICE_CLIENT_TOKENS`, а из действующей конфигурации извлечь `VOICE_YANDEX_TOKEN`,
`VOICE_STATION` и `VOICE_STATION_NAMES`. Записать на Pi:

```bash
printf '%s\n' \
  'HUMAN4AI_URL=https://human4ai.paulislava.space' \
  "HUMAN4AI_VOICE_CLIENT_TOKEN=${BRIDGE_TOKEN}" \
  'HUMAN4AI_CLIENT_ID=pi' \
  "VOICE_YANDEX_TOKEN=${YANDEX_TOKEN}" \
  "VOICE_STATION=${DEFAULT_STATION}" \
  "VOICE_STATION_NAMES=${STATION_NAMES}" \
  "VOICE_STATIONS=${DISCOVERED_STATIONS}" > .env
chmod 600 .env
```

Expected: файл имеет режим `0600`, секретные значения не появляются в output.

- [x] **Step 6: Запустить user service**

Скопировать unit, выполнить `systemctl --user daemon-reload` и
`systemctl --user enable --now human4ai-client.service`.

Expected: `systemctl --user is-active human4ai-client.service` возвращает `active`.

### Task 3: Безопасное переключение с Windows

**Files:**
- State change: Windows services `human4ai-client`, `lan-proxy`

**Interfaces:**
- Consumes: подключённый Pi-клиент и существующие Windows-службы.
- Produces: Pi как единственный активный voice bridge с сохранённым rollback.

- [x] **Step 1: Проверить Pi до отключения Windows**

Вызвать `/api/voice/stations`, затем `/api/voice/say` для `кабинет` и `миди`.

Expected: ответы содержат `via pi` и `ok: true`.

- [x] **Step 2: Отключить Windows-службы**

На ПК выполнить:

```powershell
Stop-Service human4ai-client
Set-Service human4ai-client -StartupType Disabled
Stop-Service lan-proxy
Set-Service lan-proxy -StartupType Disabled
```

- [x] **Step 3: Проверить Pi после отключения Windows**

Повторить `/api/voice/stations`, default-вызов и вызов `миди`.

Expected: станции остаются доступны, default возвращает `кабинет via pi`, явная
цель возвращает `миди via pi`.

- [x] **Step 4: Rollback при любой неудаче**

```powershell
Set-Service human4ai-client -StartupType Automatic
Start-Service human4ai-client
Set-Service lan-proxy -StartupType Automatic
Start-Service lan-proxy
```

После rollback повторить `/api/voice/stations` и не продолжать cutover.

### Task 4: Финальная проверка и документация

**Files:**
- Modify: `ai/FEATURES.md`
- Modify: `ai/ERRORS.md`
- Modify: `AGENTS.md`
- Create: Obsidian `Features/human4ai/raspberry-pi-voice-client.md`
- Create: Obsidian `Bugs/human4ai/default-station-ignored-by-bridge.md`

**Interfaces:**
- Consumes: успешный cutover и исправленный default из коммита `fc5c9e3`.
- Produces: воспроизводимую документацию и зафиксированную эксплуатационную архитектуру.

- [x] **Step 1: Проверить проект**

Run: `npm test -- --runInBand && npm run build`

Expected: 7 suites, 91 tests, build exit 0 или больше тестов без failures.

- [x] **Step 2: Зафиксировать feature и bug**

В `ai/FEATURES.md` описать Pi WSS-client и Windows rollback. В `ai/ERRORS.md`
описать передачу серверного `VOICE_STATION` в bridge. Обновить `AGENTS.md`, что
домашний voice-клиент работает на `PaulIslavaTV`.

- [x] **Step 3: Обновить Obsidian fallback**

Создать feature- и bug-заметки в `/Users/pkondratov/Yandex.Disk.localized/Projects`
с датой, причиной/решением и списком файлов.

- [x] **Step 4: Commit and push**

```bash
git add client ai AGENTS.md docs/superpowers
git commit -m "Переносим голосовой клиент на Raspberry Pi"
git push origin main
```

После push дождаться терминального результата Tests и Build & Deploy и объявить
стадии русскими macOS- и голосовыми уведомлениями.
