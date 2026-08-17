import crypto from 'node:crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { Ask, AskChannel, AskService, AskStore } from './asks';
import { config } from './config';
import { VoiceService } from './voice/voice.service';

/**
 * MCP поверх HTTP — то, чем пользуются сессии Claude Code:
 *
 *   claude mcp add --transport http human4ai https://<домен>/mcp \
 *     --header "Authorization: Bearer <MCP_TOKEN>"
 *
 * Инструменты — та же подсистема вопросов, что и у REST: `ask_user` кладёт
 * вопрос (голосом на колонку или реплаем в Telegram), `wait_answer` дожидается
 * ответа, `queue_status` показывает голосовую очередь.
 *
 * Своя реализация JSON-RPC, а не SDK: нужен один POST-эндпоинт рядом с
 * остальными в том же Express-приложении. Ответы отдаём как `application/json` —
 * streamable-http это допускает, SSE-поток не нужен (сервер сам ничего не
 * инициирует).
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'human4ai', title: 'Вопросы Павлу', version: '1.0.0' };

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'ask_user',
    title: 'Спросить Павла',
    description:
      'Задать Павлу вопрос и дождаться ответа. channel="voice" (по умолчанию) — ' +
      'вопрос произносит Яндекс-Станция, Павел отвечает «Алиса, ответь коду …»; ' +
      'голосовая очередь общая для всех сессий и строго FIFO. channel="telegram" — ' +
      'вопрос уходит реплаем в Telegram (годится для длинных ответов, ссылок и ' +
      'секретов). Голосом формулируй коротко и разговорно: это произносится вслух.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Вопрос одной фразой, без markdown.' },
        channel: { type: 'string', enum: ['voice', 'telegram'], description: 'Канал доставки.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Варианты ответа: зачитываются на колонке, в Telegram уходят опросом.',
        },
        context: {
          type: 'string',
          description: 'Кто спрашивает (звучит в вопросе): проект, задача.',
        },
        station: { type: 'string', description: 'Колонка: номер, имя или device_id.' },
        wait: { type: 'number', description: 'Сколько секунд ждать ответ в этом вызове.' },
        timeout: { type: 'number', description: 'Сколько всего секунд вопрос ждёт ответа.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'wait_answer',
    title: 'Дождаться ответа',
    description: 'Продолжить ожидание ответа, если ask_user вернул status=pending.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        wait: { type: 'number', description: 'Секунды ожидания.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'cancel_ask',
    title: 'Снять вопрос',
    description: 'Убрать свой вопрос из очереди, если он больше не нужен.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'queue_status',
    title: 'Очередь вопросов',
    description: 'Голосовая очередь: порядок, кто спрашивает, сколько ждёт. Плюс список колонок.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function result(ask: Ask | null, id?: string) {
  if (!ask) return { status: 'not_found', id: id ?? null };

  switch (ask.status) {
    case 'answered':
    case 'taken':
      return { status: 'answered', id: ask.id, answer: ask.answer };
    case 'skipped':
      return {
        status: 'skipped',
        id: ask.id,
        hint: 'Павел сказал «пропусти» — спроси в терминале',
      };
    case 'timeout':
      return {
        status: 'timeout',
        id: ask.id,
        hint: 'ответа не было, вопрос снят — спроси в терминале',
      };
    default:
      return {
        status: 'pending',
        id: ask.id,
        hint: 'ответа пока нет — вызови wait_answer с этим id',
      };
  }
}

export function createMcpRouter(
  asks: { store: AskStore; service: AskService },
  voice: VoiceService,
): Router {
  const router = Router();

  /** Дождаться, пока вопрос уйдёт из pending, но не дольше `waitMs`. */
  async function waitFor(id: string, waitMs: number): Promise<Ask | null> {
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, config.mcp.maxWaitMs));
    let ask = asks.store.get(id);

    while (ask && ask.status === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      ask = asks.store.get(id);
    }

    return ask;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'ask_user': {
        const question = String(args.question ?? '').trim();
        if (!question) throw new Error('question обязателен');

        const channel = (args.channel === 'telegram' ? 'telegram' : 'voice') as AskChannel;
        if (!asks.service.isAvailable(channel)) {
          throw new Error(
            channel === 'voice'
              ? 'голосовой канал не настроен (нет токена Яндекса или секрета навыка)'
              : 'Telegram не настроен',
          );
        }

        const ask = asks.service.create({
          client: 'claude-code',
          channel,
          question,
          context: typeof args.context === 'string' ? args.context : null,
          options: Array.isArray(args.options) ? (args.options as string[]) : undefined,
          station: typeof args.station === 'string' ? args.station : null,
          timeoutMs: typeof args.timeout === 'number' ? args.timeout * 1000 : undefined,
        });

        // Ход вопроса живёт в фоне: инструмент может вернуться раньше ответа, а
        // ожидание продолжится через wait_answer.
        void asks.service.run(ask.id).catch((error: Error) => {
          console.error(`[mcp] вопрос ${ask.id} упал:`, error.message);
        });

        const waitMs = (typeof args.wait === 'number' ? args.wait : config.mcp.maxWaitMs / 1000) * 1000;
        return result(await waitFor(ask.id, waitMs), ask.id);
      }

      case 'wait_answer': {
        const id = String(args.id ?? '');
        const waitMs = (typeof args.wait === 'number' ? args.wait : config.mcp.maxWaitMs / 1000) * 1000;
        return result(await waitFor(id, waitMs), id);
      }

      case 'cancel_ask': {
        const id = String(args.id ?? '');
        const cancelled = asks.service.cancel(id);
        return { status: cancelled ? 'cancelled' : 'not_pending', id };
      }

      case 'queue_status': {
        const now = Date.now();
        return {
          pending: asks.store.voicePending().map((ask, index) => ({
            id: ask.id,
            position: index + 1,
            context: ask.context,
            question: ask.question,
            waitingSec: Math.round((now - ask.createdAt) / 1000),
          })),
          stations: (await voice.stations()).map((station) => station.label),
        };
      }

      default:
        throw new Error(`неизвестный инструмент: ${name}`);
    }
  }

  async function handle(message: RpcRequest) {
    const { id, method, params = {} } = message;
    if (id === undefined || id === null) return null; // уведомление: ответа не ждут

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Вопросы Павлу. Голосовая очередь FIFO: ответ уходит той сессии, ' +
            'которая спросила раньше.',
        },
      };
    }

    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    if (method === 'tools/call') {
      const name = String((params as { name?: string }).name ?? '');
      const args = ((params as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<
        string,
        unknown
      >;

      try {
        const data = await callTool(name, args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          },
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: (error as Error).message }],
          },
        };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `метод не поддерживается: ${method}` } };
  }

  function authenticate(req: Request, res: Response, next: NextFunction): void {
    if (!config.mcp.token) {
      res.status(503).json({ error: 'MCP_TOKEN не задан' });
      return;
    }

    const header = (req.header('authorization') ?? '').trim();
    const got = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header;
    const want = config.mcp.token;
    const ok =
      got.length === want.length &&
      crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));

    if (!ok) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  }

  router.post('/mcp', authenticate, async (req: Request, res: Response) => {
    const body = req.body;

    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map(handle))).filter(Boolean);
      answers.length ? res.json(answers) : res.status(202).end();
      return;
    }

    const answer = await handle(body ?? {});
    answer ? res.json(answer) : res.status(202).end();
  });

  // SSE-поток серверу не нужен: уведомлений он не инициирует.
  router.get('/mcp', authenticate, (_req, res) => {
    res.status(405).json({ error: 'method not allowed' });
  });

  return router;
}
