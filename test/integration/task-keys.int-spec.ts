/**
 * Step 1.1 (ADR-0004) on a real database: the gapless counter, workspace key
 * allocation, rename + aliases, the account-level race the advisory lock
 * exists for, and the by-key lookup's authorisation.
 */
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskKeyService } from '../../src/projects-tasks/tasks/task-key.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { createProject, createUser, createUserWithAccount } from './factories';

describe('task keys (real database)', () => {
  let prisma: PrismaService;
  let tasks: TasksService;
  let workspaces: WorkspacesService;
  let keys: WorkspaceKeysService;
  let byKey: TaskKeyService;
  let writer: DomainWriter;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        ActivityService,
        AuditLogService,
        PermissionResolver,
        PlanLimitsService,
        TaskVisibilityService,
        TasksService,
        TaskTreeService,
        WorkflowService,
        TaskPlanningService,
        ProjectsService,
        CustomFieldsService,
        WorkspaceKeysService,
        WorkspacesService,
        TaskKeyService,
        DomainWriter,
      ],
    }).compile();
    tasks = moduleRef.get(TasksService);
    workspaces = moduleRef.get(WorkspacesService);
    keys = moduleRef.get(WorkspaceKeysService);
    byKey = moduleRef.get(TaskKeyService);
    writer = moduleRef.get(DomainWriter);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function org() {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType: AccountType.ORGANIZATION,
    });
    return { user, account };
  }
  const mkWs = (accountId: string, name: string, key?: string) =>
    workspaces.create({ accountId, name, ...(key ? { key } : {}) });
  const mkTask = (workspaceId: string, createdById: string, title = 't') =>
    tasks.create({ workspaceId, title }, createdById);

  // ------------------------------------------------------------- counter
  describe('task numbers', () => {
    it('60 parallel creates in one workspace get exactly 1..60: unique and gapless', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      const created = await Promise.all(
        Array.from({ length: 60 }, (_, i) => mkTask(ws.id, user.id, `t${i}`)),
      );
      const nums = created.map((t) => t.number as number).sort((a, b) => a - b);
      expect(nums).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      expect(
        (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } }))
          .nextTaskNumber,
      ).toBe(61);
    });

    it('a create that fails AFTER taking its number gives the number back (no gap)', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      await mkTask(ws.id, user.id);
      await mkTask(ws.id, user.id);
      // createdById violates a foreign key at INSERT, after the counter was bumped
      await expect(
        tasks.create({ workspaceId: ws.id, title: 'bad' }, 'no-such-user'),
      ).rejects.toBeDefined();
      expect(
        (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } }))
          .nextTaskNumber,
      ).toBe(3);
      expect((await mkTask(ws.id, user.id)).number).toBe(3);
    });

    it('numbers are per workspace', async () => {
      const { user, account } = await org();
      const a = await mkWs(account.id, 'Alpha');
      const b = await mkWs(account.id, 'Beta');
      expect((await mkTask(a.id, user.id)).number).toBe(1);
      expect((await mkTask(a.id, user.id)).number).toBe(2);
      expect((await mkTask(b.id, user.id)).number).toBe(1);
    });

    it('a bulk chunk reserves a contiguous range and interleaves cleanly with live creates', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      const proj = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      const items = Array.from({ length: 25 }, (_, i) => ({
        title: `b${i}`,
        projectId: proj.id,
      }));
      await Promise.all([
        writer.createTasksBulk(
          ws.id,
          items,
          user.id,
          { origin: 'IMPORT', actorId: null },
          { chunkSize: 10 },
        ),
        ...Array.from({ length: 20 }, (_, i) =>
          mkTask(ws.id, user.id, `live${i}`),
        ),
      ]);
      const all = await prisma.task.findMany({
        where: { workspaceId: ws.id },
        select: { number: true, title: true },
      });
      expect(
        all.map((t) => t.number).sort((a, b) => (a as number) - (b as number)),
      ).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
      // within the bulk, items stay in input order inside each chunk's range
      const bulk = all
        .filter((t) => t.title!.startsWith('b'))
        .sort((x, y) => (x.number as number) - (y.number as number));
      const firstChunk = bulk
        .filter((t) => Number(t.title!.slice(1)) < 10)
        .map((t) => t.number as number);
      expect(
        firstChunk.every((n, i) => i === 0 || n === firstChunk[i - 1] + 1),
      ).toBe(true);
    });

    it('a rolled-back DomainWriter run returns its number', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      await expect(
        writer.run({ origin: 'INTEGRATION', actorId: user.id }, async (c) => {
          await tasks.create(
            { workspaceId: ws.id, title: 'ghost' },
            user.id,
            c,
          );
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect((await mkTask(ws.id, user.id)).number).toBe(1);
    });
  });

  // ---------------------------------------------------------- allocation
  describe('workspace key allocation', () => {
    it('generates ENG, ENG2, ENG3 for colliding names', async () => {
      const { account } = await org();
      expect((await mkWs(account.id, 'Engineering')).key).toBe('ENG');
      expect((await mkWs(account.id, 'Engineering')).key).toBe('ENG2');
      expect((await mkWs(account.id, 'Engine Room')).key).toBe('ENG3');
    });

    it('the same name in a different account gets the plain key again', async () => {
      const a = await org();
      const b = await org();
      expect((await mkWs(a.account.id, 'Engineering')).key).toBe('ENG');
      expect((await mkWs(b.account.id, 'Engineering')).key).toBe('ENG');
    });

    it('accepts an explicit key (any case), rejects a duplicate (409) and a malformed one (400)', async () => {
      const { account } = await org();
      expect((await mkWs(account.id, 'Platform', 'plat')).key).toBe('PLAT');
      await expect(mkWs(account.id, 'Other', 'PLAT')).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(mkWs(account.id, 'Other', 'P')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(mkWs(account.id, 'Other', '1AB')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('12 simultaneous creates with the same name all get distinct keys', async () => {
      const { account } = await org();
      const made = await Promise.all(
        Array.from({ length: 12 }, () => mkWs(account.id, 'Engineering')),
      );
      const ks = made.map((w) => w.key);
      expect(new Set(ks).size).toBe(12);
      expect(ks).toContain('ENG');
    });
  });

  // -------------------------------------------------------------- rename
  describe('rename and aliases', () => {
    it('after ENG -> PLAT both keys resolve, to the same workspace and task', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      const t = await mkTask(ws.id, user.id);
      await keys.rename(ws.id, 'plat', user.id);

      const viaOld = await keys.resolveTask(prisma, account.id, 'ENG-1');
      const viaNew = await keys.resolveTask(prisma, account.id, 'plat-1');
      expect(viaOld).toMatchObject({
        taskId: t.id,
        viaAlias: true,
        currentKey: 'PLAT',
      });
      expect(viaNew).toMatchObject({
        taskId: t.id,
        viaAlias: false,
        currentKey: 'PLAT',
      });
    });

    it('a retired key stays reserved: nobody else in the account can take it', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      await keys.rename(ws.id, 'PLAT', user.id);
      await expect(mkWs(account.id, 'Other', 'ENG')).rejects.toBeInstanceOf(
        ConflictException,
      );
      const other = await mkWs(account.id, 'Ops');
      await expect(
        keys.rename(other.id, 'ENG', user.id),
      ).rejects.toBeInstanceOf(ConflictException);
      // and a generated key skips it too
      expect((await mkWs(account.id, 'Engineering')).key).toBe('ENG2');
    });

    it("renaming back to the workspace's own retired key promotes it again", async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      await keys.rename(ws.id, 'PLAT', user.id);
      const back = await keys.rename(ws.id, 'ENG', user.id);
      expect(back.key).toBe('ENG');
      const aliases = (
        await prisma.workspaceKeyAlias.findMany({
          where: { workspaceId: ws.id },
        })
      ).map((a) => a.key);
      expect(aliases).toEqual(['PLAT']); // ENG is current again, so no longer an alias
    });

    it("cannot rename onto another workspace's current key; unknown workspace is 404", async () => {
      const { user, account } = await org();
      const a = await mkWs(account.id, 'Alpha');
      const b = await mkWs(account.id, 'Beta');
      await expect(keys.rename(a.id, b.key!, user.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(keys.rename('nope', 'ZZZ', user.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(keys.rename(a.id, 'x', user.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('records one audit entry per real change, none for a no-op', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      await keys.rename(ws.id, 'ENG', user.id); // already ENG
      expect(
        await prisma.auditLog.count({
          where: { action: 'WORKSPACE_KEY_CHANGED' },
        }),
      ).toBe(0);
      await keys.rename(ws.id, 'PLAT', user.id);
      const rows = await prisma.auditLog.findMany({
        where: { action: 'WORKSPACE_KEY_CHANGED' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({
        workspaceId: ws.id,
        from: 'ENG',
        to: 'PLAT',
      });
      expect(rows[0].actorId).toBe(user.id);
    });

    it('two renames into the SAME key: exactly one wins, the other is a clean 409 (never a 500)', async () => {
      const { user, account } = await org();
      const a = await mkWs(account.id, 'Alpha');
      const b = await mkWs(account.id, 'Beta');
      const res = await Promise.allSettled([
        keys.rename(a.id, 'SAME', user.id),
        keys.rename(b.id, 'SAME', user.id),
      ]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = res.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ConflictException);
    });

    // An INVARIANT check, not a proven detector: with the advisory lock
    // disabled this still passed in 120 attempts, so the straddle window it
    // probes (two queries bracketing another transaction's commit) could not be
    // provoked. The lock's necessity is demonstrated by the two same-key tests
    // above, which fail without it; this guards the stronger property that must
    // hold regardless.
    it('invariant under contention: a key A just retired is never also a current key (40 rounds, 1 rename vs 6 requests)', async () => {
      let violations = 0;
      let leaks = 0;
      for (let i = 0; i < 40; i++) {
        const { user, account } = await org();
        const a = await mkWs(account.id, 'Engineering'); // ENG
        const res = await Promise.allSettled([
          keys.rename(a.id, `NEW${i}`, user.id),
          ...Array.from({ length: 6 }, (_, n) =>
            mkWs(account.id, `Other${n}`, 'ENG'),
          ),
        ]);
        expect(res[0].status).toBe('fulfilled');
        leaks += res.slice(1).filter((r) => r.status === 'fulfilled').length;
        const current = (
          await prisma.workspace.findMany({ where: { accountId: account.id } })
        ).map((w) => w.key);
        const aliases = (
          await prisma.workspaceKeyAlias.findMany({
            where: { accountId: account.id },
          })
        ).map((x) => x.key);
        violations += current.filter((k) =>
          aliases.includes(k as string),
        ).length;
      }
      expect({ violations, leaks }).toEqual({ violations: 0, leaks: 0 });
    });
  });

  // -------------------------------------------------------------- by-key
  describe('GET by key (TaskKeyService)', () => {
    it('resolves case-insensitively and returns number + key; also via a retired key', async () => {
      const { user, account } = await org();
      const ws = await mkWs(account.id, 'Engineering');
      const t = await mkTask(ws.id, user.id, 'hello');
      const detail = await byKey.getByKey(account.id, 'eng-1', user.id);
      expect(detail).toMatchObject({
        id: t.id,
        number: 1,
        key: 'ENG-1',
        title: 'hello',
      });
      await keys.rename(ws.id, 'PLAT', user.id);
      expect(await byKey.getByKey(account.id, 'ENG-1', user.id)).toMatchObject({
        id: t.id,
        key: 'PLAT-1',
      });
    });

    it('404 - the SAME 404 - for: unknown key, unknown number, malformed key, wrong account, and a user with no access', async () => {
      const a = await org();
      const b = await org();
      const ws = await mkWs(a.account.id, 'Engineering');
      await mkTask(ws.id, a.user.id);
      const stranger = await createUser(prisma);
      const attempts: Array<Promise<unknown>> = [
        byKey.getByKey(a.account.id, 'NOPE-1', a.user.id), // no such key
        byKey.getByKey(a.account.id, 'ENG-999', a.user.id), // no such number
        byKey.getByKey(a.account.id, 'ENG', a.user.id), // malformed
        byKey.getByKey(a.account.id, 'ENG-1; DROP', a.user.id), // malformed
        byKey.getByKey(b.account.id, 'ENG-1', b.user.id), // key exists only in the OTHER account
        byKey.getByKey(a.account.id, 'ENG-1', stranger.id), // exists, but not theirs
        byKey.getByKey(a.account.id, 'ENG-1', b.user.id), // member of another account only
      ];
      for (const r of await Promise.allSettled(attempts)) {
        expect(r.status).toBe('rejected');
        const reason = (r as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(NotFoundException);
        expect(reason.message).toBe('Task not found');
      }
    });

    it('the same key in two accounts resolves to two different tasks', async () => {
      const a = await org();
      const b = await org();
      const wa = await mkWs(a.account.id, 'Engineering');
      const wb = await mkWs(b.account.id, 'Engineering');
      const ta = await mkTask(wa.id, a.user.id, 'A');
      const tb = await mkTask(wb.id, b.user.id, 'B');
      expect((await byKey.getByKey(a.account.id, 'ENG-1', a.user.id)).id).toBe(
        ta.id,
      );
      expect((await byKey.getByKey(b.account.id, 'ENG-1', b.user.id)).id).toBe(
        tb.id,
      );
    });
  });
});
