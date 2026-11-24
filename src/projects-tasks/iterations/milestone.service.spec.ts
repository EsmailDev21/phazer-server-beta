import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IterationKind, IterationState, TaskStatus } from '@prisma/client';
import { MilestoneService } from './milestone.service';

const S = IterationState;
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);

const milestone = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  workspaceId: 'w1',
  projectId: null,
  kind: IterationKind.MILESTONE,
  name: 'Checkout v2 beta',
  state: S.ACTIVE,
  startDate: d('2026-11-01'),
  endDate: d('2026-11-30'),
  config: null,
  ...over,
});

const task = (
  id: string,
  status: TaskStatus,
  over: Record<string, unknown> = {},
) => ({
  id,
  number: Number(id.replace(/\D/g, '')) || 1,
  title: `Task ${id}`,
  parentId: null,
  status,
  isArchived: false,
  estimate: null,
  workflowStatus: null,
  ...over,
});

const critRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  iterationId: 'm1',
  title: `Criterion ${id}`,
  taskId: null,
  doneAt: null,
  position: 0,
  task: null,
  ...over,
});

interface Scenario {
  it?: ReturnType<typeof milestone> | null;
  criteria?: ReturnType<typeof critRow>[];
  tasks?: ReturnType<typeof task>[];
  blockers?: unknown[];
  blockerCount?: number;
  changes?: unknown[];
  links?: unknown[];
  access?: boolean;
  lookupTask?: { title: string } | null;
  dupCriterion?: unknown;
  maxPosition?: number | null;
  criterionCount?: number;
  found?: ReturnType<typeof critRow> | null;
  deleted?: number;
}

function setup(sc: Scenario = {}) {
  const prisma = {
    iteration: {
      findFirst: jest.fn(async () =>
        sc.it === undefined ? milestone() : sc.it,
      ),
    },
    milestoneCriterion: {
      findMany: jest.fn(async () => sc.criteria ?? []),
      count: jest.fn(
        async () => sc.criterionCount ?? (sc.criteria ?? []).length,
      ),
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
        args.where.taskId !== undefined
          ? (sc.dupCriterion ?? null)
          : (sc.found ?? null),
      ),
      aggregate: jest.fn(async () => ({
        _max: { position: sc.maxPosition ?? null },
      })),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'new',
        ...args.data,
      })),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: sc.deleted ?? 1 })),
      findUniqueOrThrow: jest.fn(async () => critRow('new')),
    },
    task: {
      findMany: jest.fn(async () => sc.tasks ?? []),
      findFirst: jest.fn(async () =>
        sc.lookupTask === undefined ? { title: 'Linked' } : sc.lookupTask,
      ),
    },
    taskDependency: {
      findMany: jest.fn(async () => sc.blockers ?? []),
      count: jest.fn(async () => sc.blockerCount ?? (sc.blockers ?? []).length),
    },
    iterationTargetChange: { findMany: jest.fn(async () => sc.changes ?? []) },
    externalLink: { findMany: jest.fn(async () => sc.links ?? []) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  const permissions = {
    hasWorkspaceLevelAccess: jest.fn(async () => sc.access ?? true),
  };
  return {
    service: new MilestoneService(prisma as never, permissions as never),
    prisma,
    permissions,
  };
}

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-11T12:00:00Z'),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'performance',
    ],
  });
});
afterAll(() => jest.useRealTimers());

describe('MilestoneService.road', () => {
  it('assembles progress, health, criteria, blockers and the date history', async () => {
    const t = setup({
      tasks: [
        task('t1', TaskStatus.DONE),
        task('t2', TaskStatus.DONE),
        task('t3', TaskStatus.DONE),
        task('t4', TaskStatus.DONE),
        task('t5', TaskStatus.DONE),
        task('t6', TaskStatus.TODO),
        task('t7', TaskStatus.TODO),
        task('t8', TaskStatus.IN_PROGRESS),
        task('t9', TaskStatus.TODO),
        task('t10', TaskStatus.TODO),
      ],
      criteria: [
        critRow('c1', { doneAt: new Date(), position: 0 }),
        critRow('c2', {
          position: 1,
          taskId: 't9',
          task: {
            id: 't9',
            number: 9,
            title: 'Task t9',
            status: TaskStatus.TODO,
          },
        }),
      ],
      blockers: [
        {
          blockedTask: { id: 't9', number: 9, title: 'Task t9' },
          blockingTask: { id: 't7', number: 7, title: 'Task t7' },
        },
      ],
      changes: [
        {
          previousDate: d('2026-11-23'),
          newDate: d('2026-11-30'),
          createdAt: new Date('2026-11-05T00:00:00Z'),
          changedById: 'u1',
        },
      ],
    });
    const r = await t.service.road('w1', 'm1', 'u1');
    expect(r.progress).toEqual({ basis: 'TASKS', done: 5, total: 10, pct: 50 });
    expect(r.health).toEqual({
      status: 'ON_TRACK',
      projectedDate: '2026-11-21',
      daysLeft: 19,
      reasons: [],
    });
    expect(r.criteriaSummary).toEqual({ total: 2, met: 1 });
    expect(r.criteria[0]).toMatchObject({
      id: 'c1',
      source: 'MANUAL',
      met: true,
    });
    expect(r.criteria[1]).toMatchObject({
      id: 'c2',
      source: 'TASK',
      met: false,
      taskNumber: 9,
      doneAt: null,
    });
    expect(r.blockers.count).toBe(1);
    expect(r.blockers.items[0]).toMatchObject({
      blocked: { number: 9 },
      blocker: { number: 7 },
    });
    expect(r.slips).toMatchObject({
      count: 1,
      totalDays: 7,
      originalTarget: '2026-11-23',
    });
    expect(r.requireExitCriteria).toBe(true);
    expect(r.endDate).toBe('2026-11-30');
  });

  it('counts the real number of blockers even when only some are listed', async () => {
    const t = setup({ blockers: [], blockerCount: 120 });
    const r = await t.service.road('w1', 'm1', 'u1');
    expect(r.blockers.count).toBe(120);
  });

  it('a milestone with only criteria is judged by them', async () => {
    const t = setup({
      criteria: [
        critRow('c1', { doneAt: new Date() }),
        critRow('c2'),
        critRow('c3'),
      ],
    });
    const r = await t.service.road('w1', 'm1', 'u1');
    expect(r.progress).toEqual({
      basis: 'CRITERIA',
      done: 1,
      total: 3,
      pct: 33,
    });
  });

  it('an empty milestone has no progress to judge', async () => {
    const r = await setup().service.road('w1', 'm1', 'u1');
    expect(r.progress).toEqual({ basis: 'NONE', done: 0, total: 0, pct: 0 });
    expect(r.health.status).toBe('ON_TRACK');
  });

  it('reports the gate setting, defaulting to required', async () => {
    const off = await setup({
      it: milestone({ config: { requireExitCriteria: false } }),
    }).service.road('w1', 'm1', 'u1');
    expect(off.requireExitCriteria).toBe(false);
  });

  it('is slipped after the target with work open', async () => {
    const t = setup({
      it: milestone({ endDate: d('2026-11-05') }),
      tasks: [task('t1', TaskStatus.TODO)],
    });
    const r = await t.service.road('w1', 'm1', 'u1');
    expect(r.health).toMatchObject({ status: 'SLIPPED', daysLeft: -6 });
  });

  it('answers 400 for a sprint or a cycle, 404 for a missing one, 403 without access', async () => {
    await expect(
      setup({ it: milestone({ kind: IterationKind.SPRINT }) }).service.road(
        'w1',
        'm1',
        'u1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup({ it: null }).service.road('w1', 'm1', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ access: false }).service.road('w1', 'm1', 'u1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MilestoneService.releaseNotes', () => {
  it('lists finished leaf tasks only, and merged pull requests once each', async () => {
    const t = setup({
      tasks: [
        task('t1', TaskStatus.DONE, { number: 12, title: 'Fix login' }),
        task('t2', TaskStatus.TODO, { number: 13 }),
        // a parent is its subtasks: the parent itself is not listed
        task('p1', TaskStatus.DONE, { number: 5, title: 'Parent' }),
        task('c1', TaskStatus.DONE, {
          number: 6,
          title: 'Child',
          parentId: 'p1',
        }),
      ],
      links: [
        { title: 'Add Stripe', url: 'https://github.com/o/r/pull/9' },
        { title: 'Add Stripe', url: 'https://github.com/o/r/pull/9' },
        { title: 'Fix login', url: 'https://github.com/o/r/pull/10' },
      ],
    });
    const r = await t.service.releaseNotes('w1', 'm1', 'u1');
    expect(r.tasks.map((x) => x.number).sort((a, b) => a - b)).toEqual([6, 12]);
    expect(r.prs).toHaveLength(2);
    expect(r.markdown).toContain('# Checkout v2 beta');
    expect(r.markdown).toContain('Target: 2026-11-30');
    expect(r.markdown).toContain('- #12 Fix login');
    expect(r.markdown).not.toContain('Parent');
    expect(r.markdown).toContain('[Add Stripe](https://github.com/o/r/pull/9)');
  });

  it('looks for merged PRs only', async () => {
    const t = setup({ tasks: [task('t1', TaskStatus.DONE)] });
    await t.service.releaseNotes('w1', 'm1', 'u1');
    expect(
      t.prisma.externalLink.findMany.mock.calls[0]![0].where,
    ).toMatchObject({ kind: 'PR', state: 'merged' });
  });

  it('refuses a cycle', async () => {
    await expect(
      setup({
        it: milestone({ kind: IterationKind.CYCLE }),
      }).service.releaseNotes('w1', 'm1', 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MilestoneService criteria', () => {
  it('adds a plain criterion at the end, trimmed, under a share lock', async () => {
    const t = setup({ maxPosition: 4 });
    await t.service.addCriterion('w1', 'm1', { title: '  Docs published  ' });
    expect(
      t.prisma.milestoneCriterion.create.mock.calls[0]![0].data,
    ).toMatchObject({
      iterationId: 'm1',
      title: 'Docs published',
      taskId: null,
      position: 5,
    });
    expect(t.prisma.$queryRaw).toHaveBeenCalled();
  });

  it('the first criterion is at position 0', async () => {
    const t = setup({ maxPosition: null });
    await t.service.addCriterion('w1', 'm1', { title: 'x' });
    expect(
      t.prisma.milestoneCriterion.create.mock.calls[0]![0].data.position,
    ).toBe(0);
  });

  it('tied to a task it takes the task title when none is given', async () => {
    const t = setup({ lookupTask: { title: 'Ship payments' } });
    await t.service.addCriterion('w1', 'm1', { taskId: 't1' });
    expect(
      t.prisma.milestoneCriterion.create.mock.calls[0]![0].data,
    ).toMatchObject({ title: 'Ship payments', taskId: 't1' });
  });

  it('looks the task up in the same workspace only', async () => {
    const t = setup();
    await t.service.addCriterion('w1', 'm1', { taskId: 't1' });
    expect(t.prisma.task.findFirst.mock.calls[0]![0].where).toEqual({
      id: 't1',
      workspaceId: 'w1',
    });
  });

  it('refuses an unknown task, a task already used, no title and no task, a full milestone', async () => {
    await expect(
      setup({ lookupTask: null }).service.addCriterion('w1', 'm1', {
        taskId: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ dupCriterion: { id: 'c' } }).service.addCriterion('w1', 'm1', {
        taskId: 't1',
      }),
    ).rejects.toMatchObject({
      response: { code: 'CRITERION_EXISTS' },
    });
    await expect(
      setup().service.addCriterion('w1', 'm1', { title: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup().service.addCriterion('w1', 'm1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup({ criterionCount: 50 }).service.addCriterion('w1', 'm1', {
        title: 'x',
      }),
    ).rejects.toMatchObject({
      response: { code: 'TOO_MANY_CRITERIA' },
    });
  });

  it('cannot change a closed milestone, or a sprint', async () => {
    await expect(
      setup({ it: milestone({ state: S.CLOSED }) }).service.addCriterion(
        'w1',
        'm1',
        { title: 'x' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      setup({
        it: milestone({ kind: IterationKind.SPRINT }),
      }).service.addCriterion('w1', 'm1', { title: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks and unchecks a plain criterion', async () => {
    const t = setup({ found: critRow('c1') });
    await t.service.updateCriterion('w1', 'm1', 'c1', { done: true });
    expect(
      t.prisma.milestoneCriterion.update.mock.calls[0]![0].data.doneAt,
    ).toBeInstanceOf(Date);
    await t.service.updateCriterion('w1', 'm1', 'c1', { done: false });
    expect(
      t.prisma.milestoneCriterion.update.mock.calls[1]![0].data.doneAt,
    ).toBeNull();
  });

  it('a criterion tied to a task follows the task: it cannot be checked by hand', async () => {
    const t = setup({ found: critRow('c1', { taskId: 't1' }) });
    await expect(
      t.service.updateCriterion('w1', 'm1', 'c1', { done: true }),
    ).rejects.toMatchObject({
      response: { code: 'CRITERION_FOLLOWS_TASK' },
    });
    expect(t.prisma.milestoneCriterion.update).not.toHaveBeenCalled();
  });

  it('renames, refusing an empty name, and 404s an unknown criterion', async () => {
    const t = setup({ found: critRow('c1') });
    await t.service.updateCriterion('w1', 'm1', 'c1', { title: ' New ' });
    expect(
      t.prisma.milestoneCriterion.update.mock.calls[0]![0].data.title,
    ).toBe('New');
    await expect(
      t.service.updateCriterion('w1', 'm1', 'c1', { title: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup({ found: null }).service.updateCriterion('w1', 'm1', 'zz', {
        done: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a criterion of this milestone only, and 404s when there was none', async () => {
    const t = setup({ deleted: 1 });
    await t.service.removeCriterion('w1', 'm1', 'c1');
    expect(
      t.prisma.milestoneCriterion.deleteMany.mock.calls[0]![0].where,
    ).toEqual({ id: 'c1', iterationId: 'm1' });
    await expect(
      setup({ deleted: 0 }).service.removeCriterion('w1', 'm1', 'c1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
