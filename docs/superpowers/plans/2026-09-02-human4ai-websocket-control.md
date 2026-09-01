# Human4AI WebSocket Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить сервер human4ai к локальным Яндекс-Станциям через исходящий WebSocket-клиент на Windows-ПК, восстановить `alice_say` и Telegram-доставку, установить глобальный skill и персональный Codex-плагин.

**Architecture:** Сервер держит реестр аутентифицированных WebSocket-клиентов и выполняет RPC `voice.say` с подтверждением до побочного эффекта. Windows-клиент обнаруживает станции по mDNS, выполняет glagol локально и переподключается автоматически; старый `VOICE_PC_PROXY` остаётся fallback. Telegram остаётся на сервере с явной ошибкой доставки и ограниченными повторами, а внешний WebSocket публикуется прямым nginx reverse proxy по образцу TV-приложения.

**Tech Stack:** TypeScript 5.7, Node.js 22, `ws`, Express, Jest/ts-jest, PowerShell/NSSM, nginx, Codex plugins/skills.

**Spec:** `docs/superpowers/specs/2026-09-01-human4ai-websocket-control-design.md`

## Global Constraints

- Все изменения поведения делаются по RED → GREEN → REFACTOR.
- Секреты WebSocket, Telegram и Яндекса не печатаются и не коммитятся.
- WebSocket инициирует только локальный клиент; сервер не требует входящих портов на ПК.
- После `ack` сервер не повторяет TTS автоматически.
- `VOICE_PC_PROXY` остаётся fallback до успешной живой проверки.
- Каждый вопрос при активном skill сначала полностью показывается текстом.
- Ручное сообщение выключает режим, кроме маркера `gup`/`vc` в начале или конце.

---

### Task 1: WebSocket bridge server

**Files:**
- Create: `src/bridge/protocol.ts`
- Create: `src/bridge/server.ts`
- Create: `src/bridge/server.spec.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: `BridgeServer.attach(httpServer)`, `BridgeServer.call(method, params, options)`, `BridgeServer.clients()`.
- Produces wire messages `hello`, `heartbeat`, `request`, `ack`, `response` with `protocol: 1`.

- [ ] **Step 1: Write failing bridge tests**

```ts
it('rejects a websocket without a valid bearer token', async () => {
  const result = await connectBridge({ token: 'wrong' });
  expect(result.status).toBe(401);
});

it('completes request only after ack and response', async () => {
  const call = bridge.call('voice.say', { text: 'готово' });
  const request = await client.nextRequest();
  client.ack(request.id);
  client.respond(request.id, { station: 'Миди' });
  await expect(call).resolves.toEqual({ station: 'Миди' });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- src/bridge/server.spec.ts --runInBand`
Expected: FAIL because `BridgeServer` and protocol do not exist.

- [ ] **Step 3: Implement the protocol and authenticated bridge**

```ts
export class BridgeServer {
  attach(server: http.Server): void;
  call<T>(method: string, params: unknown, options?: { station?: string; ackMs?: number; resultMs?: number }): Promise<T>;
  clients(): BridgeClientInfo[];
}
```

Add `VOICE_CLIENT_TOKENS=token:client-id` parsing and pass the HTTP server from `src/index.ts` to `attach`.

- [ ] **Step 4: Run GREEN and full tests**

Run: `npm test -- src/bridge/server.spec.ts --runInBand && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bridge src/config.ts src/index.ts .env.example .github/workflows/deploy.yml
git commit -m "Добавляем WebSocket-мост локальных клиентов"
```

### Task 2: Voice transport and local client

**Files:**
- Create: `src/voice/discovery.ts`
- Create: `src/voice/bridge.transport.ts`
- Create: `src/voice/client.ts`
- Create: `src/voice/client.spec.ts`
- Modify: `src/voice/voice.service.ts`
- Modify: `src/voice/glagol.ts`
- Modify: `src/voice.spec.ts`
- Modify: `src/server.ts`
- Modify: `src/mcp.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `BridgeServer.call('voice.say', { text, station })`.
- Produces: `runVoiceClient(config)`, reusable `discoverStations()`, bridge-first `VoiceService`.

- [ ] **Step 1: Write failing voice and client tests**

```ts
it('prefers a connected bridge client over legacy glagol', async () => {
  const result = await voice.speak('сборка готова', 'Миди');
  expect(result).toEqual({ ok: true, detail: 'Миди via pc' });
});

it('does not repeat a request id after reconnect', async () => {
  await client.handle(sayRequest);
  await client.handle(sayRequest);
  expect(spoken).toEqual(['сборка готова']);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- src/voice.spec.ts src/voice/client.spec.ts --runInBand`
Expected: FAIL because the bridge transport/client do not exist.

- [ ] **Step 3: Implement bridge-first voice and client reconnect**

```ts
export interface VoiceTransport {
  stations(): Promise<Station[]>;
  speak(text: string, station?: string | null): Promise<{ ok: boolean; detail: string }>;
}

export async function runVoiceClient(options: VoiceClientOptions): Promise<never>;
```

Refactor mDNS from `scripts/find-stations.mjs` into an importable module, retain CLI compatibility, and persist a bounded request-result cache.

- [ ] **Step 4: Run GREEN and full tests**

Run: `npm test -- src/voice.spec.ts src/voice/client.spec.ts --runInBand && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/voice src/voice.spec.ts src/server.ts src/mcp.ts package.json package-lock.json scripts/find-stations.mjs
git commit -m "Переводим озвучку на локальный WebSocket-клиент"
```

### Task 3: Windows service installer

**Files:**
- Create: `client/install-windows.ps1`
- Create: `client/README.md`
- Modify: `start.ps1`
- Modify: `README.md`
- Modify: `docs/SETUP.md`
- Modify: `docs/ALICE.md`

**Interfaces:**
- Consumes: built `dist/voice/client.js`, `HUMAN4AI_URL`, `HUMAN4AI_VOICE_CLIENT_TOKEN`, Yandex configuration.
- Produces: automatic NSSM service `human4ai-client` and a health verification command.

- [ ] **Step 1: Add an installer smoke test command**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File client/install-windows.ps1 -ValidateOnly
```

Expected before implementation: FAIL because the script does not exist.

- [ ] **Step 2: Implement idempotent install and `-ValidateOnly`**

The script must copy runtime files, write secrets only to a protected config, replace the NSSM service, start it, and query server bridge status without printing token values.

- [ ] **Step 3: Verify locally and on PC**

Run: `npm run build` and the PowerShell validation on `paulislava@pc`.
Expected: exit 0 and `human4ai-client` configuration reported valid.

- [ ] **Step 4: Commit**

```bash
git add client start.ps1 README.md docs/SETUP.md docs/ALICE.md
git commit -m "Добавляем установку human4ai-client на Windows"
```

### Task 4: Honest Telegram delivery

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/asks.ts`
- Modify: `src/asks.spec.ts`
- Modify: `src/voice.spec.ts`

**Interfaces:**
- Produces: bounded retry for transient Bot API network errors.
- Produces: failed ask status visible through MCP instead of endless `pending`.

- [ ] **Step 1: Write failing delivery tests**

```ts
it('marks telegram ask failed when initial delivery exhausts retries', async () => {
  await expect(service.run(ask.id)).rejects.toThrow('telegram unavailable');
  expect(store.get(ask.id)?.status).toBe('failed');
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- src/asks.spec.ts src/voice.spec.ts --runInBand`
Expected: FAIL because delivery error leaves the ask pending.

- [ ] **Step 3: Implement bounded retries and status propagation**

Retry only transient network codes (`ETIMEDOUT`, `ECONNRESET`, `ENETUNREACH`) and preserve immediate failure for Bot API validation errors.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- src/asks.spec.ts src/voice.spec.ts --runInBand && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts src/asks.ts src/asks.spec.ts src/voice.spec.ts
git commit -m "Показываем ошибки доставки вопросов в Telegram"
```

### Task 5: Global skill and Codex plugin

**Files:**
- Create: `skills/human4ai-control/SKILL.md`
- Create: `plugins/human4ai-control/.codex-plugin/plugin.json`
- Create: `plugins/human4ai-control/.mcp.json`
- Create: `plugins/human4ai-control/skills/human4ai-control/SKILL.md`
- Install: `~/.agents/skills/human4ai-control/SKILL.md`
- Update: `~/.agents/plugins/marketplace.json`

**Interfaces:**
- Produces session modes `voice`, `voice(station)`, `telegram`, and `off`.
- Uses existing remote MCP token variable `HUMAN4AI_MCP_TOKEN`.

- [ ] **Step 1: Record baseline behavior without the new skill**

Use realistic scenarios: activation, ordinary typed follow-up, and typed follow-up wrapped with `gup`/`vc`. Record where the default agent loses mode or fails to duplicate the question in text.

- [ ] **Step 2: Scaffold plugin and write minimal skill**

```yaml
---
name: human4ai-control
description: Use when the user says «голосовое управление», «управление через телеграм», `gup` or `vc`, including selection of a room or station.
---
```

The skill must display each question in chat, cancel and disable on ordinary typed input, preserve mode only for prefix/suffix `gup` or `vc`, and follow human4ai wait/cancel rules.

- [ ] **Step 3: Validate skill and plugin**

Run the skill quick validator, plugin validator, and scenario checks with the skill loaded.
Expected: all validators pass and scenarios follow the mode contract.

- [ ] **Step 4: Install globally**

Copy the validated skill to `~/.agents/skills`, update the personal marketplace through plugin-creator helpers, and `rsync -av --update ~/.agents/skills/ root@paulislava.space:/root/.openclaw/workspace/skills/`.

- [ ] **Step 5: Commit repository copies**

```bash
git add skills/human4ai-control plugins/human4ai-control
git commit -m "Добавляем плагин голосового управления human4ai"
```

### Task 6: Production proxy, deployment, verification, and memory

**Files:**
- Create: `deploy/human4ai-proxy.conf`
- Create: `AGENTS.md`
- Create: `ai/FEATURES.md`
- Create: `ai/ERRORS.md`
- Create: `ai/features/websocket-voice-client.md`
- Modify: `README.md`
- Modify: `~/AGENTS.md`
- Create: Obsidian feature, bug, and architecture notes for `human4ai`.

**Interfaces:**
- Produces nginx WebSocket forwarding based on `/opt/tv/deploy/tv-proxy.conf`.
- Produces deployed server, installed PC client, working `alice_say`, and documented architecture.

- [ ] **Step 1: Add and validate direct nginx config**

```nginx
location /api/bridge {
    proxy_pass http://127.0.0.1:4020;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
}
```

Run `nginx -t` before reload. Preserve a backup of the current human4ai domain config.

- [ ] **Step 2: Run final local verification**

Run: `npm ci && npm run build && npm test -- --runInBand && git diff --check`
Expected: PASS and clean output.

- [ ] **Step 3: Push and monitor CI/CD**

Push `main`, watch the GitHub Actions run through terminal state, and announce test/build/deploy stages through macOS and Alice notifications in Russian.

- [ ] **Step 4: Install client and verify live behavior**

Install the Windows service without printing secrets, verify connected client/stations, run MCP `alice_say`, send a Telegram question, and receive its answer.

- [ ] **Step 5: Write project/global memory last**

Document the feature, proxy/Telegram bugs, and WebSocket decision in `AGENTS.md`, `ai/*`, `~/AGENTS.md`, and Obsidian. Commit project documentation and push; monitor the resulting pipeline again.

- [ ] **Step 6: Final status**

Confirm clean working tree, live service/client status, pipeline result, and exact validation evidence.
