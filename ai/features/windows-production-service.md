# Human4AI на Windows-ПК

Дата переноса: 2026-11-02. Рабочий хост: `DESKTOP-NGNE28E`.

## Устройство

Windows SCM запускает службу `Human4AI` от `NT AUTHORITY\LocalService`.
Она держит отдельный WSL2-дистрибутив `Human4AI`. Вход Павла в Windows не нужен.
OpenClaw использует другой дистрибутив и службу; их lifecycle не связан.

- Корень данных: `D:\Human4AI`; WSL-диск: `D:\Human4AI\wsl\ext4.vhdx`.
- SCM wrapper: `D:\Human4AI\nssm.exe`; журналы: `service.log`, `service-error.log`.
- Архивы образов, конфигурации, авторизации Claude и финальной SQLite:
  `D:\Human4AI\backup`. Проверки и скрипты: `D:\Human4AI\migration`.
- Runtime в WSL: `/opt/human4ai`, SQLite: `/opt/human4ai/data/human4ai.sqlite`.
- Конфигурация и provider credentials находятся в закрытых файлах этого каталога.
- Claude shim и авторизация: `/opt/claude-shim`, `/root/.claude`, `/root/.claude.json`.
- Linux units: `human4ai-runtime`, `human4ai-tunnel`, `claude-shim`.
  Они `disabled`; контейнеры имеют `restart=no`. Их запускает SCM wrapper.
- `human4ai-windows-service` и синхронный Stop/Pre hook
  `human4ai-stop-windows-service` находятся в `/usr/local/bin`.

Docker запускает сохранённый production image коммита `1bdd480` без пересборки.
Локальные изменения TypeScript и автономного stdio-пакета не развёртывались.
GigaChat работает отдельным контейнером с прежними credentials и scope PERS.
Для Telegram добавлен существующий рабочий proxy; значения остальных исходных
переменных окружения сохранены. Токены и адреса публичных API не менялись.

## Публичный доступ и единственный poller

TLS остаётся на VPS. Nginx отправляет `/api`, `/alice/`, `/mcp` и WebSocket
`/api/bridge` на `127.0.0.1:4020`. Этот порт открывает SSH reverse tunnel с ПК.
Приватный ключ туннеля находится в WSL; сервер разрешает только нужный
loopback listener. Приложение на ПК опубликовано только на loopback.

Старые Docker-контейнеры Human4AI и GigaChat на VPS остановлены, `restart=no`.
Серверные Claude shim и runner репозитория Human4AI выключены и `disabled`.
GitHub workflow `human4ai` (`336428101`) имеет `disabled_manually`: прежний push
не должен запустить второй production poller. Автодеплой на ПК не настроен.
Перед включением workflow нужно изменить его владельца и процедуру deploy.
Автономный stdio MCP со своим ботом не является частью production-службы.

## Управление

Из PowerShell администратора:

```powershell
Get-Service Human4AI
Start-Service Human4AI
Stop-Service Human4AI
Restart-Service Human4AI
Invoke-RestMethod http://127.0.0.1:4020/api/health
```

Дистрибутив принадлежит LocalService. Не заменять его пользовательским Ubuntu
и не запускать production вручную параллельно SCM. Остановка SCM сначала
останавливает Linux units и контейнеры, проверяет `MainPID=0`, затем завершает
supervisor. Staging keeper после переключения остановлен.

## Проверки переноса

ПК сам получил архивы по SSH с VPS; большие данные не проходили через Mac.
SHA-256 всех архивов совпали на обоих концах. Конфигурация исходного image
и восемь слоёв файловой системы совпали после Docker load. Финальная SQLite
снята после остановки исходного poller. Проверены SHA-256 файла, `quick_check`,
схемы, число и содержимое строк каждой таблицы: 69 `asks`, 7 `tasks`, 8 `attempts`,
одна строка `sqlite_sequence`. История, ключи, статусы и отметки сохранены.

Проверены Telegram `getMe` три раза и пустой webhook, GigaChat `/models` и
реальный короткий completion, Claude shim `/health`. Публичные HTTPS health,
авторизованный MCP `queue_status` и отклонение неверной авторизации прошли.
Настоящий WebSocket-клиент без токена получает HTTP 401 с проверкой TLS.

`migration/lifecycle-windows.ps1` и сохранённый `lifecycle-windows.log`
подтверждают синхронный Stop, холодный запуск WSL без production, Start,
Restart и восстановление после принудительного завершения только Human4AI WSL.
OpenClaw сохранил рабочий health. Физическая перезагрузка ПК не выполнялась.

Список станций был пустым до и после переноса. Реальная озвучка, ответы
человека и повторное подключение физического bridge-клиента не проверялись.
Флаг `voice=true` не подтверждает подключённую колонку. Незавершённые HTTP/MCP
ожидания требуют переподключения клиента; сохранённый ask ID повторно создавать
не нужно. Резервные копии удалять только после отдельного разрешения Павла.
