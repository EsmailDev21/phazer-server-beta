import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IterationKind, IterationState } from '@prisma/client';
import { CycleService } from './cycle.service';

const S = IterationState;
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);

interface Row {
  id: string;
  workspaceId: string;
  projectId: string | null;
  kind: IterationKind;
  name: string;
  state: IterationState;
  startDate: Date | null;
  endDate: Date | null;
  config: Record<string, unknown> | null;
  closeSummary: unknown;
  createdAt: Date;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'c12',
  workspaceId: 'w1',
  projectId: null,
  kind: IterationKind.CYCLE,
  name: 'Cycle 12',
  state: S.ACTIVE,
  startDate: d('2026-11-02'),
  endDate: d('2026-11-15'),
  config: { cadenceWeeks: 2, autoCreateNext: true, autoRollover: true },
  closeSummary: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

/** A fake database that answers by the shape of the query, so the tests read as scenarios. */
function setup(
  scenario: {
    running?: Row[];
    waiting?: Row[];
    successor?: Row | null;
    siblings?: Array<{ name: string }>;
    activeInScope?: number;
    count?: number;
    closeImpl?: (ws: string, id: string, dto: unknown) => Promise<unknown>;
  } = {},
) {
  const iteration = {
    findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      if (w.OR && w.state === S.ACTIVE) return scenario.running ?? [];
      if (w.state === S.PLANNED) return scenario.waiting ?? [];
      return scenario.siblings ?? [];
    }),
    findFirst: jest.fn(async () => scenario.successor ?? null),
    count: jest.fn(async (args: { where: Record<string, unknown> }) =>
      args.where.state === S.ACTIVE
        ? (scenario.activeInScope ?? 0)
        : (scenario.count ?? 10),
    ),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'new',
      state: S.PLANNED,
      closeSummary: null,
      createdAt: new Date(),
      ...args.data,
    })),
  };
  const order: string[] = [];
  const prisma = {
    iteration,
    task: { findMany: jest.fn(async () => []) },
    $executeRaw: jest.fn(async () => {
      order.push('lock');
    }),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  iteration.findFirst.mockImplementation(async () => {
    order.push('find-successor');
    return scenario.successor ?? null;
  });
  const iterations = {
    close: jest.fn(scenario.closeImpl ?? (async () => ({}))),
    start: jest.fn(async () => ({})),
  };
  const permissions = { hasWorkspaceLevelAccess: jest.fn(async () => true) };
  const service = new CycleService(
    prisma as never,
    permissions as never,
    iterations as never,
  );
  return { service, prisma, iteration, iterations, permissions, order };
}

describe('CycleService.sweep: create the next cycle', () => {
  it('creates it ahead of time with the next dates, the next name and the same settings', async () => {
    const t = setup({
      running: [row()],
      siblings: [{ name: 'Cycle 12' }, { name: 'Cycle 11' }],
    });
    const r = await t.service.sweep('2026-11-10');
    expect(r).toEqual({ created: 1, rolled: 0, started: 0, failed: 0 });
    const data = t.iteration.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: 'w1',
      projectId: null,
      kind: IterationKind.CYCLE,
      name: 'Cycle 13',
      config: { cadenceWeeks: 2, autoCreateNext: true, autoRollover: true },
    });
    expect((data.startDate as Date).toISOString().slice(0, 10)).toBe(
      '2026-11-16',
    );
    expect((data.endDate as Date).toISOString().slice(0, 10)).toBe(
      '2026-11-29',
    );
    expect(t.iterations.close).not.toHaveBeenCalled();
  });

  it('honours the cooldown', async () => {
    const t = setup({
      running: [
        row({
          config: { cadenceWeeks: 1, autoCreateNext: true, cooldownDays: 2 },
        }),
      ],
    });
    await t.service.sweep('2026-11-10');
    const data = t.iteration.create.mock.calls[0]![0].data;
    expect((data.startDate as Date).toISOString().slice(0, 10)).toBe(
      '2026-11-18',
    );
    expect((data.endDate as Date).toISOString().slice(0, 10)).toBe(
      '2026-11-24',
    );
  });

  it('takes the per-cycle lock before it looks again for a successor (two workers cannot both create)', async () => {
    const t = setup({ running: [row()] });
    await t.service.sweep('2026-11-10');
    // 1st find: outside the lock (cheap check); then lock; then the find inside the lock.
    expect(t.order).toEqual(['find-successor', 'lock', 'find-successor']);
  });

  it('creates nothing when a successor already exists (running it again changes nothing)', async () => {
    const t = setup({
      running: [row({ config: { cadenceWeeks: 2, autoCreateNext: true } })],
      successor: row({
        id: 'c13',
        state: S.PLANNED,
        startDate: d('2026-11-16'),
      }),
    });
    const r = await t.service.sweep('2026-11-10');
    expect(r.created).toBe(0);
    expect(t.iteration.create).not.toHaveBeenCalled();
    expect(t.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('creates nothing when the workspace is full', async () => {
    const t = setup({ running: [row()], count: 1000 });
    const r = await t.service.sweep('2026-11-10');
    expect(r).toMatchObject({ created: 0, failed: 0 });
    expect(t.iteration.create).not.toHaveBeenCalled();
  });

  it('does not create from a cycle without a cadence', async () => {
    const t = setup({ running: [row({ config: { autoCreateNext: true } })] });
    await t.service.sweep('2026-11-10');
    expect(t.iteration.create).not.toHaveBeenCalled();
  });
});

describe('CycleService.sweep: roll over a finished cycle', () => {
  const next = row({
    id: 'c13',
    name: 'Cycle 13',
    state: S.PLANNED,
    startDate: d('2026-11-16'),
    endDate: d('2026-11-29'),
  });

  it('closes it, moving unfinished tasks to the next cycle', async () => {
    const t = setup({ running: [row()], successor: next });
    const r = await t.service.sweep('2026-11-16');
    expect(t.iterations.close).toHaveBeenCalledWith('w1', 'c12', {
      action: 'MOVE',
      moveToIterationId: 'c13',
    });
    expect(r.rolled).toBe(1);
  });

  it('then starts the next cycle once its day has come and nothing else runs', async () => {
    const t = setup({
      running: [row()],
      successor: next,
      waiting: [next],
      activeInScope: 0,
    });
    const r = await t.service.sweep('2026-11-16');
    expect(t.iterations.start).toHaveBeenCalledWith('w1', 'c13');
    expect(r).toEqual({ created: 0, rolled: 1, started: 1, failed: 0 });
  });

  it('waits through the last day of the cycle', async () => {
    const t = setup({ running: [row()], successor: next });
    const r = await t.service.sweep('2026-11-15');
    expect(t.iterations.close).not.toHaveBeenCalled();
    expect(r.rolled).toBe(0);
  });

  it('never closes when there is nowhere to move the unfinished work', async () => {
    const t = setup({
      running: [row({ config: { autoRollover: true } })],
      successor: null,
    });
    const r = await t.service.sweep('2026-11-20');
    expect(t.iterations.close).not.toHaveBeenCalled();
    expect(r.rolled).toBe(0);
  });

  it('leaves a finished cycle alone when it did not ask for rollover', async () => {
    const t = setup({
      running: [row({ config: { cadenceWeeks: 2, autoCreateNext: true } })],
      successor: next,
    });
    await t.service.sweep('2026-11-20');
    expect(t.iterations.close).not.toHaveBeenCalled();
  });
});

describe('CycleService.sweep: start a waiting cycle', () => {
  const waiting = row({
    id: 'c13',
    state: S.PLANNED,
    startDate: d('2026-11-18'),
    endDate: d('2026-12-01'),
  });

  it('starts it on its first day (the end of a cooldown)', async () => {
    const t = setup({ waiting: [waiting], activeInScope: 0 });
    const r = await t.service.sweep('2026-11-18');
    expect(t.iterations.start).toHaveBeenCalledWith('w1', 'c13');
    expect(r.started).toBe(1);
  });

  it('does not start it while another cycle of the same scope is running', async () => {
    const t = setup({ waiting: [waiting], activeInScope: 1 });
    await t.service.sweep('2026-11-18');
    expect(t.iterations.start).not.toHaveBeenCalled();
  });

  it('does not start a cycle whose time is over', async () => {
    const t = setup({ waiting: [waiting], activeInScope: 0 });
    await t.service.sweep('2026-12-05');
    expect(t.iterations.start).not.toHaveBeenCalled();
  });
});

describe('CycleService.sweep: one failure never stops the rest', () => {
  it('counts it, goes on, and reports it', async () => {
    const a = row({
      id: 'a',
      endDate: d('2026-11-01'),
      config: { autoRollover: true },
    });
    const b = row({
      id: 'b',
      endDate: d('2026-11-02'),
      config: { autoRollover: true },
    });
    const next = (id: string) =>
      row({ id, state: S.PLANNED, startDate: d('2026-11-20') });
    const t = setup({
      running: [a, b],
      closeImpl: async (_ws, id) => {
        if (id === 'a')
          throw new Error(
            '1 unfinished task(s) are not in the project of the target',
          );
        return {};
      },
    });
    t.iteration.findFirst
      .mockResolvedValueOnce(next('x'))
      .mockResolvedValueOnce(next('y'));
    const r = await t.service.sweep('2026-11-10');
    expect(t.iterations.close).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ rolled: 1, failed: 1 });
  });
});

describe('CycleService.ring', () => {
  const mk = (
    id: string,
    start: string,
    state: IterationState,
    extra: Partial<Row> = {},
  ) =>
    row({
      id,
      name: `Cycle ${id}`,
      state,
      startDate: d(start),
      endDate: d(start.replace(/-\d\d$/, '-28')),
      ...extra,
    });

  it('shows the neighbours, what each finished, and what was handed over', async () => {
    const closed = mk('c10', '2026-09-01', S.CLOSED, {
      closeSummary: {
        unfinished: 4,
        movedToId: 'c11',
        velocity: {
          totalCount: 10,
          completedCount: 6,
          totalPoints: 20,
          completedPoints: 12,
        },
      },
    });
    const current = mk('c11', '2026-10-01', S.ACTIVE);
    const next = mk('c12', '2026-11-01', S.PLANNED);
    const t = setup();
    t.iteration.findFirst.mockResolvedValue(current);
    t.iteration.findMany.mockResolvedValue([next, closed, current]);
    t.prisma.task.findMany.mockResolvedValue([
      {
        id: 't1',
        iterationId: 'c11',
        parentId: null,
        status: 'DONE',
        isArchived: false,
        estimate: 3,
        workflowStatus: null,
      },
      {
        id: 't2',
        iterationId: 'c11',
        parentId: null,
        status: 'TODO',
        isArchived: false,
        estimate: 5,
        workflowStatus: null,
      },
    ] as never);

    const ring = await t.service.ring('w1', 'c11', 'u1');
    expect(ring.items.map((i) => i.id)).toEqual(['c10', 'c11', 'c12']);
    expect(ring.items[0]).toMatchObject({
      completionPct: 60,
      completedCount: 6,
      totalCount: 10,
      rolledIn: 0,
    });
    expect(ring.items[1]).toMatchObject({
      completionPct: 50,
      completedPoints: 3,
      totalPoints: 8,
      rolledIn: 4,
    });
    expect(ring.items[2]).toMatchObject({
      state: 'PLANNED',
      completionPct: 0,
      rolledIn: 0,
    });
  });

  it('answers 400 for a sprint', async () => {
    const t = setup();
    t.iteration.findFirst.mockResolvedValue(
      row({ kind: IterationKind.SPRINT }),
    );
    await expect(t.service.ring('w1', 'c11', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('needs workspace access', async () => {
    const t = setup();
    t.permissions.hasWorkspaceLevelAccess.mockResolvedValue(false);
    await expect(t.service.ring('w1', 'c11', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
