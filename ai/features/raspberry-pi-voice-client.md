# Голосовой клиент на Raspberry Pi

## Контекст

Озвучка домашних Яндекс-Станций зависела от включённого Windows-ПК. Для
постоянно доступного домашнего узла выбран Raspberry Pi `PaulIslavaTV`.

## Решение

- Существующий Node.js WSS-клиент запускается как user systemd-служба.
- Для Pi выдан отдельный bridge-токен и client id `pi`.
- Станции обнаружены по mDNS и записаны в `.env` с правами `0600`.
- Runtime-зависимости готовятся вне Pi, чтобы не устанавливать весь серверный
  dependency tree и нативный `better-sqlite3` на ARM.
- `human4ai-client` и `lan-proxy` на Windows остановлены и отключены, но не удалены.

## Проверка и откат

Живые вызовы default-колонки и алиаса `миди` вернули `кабинет via pi` и
`миди via pi`. Для отката достаточно вернуть Windows-службам startup type `Automatic` и
запустить их.

## Файлы

- `client/runtime-package.json`
- `client/human4ai-client.service`
- `client/README.md`
- `src/voice/client.ts`
- `docs/superpowers/specs/2026-09-13-raspberry-pi-voice-client-design.md`
