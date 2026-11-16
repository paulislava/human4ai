import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from './config';
import { TelegramClient } from './telegram';

jest.mock('axios');
jest.mock('./config', () => ({
  config: {
    telegram: {
      botToken: 'test-bot', chatId: 'test-chat',
      proxy: { url: '', protocol: 'http', host: '', port: 0, authHeader: null, origin: '' },
    },
  },
}));

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const directProxy = { ...config.telegram.proxy };

describe('TelegramClient transport', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.telegram.proxy = { ...directProxy };
    post.mockResolvedValue({ data: { result: { message_id: 42 } } });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['socks5', 'socks5h'])('uses an authenticated %s agent without HTTP proxy credentials', async (scheme) => {
    config.telegram.proxy = {
      ...directProxy,
      url: `${scheme}://test%40user:p%3Aa%25ss@127.0.0.1:14837`,
      // Shared voice/config parser still exposes these as HTTP.
      protocol: 'http', host: '127.0.0.1', port: 14837,
      authHeader: `Basic ${Buffer.from('test@user:p:a%ss').toString('base64')}`,
    };

    await new TelegramClient().sendQuestion({ text: 'question' });

    const [url, body, options] = post.mock.calls[0];
    expect(options.proxy).toBe(false);
    expect(options.httpAgent).toBeInstanceOf(SocksProxyAgent);
    expect(options.httpsAgent).toBe(options.httpAgent);
    expect(options.httpsAgent.proxy).toMatchObject({
      host: '127.0.0.1', port: 14837, userId: 'test@user', password: 'p:a%ss',
    });
    expect(options.headers).toBeUndefined();
    expect(options.auth).toBeUndefined();
    expect(JSON.stringify({ url, body })).not.toContain('test@user');
  });

  it.each(['http', 'https'] as const)('preserves authenticated %s proxy requests', async (protocol) => {
    config.telegram.proxy = {
      url: `${protocol}://user:p%3Aass@127.0.0.1:3128`,
      protocol, host: '127.0.0.1', port: 3128, origin: `${protocol}://127.0.0.1:3128`,
      authHeader: `Basic ${Buffer.from('user:p:ass').toString('base64')}`,
    };
    await new TelegramClient().sendMessage('message');
    expect(post.mock.calls[0][2]).toEqual({
      timeout: 15_000,
      proxy: { protocol, host: '127.0.0.1', port: 3128, auth: { username: 'user', password: 'p:ass' } },
    });
  });

  it('preserves direct requests', async () => {
    await new TelegramClient().sendMessage('message');
    expect(post.mock.calls[0][2]).toEqual({ timeout: 15_000 });
  });

  it('aborts a stuck poll at 40s and delivers the next reply after the 5s retry', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let firstSignal: AbortSignal | undefined;
    get.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      firstSignal = options.signal;
      firstSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    get.mockResolvedValueOnce({ data: { result: [{
      update_id: 10,
      message: { message_id: 12, reply_to_message: { message_id: 11 }, text: ' answer ' },
    }] } });
    const client = new TelegramClient();
    const onReply = jest.fn(() => client.stopPolling());
    client.startPolling(onReply);
    try {
      await jest.advanceTimersByTimeAsync(39_999);
      expect(get).toHaveBeenCalledTimes(1);
      expect(firstSignal?.aborted).not.toBe(true);
      await jest.advanceTimersByTimeAsync(1);
      expect(firstSignal?.aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(4_999);
      expect(get).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(get).toHaveBeenCalledTimes(2);
      expect(onReply).toHaveBeenCalledWith({ replyToMessageId: 11, messageId: 12, text: 'answer' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      client.stopPolling();
    }
  });

  it('clears the deadline when polling succeeds', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = new TelegramClient();
    get.mockImplementationOnce(async (_url, options) => {
      signal = options.signal;
      return { data: { result: [] } };
    });
    get.mockImplementationOnce(async () => {
      client.stopPolling();
      return { data: { result: [] } };
    });
    client.startPolling(jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(40_000);
    expect(signal?.aborted).toBe(false);
  });

  it('cancels the active request and clears its deadline when polling stops', async () => {
    jest.useFakeTimers();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let signal: AbortSignal | undefined;
    get.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = new TelegramClient();
    client.startPolling(jest.fn());
    client.stopPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(45_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not restart a cancelled polling loop after an immediate stop/start', async () => {
    jest.useFakeTimers();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    get.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = new TelegramClient();
    client.startPolling(jest.fn());
    client.stopPolling();
    client.startPolling(jest.fn());
    await jest.advanceTimersByTimeAsync(5_000);
    expect(get).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    client.stopPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores a successful old response when stop/start occurs before delivery', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const replies: Array<(value: unknown) => void> = [];
    get.mockImplementation((_url, options) => new Promise((resolve, reject) => {
      replies.push(resolve);
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = new TelegramClient();
    const oldCallback = jest.fn();
    const newCallback = jest.fn(() => client.stopPolling());
    client.startPolling(oldCallback);
    try {
      replies[0]({ data: { result: [{
        update_id: 10,
        message: { message_id: 12, reply_to_message: { message_id: 11 }, text: 'old' },
      }] } });
      queueMicrotask(() => {
        client.stopPolling();
        client.startPolling(newCallback);
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(oldCallback).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledTimes(2);
      replies[1]({ data: { result: [] } });
      await jest.advanceTimersByTimeAsync(0);
      expect(get.mock.calls[2][1].params.offset).toBe(0);
      replies[2]({ data: { result: [{
        update_id: 20,
        message: { message_id: 22, reply_to_message: { message_id: 21 }, text: 'new' },
      }] } });
      await jest.advanceTimersByTimeAsync(0);
      expect(newCallback).toHaveBeenCalledWith({ replyToMessageId: 21, messageId: 22, text: 'new' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      client.stopPolling();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  it('ignores the rest of a batch when its callback stops and restarts polling', async () => {
    jest.useFakeTimers();
    const replies: Array<(value: unknown) => void> = [];
    get.mockImplementation((_url, options) => new Promise((resolve, reject) => {
      replies.push(resolve);
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = new TelegramClient();
    const newCallback = jest.fn();
    const oldCallback = jest.fn(() => {
      client.stopPolling();
      client.startPolling(newCallback);
    });
    client.startPolling(oldCallback);
    try {
      replies[0]({ data: { result: [10, 30].map((id) => ({
        update_id: id,
        message: { message_id: id + 2, reply_to_message: { message_id: id + 1 }, text: `reply ${id}` },
      })) } });
      await jest.advanceTimersByTimeAsync(0);
      expect(oldCallback).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(2);
      replies[1]({ data: { result: [] } });
      await jest.advanceTimersByTimeAsync(0);
      expect(get.mock.calls[2][1].params.offset).toBe(11);
      expect(newCallback).not.toHaveBeenCalled();
    } finally {
      client.stopPolling();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(jest.getTimerCount()).toBe(0);
  });
});
