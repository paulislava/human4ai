import express, { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { TaskStore } from './db';
import { CaptchaOrchestrator } from './orchestrator';

declare module 'express-serve-static-core' {
  interface Request {
    clientName?: string;
  }
}

export function createServer(
  store: TaskStore,
  orchestrator: CaptchaOrchestrator,
) {
  const app = express();

  // Картинки капчи в base64 — стандартного лимита в 100kb не хватает.
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', solvers: orchestrator.availableSolvers() });
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
