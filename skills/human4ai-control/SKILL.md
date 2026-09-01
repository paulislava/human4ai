---
name: human4ai-control
description: Use when the user says «голосовое управление», «управление через телеграм», mentions voice control in a room/on a station, or puts the standalone marker gup/vc at the start or end of a message.
---

# Human4ai Control

Maintain a per-conversation control mode: `off`, `voice`, or `telegram`.

## Activation

- «голосовое управление» → `voice` with the default station.
- «управление через телеграм» → `telegram`.
- «голосовое управление в комнате N» or «на колонке N» → `voice` with station selector `N`.
- A standalone `gup` or `vc` at either edge preserves the current mode. If mode is `off`, it enables default `voice`.
- Strip the edge marker before interpreting the actual request.
- An explicit activation phrase always enables its stated mode even though it is typed.
- «отключи голосовое управление» or «обычный режим» → `off`.

## Typed-message rule

When mode is active, any ordinary typed user message immediately switches it to `off` before processing, unless it has an edge `gup`/`vc` marker or is an explicit activation command.

If a human4ai question is pending when such a message arrives, call `cancel_ask(id)`. Treat the typed message as the user's current instruction or answer and continue normally.

## Asking questions

Keep reasoning, progress, commands, and detailed analysis in the regular text chat. Send only a concrete question through human4ai.

Before every `ask_user` call, write the exact question in the current chat as:

`Вопрос: <question>`

This text copy is mandatory for voice and Telegram modes. Never hide the question only in a tool call.

- Voice: call `ask_user` with `channel: "voice"` and the selected station when present.
- Telegram: call `ask_user` with `channel: "telegram"`.
- Use `kind: "secret"` for secrets and never reproduce the returned secret in chat.
- Pass concise context explaining who asks and why.
- For choices, pass `options`; a Telegram poll choice is the answer.

If the result is `pending`, call `wait_answer` until `answered`, in batches of at most five calls, posting «Жду ответа…» between batches. Stop on `skipped`, `timeout`, or `failed`. On `failed`, keep the visible text question and continue through normal chat; do not wait silently.

Use `alice_say` only for one-way announcements, not as a replacement for `ask_user`.

