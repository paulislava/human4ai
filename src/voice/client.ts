import WebSocket, { RawData } from 'ws';
import { BRIDGE_PROTOCOL, BridgeAck, BridgeRequest, BridgeResponse } from '../bridge/protocol';
import { config } from '../config';
import { say } from './glagol';
import { resolveStation, Station, stations } from './stations';

type ClientReply = BridgeAck | BridgeResponse;

export interface VoiceCommandDependencies {
  resolveStation(target?: string | null): Promise<Station>;
  speak(station: Station, text: string): Promise<void>;
}

export class VoiceCommandHandler {
  private readonly completed = new Map<string, BridgeResponse>();

  constructor(private readonly dependencies: VoiceCommandDependencies) {}

  async handle(request: BridgeRequest, send: (message: ClientReply) => void): Promise<void> {
    const previous = this.completed.get(request.id);
    if (previous) {
      send({ type: 'ack', id: request.id });
      send(previous);
      return;
    }

    send({ type: 'ack', id: request.id });
    let response: BridgeResponse;
    try {
      if (request.method !== 'voice.say') throw new Error(`неизвестный метод ${request.method}`);
      const params = request.params as { text?: unknown; station?: unknown };
      const text = String(params.text ?? '').trim();
      if (!text) throw new Error('text обязателен');
      const target = typeof params.station === 'string' ? params.station : null;
      const station = await this.dependencies.resolveStation(target);
      await this.dependencies.speak(station, text);
      response = {
        type: 'response',
        id: request.id,
        ok: true,
        result: { station: station.label, clientId: process.env.HUMAN4AI_CLIENT_ID || undefined },
      };
    } catch (error) {
      response = { type: 'response', id: request.id, ok: false, error: (error as Error).message };
    }

    this.completed.set(request.id, response);
    while (this.completed.size > 200) this.completed.delete(this.completed.keys().next().value!);
    send(response);
  }
}

export interface VoiceClientOptions {
  url: string;
  token: string;
  heartbeatMs?: number;
}

export async function connectVoiceClient(options: VoiceClientOptions): Promise<WebSocket> {
  const endpoint = bridgeUrl(options.url);
  const ws = new WebSocket(endpoint, { headers: { authorization: `Bearer ${options.token}` } });
  const handler = new VoiceCommandHandler({ resolveStation, speak: say });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const currentStations = await stations(true);
  ws.send(JSON.stringify({
    type: 'hello',
    protocol: BRIDGE_PROTOCOL,
    version: process.env.npm_package_version ?? '1.0.0',
    capabilities: ['voice'],
    stations: currentStations,
  }));

  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'heartbeat', protocol: BRIDGE_PROTOCOL }));
  }, options.heartbeatMs ?? 20_000);
  heartbeat.unref();

  ws.on('message', (raw: RawData) => {
    let request: BridgeRequest;
    try {
      request = JSON.parse(raw.toString()) as BridgeRequest;
    } catch {
      return;
    }
    if (request.type !== 'request') return;
    void handler.handle(request, (message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    });
  });
  ws.once('close', () => clearInterval(heartbeat));
  return ws;
}

export async function runVoiceClient(): Promise<never> {
  const url = process.env.HUMAN4AI_URL ?? 'https://human4ai.paulislava.space';
  const token = process.env.HUMAN4AI_VOICE_CLIENT_TOKEN ?? '';
  if (!token) throw new Error('HUMAN4AI_VOICE_CLIENT_TOKEN не задан');

  let delay = 1_000;
  for (;;) {
    try {
      const ws = await connectVoiceClient({ url, token });
      console.log(`[voice-client] подключён к ${new URL(url).host}`);
      delay = 1_000;
      await new Promise<void>((resolve) => ws.once('close', resolve));
    } catch (error) {
      console.error('[voice-client] соединение:', (error as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 500)));
    delay = Math.min(delay * 2, 30_000);
  }
}

function bridgeUrl(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/bridge';
  url.search = '';
  return url.toString();
}

if (require.main === module) {
  // dotenv уже загружен config.ts; дополнительный конфиг клиента можно указать
  // через DOTENV_CONFIG_PATH.
  void runVoiceClient().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
