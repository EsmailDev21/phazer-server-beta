/**
 * Pins TasksService.create/list's CURRENT behavior before Phase 1 touches
 * it (subtasks, workspace-scoped task numbers, per-project workflow
 * statuses). If any assertion in this file starts failing during Phase 1
 * work, that's a real behavior change — stop and decide on purpose whether
 * it's intended, don't let it slide through as a side effect.
 */
import { TaskPlanningService } from '../../../src/projects-tasks/planning/task-planning.service';
import { WorkflowService } from '../../../src/projects-tasks/workflow/workflow.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TasksService } from '../../../src/projects-tasks/tasks/tasks.service';
import { TaskTreeService } from '../../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../../src/projects-tasks/tasks/task-visibility.service';
import { ActivityService } from '../../../src/events/activity.service';
import { PermissionResolver } from '../../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../../src/access-control/plan-limits.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from '../support/prisma-test-client';
import { resetDb } from '../support/reset-db';
import {
  createUserWithAccount,
  createWorkspace,
  createProject,
} from '../factories';
import { ActivityAction, ActivityTargetType } from '@prisma/client';

describe('TasksService (characterization)', () => {
  let prisma: PrismaService;
  let tasks: TasksService;

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
        TasksService,
        TaskTreeService,
        WorkflowService,
        TaskPlanningService,
        TaskVisibilityService,
        ActivityService,
        PermissionResolver,
        PlanLimitsService,
      ],
    }).compile();
    tasks = moduleRef.get(TasksService);
  });

  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function scenario() {
    const { user, account } = await createUserWithAccount(prisma);
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    return { user, account, workspace, project };
  }

  it('CURRENT: create() always sets createdVia to the literal string "MANUAL"', async () => {
    const { user, workspace } = await scenario();
    const task = await tasks.create(
      { workspaceId: workspace.id, title: 'T' } as any,
      user.id,
    );
    expect(task.createdVia).toBe('MANUAL');
    // NOTE: this is the exact behavior step 0.7 (WriteContext/DomainWriter)
    // changes on purpose, to accept IMPORT/TEMPLATE/INTEGRATION too. This
    // assertion should be UPDATED, not silently broken, when that lands.
  });

  it('CURRENT: create() writes exactly one Activity row of action CREATED', async () => {
    const { user, workspace } = await scenario();
    const task = await tasks.create(
      { workspaceId: workspace.id, title: 'T' } as any,
      user.id,
    );

    const activity = await prisma.activity.findMany({
      where: { targetId: task.id, targetType: ActivityTargetType.TASK },
    });
    expect(activity).toHaveLength(1);
    expect(activity[0].action).toBe(ActivityAction.CREATED);
    expect(activity[0].actorId).toBe(user.id);
    expect(activity[0].workspaceId).toBe(workspace.id);
  });

  it('CURRENT: create() rejects startDate after dueDate', async () => {
    const { user, workspace } = await scenario();
    await expect(
      tasks.create(
        {
          workspaceId: workspace.id,
          title: 'T',
          startDate: '2027-01-10',
          dueDate: '2027-01-01',
        } as any,
        user.id,
      ),
    ).rejects.toThrow();
  });

  it('CURRENT: create() with a projectId from a DIFFERENT workspace is rejected', async () => {
    const { user, workspace, project } = await scenario();
    const otherWorkspace = await createWorkspace(prisma, {
      accountId: (await scenario()).account.id,
    });
    void project;
    await expect(
      tasks.create(
        {
          workspaceId: workspace.id,
          projectId: otherWorkspace.id,
          title: 'T',
        } as any,
        user.id,
      ),
    ).rejects.toThrow(/does not belong to this workspace/);
  });

  it('CURRENT: an Inbox task (no projectId) is created successfully', async () => {
    const { user, workspace } = await scenario();
    const task = await tasks.create(
      { workspaceId: workspace.id, title: 'Inbox item' } as any,
      user.id,
    );
    expect(task.projectId).toBeNull();
  });
});
