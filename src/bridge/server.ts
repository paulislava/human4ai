import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import {
  BRIDGE_PROTOCOL,
  BridgeClientInfo,
  BridgeIncoming,
  BridgeRequest,
  BridgeStation,
} from './protocol';

interface ConnectedClient extends BridgeClientInfo {
  socket: WebSocket;
}

interface PendingCall {
  clientId: string;
  acknowledged: boolean;
  ackTimer: NodeJS.Timeout;
  resultTimer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: BridgeCallError) => void;
}

export class BridgeCallError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'ack_timeout' | 'result_timeout' | 'outcome_unknown' | 'remote_error',
    readonly acknowledged = false,
  ) {
    super(message);
    this.name = 'BridgeCallError';
  }
}

export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connected = new Map<string, ConnectedClient>();
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly tokens: ReadonlyMap<string, string>) {}

  attach(server: http.Server): void {
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== '/api/bridge') return;

      const clientId = this.authenticate(request.headers.authorization);
      if (!clientId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => this.register(clientId, ws));
    });
  }

  clients(): BridgeClientInfo[] {
    return [...this.connected.values()]
      .map(({ socket: _socket, ...client }) => ({ ...client, stations: client.stations.map((s) => ({ ...s })) }))
      .sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  stations(): BridgeStation[] {
    return this.clients().flatMap((client) =>
      client.stations.map((station) => ({ ...station, clientId: client.clientId })),
    );
  }

  hasCapability(capability: string): boolean {
    return [...this.connected.values()].some(
      (client) => client.socket.readyState === WebSocket.OPEN && client.capabilities.includes(capability),
    );
  }

  call<T>(
    method: string,
    params: unknown,
    options: { clientId?: string; ackMs?: number; resultMs?: number } = {},
  ): Promise<T> {
    const client = options.clientId
      ? this.connected.get(options.clientId)
      : [...this.connected.values()].find((item) => item.capabilities.includes(method.split('.')[0]));

    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeCallError('локальный клиент human4ai не подключён', 'unavailable'));
    }

    const id = randomUUID();
    const message: BridgeRequest = { type: 'request', protocol: BRIDGE_PROTOCOL, id, method, params };
    const ackMs = options.ackMs ?? 5_000;
    const resultMs = options.resultMs ?? 30_000;

    return new Promise<T>((resolve, reject) => {
      const fail = (error: BridgeCallError) => this.finish(id, () => reject(error));
      const ackTimer = setTimeout(
        () => fail(new BridgeCallError('локальный клиент не подтвердил команду', 'ack_timeout')),
        ackMs,
      );
      const resultTimer = setTimeout(() => {
        const call = this.pending.get(id);
        fail(
          new BridgeCallError(
            call?.acknowledged ? 'результат команды неизвестен после подтверждения' : 'локальный клиент не ответил',
            call?.acknowledged ? 'outcome_unknown' : 'result_timeout',
            Boolean(call?.acknowledged),
          ),
        );
      }, resultMs);

      this.pending.set(id, {
        clientId: client.clientId,
        acknowledged: false,
        ackTimer,
        resultTimer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      client.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    for (const client of this.connected.values()) client.socket.close();
    this.wss.close();
  }

  private authenticate(header?: string): string | null {
    const got = (header ?? '').replace(/^Bearer\s+/i, '').trim();
    for (const [token, clientId] of this.tokens) {
      if (got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token))) return clientId;
    }
    return null;
  }

  private register(clientId: string, socket: WebSocket): void {
    const previous = this.connected.get(clientId);
    if (previous) previous.socket.close(4001, 'replaced');

    const now = Date.now();
    this.connected.set(clientId, {
      clientId,
      connectedAt: now,
      lastSeenAt: now,
      version: null,
      capabilities: [],
      stations: [],
      socket,
    });

    socket.on('message', (raw) => this.onMessage(clientId, raw));
    socket.on('close', () => this.onClose(clientId, socket));
    socket.on('error', () => this.onClose(clientId, socket));
  }

  private onMessage(clientId: string, raw: RawData): void {
    let message: BridgeIncoming;
    try {
      message = JSON.parse(raw.toString()) as BridgeIncoming;
    } catch {
      return;
    }

    const client = this.connected.get(clientId);
    if (!client) return;
    client.lastSeenAt = Date.now();

    if (message.type === 'hello') {
      if (message.protocol !== BRIDGE_PROTOCOL) {
        client.socket.close(4002, 'unsupported protocol');
        return;
      }
      client.version = message.version ?? null;
      client.capabilities = [...new Set(message.capabilities ?? [])];
      client.stations = Array.isArray(message.stations) ? message.stations : [];
      return;
    }

    if (message.type === 'heartbeat') {
      if (message.capabilities) client.capabilities = [...new Set(message.capabilities)];
      if (message.stations) client.stations = message.stations;
      return;
    }

    const call = this.pending.get(message.id);
    if (!call || call.clientId !== clientId) return;

    if (message.type === 'ack') {
      call.acknowledged = true;
      clearTimeout(call.ackTimer);
      return;
    }

    call.acknowledged = true;
    if (message.ok) this.finish(message.id, () => call.resolve(message.result));
    else {
      this.finish(message.id, () =>
        call.reject(new BridgeCallError(message.error || 'ошибка локального клиента', 'remote_error', true)),
      );
    }
  }

  private onClose(clientId: string, socket: WebSocket): void {
    if (this.connected.get(clientId)?.socket !== socket) return;
    this.connected.delete(clientId);
    for (const [id, call] of this.pending) {
      if (call.clientId !== clientId) continue;
      this.finish(id, () =>
        call.reject(
          new BridgeCallError(
            call.acknowledged ? 'соединение потеряно после подтверждения команды' : 'локальный клиент отключился',
            call.acknowledged ? 'outcome_unknown' : 'unavailable',
            call.acknowledged,
          ),
        ),
      );
    }
  }

  private finish(id: string, action: () => void): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.ackTimer);
    clearTimeout(call.resultTimer);
    action();
  }
}
