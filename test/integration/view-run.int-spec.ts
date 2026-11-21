/**
 * Step 5.11 on a real database: running saved views.
 *
 * THE key test: ~200 varied tasks, and every condition and operator the SQL pre-filter translates must
 * return EXACTLY the tasks the in-memory evaluator (`evaluateCondition`, the one definition of a
 * condition) returns. Then the service on top: the caller's visibility, `ME`, paging, the scan limit,
 * archived tasks, and conditions the database cannot narrow (custom fields, title).
 */
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Priority,
  Prisma,
  Role,
  SavedViewLayout,
  TaskStatus,
} from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import type { Condition } from '../../src/automations/dsl/rule.types';
import { WorkspaceContextLoader } from '../../src/automations/dsl/workspace-context.loader';
import {
  evaluateCondition,
  evaluateConditions,
} from '../../src/automations/engine/conditions-eval';
import {
  SNAPSHOT_SELECT,
  toSnapshot,
} from '../../src/automations/task-snapshot';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TaskQueryService } from '../../src/views/run/task-query.service';
import {
  conditionToWhere,
  conditionsToWhere,
} from '../../src/views/run/task-where';
import { viewFilters } from '../../src/views/run/view-filters';
import { ViewsService } from '../../src/views/views.service';
import {
  addAccountMember,
  addProjectMember,
  createAccount,
  createProject,
  createTask,
  createUser,
  createWorkspace,
} from './factories';
import {
  disconnectTestPrisma,
  getTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

jest.setTimeout(240_000);

const NOW = new Date('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

/** a tiny seeded PRNG so the dataset is the same on every run */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('Running saved views (step 5.11)', () => {
  let prisma: PrismaService;
  let query: TaskQueryService;
  let views: ViewsService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        PlanLimitsService,
        PermissionResolver,
        WorkspaceContextLoader,
        TaskVisibilityService,
        TaskQueryService,
        ViewsService,
      ],
    }).compile();
    query = moduleRef.get(TaskQueryService);
    views = moduleRef.get(ViewsService);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const account = await createAccount(prisma, {});
    const mk = async (role: Role) => {
      const u = await createUser(prisma);
      await addAccountMember(prisma, {
        accountId: account.id,
        userId: u.id,
        role,
      });
      return u;
    };
    const owner = await mk(Role.OWNER);
    const member = await mk(Role.MEMBER);
    const other = await mk(Role.MEMBER);
    // a person with NO workspace-level access: only a seat in project 1
    const scoped = await createUser(prisma);
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const p1 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const p2 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    await addProjectMember(prisma, { projectId: p1.id, userId: scoped.id });
    const tag = (n: string) =>
      prisma.tag.create({ data: { workspaceId: ws.id, name: n, nameKey: n } });
    const [tagA, tagB, tagC] = [await tag('a'), await tag('b'), await tag('c')];
    const type = await prisma.issueType.create({
      data: {
        workspaceId: ws.id,
        name: 'bug',
        nameKey: 'bug',
        level: 'STANDARD',
      },
    });
    const iter = await prisma.iteration.create({
      data: {
        workspaceId: ws.id,
        name: 'Sprint 1',
        kind: 'SPRINT',
        startDate: new Date('2026-10-01'),
        endDate: new Date('2026-10-14'),
      } as never,
    });
    const field = await prisma.customField.create({
      data: {
        workspaceId: ws.id,
        key: 'score',
        name: 'score',
        dataType: 'NUMBER',
      },
    });
    return {
      account,
      owner,
      member,
      other,
      scoped,
      ws,
      p1,
      p2,
      tagA,
      tagB,
      tagC,
      type,
      iter,
      field,
    };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const TITLES = [
    'Fix login bug',
    'fix LOGIN bug',
    'Write docs 100%',
    'under_score name',
    'ÉCOLE de Paris',
    'plain',
    'Ship it',
    'Refactor % and _ chars',
  ];

  /** ~200 tasks, deliberately awkward: nulls, zero, boundaries, inbox, archived, subtasks, odd titles */
  async function seed(w: W, n = 200) {
    const r = rng(42);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const created: string[] = [];
    for (let i = 0; i < n; i++) {
      const project = pick([w.p1.id, w.p1.id, w.p2.id, null]);
      const status = pick(Object.values(TaskStatus));
      const t = await createTask(prisma, {
        workspaceId: w.ws.id,
        createdById: pick([w.owner.id, w.member.id]),
        ...(project ? { projectId: project } : {}),
        title: pick(TITLES),
        status,
        priority: pick([null, ...Object.values(Priority)]) as Priority | null,
        estimate: pick([null, 0, 1, 3, 5, 8]),
        dueDate: pick([
          null,
          at(-3),
          at(-1),
          at(0.5),
          at(1),
          at(2),
          at(5),
          at(30),
        ]),
        startDate: pick([null, at(-2), at(1)]),
        ...(r() < 0.2 && created.length > 0
          ? { parent: { connect: { id: pick(created) } } }
          : {}),
        ...(r() < 0.4 ? { issueType: { connect: { id: w.type.id } } } : {}),
        ...(r() < 0.4 ? { iteration: { connect: { id: w.iter.id } } } : {}),
        isArchived: r() < 0.08,
      });
      created.push(t.id);
      const tags = [w.tagA, w.tagB, w.tagC].filter(() => r() < 0.4);
      if (tags.length)
        await prisma.taskTag.createMany({
          data: tags.map((x) => ({ taskId: t.id, tagId: x.id })),
        });
      const assignees = [w.member, w.other].filter(() => r() < 0.4);
      if (assignees.length)
        await prisma.task.update({
          where: { id: t.id },
          data: {
            assignees: { connect: assignees.map((u) => ({ id: u.id })) },
          },
        });
      if (r() < 0.5)
        await prisma.taskCustomValue.create({
          data: {
            taskId: t.id,
            fieldId: w.field.id,
            value: pick([0, 2, 3, 7]),
          },
        });
    }
    return created;
  }

  /** every task of the workspace as the evaluator sees it */
  async function snapshots(w: W) {
    const rows = await prisma.task.findMany({
      where: { workspaceId: w.ws.id },
      orderBy: { id: 'asc' },
      select: { id: true, isArchived: true, ...SNAPSHOT_SELECT },
    });
    return rows.map((r) => ({
      id: r.id,
      archived: r.isArchived,
      snap: toSnapshot(r),
    }));
  }

  // ------------------------------------------------------------------ SQL === evaluator -----------
  it('every translatable condition returns exactly what the evaluator returns', async () => {
    const w = await world();
    await seed(w);
    const all = await snapshots(w);
    expect(all.length).toBe(200);
    const statusIds = (
      await prisma.workflowStatus.findMany({
        where: { projectId: w.p1.id },
        take: 2,
        orderBy: { id: 'asc' },
      })
    ).map((s) => s.id);
    const env = { now: NOW, viewerId: w.member.id };
    const ctx = { now: NOW, actorId: w.member.id, viewerId: w.member.id };

    const C = (field: string, op: string, value?: unknown): Condition =>
      ({ field, op, ...(value === undefined ? {} : { value }) }) as Condition;
    const table: Condition[] = [
      C('STATUS_CATEGORY', 'IN', ['TODO']),
      C('STATUS_CATEGORY', 'IN', ['TODO', 'DONE']),
      C('STATUS_CATEGORY', 'IN', []),
      C('STATUS_CATEGORY', 'NOT_IN', ['DONE']),
      C('STATUS_CATEGORY', 'NOT_IN', []),
      C('STATUS', 'IN', statusIds),
      C('STATUS', 'NOT_IN', statusIds),
      C('STATUS', 'IN', []),
      C('STATUS', 'NOT_IN', []),
      C('PRIORITY', 'IS_SET'),
      C('PRIORITY', 'IS_NOT_SET'),
      C('PRIORITY', 'IN', ['HIGH', 'URGENT']),
      C('PRIORITY', 'IN', []),
      C('PRIORITY', 'NOT_IN', ['LOW']),
      C('PRIORITY', 'NOT_IN', []),
      C('ISSUE_TYPE', 'IS_SET'),
      C('ISSUE_TYPE', 'IS_NOT_SET'),
      C('ISSUE_TYPE', 'IN', [w.type.id]),
      C('ISSUE_TYPE', 'NOT_IN', [w.type.id]),
      C('ITERATION', 'IS_SET'),
      C('ITERATION', 'IS_NOT_SET'),
      C('ITERATION', 'IN', [w.iter.id]),
      C('ITERATION', 'NOT_IN', [w.iter.id]),
      C('PROJECT', 'IN', [w.p1.id]),
      C('PROJECT', 'IN', [w.p1.id, w.p2.id]),
      C('PROJECT', 'IN', []),
      C('PROJECT', 'NOT_IN', [w.p1.id]),
      C('PROJECT', 'NOT_IN', []),
      C('ASSIGNEES', 'IS_EMPTY'),
      C('ASSIGNEES', 'IS_NOT_EMPTY'),
      C('ASSIGNEES', 'INCLUDES_ANY', [w.member.id]),
      C('ASSIGNEES', 'INCLUDES_ANY', [w.member.id, w.other.id]),
      C('ASSIGNEES', 'INCLUDES_ANY', ['ME']),
      C('ASSIGNEES', 'INCLUDES_ANY', []),
      C('ASSIGNEES', 'INCLUDES_NONE', [w.member.id]),
      C('ASSIGNEES', 'INCLUDES_NONE', ['ME']),
      C('ASSIGNEES', 'INCLUDES_NONE', []),
      C('TAGS', 'HAS_ANY', [w.tagA.id]),
      C('TAGS', 'HAS_ANY', [w.tagA.id, w.tagB.id]),
      C('TAGS', 'HAS_ANY', []),
      C('TAGS', 'HAS_ALL', [w.tagA.id, w.tagB.id]),
      C('TAGS', 'HAS_ALL', [w.tagA.id]),
      C('TAGS', 'HAS_ALL', []),
      C('TAGS', 'HAS_NONE', [w.tagA.id]),
      C('TAGS', 'HAS_NONE', []),
      C('ESTIMATE', 'IS_SET'),
      C('ESTIMATE', 'IS_NOT_SET'),
      C('ESTIMATE', 'EQ', 3),
      C('ESTIMATE', 'EQ', 0),
      C('ESTIMATE', 'NE', 3),
      C('ESTIMATE', 'GT', 3),
      C('ESTIMATE', 'GTE', 3),
      C('ESTIMATE', 'LT', 3),
      C('ESTIMATE', 'LTE', 3),
      C('ESTIMATE', 'EQ', 'x'),
      C('ESTIMATE', 'NE', 'x'),
      C('IS_SUBTASK', 'IS_TRUE'),
      C('IS_SUBTASK', 'IS_FALSE'),
      C('START_DATE', 'IS_SET'),
      C('START_DATE', 'IS_NOT_SET'),
      C('DUE_DATE', 'IS_SET'),
      C('DUE_DATE', 'IS_NOT_SET'),
      C('DUE_DATE', 'IS_OVERDUE'),
      C('DUE_DATE', 'IS_NOT_OVERDUE'),
      C('DUE_DATE', 'DUE_WITHIN_DAYS', 0),
      C('DUE_DATE', 'DUE_WITHIN_DAYS', 2),
      C('DUE_DATE', 'DUE_WITHIN_DAYS', 7),
      C('CREATED_BY', 'IN', [w.owner.id]),
      C('CREATED_BY', 'IN', ['ME']),
      C('CREATED_BY', 'NOT_IN', [w.owner.id]),
      C('CREATED_BY', 'NOT_IN', ['ME']),
      C('CREATED_BY', 'IN', []),
    ];

    let varied = 0;
    for (const c of table) {
      const where = conditionToWhere(c, env);
      expect(where).not.toBeNull();
      const sql = (
        await prisma.task.findMany({
          where: {
            AND: [{ workspaceId: w.ws.id }, where as Prisma.TaskWhereInput],
          },
          select: { id: true },
        })
      )
        .map((t) => t.id)
        .sort();
      const mem = all
        .filter((t) => evaluateCondition(c, t.snap, ctx))
        .map((t) => t.id)
        .sort();
      expect({ c, ids: sql }).toEqual({ c, ids: mem });
      if (mem.length > 0 && mem.length < all.length) varied++;
    }
    // the dataset must actually tell the conditions apart, or equality proves nothing
    expect(varied).toBeGreaterThanOrEqual(Math.floor(table.length * 0.75));
  });

  it('leaves what it cannot translate exactly to the evaluator (custom fields, title)', () => {
    const env = { now: NOW, viewerId: 'u' };
    expect(
      conditionToWhere(
        { field: 'CUSTOM', op: 'GT', value: 3, customFieldId: 'f' },
        env,
      ),
    ).toBeNull();
    expect(
      conditionToWhere({ field: 'TITLE', op: 'CONTAINS', value: 'x' }, env),
    ).toBeNull();
    expect(
      conditionToWhere({ field: 'NOPE', op: 'IN', value: [] } as never, env),
    ).toBeNull();
    // an OR with one arm it cannot translate narrows nothing; an AND still narrows by the arms it can
    expect(
      conditionsToWhere(
        {
          any: [
            { field: 'PRIORITY', op: 'IS_SET' },
            { field: 'TITLE', op: 'CONTAINS', value: 'x' },
          ],
        },
        env,
      ),
    ).toEqual({});
    expect(
      conditionsToWhere(
        {
          all: [
            { field: 'PRIORITY', op: 'IS_SET' },
            { field: 'TITLE', op: 'CONTAINS', value: 'x' },
          ],
        },
        env,
      ),
    ).toEqual({ AND: [{ priority: { not: null } }] });
  });

  // ------------------------------------------------------------------ the service ----------------
  const ids = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id);

  async function expected(
    w: W,
    userId: string,
    filters: Parameters<typeof evaluateConditions>[0],
    projectIds?: string[],
  ) {
    const ctx = { now: NOW, actorId: userId, viewerId: userId };
    return (await snapshots(w))
      .filter((t) => !t.archived)
      .filter((t) =>
        projectIds
          ? t.snap.projectId !== null && projectIds.includes(t.snap.projectId)
          : true,
      )
      .filter((t) => evaluateConditions(filters, t.snap, ctx))
      .map((t) => t.id);
  }

  async function everyPage(input: Parameters<TaskQueryService['run']>[0]) {
    const out: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 500; guard++) {
      const page = await query.run({ ...input, cursor, now: NOW });
      out.push(...ids(page));
      if (page.nextCursor === null) return out;
      cursor = page.nextCursor;
    }
    throw new Error('paging never ended');
  }

  const FILTERS = [
    {},
    { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH', 'URGENT'] }] },
    {
      all: [
        { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] },
        { field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] },
      ],
    },
    {
      any: [
        { field: 'ESTIMATE', op: 'GT', value: 3 },
        { field: 'DUE_DATE', op: 'IS_OVERDUE' },
      ],
    },
    // not narrowable by the database: the evaluator alone decides
    { all: [{ field: 'TITLE', op: 'CONTAINS', value: 'fix login' }] },
    {
      all: [
        { field: 'CUSTOM', op: 'GT', value: 2, customFieldId: '__FIELD__' },
      ],
    },
    {
      any: [
        { field: 'TITLE', op: 'CONTAINS', value: '%' },
        { field: 'TAGS', op: 'HAS_ANY', value: ['__TAG__'] },
      ],
    },
    { all: [{ field: 'TITLE', op: 'CONTAINS', value: 'école' }] },
  ] as Array<Record<string, unknown>>;
  const fill = (f: Record<string, unknown>, w: W) =>
    JSON.parse(
      JSON.stringify(f)
        .replace('__FIELD__', w.field.id)
        .replace('__TAG__', w.tagB.id),
    );

  it('returns exactly what the evaluator says, for a workspace-level user, across pages', async () => {
    const w = await world();
    await seed(w);
    for (const raw of FILTERS) {
      const filters = fill(raw, w);
      const got = await everyPage({
        workspaceId: w.ws.id,
        userId: w.member.id,
        filters,
        limit: 17,
      });
      expect({ filters, got }).toEqual({
        filters,
        got: await expected(w, w.member.id, filters),
      });
    }
  });

  it('shows a person with only a seat in one project that project alone (no inbox, no other project)', async () => {
    const w = await world();
    await seed(w);
    const got = await everyPage({
      workspaceId: w.ws.id,
      userId: w.scoped.id,
      filters: {},
    });
    expect(got.length).toBeGreaterThan(10);
    expect(got).toEqual(await expected(w, w.scoped.id, {}, [w.p1.id]));
    // and asking for the project they are not in is refused, not an empty list
    await expect(
      query.run({
        workspaceId: w.ws.id,
        userId: w.scoped.id,
        projectId: w.p2.id,
        now: NOW,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('never returns an archived task', async () => {
    const w = await world();
    await seed(w);
    const archived = (await snapshots(w))
      .filter((t) => t.archived)
      .map((t) => t.id);
    expect(archived.length).toBeGreaterThan(3);
    const got = await everyPage({ workspaceId: w.ws.id, userId: w.owner.id });
    for (const id of archived) expect(got).not.toContain(id);
  });

  it('`ME` is whoever runs it', async () => {
    const w = await world();
    await seed(w);
    const filters = {
      all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
    } as never;
    const mine = await everyPage({
      workspaceId: w.ws.id,
      userId: w.member.id,
      filters,
    });
    const theirs = await everyPage({
      workspaceId: w.ws.id,
      userId: w.other.id,
      filters,
    });
    expect(mine.length).toBeGreaterThan(5);
    expect(theirs.length).toBeGreaterThan(5);
    expect(mine).not.toEqual(theirs);
    expect(mine).toEqual(await expected(w, w.member.id, filters));
  });

  it('pages without gaps or repeats, in id order, and says whether there is more', async () => {
    const w = await world();
    await seed(w);
    const first = await query.run({
      workspaceId: w.ws.id,
      userId: w.owner.id,
      limit: 25,
      now: NOW,
    });
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBe(first.items[24].id);
    const all = await everyPage({
      workspaceId: w.ws.id,
      userId: w.owner.id,
      limit: 25,
    });
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([...all].sort());
    // the page size is capped (default 100), so asking for 500 gives 100 and a next page
    const capped = await query.run({
      workspaceId: w.ws.id,
      userId: w.owner.id,
      limit: 500,
      now: NOW,
    });
    expect(capped.items).toHaveLength(100);
    expect(capped.nextCursor).not.toBeNull();
    // with the cap raised, everything fits on one page and there is no cursor
    const before = process.env.VIEW_RUN_MAX_PAGE;
    process.env.VIEW_RUN_MAX_PAGE = '500';
    try {
      const last = await query.run({
        workspaceId: w.ws.id,
        userId: w.owner.id,
        limit: 500,
        now: NOW,
      });
      expect(last.nextCursor).toBeNull();
      expect(last.items.length).toBe(all.length);
    } finally {
      before === undefined
        ? delete process.env.VIEW_RUN_MAX_PAGE
        : (process.env.VIEW_RUN_MAX_PAGE = before);
    }
  });

  it('stops at the scan limit, says so, and a client that follows the cursor still gets everything', async () => {
    const w = await world();
    await seed(w);
    const before = process.env.VIEW_RUN_MAX_SCAN;
    process.env.VIEW_RUN_MAX_SCAN = '30';
    try {
      // a filter only the evaluator can apply, so the database narrows nothing
      const filters = {
        all: [{ field: 'TITLE', op: 'CONTAINS', value: 'plain' }],
      } as never;
      const page = await query.run({
        workspaceId: w.ws.id,
        userId: w.owner.id,
        filters,
        limit: 100,
        now: NOW,
      });
      expect(page.scanned).toBe(30);
      expect(page.capped).toBe(true);
      expect(page.nextCursor).not.toBeNull();
      const got = await everyPage({
        workspaceId: w.ws.id,
        userId: w.owner.id,
        filters,
        limit: 100,
      });
      expect(got).toEqual(await expected(w, w.owner.id, filters));
    } finally {
      before === undefined
        ? delete process.env.VIEW_RUN_MAX_SCAN
        : (process.env.VIEW_RUN_MAX_SCAN = before);
    }
  });

  it('caps the page size at the configured maximum', async () => {
    const w = await world();
    await seed(w, 60);
    const before = process.env.VIEW_RUN_MAX_PAGE;
    process.env.VIEW_RUN_MAX_PAGE = '7';
    try {
      const page = await query.run({
        workspaceId: w.ws.id,
        userId: w.owner.id,
        limit: 1000,
        now: NOW,
      });
      expect(page.items).toHaveLength(7);
    } finally {
      before === undefined
        ? delete process.env.VIEW_RUN_MAX_PAGE
        : (process.env.VIEW_RUN_MAX_PAGE = before);
    }
  });

  // ------------------------------------------------------------------ through a saved view -------
  describe('a saved view', () => {
    const mkView = (
      w: W,
      userId: string,
      config: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) =>
      views.create(w.ws.id, userId, {
        name: `v${Math.random()}`,
        layout: SavedViewLayout.LIST,
        isShared: true,
        config,
        ...extra,
      } as never);

    it('runs its filters, hideCompleted and showSubtasks:false for the caller', async () => {
      const w = await world();
      await seed(w);
      const v = await mkView(w, w.owner.id, {
        filters: {
          all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
        },
        hideCompleted: true,
        showSubtasks: false,
      });
      const filters = viewFilters({
        filters: {
          all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
        },
        hideCompleted: true,
        showSubtasks: false,
      });
      const got = await views.run(w.ws.id, v.id, w.member.id, {});
      const everything: string[] = [...ids(got)];
      let cursor = got.nextCursor;
      while (cursor) {
        const next = await views.run(w.ws.id, v.id, w.member.id, { cursor });
        everything.push(...ids(next));
        cursor = next.nextCursor;
      }
      expect(everything).toEqual(await expected(w, w.member.id, filters));
      const snaps = await snapshots(w);
      for (const id of everything) {
        const s = snaps.find((x) => x.id === id)!.snap;
        expect(s.status).not.toBe('DONE');
        expect(s.parentId).toBeNull();
        expect(s.assigneeIds).toContain(w.member.id);
      }
    });

    it('is per caller: the same shared view shows each person their own `ME`', async () => {
      const w = await world();
      await seed(w);
      const v = await mkView(w, w.owner.id, {
        filters: {
          all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
        },
      });
      const a = await views.run(w.ws.id, v.id, w.member.id, { limit: 500 });
      const b = await views.run(w.ws.id, v.id, w.other.id, { limit: 500 });
      expect(ids(a)).not.toEqual(ids(b));
    });

    it("another person's personal view is not there (404), as with reading it", async () => {
      const w = await world();
      const v = await mkView(w, w.member.id, {}, { isShared: false });
      await expect(views.run(w.ws.id, v.id, w.other.id, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('a view that names something deleted answers 422 with the issues, not a wrong list', async () => {
      const w = await world();
      await seed(w, 20);
      const v = await mkView(w, w.owner.id, {
        filters: {
          all: [{ field: 'TAGS', op: 'HAS_ANY', value: [w.tagA.id] }],
        },
      });
      await prisma.tag.delete({ where: { id: w.tagA.id } });
      await expect(views.run(w.ws.id, v.id, w.owner.id, {})).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('previews an unsaved config, and refuses an invalid one', async () => {
      const w = await world();
      await seed(w, 40);
      const ok = await views.runConfig(
        w.ws.id,
        w.owner.id,
        SavedViewLayout.LIST,
        null,
        {
          filters: { all: [{ field: 'PRIORITY', op: 'IS_SET' }] },
        },
        { limit: 500 },
      );
      expect(ok.items.length).toBeGreaterThan(0);
      await expect(
        views.runConfig(
          w.ws.id,
          w.owner.id,
          SavedViewLayout.LIST,
          null,
          {
            filters: { all: [{ field: 'PRIORITY', op: 'GT', value: 1 }] },
          },
          {},
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('a view scoped to one project shows only that project', async () => {
      const w = await world();
      await seed(w);
      const v = await mkView(w, w.owner.id, {}, { projectId: w.p2.id });
      const got = await views.run(w.ws.id, v.id, w.owner.id, { limit: 500 });
      const snaps = await snapshots(w);
      expect(got.items.length).toBeGreaterThan(5);
      for (const id of ids(got))
        expect(snaps.find((s) => s.id === id)!.snap.projectId).toBe(w.p2.id);
    });
  });
});
