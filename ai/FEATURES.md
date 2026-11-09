# Функционал

- [WebSocket-мост локальных Яндекс-Станций](features/websocket-voice-client.md) —
  исходящий LAN-клиент, алиасы колонок, MCP `alice_say`, прямой nginx proxy.
- [Голосовой клиент на Raspberry Pi](features/raspberry-pi-voice-client.md) —
  автозапуск на `PaulIslavaTV`, отдельный bridge-токен и откат на сохранённые
  Windows-службы.
- `human4ai-control` — отдельные skill и Codex-плагин для явного голосового или
  Telegram-управления, обязательной текстовой копии вопроса и маркеров `gup`/`vc`.

- [Production на Windows-ПК](features/windows-production-service.md) — отдельная
  SCM-служба и WSL2 на D:, сохранённые SQLite, токены и публичные адреса.

## Фоновое ожидание CI в плагине human4ai

Общие автономные команды отслеживания GitLab/GitHub и длительного ожидания
сохранённого результата: [описание](features/background-ci-tracker.md).
