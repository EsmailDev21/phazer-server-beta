import { IterationKind, IterationState, TaskStatus } from '@prisma/client';
import { IterationsService } from './iterations.service';

const d = (day: string) => new Date(`${day}T00:00:00.000Z`);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  workspaceId: 'w1',
  projectId: null,
  kind: IterationKind.MILESTONE,
  name: 'M',
  goal: null,
  state: IterationState.ACTIVE,
  startDate: d('2026-11-01'),
  endDate: d('2026-11-30'),
  closedAt: null,
  closeSummary: null,
  config: null,
  startSummary: null,
  createdAt: new Date(),
  ...over,
});

/** Criteria as the database returns them: only `doneAt` and the task's status decide if one is met. */
const criterion = (met: boolean, taskStatus: TaskStatus | null = null) => ({
  id: `c-${Math.random()}`,
  iterationId: 'm1',
  title: 'x',
  taskId: taskStatus ? 't' : null,
  doneAt: taskStatus ? null : met ? new Date() : null,
  position: 0,
  task: taskStatus
    ? { id: 't', number: 1, title: 't', status: taskStatus }
    : null,
});

function setup(
  current: ReturnType<typeof row>,
  criteria: ReturnType<typeof criterion>[] = [],
) {
  const prisma = {
    iteration: {
      findFirst: jest.fn(async () => current),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...current,
        ...args.data,
      })),
    },
    milestoneCriterion: { findMany: jest.fn(async () => criteria) },
    iterationTargetChange: { create: jest.fn(async () => ({})) },
    task: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => {
        throw new Error('reached the unfinished-task count');
      }),
    },
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  const service = new IterationsService(
    prisma as never,
    { hasWorkspaceLevelAccess: jest.fn() } as never,
  );
  return { service, prisma };
}

describe('closing a milestone (ADR-0046 gate)', () => {
  it('is refused while an exit criterion is not met, before any task is touched', async () => {
    const t = setup(row(), [
      criterion(true),
      criterion(false),
      criterion(false, TaskStatus.IN_PROGRESS),
    ]);
    await expect(
      t.service.close('w1', 'm1', {} as never),
    ).rejects.toMatchObject({
      response: { code: 'CRITERIA_UNMET', details: { unmet: 2, total: 3 } },
    });
    expect(t.prisma.task.count).not.toHaveBeenCalled();
    expect(t.prisma.iteration.update).not.toHaveBeenCalled();
  });

  it('goes on to close when every criterion is met (by a person or by its task)', async () => {
    const t = setup(row(), [
      criterion(true),
      criterion(false, TaskStatus.DONE),
    ]);
    await expect(t.service.close('w1', 'm1', {} as never)).rejects.toThrow(
      'reached the unfinished-task count',
    );
  });

  it('goes on when there are no criteria at all', async () => {
    const t = setup(row(), []);
    await expect(t.service.close('w1', 'm1', {} as never)).rejects.toThrow(
      'reached the unfinished-task count',
    );
  });

  it('goes on when the milestone opted out of the gate', async () => {
    const t = setup(row({ config: { requireExitCriteria: false } }), [
      criterion(false),
    ]);
    await expect(t.service.close('w1', 'm1', {} as never)).rejects.toThrow(
      'reached the unfinished-task count',
    );
  });

  it('never asks a sprint or a cycle about criteria', async () => {
    for (const kind of [IterationKind.SPRINT, IterationKind.CYCLE]) {
      const t = setup(row({ kind }), [criterion(false)]);
      await expect(t.service.close('w1', 'm1', {} as never)).rejects.toThrow(
        'reached the unfinished-task count',
      );
      expect(t.prisma.milestoneCriterion.findMany).not.toHaveBeenCalled();
    }
  });
});

describe("a milestone's target date history (ADR-0046)", () => {
  const record = (t: ReturnType<typeof setup>) =>
    t.prisma.iterationTargetChange.create.mock.calls[0]?.[0].data;

  it('records who moved a date that was set, and from where to where', async () => {
    const t = setup(row());
    await t.service.update(
      'w1',
      'm1',
      { endDate: '2026-12-14' } as never,
      'u7',
    );
    expect(record(t)).toEqual({
      iterationId: 'm1',
      previousDate: d('2026-11-30'),
      newDate: d('2026-12-14'),
      changedById: 'u7',
    });
  });

  it('records an earlier date too, and a date that was taken away', async () => {
    const earlier = setup(row());
    await earlier.service.update(
      'w1',
      'm1',
      { endDate: '2026-11-20' } as never,
      'u1',
    );
    expect(record(earlier)).toMatchObject({ newDate: d('2026-11-20') });
    const removed = setup(row());
    await removed.service.update('w1', 'm1', { endDate: null } as never, 'u1');
    expect(record(removed)).toMatchObject({
      previousDate: d('2026-11-30'),
      newDate: null,
    });
  });

  it('records nothing the first time a date is chosen (that is planning)', async () => {
    const t = setup(row({ endDate: null, startDate: null }));
    await t.service.update(
      'w1',
      'm1',
      { endDate: '2026-12-14' } as never,
      'u1',
    );
    expect(t.prisma.iterationTargetChange.create).not.toHaveBeenCalled();
  });

  it('records nothing when the date did not move, or other fields change', async () => {
    const same = setup(row());
    await same.service.update(
      'w1',
      'm1',
      { endDate: '2026-11-30', name: 'Renamed' } as never,
      'u1',
    );
    expect(same.prisma.iterationTargetChange.create).not.toHaveBeenCalled();
    const other = setup(row());
    await other.service.update('w1', 'm1', { name: 'Renamed' } as never, 'u1');
    expect(other.prisma.iterationTargetChange.create).not.toHaveBeenCalled();
  });

  it('keeps no history for a sprint or a cycle', async () => {
    for (const kind of [IterationKind.SPRINT, IterationKind.CYCLE]) {
      const t = setup(row({ kind }));
      await t.service.update(
        'w1',
        'm1',
        { endDate: '2026-12-14' } as never,
        'u1',
      );
      expect(t.prisma.iterationTargetChange.create).not.toHaveBeenCalled();
    }
  });

  it('starts keeping history when a sprint is turned into a milestone in the same edit', async () => {
    const t = setup(row({ kind: IterationKind.SPRINT }));
    await t.service.update(
      'w1',
      'm1',
      { kind: 'MILESTONE', endDate: '2026-12-14' } as never,
      'u1',
    );
    expect(t.prisma.iterationTargetChange.create).toHaveBeenCalledTimes(1);
  });

  it('works without a known person (system or import)', async () => {
    const t = setup(row());
    await t.service.update('w1', 'm1', { endDate: '2026-12-14' } as never);
    expect(record(t)).toMatchObject({ changedById: null });
  });
});
