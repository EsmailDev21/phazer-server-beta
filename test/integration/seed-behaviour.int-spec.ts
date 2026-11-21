/**
 * Step 5.6 on a real database: more triggers (comments, archive/restore, all subtasks done, overdue,
 * schedules) and more actions (create/rename/describe/estimate/classify/prioritise/date/archive/restore).
 * Original header: Step 5.2 on a real database. Rules are saved through the real AutomationsService and people change
 * tasks through the real TasksService, so every event travels the real path:
 *   service write -> activity row -> 'activity.created' -> runner -> rule -> actions (real services) -> activity -> ...
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { CommentableType, Role } from '@prisma/client';
import { STORAGE_PROVIDER } from '../../src/attachments/storage/storage-provider.interface';
import { TemplateApplyService } from '../../src/templates/apply/apply.service';
import { TemplateAssetsService } from '../../src/templates/assets/template-assets.service';
import { TemplateExtractionService } from '../../src/templates/extract';
import { TemplateSeedService } from '../../src/templates/seeds';
import { TemplatesModule } from '../../src/templates/templates.module';
import { TemplatesService } from '../../src/templates/templates.service';
import { MemoryStorage } from './support/memory-storage';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { NotificationsService } from '../../src/activity-notifications/notifications/notifications.service';
import { AutomationActorService } from '../../src/automations/automation-actor.service';
import { AutomationRunnerService } from '../../src/automations/automation-runner.service';
import { ActionExecutor } from '../../src/automations/action-executor.service';
import { AutomationNotifier } from '../../src/automations/automation-notifier.service';
import { AutomationWaitService } from '../../src/automations/automation-wait.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TaskQueryService } from '../../src/views/run/task-query.service';
import { AutomationsService } from '../../src/automations/automations.service';
import { WorkspaceContextLoader } from '../../src/automations/dsl/workspace-context.loader';
import { DueSweepService } from '../../src/automations/due-sweep.service';
import { CommentsService } from '../../src/collaboration/comments/comments.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TagsService } from '../../src/projects-tasks/tags/tags.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import {
  addAccountMember,
  createAccount,
  createProject,
  createUser,
  createWorkspace,
} from './factories';
import {
  disconnectTestPrisma,
  getTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

jest.setTimeout(180_000);

describe('The shipped automations do what they say (step 5.7)', () => {
  let prisma: PrismaService;
  let rules: AutomationsService;
  let runner: AutomationRunnerService;
  let sweep: DueSweepService;
  let tasks: TasksService;
  let comments: CommentsService;
  let seeder: TemplateSeedService;
  let applier: TemplateApplyService;
  const storage = new MemoryStorage();
  let emitter: EventEmitter2;
  let flags: { WORKFLOW: boolean };

  beforeAll(async () => {
    prisma = getTestPrisma();
    emitter = new EventEmitter2();
    flags = { WORKFLOW: true };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: WorkspacesService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        {
          provide: FeatureFlagsService,
          useValue: {
            isEnabled: (f: string) =>
              f === 'WORKFLOW' ? flags.WORKFLOW : false,
          },
        },
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
        TagsService,
        CommentsService,
        DomainWriter,
        WorkspaceContextLoader,
        AutomationsService,
        AutomationActorService,
        TaskQueryService,
        AutomationNotifier,
        AutomationWaitService,
        ActionExecutor,
        AutomationRunnerService,
        DueSweepService,
        TemplateExtractionService,
        TemplateAssetsService,
        TemplatesService,
        TemplateApplyService,
        TemplateSeedService,
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();
    new TemplatesModule(moduleRef.get(PlanLimitsService)).onModuleInit();
    seeder = moduleRef.get(TemplateSeedService);
    applier = moduleRef.get(TemplateApplyService);
    rules = moduleRef.get(AutomationsService);
    runner = moduleRef.get(AutomationRunnerService);
    sweep = moduleRef.get(DueSweepService);
    tasks = moduleRef.get(TasksService);
    comments = moduleRef.get(CommentsService);
    // what @OnEvent does in the real app
    emitter.on('activity.created', (a) => runner.onActivity(a));
  });
  beforeEach(async () => {
    flags.WORKFLOW = true;
    storage.reset();
    await resetDb(prisma);
  });
  afterAll(() => disconnectTestPrisma());

  // ------------------------------------------------------------------ world --------------------
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
    const member2 = await mk(Role.MEMBER);
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const p1 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const p2 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const tag = (name: string) =>
      prisma.tag.create({ data: { workspaceId: ws.id, name, nameKey: name } });
    const [tagA, tagB] = [await tag('a'), await tag('b')];
    const status = async (projectId: string, category: string) =>
      await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId, category: category as any },
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
      member2,
      ws,
      p1,
      p2,
      tagA,
      tagB,
      field,
      done1: await status(p1.id, 'DONE'),
      todo1: await status(p1.id, 'TODO'),
    };
  }
  const idle = () => runner.whenIdle();
  // ------------------------------------------------------------------ helpers (5.7) ----------
  const NOW = new Date('2026-10-19T07:05:00.000Z'); // a Monday
  const hours = (n: number, from = NOW) =>
    new Date(from.getTime() + n * 3_600_000);
  const ANSWERS: Record<string, Record<string, unknown>> = {
    'student-workspace': {
      variables: { semesterStart: '2026-09-01', course: 'Biology 101' },
      modules: { labs: true },
    },
    'sprint-board': { variables: { team: 'Core' } },
    'content-calendar': {
      variables: { launchDate: '2026-10-12', brand: 'Acme' },
      modules: { paid: true },
    },
  };

  /** Seeds the templates, applies one into a fresh workspace as an admin, and switches EVERY shipped rule on. */
  async function install(key: string) {
    const w = await world();
    await seeder.seedAll();
    const ws = await createWorkspace(prisma, {
      accountId: w.account.id,
      name: 'Seeded',
      key: 'SEED',
    });
    const seed = await prisma.template.findUniqueOrThrow({
      where: { seedKey: key },
    });
    await applier.apply(
      w.owner.id,
      seed.id,
      { workspaceId: ws.id, ...ANSWERS[key] } as any,
      { today: '2026-10-09' },
    );
    for (const a of await prisma.automation.findMany({
      where: { workspaceId: ws.id },
    }))
      await rules.update(ws.id, a.id, w.owner.id, { enabled: true });
    await idle();
    const project = (name: RegExp) =>
      prisma.project
        .findFirstOrThrow({ where: { workspaceId: ws.id, name: { not: '' } } })
        .then(async () =>
          (
            await prisma.project.findMany({ where: { workspaceId: ws.id } })
          ).find((p) => name.test(p.name))!,
        );
    const status = (projectId: string, name: string) =>
      prisma.workflowStatus.findFirstOrThrow({ where: { projectId, name } });
    const type = (name: string) =>
      prisma.issueType.findFirstOrThrow({
        where: { workspaceId: ws.id, name },
      });
    const make = async (
      projectId: string,
      data: Record<string, unknown> = {},
    ) => {
      const t = await tasks.create(
        { workspaceId: ws.id, projectId, title: 'Test task', ...data } as any,
        w.owner.id,
      );
      await idle();
      return t;
    };
    /** Moves a task along the workflow, one allowed step at a time (a project may only allow some moves). */
    const walk = async (taskId: string, projectId: string, names: string[]) => {
      for (const n of names)
        await move(taskId, (await status(projectId, n)).id);
    };
    const move = async (taskId: string, statusId: string) => {
      await tasks.update(
        taskId,
        { workflowStatusId: statusId } as any,
        w.owner.id,
      );
      await idle();
    };
    const row = (id: string) =>
      prisma.task.findUniqueOrThrow({
        where: { id },
        include: { assignees: true },
      });
    const lastComment = async (taskId: string) =>
      (
        await prisma.comment.findMany({
          where: { targetId: taskId },
          orderBy: { createdAt: 'desc' },
        })
      )[0]?.content;
    const late = async (taskId: string, due: Date) =>
      prisma.task.update({ where: { id: taskId }, data: { dueDate: due } });
    return {
      w,
      ws,
      project,
      status,
      type,
      make,
      move,
      walk,
      row,
      lastComment,
      late,
    };
  }

  describe('sprint board', () => {
    it('blocked work gets more urgent and a note asking what is needed', async () => {
      const s = await install('sprint-board');
      const board = await s.project(/sprint board/);
      const t = await s.make(board.id, { priority: 'MEDIUM' });
      await s.walk(t.id, board.id, ['Ready', 'In progress', 'Blocked']);
      expect((await s.row(t.id)).priority).toBe('HIGH');
      expect(await s.lastComment(t.id)).toMatch(
        /^Blocked on \d{4}-\d{2}-\d{2}: say what is needed to unblock [A-Z0-9]+-\d+\.$/,
      );
    });
    it('work that goes to code review with nobody on it gets the person who moved it; work with an owner is left alone', async () => {
      const s = await install('sprint-board');
      const board = await s.project(/sprint board/);
      const orphan = await s.make(board.id);
      const owned = await s.make(board.id, { title: 'Owned' });
      await tasks.setAssignees(
        owned.id,
        { userIds: [s.w.member.id] },
        s.w.owner.id,
      );
      await idle();
      await s.walk(orphan.id, board.id, [
        'Ready',
        'In progress',
        'Code review',
      ]);
      await s.walk(owned.id, board.id, ['Ready', 'In progress', 'Code review']);
      expect((await s.row(orphan.id)).assignees.map((u) => u.id)).toEqual([
        s.w.owner.id,
      ]);
      expect((await s.row(owned.id)).assignees.map((u) => u.id)).toEqual([
        s.w.member.id,
      ]);
    });
    it('a story in review closes itself when its last sub-task is done; one that is not in review is left alone (the workflow only allows review -> done)', async () => {
      const s = await install('sprint-board');
      const board = await s.project(/sprint board/);
      const done = await s.status(board.id, 'Done');
      const story = await s.make(board.id, { title: 'Story' });
      const early = await s.make(board.id, { title: 'Early story' });
      await s.walk(story.id, board.id, ['Ready', 'In progress', 'Code review']);
      await s.walk(early.id, board.id, ['Ready', 'In progress']);
      const kids = async (parent: string) => [
        await s.make(board.id, { title: 'a', parentId: parent }),
        await s.make(board.id, { title: 'b', parentId: parent }),
      ];
      const [a, b] = await kids(story.id);
      const [c, d] = await kids(early.id);
      for (const t of [a, b, c, d])
        await s.walk(t.id, board.id, [
          'Ready',
          'In progress',
          'Code review',
          'Done',
        ]);
      expect(await s.row(story.id)).toMatchObject({
        status: 'DONE',
        workflowStatusId: done.id,
      });
      expect(await s.lastComment(story.id)).toMatch(
        /^All sub-tasks of [A-Z0-9]+-\d+ are done\.$/,
      );
      expect((await s.row(early.id)).status).toBe('IN_PROGRESS');
      expect(
        await prisma.automationRun.count({
          where: { workspaceId: s.ws.id, status: 'FAILED' },
        }),
      ).toBe(0); // "left alone", not "failed"
    });
    it('a bug that is overdue becomes urgent and says so; an overdue story is not touched', async () => {
      const s = await install('sprint-board');
      const board = await s.project(/sprint board/);
      const bug = await s.make(board.id, {
        title: 'Crash',
        issueTypeId: (await s.type('Bug')).id,
        priority: 'LOW',
      });
      const story = await s.make(board.id, {
        title: 'Late story',
        issueTypeId: (await s.type('Story')).id,
        priority: 'LOW',
      });
      await s.late(bug.id, hours(-3));
      await s.late(story.id, hours(-3));
      await sweep.sweep(NOW);
      await idle();
      expect((await s.row(bug.id)).priority).toBe('URGENT');
      expect(await s.lastComment(bug.id)).toMatch(
        /^This bug is overdue since 2026-10-19\.$/,
      );
      expect((await s.row(story.id)).priority).toBe('LOW');
    });
    it('work marked "Won\'t do" is archived', async () => {
      const s = await install('sprint-board');
      const board = await s.project(/sprint board/);
      const t = await s.make(board.id);
      await s.move(t.id, (await s.status(board.id, "Won't do")).id);
      expect((await s.row(t.id)).isArchived).toBe(true);
    });
  });

  describe('student workspace', () => {
    it('an assignment that reaches professor review is marked "pending" and says it is ready; other kinds of work are not', async () => {
      const s = await install('student-workspace');
      const cw = await s.project(/coursework/);
      const review = await s.status(cw.id, 'Professor review');
      const essay = await s.make(cw.id, {
        title: 'Essay',
        issueTypeId: (await s.type('Assignment')).id,
      });
      const reading = await s.make(cw.id, {
        title: 'Reading',
        issueTypeId: (await s.type('Reading')).id,
      });
      await s.move(essay.id, review.id);
      await s.move(reading.id, review.id);
      const field = await prisma.customField.findFirstOrThrow({
        where: { workspaceId: s.ws.id, key: 'prof-review' },
      });
      expect(
        (
          await prisma.taskCustomValue.findFirstOrThrow({
            where: { taskId: essay.id, fieldId: field.id },
          })
        ).value,
      ).toBe('pending');
      expect(
        await prisma.taskCustomValue.count({ where: { taskId: reading.id } }),
      ).toBe(0);
      expect(await s.lastComment(essay.id)).toMatch(
        / is ready for the professor to review\.$/,
      );
    });
    it('a late assignment is raised a step and flagged', async () => {
      const s = await install('student-workspace');
      const cw = await s.project(/coursework/);
      const t = await s.make(cw.id, {
        issueTypeId: (await s.type('Assignment')).id,
        priority: 'MEDIUM',
      });
      await s.late(t.id, hours(-5));
      await sweep.sweep(NOW);
      await idle();
      expect((await s.row(t.id)).priority).toBe('HIGH');
      expect(await s.lastComment(t.id)).toBe(
        'Overdue since 2026-10-19: priority raised.',
      );
    });
    it('every Monday a planning task appears in coursework, due the next day, once', async () => {
      const s = await install('student-workspace');
      const cw = await s.project(/coursework/);
      await sweep.sweep(NOW);
      await idle();
      await sweep.sweep(hours(0.4, NOW));
      await idle();
      const planning = await prisma.task.findMany({
        where: { projectId: cw.id, title: 'Plan the week (2026-10-19)' },
      });
      expect(planning).toHaveLength(1);
      expect(planning[0]).toMatchObject({
        priority: 'MEDIUM',
        createdVia: 'AUTOMATION',
      });
      const n = new Date();
      expect(planning[0].dueDate!.toISOString()).toBe(
        new Date(
          Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1),
        ).toISOString(),
      );
      await sweep.sweep(new Date('2026-10-20T07:05:00Z'));
      await idle(); // Tuesday: nothing
      expect(
        await prisma.task.count({
          where: { projectId: cw.id, title: { startsWith: 'Plan the week' } },
        }),
      ).toBe(1);
    });
    it('a comment on finished work reopens it', async () => {
      const s = await install('student-workspace');
      const cw = await s.project(/coursework/);
      const t = await s.make(cw.id);
      await s.move(t.id, (await s.status(cw.id, 'Done')).id);
      expect((await s.row(t.id)).status).toBe('DONE');
      await comments.create(
        {
          targetType: CommentableType.TASK,
          targetId: t.id,
          content: 'I found one more problem',
        } as any,
        s.w.owner.id,
      );
      await idle();
      expect(await s.row(t.id)).toMatchObject({ status: 'TODO' });
    });
  });

  describe('content calendar', () => {
    const approved = (ws: string) =>
      prisma.customField.findFirstOrThrow({
        where: { workspaceId: ws, key: 'approved' },
      });
    it('the day before a piece is due and not approved: a warning and a step up; an approved piece is left alone', async () => {
      const s = await install('content-calendar');
      const cal = await s.project(/content calendar/);
      const field = await approved(s.ws.id);
      const pending = await s.make(cal.id, {
        title: 'Pending piece',
        priority: 'LOW',
      });
      const ok = await s.make(cal.id, {
        title: 'Approved piece',
        priority: 'LOW',
      });
      await s.late(pending.id, hours(10));
      await s.late(ok.id, hours(10));
      await prisma.taskCustomValue.create({
        data: { taskId: ok.id, fieldId: field.id, value: true },
      });
      await sweep.sweep(NOW);
      await idle();
      expect((await s.row(pending.id)).priority).toBe('MEDIUM');
      expect(await s.lastComment(pending.id)).toMatch(
        / is due tomorrow and is not approved yet\.$/,
      );
      expect((await s.row(ok.id)).priority).toBe('LOW');
    });
    it('late posts are escalated and flagged', async () => {
      const s = await install('content-calendar');
      const cal = await s.project(/content calendar/);
      const t = await s.make(cal.id, { priority: 'MEDIUM' });
      await s.late(t.id, hours(-2));
      await sweep.sweep(NOW);
      await idle();
      expect((await s.row(t.id)).priority).toBe('HIGH');
      expect(await s.lastComment(t.id)).toMatch(
        / is overdue since 2026-10-19\.$/,
      );
    });
    it('a piece closes when all its steps are done', async () => {
      const s = await install('content-calendar');
      const cal = await s.project(/content calendar/);
      const piece = await s.make(cal.id, { title: 'Newsletter' });
      const a = await s.make(cal.id, { title: 'draft', parentId: piece.id });
      const b = await s.make(cal.id, { title: 'publish', parentId: piece.id });
      await tasks.update(a.id, { status: 'DONE' }, s.w.owner.id);
      await idle();
      await tasks.update(b.id, { status: 'DONE' }, s.w.owner.id);
      await idle();
      expect((await s.row(piece.id)).status).toBe('DONE');
    });
    it('Monday planning: a task tagged "social" in the calendar project', async () => {
      const s = await install('content-calendar');
      const cal = await s.project(/content calendar/);
      await sweep.sweep(new Date('2026-10-19T08:10:00Z'));
      await idle();
      const t = await prisma.task.findFirstOrThrow({
        where: { projectId: cal.id, title: { startsWith: 'Plan next week' } },
      });
      expect(t.title).toBe("Plan next week's content (2026-10-19)");
      expect(
        (
          await prisma.taskTag.findMany({
            where: { taskId: t.id },
            include: { tag: true },
          })
        ).map((x) => x.tag.name),
      ).toEqual(['social']);
    });
  });

  describe('the whole set at once', () => {
    it.each(['student-workspace', 'sprint-board', 'content-calendar'])(
      '%s: with every rule on, ordinary work raises no runaway and no failed run',
      async (key) => {
        const s = await install(key);
        const project = (
          await prisma.project.findMany({ where: { workspaceId: s.ws.id } })
        )[0];
        const t = await s.make(project.id, {
          title: 'Ordinary',
          priority: 'MEDIUM',
        });
        await tasks.update(t.id, { priority: 'HIGH' }, s.w.owner.id);
        await comments.create(
          {
            targetType: CommentableType.TASK,
            targetId: t.id,
            content: 'a note',
          } as any,
          s.w.owner.id,
        );
        await idle();
        await sweep.sweep(NOW);
        await idle();
        expect(
          await prisma.automationRun.count({
            where: { workspaceId: s.ws.id, status: 'FAILED' },
          }),
        ).toBe(0);
        expect(
          await prisma.automation.count({
            where: { workspaceId: s.ws.id, enabled: false },
          }),
        ).toBe(0); // none was paused by the rate breaker
      },
    );
  });
});
