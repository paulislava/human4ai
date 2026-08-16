import { unlinkSync } from 'node:fs';
import { TaskStore } from './db';
import { CaptchaOrchestrator } from './orchestrator';
import { CaptchaSolver } from './solvers/types';
import { TelegramClient } from './telegram';

/** Подставной решатель: отдаёт заранее заданные ответы по очереди. */
class StubSolver implements CaptchaSolver {
  calls = 0;

  constructor(
    readonly name: string,
    private readonly answers: Array<string | null | Error>,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async solve(): Promise<string | null> {
    const answer = this.answers[this.calls] ?? null;
    this.calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function makeOrchestrator(solvers: CaptchaSolver[]) {
  const path = `./data/test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  const store = new TaskStore(path);
  const orchestrator = new CaptchaOrchestrator(store, new TelegramClient());

  // Подменяем реестр решателей на подставные.
  const registry = new Map(solvers.map((solver) => [solver.name, solver]));
  Object.defineProperty(orchestrator, 'solvers', { value: registry });

  return { store, orchestrator, cleanup: () => { store.close(); unlinkSync(path); } };
}

describe('CaptchaOrchestrator', () => {
  it('останавливается на первом решателе, который дал ответ', async () => {
    const first = new StubSolver('gigachat', ['A7K2M']);
    const second = new StubSolver('claude', ['ДРУГОЕ']);
    const { orchestrator, cleanup } = makeOrchestrator([first, second]);

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['gigachat', 'claude'],
    });
    const result = await orchestrator.run(task.id);

    expect(result.status).toBe('solved');
    expect(result.answer).toBe('A7K2M');
    expect(result.answeredBy).toBe('gigachat');
    expect(second.calls).toBe(0);

    cleanup();
  });

  it('переходит к следующей ступени, когда первая не справилась', async () => {
    const first = new StubSolver('gigachat', [null]);
    const second = new StubSolver('claude', ['A7K2M']);
    const { orchestrator, cleanup } = makeOrchestrator([first, second]);

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['gigachat', 'claude'],
    });
    const result = await orchestrator.run(task.id);

    expect(result.answer).toBe('A7K2M');
    expect(result.answeredBy).toBe('claude');

    cleanup();
  });

  it('ошибка ступени не роняет каскад', async () => {
    const first = new StubSolver('gigachat', [new Error('прокси недоступен')]);
    const second = new StubSolver('claude', ['A7K2M']);
    const { orchestrator, cleanup } = makeOrchestrator([first, second]);

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['gigachat', 'claude'],
    });
    const result = await orchestrator.run(task.id);

    expect(result.status).toBe('solved');
    expect(result.answeredBy).toBe('claude');

    cleanup();
  });

  it('reject переводит задачу на следующую ступень, а не начинает сначала', async () => {
    const first = new StubSolver('gigachat', ['НЕВЕРНО', 'СНОВА-НЕВЕРНО']);
    const second = new StubSolver('claude', ['A7K2M']);
    const { orchestrator, cleanup } = makeOrchestrator([first, second]);

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['gigachat', 'claude'],
    });
    await orchestrator.run(task.id);

    const afterReject = await orchestrator.reject(task.id);

    expect(afterReject.answer).toBe('A7K2M');
    expect(afterReject.answeredBy).toBe('claude');
    // Первая ступень не переспрашивается — иначе каскад зациклился бы.
    expect(first.calls).toBe(1);

    cleanup();
  });

  it('помечает задачу failed, когда все ступени исчерпаны', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([
      new StubSolver('gigachat', [null]),
      new StubSolver('claude', [null]),
    ]);

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['gigachat', 'claude'],
    });
    const result = await orchestrator.run(task.id);

    expect(result.status).toBe('failed');
    expect(result.answer).toBeNull();

    cleanup();
  });

  it('пишет каждую попытку в аудит', async () => {
    const { store, orchestrator, cleanup } = makeOrchestrator([
      new StubSolver('gigachat', [null]),
      new StubSolver('claude', ['A7K2M']),
    ]);

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['gigachat', 'claude'],
    });
    await orchestrator.run(task.id);

    const stats = store.solverStats();
    expect(stats).toEqual(
      expect.arrayContaining([
        { solver: 'claude', outcome: 'solved', count: 1 },
        { solver: 'gigachat', outcome: 'failed', count: 1 },
      ]),
    );

    cleanup();
  });

  it('переживает рестарт: задача читается из базы заново', async () => {
    const path = `./data/test-restart-${Date.now()}.sqlite`;
    const store = new TaskStore(path);
    const orchestrator = new CaptchaOrchestrator(store, new TelegramClient());
    Object.defineProperty(orchestrator, 'solvers', {
      value: new Map([['human', new StubSolver('human', [null])]]),
    });

    const task = orchestrator.createTask({
      client: 'test',
      image: 'x',
      solvers: ['human'],
    });
    store.close();

    const reopened = new TaskStore(path);
    expect(reopened.get(task.id)?.status).toBe('pending');

    reopened.close();
    unlinkSync(path);
  });
});
