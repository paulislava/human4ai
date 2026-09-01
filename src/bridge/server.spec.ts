import http from 'node:http';
import WebSocket from 'ws';
import { BridgeServer } from './server';

const TOKEN = 'bridge-secret';

async function listen(bridge: BridgeServer) {
  const server = http.createServer((_req, res) => res.end('ok'));
  bridge.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `ws://127.0.0.1:${port}/api/bridge`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function connect(url: string, token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextJson(ws: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

describe('BridgeServer', () => {
  it('rejects a websocket without a valid bearer token', async () => {
    const bridge = new BridgeServer(new Map([[TOKEN, 'pc']]));
    const runtime = await listen(bridge);

    await expect(connect(runtime.url, 'wrong')).rejects.toThrow(/401/);
    await runtime.close();
  });

  it('registers stations from hello and heartbeat', async () => {
    const bridge = new BridgeServer(new Map([[TOKEN, 'pc']]));
    const runtime = await listen(bridge);
    const ws = await connect(runtime.url);

    ws.send(JSON.stringify({
      type: 'hello',
      protocol: 1,
      capabilities: ['voice'],
      stations: [{ deviceId: 'midi', host: '192.168.1.10', port: 1961, platform: 'yandexmidi', label: 'Миди' }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridge.clients()).toEqual([
      expect.objectContaining({ clientId: 'pc', capabilities: ['voice'] }),
    ]);
    expect(bridge.stations()).toEqual([
      expect.objectContaining({ deviceId: 'midi', label: 'Миди', clientId: 'pc' }),
    ]);

    ws.close();
    await runtime.close();
  });

  it('completes request only after ack and response', async () => {
    const bridge = new BridgeServer(new Map([[TOKEN, 'pc']]));
    const runtime = await listen(bridge);
    const ws = await connect(runtime.url);
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, capabilities: ['voice'], stations: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const call = bridge.call<{ station: string }>('voice.say', { text: 'готово' });
    const request = await nextJson(ws);
    expect(request).toMatchObject({ type: 'request', method: 'voice.say', params: { text: 'готово' } });
    ws.send(JSON.stringify({ type: 'ack', id: request.id }));
    ws.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { station: 'Миди' } }));

    await expect(call).resolves.toEqual({ station: 'Миди' });
    ws.close();
    await runtime.close();
  });

  it('does not retry through another client after ack', async () => {
    const bridge = new BridgeServer(new Map([[TOKEN, 'pc']]));
    const runtime = await listen(bridge);
    const ws = await connect(runtime.url);
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, capabilities: ['voice'], stations: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const call = bridge.call('voice.say', { text: 'один раз' }, { resultMs: 100 });
    const request = await nextJson(ws);
    ws.send(JSON.stringify({ type: 'ack', id: request.id }));
    ws.close();

    await expect(call).rejects.toMatchObject({ code: 'outcome_unknown', acknowledged: true });
    await runtime.close();
  });
});
