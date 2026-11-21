/**
 * Step 1.7 - list / progress / stats timings, BEFORE vs AFTER the step's index migration.
 *
 * PERF-GUARDED: skipped unless PERF=1. It needs the ~760k-row dataset from
 * scripts/perf-seed.sql loaded into the test database, and it does NOT reset the DB
 * (so never run it in the same jest invocation as the other int-specs: they truncate).
 *
 *   PERF=1 npx jest --config ./test/integration/jest-integration.json perf-list
 *
 * What it does: restore the pre-1.7 index set -> ANALYZE -> time every scenario through the REAL
 * services -> apply prisma/migrations/20260611000000_step_1_7_task_indexes/migration.sql ->
 * ANALYZE -> time again -> print a before/after table (also written to $PERF_OUT, default
 * /tmp/perf-1-7.json). Only ratios matter: the sandbox is small.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { IssueTypesService } from '../../src/projects-tasks/issue-types/issue-types.service';
import { IterationsService } from '../../src/projects-tasks/iterations/iterations.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';

const perf = process.env.PERF ? describe : describe.skip;
const RUNS = Number(process.env.PERF_RUNS ?? 40);
const WARMUP = 5;
const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260611000000_step_1_7_task_indexes/migration.sql',
);

/** The pre-1.7 index set on tasks (what the baseline + 1.1-1.6 left), so a re-run starts clean. */
const REVERT_SQL = [
  'DROP INDEX IF EXISTS idx_tasks_workspace_archived_created',
  'DROP INDEX IF EXISTS idx_tasks_project_archived_created',
  'DROP INDEX IF EXISTS idx_tasks_project_archived_status',
  'CREATE INDEX IF NOT EXISTS ix_tasks_workspace_id ON tasks(workspace_id)',
  'CREATE INDEX IF NOT EXISTS ix_tasks_project_id ON tasks(project_id)',
];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

perf('step 1.7 list performance (real services, seeded database)', () => {
  jest.setTimeout(30 * 60 * 1000);
  let prisma: PrismaService;
  let tasks: TasksService;
  let projects: ProjectsService;
  let iters: IterationsService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService,
        TaskVisibilityService, TasksService, TaskTreeService, WorkflowService,
        TaskPlanningService, IssueTypesService, IterationsService, ProjectsService,
        CustomFieldsService, WorkspaceKeysService, WorkspacesService, DomainWriter,
      ],
    }).compile();
    tasks = moduleRef.get(TasksService);
    projects = moduleRef.get(ProjectsService);
    iters = moduleRef.get(IterationsService);

    // u1 = full workspace access (AccountMember of the seed's account); u2 = project-scoped
    // only (ProjectMember of p_w1_1..10, no AccountMember row).
    await prisma.accountMember.upsert({
      where: { accountId_userId: { accountId: 'a1', userId: 'u1' } },
      create: { accountId: 'a1', userId: 'u1', role: 'OWNER' as never },
      update: {},
    });
    for (let i = 1; i <= 10; i++) {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: `p_w1_${i}`, userId: 'u2' } },
        create: { projectId: `p_w1_${i}`, userId: 'u2', role: 'MEMBER' as never },
        update: {},
      });
    }
  });
  afterAll(() => disconnectTestPrisma());

  const list = (u: string, q: Record<string, unknown>) =>
    tasks.list(u, { workspaceId: 'w1', take: 50, skip: 0, ...q } as never);

  const scenarios: Array<[string, () => Promise<unknown>]> = [
    ['A  workspace list, page 1', () => list('u1', {})],
    ['B  project list, page 1', () => list('u1', { projectId: 'p_w1_7' })],
    ['C  project + status=TODO', () => list('u1', { projectId: 'p_w1_7', status: 'TODO' })],
    ['D  project + rootsOnly', () => list('u1', { projectId: 'p_w1_7', rootsOnly: true })],
    ['E  children of one parent', () => list('u1', { parentId: 't_w1_100' })],
    ['F  workflowStatusId filter', () => list('u1', { workflowStatusId: 'wfs_p_w1_7_TODO' })],
    ['G  iterationId filter', () => list('u1', { iterationId: 'iter_w1_3' })],
    ['H  workspace list, skip 5000', () => list('u1', { skip: 5000 })],
    ['I  member-restricted user', () => list('u2', {})],
    ['K  computeProgress (1 project)', () => projects.computeProgress('p_w1_7')],
    ['L  getStats (1 project)', () => projects.getStats('p_w1_7', 'u1')],
    ['M  iteration detail', () => iters.get('w1', 'iter_w1_3', 'u1')],
    // the count half of every list call, on its own (what is left once the sort is fixed)
    ['N  count only, workspace', () => prisma.task.count({ where: { workspaceId: 'w1', isArchived: false } })],
    ['O  count only, project (plan limit)', () => prisma.task.count({ where: { projectId: 'p_w1_7', isArchived: false } })],
  ];

  async function measure(): Promise<Record<string, { p50: number; p95: number }>> {
    // VACUUM so the visibility map is current (index-only scans) and the 20k insert/delete
    // churn of insertCost() cannot leak into the timings; ANALYZE for fresh statistics.
    await prisma.$executeRawUnsafe('VACUUM (ANALYZE) tasks');
    const out: Record<string, { p50: number; p95: number }> = {};
    for (const [name, fn] of scenarios) {
      for (let i = 0; i < WARMUP; i++) await fn();
      const ms: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        await fn();
        ms.push(performance.now() - t0);
      }
      out[name] = { p50: pct(ms, 50), p95: pct(ms, 95) };
    }
    return out;
  }

  /** Bulk insert 20k tasks into w2 (numbers above the seed's) and delete them again. */
  async function insertCost(): Promise<number> {
    await prisma.$executeRawUnsafe(`DELETE FROM tasks WHERE workspace_id='w2' AND number > 100000`);
    const t0 = performance.now();
    await prisma.$executeRawUnsafe(`
      INSERT INTO tasks(id,workspace_id,project_id,number,title,status,priority,created_by_id,is_archived,created_at,updated_at,workflow_status_id)
      SELECT 'perf_ins_'||i,'w2','p_w2_1',100000+i,'x','TODO','MEDIUM','u1',false,now()-(random()*730||' days')::interval,now(),'wfs_p_w2_1_TODO'
      FROM generate_series(1,20000) i`);
    const ms = performance.now() - t0;
    await prisma.$executeRawUnsafe(`DELETE FROM tasks WHERE workspace_id='w2' AND number > 100000`);
    return ms;
  }

  it('before vs after the 1.7 indexes', async () => {
    for (const sql of REVERT_SQL) await prisma.$executeRawUnsafe(sql);
    const insertBefore = await insertCost();
    const before = await measure();

    // Same statements the migration runs, minus BEGIN/COMMIT (Prisma runs each call on its own).
    const migration = readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .replace(/\bBEGIN;|\bCOMMIT;/g, '');
    for (const stmt of migration.split(';').map((s) => s.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(stmt);
    }
    const insertAfter = await insertCost();
    const after = await measure();

    const rows = scenarios.map(([name]) => ({
      scenario: name,
      before_p50: +before[name].p50.toFixed(2), before_p95: +before[name].p95.toFixed(2),
      after_p50: +after[name].p50.toFixed(2), after_p95: +after[name].p95.toFixed(2),
      p95_speedup: +(before[name].p95 / after[name].p95).toFixed(1),
    }));
    const result = { runs: RUNS, rows, insert20k_ms: { before: Math.round(insertBefore), after: Math.round(insertAfter) } };
    writeFileSync(process.env.PERF_OUT ?? '/tmp/perf-1-7.json', JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.table(rows);
    // eslint-disable-next-line no-console
    console.log('bulk insert of 20k tasks (ms)', result.insert20k_ms);

    // Guard against a silent regression. p50, not p95: p95 on a shared 1-CPU sandbox is noise.
    for (const r of rows) expect(r.after_p50).toBeLessThan(r.before_p50 * 1.5 + 2);
  });
});
