import axios from 'axios';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config } from '../config';
import { Station } from './stations';

/**
 * Проактивный TTS на Яндекс-Станцию по локальному протоколу glagol.
 *
 *   1) glagol-токен из облака:
 *        GET https://quasar.yandex.net/glagol/token?device_id=..&platform=..
 *        Authorization: Oauth <VOICE_YANDEX_TOKEN>
 *   2) wss к самой колонке (сертификат самоподписанный, проверка выключена);
 *   3) команда `serverAction` со сценарием `repeat_after_me` — станция
 *      произносит текст дословно, без «Алиса, ...».
 *
 * Служба стоит вне домашней сети, поэтому шаг 2 идёт через CONNECT на
 * `lan-proxy` домашнего ПК. Node это позволяет: TLS к колонке поднимается
 * поверх туннеля (в том числе поверх TLS-соединения с самим прокси).
 */

const TOKEN_TTL_MS = 60 * 60 * 1000;
const tokens = new Map<string, { token: string; at: number }>();

async function glagolToken(station: Station): Promise<string> {
  const cached = tokens.get(station.deviceId);
  if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;

  if (!config.voice.yandexToken) throw new Error('VOICE_YANDEX_TOKEN не задан');

  const response = await axios.get('https://quasar.yandex.net/glagol/token', {
    params: { device_id: station.deviceId, platform: station.platform },
    headers: { Authorization: `Oauth ${config.voice.yandexToken}` },
    timeout: 15_000,
  });

  const token = response.data?.token as string | undefined;
  if (!token) throw new Error(`glagol-токен не выдан (HTTP ${response.status})`);

  tokens.set(station.deviceId, { token, at: Date.now() });
  return token;
}

/** TCP/TLS до прокси -> CONNECT к колонке -> сырой сокет внутрь локалки. */
function tunnel(station: Station): Promise<net.Socket> {
  const proxy = config.voice.proxy;
  if (!proxy.url) return Promise.reject(new Error('VOICE_PC_PROXY не задан'));

  return new Promise((resolve, reject) => {
    const socket =
      proxy.protocol === 'https'
        ? tls.connect({ host: proxy.host, port: proxy.port, rejectUnauthorized: false })
        : net.connect({ host: proxy.host, port: proxy.port });

    const onError = (error: Error) => {
      socket.destroy();
      reject(new Error(`прокси недоступен: ${error.message}`));
    };

    socket.setTimeout(15_000, () => onError(new Error('таймаут')));
    socket.once('error', onError);

    const ready = () => {
      const head =
        `CONNECT ${station.host}:${station.port} HTTP/1.1\r\n` +
        `Host: ${station.host}:${station.port}\r\n` +
        (proxy.authHeader ? `Proxy-Authorization: ${proxy.authHeader}\r\n` : '') +
        '\r\n';

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('latin1');
        if (!buffer.includes('\r\n\r\n')) return;

        socket.off('data', onData);
        socket.off('error', onError);
        socket.setTimeout(0);

        const status = buffer.split('\r\n', 1)[0];
        if (!status.includes(' 200')) {
          socket.destroy();
          reject(new Error(`прокси отказал: ${status}`));
          return;
        }
        resolve(socket);
      };

      socket.on('data', onData);
      socket.write(head);
    };

    if (proxy.protocol === 'https') socket.once('secureConnect', ready);
    else socket.once('connect', ready);
  });
}

/**
 * Агент, который отдаёт уже готовый туннель к колонке.
 *
 * Node проверяет `options.agent` на «Agent-like», поэтому просто объект с
 * `createConnection` не подходит — нужен наследник `https.Agent`. TLS к станции
 * поднимаем поверх туннеля здесь же: сертификат у неё самоподписанный.
 */
class TunnelAgent extends https.Agent {
  constructor(private readonly tunnelSocket: net.Socket) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  // Сигнатуру берём от базового Agent: callback ждёт Duplex, а не TLSSocket.
  createConnection(
    _options: https.RequestOptions,
    callback?: (error: Error | null, stream: tls.TLSSocket) => void,
  ): tls.TLSSocket {
    const secure = tls.connect({ socket: this.tunnelSocket, rejectUnauthorized: false });
    if (callback) {
      secure.once('secureConnect', () => callback(null, secure));
      secure.once('error', (error: Error) => callback(error, secure));
    }
    return secure;
  }
}

/** Команда «повтори дословно» — та же, что у Home Assistant-интеграции. */
function repeatAfterMe(conversationToken: string, text: string): string {
  return JSON.stringify({
    conversationToken,
    id: randomUUID(),
    sentTime: Date.now(),
    payload: {
      command: 'serverAction',
      serverActionEventPayload: {
        type: 'server_action',
        name: 'update_form',
        payload: {
          form_update: {
            name: 'personal_assistant.scenarios.repeat_after_me',
            slots: [{ type: 'string', name: 'request', value: text }],
          },
          resubmit: true,
        },
      },
    },
  });
}

/** Произнести текст на колонке. Бросает ошибку — вызывающий решает, что делать. */
export async function say(station: Station, text: string): Promise<void> {
  const token = await glagolToken(station);
  const socket = config.voice.proxy.url ? await tunnel(station) : undefined;

  const ws = new WebSocket(`wss://${station.host}:${station.port}`, {
    rejectUnauthorized: false,
    // Через прокси: соединение уже установлено, отдаём его агентом.
    ...(socket ? { agent: new TunnelAgent(socket) } : {}),
    handshakeTimeout: 15_000,
  });

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.close();
      error ? reject(error) : resolve();
    };

    const timer = setTimeout(() => finish(new Error('колонка не ответила')), 20_000);

    ws.once('open', () => {
      ws.send(repeatAfterMe(token, text));
      // Ответ колонки не обязателен: команда уже ушла. Немного ждём, чтобы не
      // закрыть соединение до отправки кадра.
      setTimeout(() => finish(), 1_500);
    });
    ws.once('error', (error: Error) => finish(error));
  });
}
