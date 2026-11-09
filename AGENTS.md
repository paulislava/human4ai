# human4ai — инструкции проекта

## Назначение

Сервер вопросов человеку через Telegram и Яндекс-Станции. Прод работает на
Windows-ПК `DESKTOP-NGNE28E`: SCM-служба `Human4AI`, отдельный WSL2 `Human4AI`
под `NT AUTHORITY\LocalService`, все данные в `D:\Human4AI`.
`human4ai.paulislava.space` сохраняется через HTTPS proxy VPS и закрытый SSH
reverse tunnel. Серверный runtime выключен. Локальные колонки подключаются
через исходящий WebSocket-клиент на Raspberry Pi `PaulIslavaTV`.
Эксплуатация и проверки: [Windows-служба](ai/features/windows-production-service.md).

## Проверка

Перед коммитом изменений TypeScript запускать:

```bash
npm test -- --runInBand
npm run build
```

Изменения WebSocket-протокола проверять тестами `src/bridge/*.spec.ts` и
`src/voice/*.spec.ts`. Ответы Telegram-полла должны сохраняться даже до
регистрации ожидания.

## Архитектура

- `/api/bridge` — WSS, аутентификация отдельным `VOICE_CLIENT_TOKENS`.
- Клиент подтверждает команду до выполнения; после ACK сервер не повторяет
  озвучку через старый транспорт, потому что результат может быть неизвестен.
- `alice_say` и голосовые вопросы идут bridge-first.
- Прямой nginx location для WSS обходит Apache/Hestia.
- Telegram остаётся серверным каналом.

## Секреты и деплой

Не печатать MCP-, bridge-, Telegram- и Yandex-токены. Старый GitHub Actions
workflow `human4ai` отключён, серверный runner этого репозитория выключен:
пуш в `main` не должен поднимать второй Telegram poller на VPS.
Автодеплой на ПК не настроен. Не включать старый workflow до переноса deploy
на нового владельца runtime. Службой управлять через Windows SCM; Linux units
и Docker restart policy не должны самостоятельно запускать production.
Основной клиент на Pi — user systemd-служба `human4ai-client.service`; Windows-откат
устанавливается `client/install-windows.ps1` как NSSM-служба.

## Единые команды ожидания CI

Локальные CLI находятся в `plugins/human4ai-control/scripts/`, точки входа
репозитория — `scripts/ci-track.cjs` и `scripts/ci-status.cjs`. Плагин должен
работать после копирования вне репозитория. Поддерживать GitLab и GitHub
Enterprise с выбором хоста по URL через настроенные `glab`/`gh`; секреты
не читать и не печатать. Существующий серверный `wait_gitlab_ci` независим
от этих автономных CLI.

Ожидать CI только фоновым tracker. Проверку статуса запускать с максимальным
таймаутом тула, при поддержке — без лимита. `in_progress` означает повторить
длительное ожидание, терминальный результат — закончить цикл. Отмена,
блокировка, ошибка, пропуск/отсутствие нужной job в завершённом CI и смерть
tracker не должны оставлять вечное ожидание.

Проверка CLI: `npm test -- --runInBand src/ci-tracker-cli.spec.ts`.
