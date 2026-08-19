import express, { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { TaskStore } from './db';
import { AskChannel, AskService, AskStore } from './asks';
import { CaptchaOrchestrator } from './orchestrator';
import { createAliceRouter } from './alice';
import { createMcpRouter } from './mcp';
import { VoiceService } from './voice/voice.service';

declare module 'express-serve-static-core' {
  interface Request {
    clientName?: string;
  }
}

export function createServer(
  store: TaskStore,
  orchestrator: CaptchaOrchestrator,
  asks: { store: AskStore; service: AskService },
  voice: VoiceService = new VoiceService(),
) {
  const app = express();

  // Картинки капчи в base64 — стандартного лимита в 100kb не хватает.
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      solvers: orchestrator.availableSolvers(),
      asks: asks.service.isAvailable(),
      voice: asks.service.isAvailable('voice'),
      voiceQueue: asks.store.voicePending().length,
      mcp: Boolean(config.mcp.token),
    });
  });

  // Голосовая половина: вебхук навыка Алисы (свой секрет в пути) и MCP для
  // сессий Claude Code (свой Bearer-токен). Оба входа сознательно живут вне
  // /api/*: у них другая авторизация, x-token тут не при чём.
  app.use(createAliceRouter(asks));
  app.use(createMcpRouter(asks, voice));

  /** Колонки, которые видно из домашней локалки — для диагностики. */
  app.get('/api/voice/stations', authenticate, async (_req, res) => {
    res.json({ stations: await voice.stations() });
  });

  /** Проверка озвучки: произнести фразу на колонке. */
  app.post('/api/voice/say', authenticate, async (req: Request, res: Response) => {
    const { text, station } = req.body ?? {};
    const result = await voice.speak(
      typeof text === 'string' && text.trim() ? text : 'Проверка связи',
      typeof station === 'string' ? station : null,
    );
    res.json(result);
  });

  /** Голосовая очередь: что ждёт ответа и в каком порядке. */
  app.get('/api/voice/queue', authenticate, (_req, res) => {
    const now = Date.now();
    res.json({
      pending: asks.store.voicePending().map((ask, index) => ({
        id: ask.id,
        position: index + 1,
        client: ask.client,
        context: ask.context,
        question: ask.question,
        waitingSec: Math.round((now - ask.createdAt) / 1000),
        spoken: Boolean(ask.spokenAt),
      })),
    });
  });

  /** Ответить первому в очереди из терминала — фолбэк, когда Алисы под рукой нет. */
  app.post('/api/voice/answer', authenticate, (req: Request, res: Response) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) {
      res.status(400).json({ error: 'Нужен текст ответа (поле text)' });
      return;
    }

    const answered = asks.service.answerVoiceHead(text);
    if (!answered) {
      res.status(404).json({ error: 'Очередь пуста' });
      return;
    }

    res.json({ answered: { id: answered.id, client: answered.client }, next: asks.store.voiceHead() });
  });

  /** Пропустить первый вопрос: клиент уйдёт в терминальный фолбэк. */
  app.post('/api/voice/skip', authenticate, (_req, res) => {
    const skipped = asks.service.skipVoiceHead();
    if (!skipped) {
      res.status(404).json({ error: 'Очередь пуста' });
      return;
    }
    res.json({ skipped: { id: skipped.id }, next: asks.store.voiceHead() });
  });

  app.use('/api/captcha', authenticate);

  /** Синхронно: ждём до timeout_ms и отдаём ответ (или null). */
  app.post('/api/captcha/solve', async (req: Request, res: Response) => {
    const input = parseCreateInput(req, res);
    if (!input) return;

    const task = orchestrator.createTask({ ...input, client: req.clientName! });
    const finished = await orchestrator.run(task.id);

    res.json({
      id: finished.id,
      status: finished.status,
      answer: finished.answer,
      answeredBy: finished.answeredBy,
    });
  });

  /** Асинхронно: сразу отдаём id, результат забирается через GET. */
  app.post('/api/captcha', (req: Request, res: Response) => {
    const input = parseCreateInput(req, res);
    if (!input) return;

    const task = orchestrator.createTask({ ...input, client: req.clientName! });

    // Каскад идёт в фоне; ошибка здесь не должна ронять процесс — статус
    // задачи клиент всё равно прочитает через GET.
    void orchestrator.run(task.id).catch((error: Error) => {
      console.error(`Каскад для ${task.id} упал:`, error.message);
    });

    res.status(202).json({ id: task.id, status: task.status });
  });

  app.get('/api/captcha/:id', (req: Request, res: Response) => {
    const task = store.get(String(req.params.id));
    if (!task) {
      res.status(404).json({ error: 'Задача не найдена' });
      return;
    }

    res.json({
      id: task.id,
      status: task.status,
      answer: task.answer,
      answeredBy: task.answeredBy,
    });
  });

  /** Ответ не подошёл — сайт его отклонил. Переходим к следующей ступени. */
  app.post('/api/captcha/:id/reject', async (req: Request, res: Response) => {
    const task = store.get(String(req.params.id));
    if (!task) {
      res.status(404).json({ error: 'Задача не найдена' });
      return;
    }

    const finished = await orchestrator.reject(task.id);
    res.json({
      id: finished.id,
      status: finished.status,
      answer: finished.answer,
      answeredBy: finished.answeredBy,
    });
  });

  // ── Запрос секретов у человека ────────────────────────────
  // Тот же принцип, что у капчи: клиент спрашивает, Павел отвечает в Telegram.
  // Разница в том, что ответ — секрет, поэтому он не логируется и стирается из
  // базы сразу после того, как клиент его забрал.

  app.use('/api/ask', authenticate);

  /** Синхронно: ждём ответ и отдаём его. */
  app.post('/api/ask/solve', async (req: Request, res: Response) => {
    const input = parseAskInput(req, res);
    if (!input) return;

    if (!asks.service.isAvailable(input.channel)) {
      res.status(503).json({
        error:
          input.channel === 'voice'
            ? 'Голосовой канал не настроен — нет токена Яндекса или секрета навыка'
            : 'Telegram не настроен — спросить некого',
      });
      return;
    }

    const ask = asks.service.create({ ...input, client: req.clientName! });
    const finished = await asks.service.run(ask.id);
    const taken = asks.service.takeAnswer(finished.id);

    res.json({ id: finished.id, status: finished.status, answer: taken?.answer ?? null });
  });

  /** Асинхронно: сразу отдаём id, значение забирается через GET. */
  app.post('/api/ask', (req: Request, res: Response) => {
    const input = parseAskInput(req, res);
    if (!input) return;

    if (!asks.service.isAvailable(input.channel)) {
      res.status(503).json({
        error:
          input.channel === 'voice'
            ? 'Голосовой канал не настроен — нет токена Яндекса или секрета навыка'
            : 'Telegram не настроен — спросить некого',
      });
      return;
    }

    const ask = asks.service.create({ ...input, client: req.clientName! });

    void asks.service.run(ask.id).catch((error: Error) => {
      console.error(`Вопрос ${ask.id} упал:`, error.message);
    });

    res.status(202).json({ id: ask.id, status: ask.status });
  });

  /**
   * Забрать ответ. Значение отдаётся **один раз** и тут же стирается из базы:
   * секрету незачем лежать на диске после того, как он доехал до клиента.
   */
  app.get('/api/ask/:id', (req: Request, res: Response) => {
    const ask = asks.service.takeAnswer(String(req.params.id));
    if (!ask) {
      res.status(404).json({ error: 'Вопрос не найден' });
      return;
    }

    res.json({ id: ask.id, status: ask.status, answer: ask.answer });
  });

  /** Значение не подошло — спрашиваем заново тем же вопросом. */
  app.post('/api/ask/:id/retry', async (req: Request, res: Response) => {
    const ask = asks.store.get(String(req.params.id));
    if (!ask) {
      res.status(404).json({ error: 'Вопрос не найден' });
      return;
    }

    const finished = await asks.service.retry(ask.id);
    const taken = asks.service.takeAnswer(finished.id);
    res.json({ id: finished.id, status: finished.status, answer: taken?.answer ?? null });
  });

  /** Значение подошло — ставим реакцию, чтобы это было видно в переписке. */
  app.post('/api/ask/:id/confirm', (req: Request, res: Response) => {
    const ask = asks.store.get(String(req.params.id));
    if (!ask) {
      res.status(404).json({ error: 'Вопрос не найден' });
      return;
    }

    asks.service.confirm(ask.id);
    res.json({ id: ask.id, status: ask.status });
  });

  /** Точность решателей: стоит ли ступень своих денег. */
  app.get('/api/stats', authenticate, (_req, res) => {
    res.json({ solvers: store.solverStats() });
  });

  return app;
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-token') ?? '';
  const client = config.clientTokens.get(token);

  if (!client) {
    res.status(401).json({ error: 'Неверный токен клиента' });
    return;
  }

  req.clientName = client;
  next();
}

function parseAskInput(req: Request, res: Response) {
  const {
    question,
    kind,
    channel,
    station,
    context,
    link,
    options,
    timeout_ms: timeoutMs,
  } = req.body ?? {};

  if (typeof question !== 'string' || question.trim().length === 0) {
    res.status(400).json({ error: 'Нужен вопрос (поле question)' });
    return null;
  }

  if (kind !== undefined && !['secret', 'code', 'text'].includes(kind)) {
    res.status(400).json({ error: 'kind: secret | code | text' });
    return null;
  }

  if (channel !== undefined && !['telegram', 'voice'].includes(channel)) {
    res.status(400).json({ error: 'channel: telegram | voice' });
    return null;
  }

  // Секрет голосом не спрашивают: колонка проговорит его вслух, а ответ придётся
  // диктовать в комнату.
  if (channel === 'voice' && kind !== undefined && kind !== 'text') {
    res.status(400).json({ error: 'секрет и код голосом не спрашиваются' });
    return null;
  }

  if (link !== undefined && link !== null && typeof link !== 'string') {
    res.status(400).json({ error: 'link должен быть строкой' });
    return null;
  }

  if (options !== undefined && (!Array.isArray(options) || options.some((o) => typeof o !== 'string'))) {
    res.status(400).json({ error: 'options должен быть массивом строк' });
    return null;
  }

  return {
    question: question.trim(),
    kind: kind as 'secret' | 'code' | 'text' | undefined,
    channel: channel as AskChannel | undefined,
    station: typeof station === 'string' ? station : null,
    context: typeof context === 'string' ? context : null,
    link: typeof link === 'string' ? link : null,
    options: options as string[] | undefined,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  };
}

function parseCreateInput(req: Request, res: Response) {
  const { image, hint, context, solvers, timeout_ms: timeoutMs } = req.body ?? {};

  if (typeof image !== 'string' || image.length === 0) {
    res.status(400).json({ error: 'Нужна картинка капчи в base64 (поле image)' });
    return null;
  }

  if (solvers !== undefined && !Array.isArray(solvers)) {
    res.status(400).json({ error: 'solvers должен быть массивом имён' });
    return null;
  }

  return {
    // Клиент может прислать data:image/png;base64,... — префикс тут лишний.
    image: image.replace(/^data:image\/\w+;base64,/, ''),
    hint: typeof hint === 'string' ? hint : null,
    context: typeof context === 'string' ? context : null,
    solvers: solvers as string[] | undefined,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  };
}
