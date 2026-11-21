/**
 * Pins ProjectsService.computeProgress/getStats CURRENT behavior — the
 * exact thing "stale progress after status change" was fixed by computing
 * at read time. Phase 1 (per-project custom statuses rolling up to these 4
 * categories, subtasks) must keep these exact numbers unless the change is
 * deliberate. See PLAN.md section 7 / diagram 07: Task.status stays the
 * category enum specifically so this class of query keeps working.
 */
import { WorkflowService } from '../../../src/projects-tasks/workflow/workflow.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActivityService } from '../../../src/events/activity.service';
import { WorkspacesService } from '../../../src/tenancy/workspaces/workspaces.service';
import { Test } from '@nestjs/testing';
import { ProjectsService } from '../../../src/projects-tasks/projects/projects.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PermissionResolver } from '../../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../../src/access-control/plan-limits.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from '../support/prisma-test-client';
import { resetDb } from '../support/reset-db';
import {
  createUserWithAccount,
  createWorkspace,
  createProject,
  createTask,
} from '../factories';

// ProjectsService also depends on a WorkspacesService for listMembers() —
// not needed by computeProgress/getStats, stubbed out rather than wired for
// real so this file stays focused on the one thing it characterizes.
class StubWorkspacesService {
  listMembers() {
    return Promise.resolve([]);
  }
}

describe('ProjectsService.computeProgress / getStats (characterization)', () => {
  let prisma: PrismaService;
  let projects: ProjectsService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        // Registered directly: overrideProvider() only replaces a provider that
        // already exists in the module, and PrismaService is deliberately not
        // part of these minimal test modules.
        { provide: PrismaService, useValue: prisma },
        // ActivityService publishes 'activity.created' through this.
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        ProjectsService,
        WorkflowService,
        PermissionResolver,
        PlanLimitsService,
        { provide: WorkspacesService, useClass: StubWorkspacesService },
        ActivityService,
      ],
    }).compile();
    projects = moduleRef.get(ProjectsService);
  });

  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function projectWithTasks(
    statuses: Array<'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE'>,
    archived: boolean[] = [],
  ) {
    const { user, account } = await createUserWithAccount(prisma);
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    for (let i = 0; i < statuses.length; i++) {
      await createTask(prisma, {
        workspaceId: workspace.id,
        projectId: project.id,
        createdById: user.id,
        status: statuses[i],
        isArchived: archived[i] ?? false,
      });
    }
    return { project, user };
  }

  it('CURRENT: empty project -> progress 0, not NaN or an error', async () => {
    const { project } = await projectWithTasks([]);
    expect(await projects.computeProgress(project.id)).toBe(0);
  });

  it('CURRENT: 1 of 3 DONE -> rounds to 33, not 33.33 or 34', async () => {
    const { project } = await projectWithTasks(['DONE', 'TODO', 'TODO']);
    expect(await projects.computeProgress(project.id)).toBe(33);
  });

  it('CURRENT: 2 of 3 DONE -> rounds to 67', async () => {
    const { project } = await projectWithTasks(['DONE', 'DONE', 'TODO']);
    expect(await projects.computeProgress(project.id)).toBe(67);
  });

  it('CURRENT: all DONE -> 100', async () => {
    const { project } = await projectWithTasks(['DONE', 'DONE']);
    expect(await projects.computeProgress(project.id)).toBe(100);
  });

  it('CURRENT: BLOCKED and IN_PROGRESS tasks count toward the total but never toward "done"', async () => {
    const { project } = await projectWithTasks([
      'DONE',
      'BLOCKED',
      'IN_PROGRESS',
      'TODO',
    ]);
    expect(await projects.computeProgress(project.id)).toBe(25); // 1/4
  });

  it('CURRENT: archived tasks are excluded from BOTH the numerator and the denominator', async () => {
    // 1 DONE (archived, excluded) + 1 DONE (active) + 1 TODO (active) -> 1/2 = 50, not 2/3
    const { project } = await projectWithTasks(
      ['DONE', 'DONE', 'TODO'],
      [true, false, false],
    );
    expect(await projects.computeProgress(project.id)).toBe(50);
  });

  it('CURRENT: getStats returns per-status counts for all 4 TaskStatus values, even ones with zero tasks', async () => {
    const { project, user } = await projectWithTasks(['DONE', 'TODO']);
    const stats = await projects.getStats(project.id, user.id);
    expect(stats.counts).toEqual({
      TODO: 1,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      DONE: 1,
    });
    expect(stats.total).toBe(2);
    expect(stats.progress).toBe(50);
  });
});
