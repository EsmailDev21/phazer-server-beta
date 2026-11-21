/**
 * Step 0.7 / ADR-0003. Real ActivityService, TasksService, PlanLimitsService
 * and DomainWriter over an in-memory Prisma double whose $transaction has real
 * commit/rollback semantics (snapshot, restore on throw). What this proves is
 * OUR logic: what is written, what is emitted and when. It cannot prove
 * Prisma-engine behaviour (createManyAndReturn, explicit updatedAt on create)
 * - those are listed in PROGRESS.md as still needing a real engine.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { AuditLogService } from '../events/audit-log.service';
import { ActivityService } from '../events/activity.service';
import { PlanLimitsService } from '../access-control/plan-limits.service';
import { TasksService } from '../projects-tasks/tasks/tasks.service';
import { ProjectsService } from '../projects-tasks/projects/projects.service';
import { CustomFieldsService } from '../projects-tasks/custom-fields/custom-fields.service';
import { PlanLimitExceededException } from '../common/exceptions/plan-limit-exceeded.exception';
import { BulkWriteError, DomainWriter } from './domain-writer.service';
import { WriteContext, assertWriteContext } from './write-context';

type Row = Record<string, any>;

function makeDb(opts: { planType?: string; existingTasks?: number } = {}) {
  const t = {
    workspaces: [{ id: 'w1', accountId: 'a1', nextTaskNumber: 1 }] as Row[],
    projects: [
      { id: 'p1', workspaceId: 'w1' },
      { id: 'p2', workspaceId: 'w1' },
      { id: 'other', workspaceId: 'w2' },
    ] as Row[],
    users: [{ id: 'u1' }, { id: 'u2' }] as Row[],
    tasks: [] as Row[],
    activities: [] as Row[],
    audit: [] as Row[],
  };
  for (let i = 0; i < (opts.existingTasks ?? 0); i++) {
    t.tasks.push({ id: `old${i}`, projectId: 'p1', isArchived: false });
  }
  let seq = 0;
  const failOn = { activityCreateMany: false };
  const client: any = {
    account: {
      findUnique: async () => ({
        type: 'PERSONAL',
        planType: opts.planType ?? 'FREE_PERSONAL',
      }),
    },
    workspace: {
      findUnique: async ({ where }: any) =>
        t.workspaces.find((w) => w.id === where.id) ?? null,
      // Prisma's `increment` = one atomic UPDATE ... RETURNING (ADR-0004).
      update: async ({ where, data }: any) => {
        const w = t.workspaces.find((x) => x.id === where.id)!;
        w.nextTaskNumber += data.nextTaskNumber.increment;
        return { nextTaskNumber: w.nextTaskNumber };
      },
    },
    project: {
      findUnique: async ({ where }: any) =>
        t.projects.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        t.projects.filter(
          (p) =>
            where.id.in.includes(p.id) && p.workspaceId === where.workspaceId,
        ),
    },
    user: {
      findMany: async ({ where }: any) =>
        t.users.filter((u) => where.id.in.includes(u.id)),
    },
    task: {
      count: async ({ where }: any) =>
        t.tasks.filter((x) => x.projectId === where.projectId && !x.isArchived)
          .length,
      create: async ({ data }: any) => {
        const { assignees, ...rest } = data;
        const row = {
          id: `t${++seq}`,
          isArchived: false,
          createdAt: new Date(),
          ...rest,
          assigneeIds: assignees?.connect?.map((a: any) => a.id) ?? [],
        };
        t.tasks.push(row);
        return row;
      },
      createManyAndReturn: async ({ data }: any) => {
        const rows = data.map((d: any) => ({
          isArchived: false,
          createdAt: new Date(),
          ...d,
        }));
        t.tasks.push(...rows);
        return [...rows].reverse(); // order deliberately NOT the input order
      },
      update: async ({ where, data }: any) => {
        const row = t.tasks.find((x) => x.id === where.id)!;
        row.assigneeIds = [
          ...(row.assigneeIds ?? []),
          ...data.assignees.connect.map((a: any) => a.id),
        ];
        return { id: row.id };
      },
    },
    activity: {
      create: async ({ data }: any) => {
        const row = { id: `act${++seq}`, ...data };
        t.activities.push(row);
        return row;
      },
      createMany: async ({ data }: any) => {
        if (failOn.activityCreateMany) throw new Error('boom');
        t.activities.push(
          ...data.map((d: any) => ({ id: `act${++seq}`, ...d })),
        );
        return { count: data.length };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        const row = { id: `aud${++seq}`, ...data };
        t.audit.push(row);
        return row;
      },
    },
  };
  let txCount = 0;
  const prisma: any = {
    ...client,
    $transaction: async (fn: any) => {
      txCount++;
      const snap = JSON.stringify(t);
      try {
        return await fn(client);
      } catch (e) {
        Object.assign(t, JSON.parse(snap)); // rollback
        throw e;
      }
    },
  };
  return { prisma, t, failOn, txCount: () => txCount };
}

function build(opts?: Parameters<typeof makeDb>[0]) {
  const db = makeDb(opts);
  const emitter = new EventEmitter2();
  const emitted: any[] = [];
  const audited: any[] = [];
  emitter.on('activity.created', (a) => emitted.push(a));
  emitter.on('auditlog.created', (a) => audited.push(a));
  const activity = new ActivityService(db.prisma, emitter);
  // The workflow rules have their own suites (workflow-rules.spec, int-specs);
  // here only the transaction/emit behaviour of the writer is under test.
  const workflow: any = {
    lockShared: async () => undefined,
    seedDefaults: async () => undefined,
    resolveForCreate: async (_tx: any, _p: any, req: any) => ({
      status: req.status ?? 'TODO',
      workflowStatusId: null,
    }),
    resolveForBulk: async (_tx: any, items: any[]) =>
      items.map((i) => ({
        status: i.status ?? 'TODO',
        workflowStatusId: null,
      })),
  };
  const planning: any = {
    lockIterations: async () => undefined,
    resolveForCreate: async () => ({ issueTypeId: null, iterationId: null }),
    resolveForBulk: async (_tx: any, _w: any, items: any[]) =>
      items.map(() => ({ issueTypeId: null, iterationId: null })),
  };
  const tasks = new TasksService(
    db.prisma,
    {} as any,
    activity,
    {} as any,
    workflow,
    planning,
  );
  const projects = new ProjectsService(
    db.prisma,
    {} as any,
    {} as any,
    activity,
    workflow,
  );
  const fields = new CustomFieldsService(db.prisma, {} as any);
  const limits = new PlanLimitsService(db.prisma);
  const writer = new DomainWriter(
    db.prisma,
    tasks,
    projects,
    fields,
    limits,
    new AuditLogService(db.prisma, emitter),
  );
  return { ...db, emitted, audited, activity, tasks, projects, limits, writer };
}

const ctx = (over: Partial<WriteContext> = {}): WriteContext => ({
  origin: 'INTEGRATION',
  actorId: 'u1',
  ...over,
});
const dto = (over: any = {}) => ({
  workspaceId: 'w1',
  projectId: 'p1',
  title: 'T',
  ...over,
});

describe('WriteContext invariants', () => {
  it('keepOriginalDates is refused for every origin except IMPORT', () => {
    for (const origin of [
      'MANUAL',
      'SNAP',
      'FOCUS',
      'TEMPLATE',
      'INTEGRATION',
    ]) {
      expect(() =>
        assertWriteContext({
          origin,
          actorId: null,
          keepOriginalDates: true,
        } as any),
      ).toThrow(BadRequestException);
    }
    expect(() =>
      assertWriteContext({
        origin: 'IMPORT',
        actorId: null,
        keepOriginalDates: true,
      }),
    ).not.toThrow();
  });
});

describe('default path (no context) is unchanged', () => {
  it('createdVia MANUAL, one CREATED activity, emitted immediately, TIMELINE', async () => {
    const s = build();
    const task = await s.tasks.create(dto(), 'u1');
    expect(task.createdVia).toBe('MANUAL');
    expect(s.t.activities).toHaveLength(1);
    expect(s.t.activities[0]).toMatchObject({
      actorId: 'u1',
      action: 'CREATED',
      visibility: 'TIMELINE',
      metadata: undefined,
    });
    expect(s.emitted).toHaveLength(1);
    // ADR-0004 (step 1.1): the counter bump and the insert share ONE short
    // transaction so a failed create cannot leave a gap. The activity row and
    // the event still follow the commit, exactly as before.
    expect(s.txCount()).toBe(1);
    expect(task.number).toBe(1);
  });

  it('numbers are sequential and a rolled-back create gives its number back (gapless)', async () => {
    const s = build();
    const a = await s.tasks.create(dto(), 'u1');
    const b = await s.tasks.create(dto(), 'u1');
    expect([a.number, b.number]).toEqual([1, 2]);
    // make the NEXT insert fail after the counter was bumped
    const realCreate = s.prisma.task.create;
    s.prisma.task.create = async () => {
      throw new Error('insert failed');
    };
    await expect(s.tasks.create(dto(), 'u1')).rejects.toThrow('insert failed');
    s.prisma.task.create = realCreate;
    expect(s.t.workspaces[0].nextTaskNumber).toBe(3); // unchanged by the failure
    expect((await s.tasks.create(dto(), 'u1')).number).toBe(3); // no hole at 3
  });
});

describe('ActivityService with a context', () => {
  it('silent: row written as SILENT with origin metadata, nothing emitted', async () => {
    const s = build();
    await s.tasks.create(dto(), 'u1', ctx({ silent: true, importJobId: 'j1' }));
    expect(s.t.activities[0]).toMatchObject({
      visibility: 'SILENT',
      metadata: { origin: 'INTEGRATION', importJobId: 'j1' },
    });
    expect(s.emitted).toHaveLength(0);
  });

  it('bulk implies silent', async () => {
    const s = build();
    await s.activity.recordMany(
      [
        {
          actorId: null,
          action: 'CREATED',
          targetType: 'TASK',
          targetId: 'x',
          workspaceId: 'w1',
        },
      ],
      ctx({ bulk: true }),
    );
    expect(s.t.activities[0].visibility).toBe('SILENT');
    expect(s.emitted).toHaveLength(0);
  });

  it('recordMany refuses a non-silent context', async () => {
    const s = build();
    await expect(s.activity.recordMany([], ctx())).rejects.toThrow(
      /silent\/bulk/,
    );
  });

  it('a tx without afterCommit is refused, never emitted inside the transaction', async () => {
    const s = build();
    await expect(
      s.tasks.create(dto(), 'u1', ctx({ tx: s.prisma })),
    ).rejects.toThrow(/afterCommit/);
    expect(s.emitted).toHaveLength(0);
  });
});

describe('DomainWriter single writes', () => {
  it('createdVia comes from ctx.origin; events fire only AFTER commit', async () => {
    const s = build();
    let emittedBeforeCommit = -1;
    const task = await s.writer.run(ctx(), async (c) => {
      const t = await s.tasks.create(dto(), 'u1', c);
      emittedBeforeCommit = s.emitted.length;
      return t;
    });
    expect(task.createdVia).toBe('INTEGRATION');
    expect(emittedBeforeCommit).toBe(0);
    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0].visibility).toBe('TIMELINE');
    expect(s.txCount()).toBe(1);
  });

  it('rollback emits nothing and leaves no rows', async () => {
    const s = build();
    await expect(
      s.writer.run(ctx(), async (c) => {
        await s.tasks.create(dto(), 'u1', c);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(s.emitted).toHaveLength(0);
    expect(s.t.tasks).toHaveLength(0);
    expect(s.t.activities).toHaveLength(0);
  });

  it('a throwing listener does not fail an already-committed write', async () => {
    const s = build();
    const res = await s.writer.run(ctx(), async (c) => {
      c.afterCommit!.push(() => {
        throw new Error('listener bug');
      });
      return s.tasks.create(dto(), 'u1', c);
    });
    expect(res.id).toBeDefined();
    expect(s.emitted).toHaveLength(1); // later callbacks still ran
  });

  it('original dates: honoured for IMPORT+keepOriginalDates, refused otherwise', async () => {
    const s = build();
    const when = new Date('2020-01-02T03:04:05Z');
    const ok = await s.writer.createTask(
      dto(),
      'u1',
      {
        origin: 'IMPORT',
        actorId: 'u1',
        keepOriginalDates: true,
        silent: true,
      },
      { createdAt: when, updatedAt: when },
    );
    expect(ok.createdAt).toEqual(when);
    await expect(
      s.writer.createTask(dto(), 'u1', ctx(), { createdAt: when }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      s.writer.createTask(
        dto(),
        'u1',
        { origin: 'IMPORT', actorId: 'u1', silent: true },
        { createdAt: when },
      ),
    ).rejects.toThrow(BadRequestException); // forgot keepOriginalDates: loud, not silently dropped
  });

  it('assignees: validated, connected, ASSIGNED activity per user', async () => {
    const s = build();
    const t = await s.writer.createTask(dto(), 'u1', ctx(), {
      assigneeIds: ['u2', 'u2'],
    });
    expect((t as any).assigneeIds).toEqual(['u2']);
    expect(s.t.activities.map((a) => a.action)).toEqual([
      'CREATED',
      'ASSIGNED',
    ]);
    await expect(
      s.writer.createTask(dto(), 'u1', ctx(), { assigneeIds: ['ghost'] }),
    ).rejects.toThrow(/ghost/);
  });

  it('projects use the same contract', async () => {
    const s = build();
    s.t.projects.length = 0;
    const silent = ctx({ silent: true });
    s.prisma.project.create = async ({ data }: any) => ({ id: 'np', ...data });
    s.prisma.project.findUniqueOrThrow = async () => ({ id: 'np' });
    const p = await s.writer.createProject(
      { workspaceId: 'w1', name: 'P' },
      'u1',
      silent,
    );
    expect(p.id).toBe('np');
    expect(s.t.activities[0]).toMatchObject({
      targetType: 'PROJECT',
      visibility: 'SILENT',
    });
    expect(s.emitted).toHaveLength(0);
  });
});

describe('DomainWriter.createTasksBulk', () => {
  const items = (n: number, projectId = 'p1') =>
    Array.from({ length: n }, (_, i) => ({ title: `T${i}`, projectId }));

  it('one transaction per chunk of 100; emits nothing; every row matched by id', async () => {
    const s = build({ planType: 'ENTERPRISE_ORG' });
    s.prisma.account.findUnique = async () => ({
      type: 'ORGANIZATION',
      planType: 'ENTERPRISE_ORG',
    });
    const withAssignee = items(250).map((i, n) =>
      n === 7 ? { ...i, assigneeIds: ['u2'] } : i,
    );
    const res = await s.writer.createTasksBulk(
      'w1',
      withAssignee,
      'u1',
      ctx({ origin: 'IMPORT', importJobId: 'job9' }),
    );
    expect(res.chunks).toBe(3);
    expect(s.txCount()).toBe(3);
    expect(res.createdIds).toHaveLength(250);
    expect(s.t.tasks).toHaveLength(250);
    expect(s.t.tasks.every((x) => x.createdVia === 'IMPORT')).toBe(true);
    expect(s.emitted).toHaveLength(0);
    expect(s.audited).toHaveLength(0);
    expect(s.t.activities).toHaveLength(251); // 250 CREATED + 1 ASSIGNED
    expect(
      s.t.activities.every(
        (a) => a.visibility === 'SILENT' && a.metadata.importJobId === 'job9',
      ),
    ).toBe(true);
    // createManyAndReturn handed rows back REVERSED; the assignee must still land on task #7
    const seventh = s.t.tasks.find((x) => x.title === 'T7')!;
    expect(seventh.assigneeIds).toEqual(['u2']);
    expect(new Set(s.t.tasks.map((x) => x.id)).size).toBe(250);
    expect(s.t.tasks[0].id).toMatch(/^c[0-9a-z]{24}$/);
  });

  it('cap exceeded fails that chunk with no partial writes, typed, never truncating', async () => {
    const s = build({ existingTasks: 40 }); // FREE_PERSONAL cap is 50
    const err: BulkWriteError = await s.writer
      .createTasksBulk('w1', items(30), 'u1', ctx({ origin: 'IMPORT' }), {
        chunkSize: 10,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BulkWriteError);
    expect(err.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(err.causeError).toBeInstanceOf(PlanLimitExceededException);
    expect(err.chunkIndex).toBe(1); // chunk 0 (10 tasks, exactly reaching 50) committed
    expect(err.createdIds).toHaveLength(10);
    expect(s.t.tasks.filter((x) => !x.id.startsWith('old'))).toHaveLength(10); // chunk 1 wrote nothing
  });

  it('Inbox tasks are never capped', async () => {
    const s = build({ existingTasks: 50 });
    const res = await s.writer.createTasksBulk(
      'w1',
      Array.from({ length: 5 }, (_, i) => ({ title: `i${i}` })),
      'u1',
      ctx({ origin: 'IMPORT' }),
    );
    expect(res.createdIds).toHaveLength(5);
  });

  it('a failure inside a chunk rolls the whole chunk back (history rows included)', async () => {
    const s = build({ planType: 'ENTERPRISE_ORG' });
    s.prisma.account.findUnique = async () => ({
      type: 'ORGANIZATION',
      planType: 'ENTERPRISE_ORG',
    });
    s.failOn.activityCreateMany = true;
    const err = await s.writer
      .createTasksBulk('w1', items(5), 'u1', ctx({ origin: 'IMPORT' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(BulkWriteError);
    expect(err.code).toBe('CHUNK_FAILED');
    expect(s.t.tasks).toHaveLength(0);
    expect(s.t.activities).toHaveLength(0);
  });

  it('re-running a chunk with filterChunk creates no duplicates', async () => {
    const s = build({ planType: 'ENTERPRISE_ORG' });
    s.prisma.account.findUnique = async () => ({
      type: 'ORGANIZATION',
      planType: 'ENTERPRISE_ORG',
    });
    const imported = new Set<string>();
    const filterChunk = async (_tx: any, chunk: any[]) =>
      chunk.filter((i) => !imported.has(i.title));
    const run = async () => {
      const r = await s.writer.createTasksBulk(
        'w1',
        items(5),
        'u1',
        ctx({ origin: 'IMPORT' }),
        { filterChunk },
      );
      s.t.tasks.forEach((x) => imported.add(x.title));
      return r;
    };
    expect((await run()).createdIds).toHaveLength(5);
    const second = await run();
    expect(second.createdIds).toHaveLength(0);
    expect(second.skipped).toBe(5);
    expect(s.t.tasks).toHaveLength(5);
  });

  it('rejects a project from another workspace; refuses a caller-supplied tx', async () => {
    const s = build({ planType: 'ENTERPRISE_ORG' });
    s.prisma.account.findUnique = async () => ({
      type: 'ORGANIZATION',
      planType: 'ENTERPRISE_ORG',
    });
    await expect(
      s.writer.createTasksBulk(
        'w1',
        items(1, 'other'),
        'u1',
        ctx({ origin: 'IMPORT' }),
      ),
    ).rejects.toThrow(/other/);
    await expect(
      s.writer.createTasksBulk(
        'w1',
        items(1),
        'u1',
        ctx({ tx: s.prisma, afterCommit: [] }),
      ),
    ).rejects.toThrow(/do not pass ctx.tx/);
  });

  it('the job summary IS emitted (one AuditLog, normal fan-out path)', async () => {
    const s = build();
    await s.writer.recordJobSummary({
      actorId: 'u1',
      accountId: 'a1',
      action: 'IMPORT_COMPLETED',
      metadata: { n: 250 },
    });
    expect(s.audited).toHaveLength(1);
    expect(s.audited[0].action).toBe('IMPORT_COMPLETED');
  });
});

describe('PlanLimitsService.checkLimit additional', () => {
  it('default (1) is exactly the old `count < limit`; additional=n is count+n <= limit', async () => {
    const s = build({ existingTasks: 49 });
    const c = { accountId: 'a1', workspaceId: 'w1', projectId: 'p1' };
    expect(await s.limits.checkLimit('task', 'createTask', c)).toBe(true); // 49 < 50
    expect(
      await s.limits.checkLimit('task', 'createTask', c, { additional: 1 }),
    ).toBe(true);
    expect(
      await s.limits.checkLimit('task', 'createTask', c, { additional: 2 }),
    ).toBe(false);
    const full = build({ existingTasks: 50 });
    expect(await full.limits.checkLimit('task', 'createTask', c)).toBe(false); // 50 < 50 is false: unchanged
    expect(
      await full.limits.checkLimit('task', 'createTask', c, { additional: 0 }),
    ).toBe(true);
    await expect(
      s.limits.checkLimit('task', 'createTask', c, { additional: -1 }),
    ).rejects.toThrow();
  });
});
