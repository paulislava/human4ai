# WebSocket-мост локальных Яндекс-Станций

## Контекст

Продовый human4ai работает на VPS, а glagol Яндекс-Станций доступен только в
домашней LAN. Старый входящий frp/HTTP-прокси перестал работать после остановки
frps и добавлял лишний сетевой слой.

## Решение

Windows-ПК держит одно исходящее WSS-соединение с
`https://human4ai.paulislava.space/api/bridge`. При подключении он передаёт
capabilities и список станций с алиасами. Сервер отправляет `voice.say`,
получает отдельные ACK и response и не повторяет уже подтверждённую команду.

Nginx проксирует `/api/bridge` прямо на `127.0.0.1:4020`, с Upgrade,
отключённой буферизацией и суточными таймаутами. Это соответствует прямой схеме
reverse proxy приложения TV и обходит Apache/Hestia.

Клиент ставится NSSM-службой `human4ai-client`, запускается автоматически и
переподключается с exponential backoff. Станции и токен Яндекса берутся из
локального assistant; mDNS имеет Node- и zeroconf-пути.

## Протокол

- Bearer-аутентификация bridge-токеном, отдельным от MCP.
- `hello` → capabilities/stations.
- `request` → `ack` → `response`.
- Heartbeat и замена старого соединения тем же client id.
- После ACK ошибка считается `outcome_unknown`; автоматического legacy retry нет.

## Файлы

- `src/bridge/protocol.ts`, `src/bridge/server.ts`
- `src/voice/client.ts`, `src/voice/voice.service.ts`
- `client/install-windows.ps1`
- `deploy/nginx.websocket.conf`
- `plugins/human4ai-control/`, `skills/human4ai-control/`

