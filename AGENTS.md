# human4ai — инструкции проекта

## Назначение

Сервер вопросов человеку через Telegram и Яндекс-Станции. Прод работает на
`human4ai.paulislava.space`; локальные колонки доступны серверу через исходящий
WebSocket-клиент на Windows-ПК.

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

Не печатать MCP-, bridge-, Telegram- и Yandex-токены. Прод выкатывается push в
`main` через GitHub Actions; после push дождаться Tests и Build & Deploy.
Windows-клиент ставится `client/install-windows.ps1` как NSSM-служба.

