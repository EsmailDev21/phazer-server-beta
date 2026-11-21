/**
 * Step 3.6 on a real database: the applier (plan, chunked execution, merge rules, limits), the
 * install record, undo, failure compensation, and the round trip
 *     workspace -> template -> apply -> workspace  (structurally equal)
 */
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { AccountType, PlanKey, Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { TemplateApplyService } from '../../src/templates/apply/apply.service';
import { fixtureJson } from '../../src/templates/blueprint/blueprint.fixtures';
import { TemplateExtractionService } from '../../src/templates/extract';
import { STORAGE_PROVIDER } from '../../src/attachments/storage/storage-provider.interface';
import { TemplateAssetsService } from '../../src/templates/assets/template-assets.service';
import { MemoryStorage } from './support/memory-storage';
import { stageDeclaredAssets } from './support/template-assets';
import { TemplatesModule } from '../../src/templates/templates.module';
import { TemplatesService } from '../../src/templates/templates.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { addAccountMember, createAccount, createProject, createTask, createUser, createWorkspace } from './factories';

jest.setTimeout(180_000);
const TODAY = '2026-10-09';

describe('Applying templates (step 3.6)', () => {
  let prisma: PrismaService;
  let templates: TemplatesService;
  let applier: TemplateApplyService;
  let writer: DomainWriter;
  let resolver: PermissionResolver;
  const storage = new MemoryStorage();

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: WorkspacesService, useValue: {} },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, TaskVisibilityService, TasksService,
        TaskTreeService, WorkflowService, TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter,
        TemplateExtractionService, TemplateAssetsService, TemplatesService, TemplateApplyService,
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();
    new TemplatesModule(moduleRef.get(PlanLimitsService)).onModuleInit();
    templates = moduleRef.get(TemplatesService);
    applier = moduleRef.get(TemplateApplyService);
    writer = moduleRef.get(DomainWriter);
    resolver = moduleRef.get(PermissionResolver);
  });
  beforeEach(async () => { storage.reset(); await resetDb(prisma); });
  afterAll(() => disconnectTestPrisma());

  // ------------------------------------------------------------------ world --------------
  async function world(planType: PlanKey = PlanKey.ENTERPRISE_ORG, type: AccountType = AccountType.ORGANIZATION) {
    const account = await createAccount(prisma, { type, planType });
    const mk = async (role: Role) => {
      const user = await createUser(prisma);
      await addAccountMember(prisma, { accountId: account.id, userId: user.id, role });
      return user;
    };
    const admin = await mk(Role.OWNER);
    const alice = await mk(Role.MEMBER);
    const viewer = await mk(Role.VIEWER);
    const ws = await createWorkspace(prisma, { accountId: account.id, name: 'Target', key: 'TGT' });
    return { account, admin, alice, viewer, ws };
  }
  const store = (w: { account: { id: string }; admin: { id: string } }, name: 'student-workspace' | 'sprint-board' | 'content-calendar' | object) => {
    const blueprint = typeof name === 'string' ? fixtureJson(name) : (name as Record<string, unknown>);
    const staged = stageDeclaredAssets(storage, blueprint as any);
    return templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint }, undefined, { id: staged.id, assets: staged.assets });
  };
  const STUDENT = { semesterStart: '2026-09-01', course: 'Biology 101' };
  const apply = (w: { admin: { id: string }; ws: { id: string } }, templateId: string, extra: Record<string, unknown> = {}, opts: { today?: string } = { today: TODAY }) =>
    applier.apply(w.admin.id, templateId, { workspaceId: w.ws.id, variables: STUDENT, ...extra } as any, opts) as Promise<any>;
  const counts = async (workspaceId: string) => ({
    projects: await prisma.project.count({ where: { workspaceId } }),
    tasks: await prisma.task.count({ where: { workspaceId } }),
    tags: await prisma.tag.count({ where: { workspaceId } }),
    fields: await prisma.customField.count({ where: { workspaceId } }),
    types: await prisma.issueType.count({ where: { workspaceId } }),
    iterations: await prisma.iteration.count({ where: { workspaceId } }),
    comments: await prisma.comment.count(),
    deps: await prisma.taskDependency.count(),
  });

  // ================================================================== basic apply =========
  describe('applying the student template into an empty workspace', () => {
    it('creates every part, with variables filled in, dates anchored, workflow and tree intact', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id, { mode: 'NEW_WORKSPACE', modules: { labs: true } });
      expect(r.dryRun).toBe(false);

      const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: w.ws.id } });
      expect(ws).toMatchObject({ name: 'Target', key: 'TGT' }); // identity untouched

      const projects = await prisma.project.findMany({ where: { workspaceId: w.ws.id }, orderBy: { name: 'asc' }, include: { workflowStatuses: { orderBy: { position: 'asc' } } } });
      expect(projects.map((p) => p.name)).toEqual(['Biology 101: coursework', 'Biology 101: labs']);
      const cw = projects[0];
      expect(cw.workflowStatuses.map((s) => [s.name, s.category, s.excludeFromProgress])).toEqual([
        ['To do', 'TODO', false], ['In progress', 'IN_PROGRESS', false], ['Professor review', 'IN_PROGRESS', false], ['Done', 'DONE', false], ['Dropped', 'DONE', true],
      ]);
      expect(await prisma.workflowTransition.count({ where: { projectId: cw.id } })).toBe(4);
      expect(cw.defaultWorkflowStatusId).toBe(cw.workflowStatuses[0].id);

      const tasks = await prisma.task.findMany({ where: { projectId: cw.id }, orderBy: { number: 'asc' }, include: { tags: { include: { tag: true } }, issueType: true, iteration: true, customValues: { include: { field: true } } } });
      expect(tasks.map((x) => x.title)).toEqual([
        'Read chapter 1 of Biology 101', 'Essay: biology-101', 'Outline', 'First draft', 'Midterm exam', 'Review lecture notes', 'Practice problems', 'Past paper, last year', 'Final exam',
      ]);
      expect(tasks.map((x) => x.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // numbering continues from the workspace counter
      const byTitle = Object.fromEntries(tasks.map((x) => [x.title, x]));
      expect(byTitle['First draft'].parentId).toBe(byTitle['Essay: biology-101'].id);
      expect(byTitle['Past paper, last year'].parentId).toBe(byTitle['Practice problems'].id);
      expect(byTitle['Midterm exam']).toMatchObject({ priority: 'URGENT', createdVia: 'TEMPLATE' });
      expect(byTitle['Midterm exam'].issueType!.name).toBe('Exam');
      expect(byTitle['Midterm exam'].tags.map((x) => x.tag.name)).toEqual(['exam']);
      expect(Object.fromEntries(byTitle['Midterm exam'].customValues.map((v) => [v.field.key, v.value]))).toEqual({ 'prof-review': 'pending', 'exam-weight': 30 });
      expect(byTitle['Midterm exam'].dueDate!.toISOString().slice(0, 10)).toBe('2026-10-20');
      expect(byTitle['Past paper, last year'].dueDate!.toISOString().slice(0, 10)).toBe('2026-10-19'); // Sunday -> skipped to Monday
      expect(byTitle['Read chapter 1 of Biology 101'].iteration!.name).toBe('Midterm period');
      expect(byTitle['Read chapter 1 of Biology 101'].startDate!.toISOString().slice(0, 10)).toBe('2026-09-01');

      expect(await prisma.taskDependency.count()).toBe(3);
      const comments = await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } });
      expect(comments.map((c) => c.content)).toEqual(['Reviewed on Tue 1 Sep: add sources.', 'Will do.']);
      expect(comments.every((c) => c.authorId === w.admin.id)).toBe(true); // the applier; never a real "professor"
      expect(await prisma.iteration.count({ where: { workspaceId: w.ws.id } })).toBe(2);
      expect(r.plan.warnings.map((x: any) => x.code)).toEqual(expect.arrayContaining(['WORKSPACE_IDENTITY_KEPT']));
    });

    it('records the install: status, snapshots, one item per created entity, a TEMPLATE_APPLIED audit entry', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id);
      const install = await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } });
      expect(install).toMatchObject({ status: 'APPLIED', mode: 'MERGE', templateName: 'Student workspace', versionSemver: '1.0.0', workspaceId: w.ws.id, appliedById: w.admin.id, accountId: w.account.id });
      expect(install.finishedAt).not.toBeNull();
      expect(install.variables).toEqual(STUDENT);
      const items = await prisma.templateInstallItem.groupBy({ by: ['entityType', 'action'], where: { installId: install.id }, _count: true });
      expect(Object.fromEntries(items.map((i) => [`${i.entityType}:${i.action}`, i._count]))).toEqual({
        'TAG:CREATED': 4, 'CUSTOM_FIELD:CREATED': 2, 'ISSUE_TYPE:CREATED': 3, 'PROJECT:CREATED': 1, 'ITERATION:CREATED': 2, 'TASK:CREATED': 9, 'ATTACHMENT:CREATED': 1, // the fixture's reference file, copied
      });
      const taskItems = await prisma.templateInstallItem.findMany({ where: { installId: install.id, entityType: 'TASK' } });
      expect(new Set(taskItems.map((i) => i.nodeKey))).toContain('midterm');
      expect(await prisma.auditLog.count({ where: { action: 'TEMPLATE_APPLIED', accountId: w.account.id } })).toBe(1);
      expect((install.report as any).tasks).toBe(9);
      const fresh = await applier.getInstall(w.admin.id, install.id);
      expect(fresh.items).toEqual(expect.arrayContaining([{ entityType: 'TASK', action: 'CREATED', count: 9 }]));
      expect((await applier.listInstalls(w.admin.id, w.ws.id)).map((i) => i.id)).toEqual([install.id]);
    });

    it('a dry run returns the plan and writes nothing at all', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const before = await counts(w.ws.id);
      const r: any = await applier.preview(w.admin.id, t.id, { workspaceId: w.ws.id, variables: STUDENT } as any, { today: TODAY });
      expect(r).toMatchObject({ dryRun: true, plan: { counts: { tasks: 9 } } });
      expect(await counts(w.ws.id)).toEqual(before);
      expect(await prisma.templateInstall.count()).toBe(0);
    });

    it('wrong or missing answers are refused up front with the reasons, and nothing is written', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const err = await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: { course: 5, nope: 1 } } as any, { today: TODAY }).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({ code: 'APPLY_INPUT_INVALID' });
      expect(err.getResponse().issues.map((i: any) => i.code).sort()).toEqual(['VARIABLE_INVALID', 'VARIABLE_UNKNOWN']);
      expect(await prisma.templateInstall.count()).toBe(0);
    });

    it('roles: a workspace member is assigned; a stranger is refused', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const stranger = await createUser(prisma);
      const bad = await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: STUDENT, roles: { student: { type: 'MEMBER', userId: stranger.id } } } as any, { today: TODAY }).catch((e) => e);
      expect(bad.getResponse().issues.map((i: any) => i.code)).toContain('ROLE_INVALID');
      await apply(w, t.id, { roles: { student: { type: 'MEMBER', userId: w.alice.id } } });
      const essay = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.ws.id, title: { startsWith: 'Essay' } }, include: { assignees: true } });
      expect(essay.assignees.map((a) => a.id)).toEqual([w.alice.id]);
    });

    it('the template must be readable by the person applying it (404 otherwise)', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace'); // PRIVATE to admin
      await expect(apply({ admin: w.alice, ws: w.ws }, t.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a chosen version is applied, not always the latest', async () => {
      const w = await world();
      const t = await store(w, 'sprint-board');
      const b2 = fixtureJson('sprint-board');
      b2.projects[0].name = '{{team}} board v2';
      await templates.addVersion(t.id, w.admin.id, { blueprint: b2 });
      await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, version: 1, variables: { team: 'X' } } as any, { today: TODAY });
      await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: { team: 'X' } } as any, { today: TODAY });
      expect((await prisma.project.findMany({ where: { workspaceId: w.ws.id }, orderBy: { createdAt: 'asc' } })).map((p) => p.name)).toEqual(['X sprint board', 'X board v2']);
    });
  });

  // ================================================================== merge rules ==========
  describe('merging into a workspace that already has things', () => {
    it('reuses tags/types by name and fields by key, skips a type conflict, renames a clashing project, never touches existing data', async () => {
      const w = await world();
      const exam = await prisma.tag.create({ data: { workspaceId: w.ws.id, name: 'EXAM', nameKey: 'exam' } });
      const type = await prisma.issueType.create({ data: { workspaceId: w.ws.id, name: 'exam', nameKey: 'exam', level: 'STANDARD' } });
      const review = await prisma.customField.create({ data: { workspaceId: w.ws.id, key: 'prof-review', name: 'Mine', dataType: 'SELECT', options: ['pending', 'approved', 'changes requested'] } });
      const weight = await prisma.customField.create({ data: { workspaceId: w.ws.id, key: 'exam-weight', name: 'Weight', dataType: 'TEXT' } });
      const existingProject = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.admin.id, name: 'Biology 101: coursework' });
      await prisma.workspace.update({ where: { id: w.ws.id }, data: { description: 'Mine', icon: 'rocket' } });

      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id);

      expect(await prisma.tag.count({ where: { workspaceId: w.ws.id } })).toBe(4); // 3 new + the existing one
      expect((await prisma.tag.findUniqueOrThrow({ where: { id: exam.id } })).name).toBe('EXAM');
      expect(await prisma.issueType.count({ where: { workspaceId: w.ws.id } })).toBe(3); // exam reused, 2 created
      expect((await prisma.issueType.findUniqueOrThrow({ where: { id: type.id } })).name).toBe('exam');
      expect((await prisma.customField.findUniqueOrThrow({ where: { id: review.id } })).name).toBe('Mine');
      expect(await prisma.customField.count({ where: { workspaceId: w.ws.id } })).toBe(2); // none created
      expect((await prisma.customField.findUniqueOrThrow({ where: { id: weight.id } })).dataType).toBe('TEXT');

      const names = (await prisma.project.findMany({ where: { workspaceId: w.ws.id } })).map((p) => p.name).sort();
      expect(names).toEqual(['Biology 101: coursework', 'Biology 101: coursework (2)']);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: existingProject.id } })).name).toBe('Biology 101: coursework');

      const midterm = await prisma.task.findFirstOrThrow({ where: { title: 'Midterm exam' }, include: { tags: true, customValues: { include: { field: true } } } });
      expect(midterm.tags.map((x) => x.tagId)).toEqual([exam.id]); // attached to the EXISTING tag
      expect(midterm.customValues.map((v) => v.field.key)).toEqual(['prof-review']); // exam-weight dropped
      expect(await prisma.task.count({ where: { title: 'Final exam' } })).toBe(1);

      const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: w.ws.id } });
      expect(ws).toMatchObject({ name: 'Target', key: 'TGT', description: 'Mine', icon: 'rocket' });

      const items = await prisma.templateInstallItem.groupBy({ by: ['entityType', 'action'], where: { installId: r.installId }, _count: true });
      const m = Object.fromEntries(items.map((i) => [`${i.entityType}:${i.action}`, i._count]));
      expect(m).toMatchObject({ 'TAG:REUSED': 1, 'TAG:CREATED': 3, 'ISSUE_TYPE:REUSED': 1, 'ISSUE_TYPE:CREATED': 2, 'CUSTOM_FIELD:REUSED': 1, 'CUSTOM_FIELD:SKIPPED': 1, 'PROJECT:CREATED': 1 });
      expect(r.plan.warnings.map((x: any) => x.code)).toEqual(expect.arrayContaining(['PROJECT_RENAMED', 'FIELD_TYPE_CONFLICT', 'VALUES_DROPPED']));
    });

    it('task numbers continue from the workspace counter, and a second apply makes a second set', async () => {
      const w = await world();
      await createTask(prisma, { workspaceId: w.ws.id, createdById: w.admin.id, title: 'existing' });
      const t = await store(w, 'student-workspace');
      await apply(w, t.id);
      await apply(w, t.id);
      const numbers = (await prisma.task.findMany({ where: { workspaceId: w.ws.id }, orderBy: { number: 'asc' }, select: { number: true } })).map((x) => x.number);
      expect(numbers).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
      expect(await prisma.project.count({ where: { workspaceId: w.ws.id } })).toBe(2);
    });

    it('NEW_WORKSPACE refuses a workspace that is not empty; a PROJECT template refuses NEW_WORKSPACE', async () => {
      const w = await world();
      await createProject(prisma, { workspaceId: w.ws.id, createdById: w.admin.id, name: 'x' });
      const t = await store(w, 'student-workspace');
      const err = await apply(w, t.id, { mode: 'NEW_WORKSPACE' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().plan.blockers.map((b: any) => b.code)).toEqual(['WORKSPACE_NOT_EMPTY']);
      const p = await store(w, 'sprint-board');
      const e2 = await applier.apply(w.admin.id, p.id, { workspaceId: w.ws.id, mode: 'NEW_WORKSPACE', variables: {} } as any, { today: TODAY }).catch((e) => e);
      expect(e2.getResponse().plan.blockers.map((b: any) => b.code)).toContain('KIND_MODE_MISMATCH');
    });
  });

  // ================================================================== limits ===============
  describe('plan limits', () => {
    it('free plan at its project cap: apply is refused with the reason, nothing is written, a module can make it fit', async () => {
      const w = await world(PlanKey.FREE_PERSONAL, AccountType.PERSONAL);
      const cap = 5; // FREE_PERSONAL.projects (per workspace)
      for (let i = 0; i < cap - 1; i++) await createProject(prisma, { workspaceId: w.ws.id, createdById: w.admin.id, name: `p${i}` });
      const t = await store(w, 'student-workspace'); // 2 projects with labs, 1 without
      const before = await counts(w.ws.id);
      const err = await apply(w, t.id, { modules: { labs: true } }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: 'APPLY_BLOCKED', plan: { blockers: [expect.objectContaining({ code: 'PROJECT_LIMIT' })] } });
      expect(await counts(w.ws.id)).toEqual(before);
      expect(await prisma.templateInstall.count()).toBe(0);
      await expect(apply(w, t.id, { modules: { labs: false } })).resolves.toMatchObject({ dryRun: false });
    });

    it('the "new workspace" path: at the workspace cap the guard blocks creating one, but merging into the existing one works', async () => {
      const w = await world(PlanKey.FREE_PERSONAL, AccountType.PERSONAL);
      const create = await resolver.resolve(w.admin.id, 'createWorkspace', 'ACCOUNT', w.account.id);
      expect(create.planLimitExceeded).toBe(true); // Free = 1 workspace, and Target is it
      const merge = await resolver.resolve(w.admin.id, 'applyTemplate', 'WORKSPACE', w.ws.id);
      expect(merge.allowed).toBe(true);
      const t = await store(w, 'student-workspace');
      await expect(apply(w, t.id)).resolves.toMatchObject({ dryRun: false });
    });

    it('free plan task cap per project: a template bigger than the cap is refused', async () => {
      const w = await world(PlanKey.FREE_PERSONAL, AccountType.PERSONAL);
      const t = await store(w, bigBlueprint(260));
      const err = await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: {} } as any, { today: TODAY }).catch((e) => e);
      expect(err.getResponse().plan.blockers.map((b: any) => b.code)).toEqual(['TASK_LIMIT']);
      expect(await prisma.task.count()).toBe(0);
    });
  });

  // ================================================================== concurrency ==========
  describe('concurrency', () => {
    it('only one apply may run in a workspace at a time', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      await prisma.templateInstall.create({ data: { templateName: 'x', versionSemver: '1.0.0', versionChecksum: 'sha256:' + 'a'.repeat(64), accountId: w.account.id, workspaceId: w.ws.id, appliedById: w.admin.id, mode: 'MERGE' } });
      const err = await apply(w, t.id).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: 'APPLY_IN_PROGRESS' });
      expect(await prisma.project.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('other people can keep creating tasks while a large apply runs (chunks, not one long lock): no deadlock, numbers unique and gapless', async () => {
      const w = await world();
      const project = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.admin.id, name: 'live' });
      const t = await store(w, bigBlueprint(1500));
      const mine = Array.from({ length: 25 }, (_, i) =>
        writer.createTask({ workspaceId: w.ws.id, projectId: project.id, title: `live ${i}` } as any, w.alice.id, { origin: 'MANUAL' as any, actorId: w.alice.id }));
      const [r, ...live] = await Promise.all([applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: {} } as any, { today: TODAY }) as Promise<any>, ...mine]);
      expect(r.dryRun).toBe(false);
      expect(live).toHaveLength(25);
      const numbers = (await prisma.task.findMany({ where: { workspaceId: w.ws.id }, select: { number: true } })).map((x) => x.number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 1525 }, (_, i) => i + 1));
    });
  });

  // ================================================================== failure ==============
  describe('a failure part-way leaves the workspace as it was', () => {
    it('compensates everything created so far, marks the install FAILED, and rethrows', async () => {
      const w = await world();
      const existing = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.admin.id, name: 'mine' });
      await prisma.tag.create({ data: { workspaceId: w.ws.id, name: 'keep', nameKey: 'keep' } });
      const t = await store(w, bigBlueprint(250));
      const before = await counts(w.ws.id);

      const real = writer.createTasksBulk.bind(writer);
      let calls = 0;
      const spy = jest.spyOn(writer, 'createTasksBulk').mockImplementation((...args: Parameters<typeof real>) => {
        calls += 1;
        if (calls === 2) throw new Error('disk on fire'); // the 2nd slice of 100
        return real(...args);
      });
      const err = await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: {} } as any, { today: TODAY }).catch((e) => e);
      spy.mockRestore();
      expect(err.message).toContain('disk on fire');

      expect(await counts(w.ws.id)).toEqual(before); // projects, tasks, tags, fields, types, iterations, comments, deps: as before
      expect((await prisma.project.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe('mine');
      const install = await prisma.templateInstall.findFirstOrThrow();
      expect(install.status).toBe('FAILED');
      expect(install.report).toMatchObject({ error: expect.stringContaining('disk on fire'), compensated: true });
      expect(await prisma.templateInstallItem.count({ where: { installId: install.id, undoneAt: null, action: 'CREATED' } })).toBe(0);
      // the workspace is free for another try (the one-apply lock is released)
      await expect(apply(w, t.id, { variables: {} })).resolves.toMatchObject({ dryRun: false });
    });
  });

  // ================================================================== undo =================
  describe('undo', () => {
    it('removes exactly what the apply created, and leaves what it only reused; the preview predicts it and changes nothing', async () => {
      const w = await world();
      await prisma.tag.create({ data: { workspaceId: w.ws.id, name: 'exam', nameKey: 'exam' } });
      const before = await counts(w.ws.id);
      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id);
      const after = await counts(w.ws.id);
      expect(after.tasks).toBe(9);

      const preview = await applier.previewUndo(w.admin.id, r.installId);
      expect(preview.deleted).toMatchObject({ TASK: 9, PROJECT: 1, TAG: 3, CUSTOM_FIELD: 2, ISSUE_TYPE: 3, ITERATION: 2 });
      expect(preview.edited).toEqual({});
      expect(preview.inUse).toEqual({});
      expect(await counts(w.ws.id)).toEqual(after); // a preview is a rolled-back run
      expect((await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } })).status).toBe('APPLIED');

      const done = await applier.undo(w.admin.id, r.installId);
      expect(done.deleted).toEqual(preview.deleted);
      expect(await counts(w.ws.id)).toEqual(before);
      expect(await prisma.tag.findFirst({ where: { workspaceId: w.ws.id, nameKey: 'exam' } })).not.toBeNull(); // the reused one stays
      const install = await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } });
      expect(install.status).toBe('UNDONE');
      expect(install.undoneAt).not.toBeNull();
      expect(await prisma.templateInstallItem.count({ where: { installId: r.installId, action: 'CREATED', undoneAt: null } })).toBe(0);
      await expect(applier.undo(w.admin.id, r.installId)).rejects.toMatchObject({ response: { code: 'ALREADY_UNDONE' } });
    });

    it('what was EDITED since is listed and kept until the person confirms; then it goes', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id);
      await new Promise((res) => setTimeout(res, 20));
      const mid = await prisma.task.findFirstOrThrow({ where: { title: 'Midterm exam' } });
      await prisma.task.update({ where: { id: mid.id }, data: { title: 'Midterm exam (my edit)' } });

      const preview = await applier.previewUndo(w.admin.id, r.installId);
      expect(preview.edited).toEqual({ TASK: 1 });
      expect(preview.inUse).toMatchObject({ PROJECT: 1 }); // the project still has a task that stays
      const first = await applier.undo(w.admin.id, r.installId);
      expect(first.deleted.TASK).toBe(8); // everything except the edited midterm
      expect(await prisma.task.findFirst({ where: { title: 'Midterm exam (my edit)' } })).not.toBeNull();
      expect(await prisma.project.count({ where: { workspaceId: w.ws.id } })).toBe(1);
      expect((await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } })).status).toBe('APPLIED'); // not fully undone

      const second = await applier.undo(w.admin.id, r.installId, { confirmEdited: true });
      expect(second.deleted.TASK).toBe(1);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      expect(await prisma.project.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      expect((await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } })).status).toBe('UNDONE');
    });

    it('things other work depends on are NEVER deleted, even with confirmation', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id);
      const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: w.ws.id } });
      await new Promise((res) => setTimeout(res, 20));
      // the user's own task in the template's project, using a template tag, field, type and iteration
      const mine = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.alice.id, projectId: project.id, title: 'my own' });
      const exam = await prisma.tag.findFirstOrThrow({ where: { workspaceId: w.ws.id, nameKey: 'exam' } });
      await prisma.taskTag.create({ data: { taskId: mine.id, tagId: exam.id } });
      const type = await prisma.issueType.findFirstOrThrow({ where: { workspaceId: w.ws.id, nameKey: 'assignment' } });
      await prisma.task.update({ where: { id: mine.id }, data: { issueTypeId: type.id } });
      // a comment on a template task, and a subtask the user added under another
      const lab = await prisma.task.findFirstOrThrow({ where: { title: 'Final exam' } });
      await prisma.comment.create({ data: { targetType: 'TASK', targetId: lab.id, authorId: w.alice.id, content: 'mine' } });
      const notes = await prisma.task.findFirstOrThrow({ where: { title: 'Review lecture notes' } });
      await createTask(prisma, { workspaceId: w.ws.id, createdById: w.alice.id, projectId: project.id, title: 'my subtask', parent: { connect: { id: notes.id } } });

      const result = await applier.undo(w.admin.id, r.installId, { confirmEdited: true });
      expect(await prisma.task.findFirst({ where: { title: 'my own' } })).not.toBeNull();
      expect(await prisma.task.findFirst({ where: { title: 'my subtask' } })).not.toBeNull();
      expect(await prisma.task.findFirst({ where: { title: 'Final exam' } })).not.toBeNull(); // has a comment
      expect(await prisma.task.findFirst({ where: { title: 'Review lecture notes' } })).not.toBeNull(); // has a subtask of the user's
      expect(await prisma.task.findFirst({ where: { title: 'Midterm exam' } })).not.toBeNull(); // its child is kept, so it is kept
      expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();
      expect(await prisma.tag.findUnique({ where: { id: exam.id } })).not.toBeNull();
      expect(await prisma.issueType.findUnique({ where: { id: type.id } })).not.toBeNull();
      expect(result.inUse).toMatchObject({ PROJECT: 1, TAG: 1 });
      expect(result.inUse.ISSUE_TYPE).toBeGreaterThanOrEqual(1); // kept tasks still use them
      expect(result.examples.inUse.map((e) => e.reason).join(' ')).toMatch(/comments|subtasks|used/);
      // what nothing depended on is gone
      expect(await prisma.task.findFirst({ where: { title: 'Read chapter 1 of Biology 101' } })).toBeNull();
      expect((await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } })).status).toBe('APPLIED');
    });

    it('needs ADMIN; a member cannot undo, and cannot see an install of a workspace they cannot access', async () => {
      const w = await world();
      const t = await store(w, 'student-workspace');
      const r = await apply(w, t.id);
      await expect(applier.assertCanUndo(w.admin.id, r.installId)).resolves.toBeUndefined();
      await expect(applier.assertCanUndo(w.alice.id, r.installId)).rejects.toBeInstanceOf(NotFoundException);
      const outsider = await createUser(prisma);
      await expect(applier.getInstall(outsider.id, r.installId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an apply that is still running cannot be undone', async () => {
      const w = await world();
      const i = await prisma.templateInstall.create({ data: { templateName: 'x', versionSemver: '1.0.0', versionChecksum: 'sha256:' + 'a'.repeat(64), accountId: w.account.id, workspaceId: w.ws.id, appliedById: w.admin.id, mode: 'MERGE' } });
      await expect(applier.undo(w.admin.id, i.id)).rejects.toMatchObject({ response: { code: 'APPLY_IN_PROGRESS' } });
    });
  });

  // ================================================================== the template can go ==
  it('the install history survives deleting the template (versionId becomes null, snapshots remain)', async () => {
    const w = await world();
    const t = await store(w, 'student-workspace');
    const r = await apply(w, t.id);
    await templates.delete(t.id);
    const install = await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } });
    expect(install.versionId).toBeNull();
    expect(install).toMatchObject({ templateName: 'Student workspace', versionSemver: '1.0.0', status: 'APPLIED' });
    await expect(applier.undo(w.admin.id, r.installId)).resolves.toMatchObject({ deleted: { TASK: 9 } }); // undo needs only the items
  });

  // ================================================================== round trip ===========
  describe('ROUND TRIP: workspace -> template -> apply -> workspace', () => {
    /** Same shape regardless of how nodeKeys happened to be numbered. */
    function shape(bp: any) {
      const keys = new Map<string, string>();
      let p = 0, t = 0, i = 0;
      const walk = (tasks: any[]) => tasks.forEach((x) => { keys.set(x.nodeKey, `T${++t}`); walk(x.children ?? []); });
      [...bp.projects].sort((a: any, b: any) => a.name.localeCompare(b.name)).forEach((pr: any) => { keys.set(pr.nodeKey, `P${++p}`); walk(pr.tasks); });
      (bp.workspace.iterations ?? []).forEach((it: any) => keys.set(it.nodeKey, `I${++i}`));
      const k = (x?: string) => (x === undefined ? undefined : keys.get(x));
      const task = (x: any): any => ({ ...x, nodeKey: k(x.nodeKey), iteration: k(x.iteration), children: x.children?.map(task) });
      return JSON.parse(JSON.stringify({
        variables: bp.variables, dateAnchor: bp.dateAnchor, roles: bp.roles,
        tags: bp.workspace.tags, customFields: bp.workspace.customFields, issueTypes: bp.workspace.issueTypes,
        iterations: (bp.workspace.iterations ?? []).map((it: any) => ({ ...it, nodeKey: k(it.nodeKey), project: k(it.project) })),
        projects: [...bp.projects].sort((a: any, b: any) => a.name.localeCompare(b.name)).map((pr: any) => ({
          ...pr, nodeKey: k(pr.nodeKey), tasks: pr.tasks.map(task),
          dependencies: (pr.dependencies ?? []).map((d: any) => ({ ...d, from: k(d.from), to: k(d.to) })),
        })),
      }));
    }

    it.each(['student-workspace', 'sprint-board', 'content-calendar'] as const)('%s: apply, export, apply the export elsewhere, export again: the two exports are structurally equal', async (name) => {
      const w = await world();
      const answers: any = { 'student-workspace': { variables: STUDENT, modules: { labs: true } }, 'sprint-board': { variables: { team: 'Core' } }, 'content-calendar': { variables: { launchDate: '2026-10-12', brand: 'Acme' } } }[name];
      const src = await store(w, name);
      const first = await apply(w, src.id, answers);
      const ws2 = await createWorkspace(prisma, { accountId: w.account.id, name: 'Second', key: 'SEC' });

      const bpA = (await templates.exportFromWorkspace(w.ws.id, w.admin.id, {})).template;
      const exportedA = (await templates.getVersion(bpA.id, 'latest', w.admin.id)).blueprint as any;
      const a = await applier.apply(w.admin.id, bpA.id, { workspaceId: ws2.id, variables: { startDate: exportedA.variables?.[0] ? await anchorOf(exportedA) : undefined }, mode: 'NEW_WORKSPACE' } as any, { today: TODAY }) as any;
      const bpB = (await templates.exportFromWorkspace(ws2.id, w.admin.id, {})).template;
      const exportedB = (await templates.getVersion(bpB.id, 'latest', w.admin.id)).blueprint as any;

      expect(shape(exportedB)).toEqual(shape(exportedA));
      expect(a.plan.counts.tasks).toBe((await counts(w.ws.id)).tasks);
      expect(await counts(ws2.id)).toMatchObject({ tasks: (await counts(w.ws.id)).tasks, projects: (await counts(w.ws.id)).projects, tags: (await counts(w.ws.id)).tags });
      expect(first.installId).toBeDefined();

      /** The sanitised export holds offsets from the earliest date; apply it with that same earliest date. */
      async function anchorOf(_bp: unknown): Promise<string> {
        const report = (await templates.exportFromWorkspace(w.ws.id, w.admin.id, {})).report; // a second export, only to read the anchor
        return report.anchor!.date;
      }
    });
  });

  // ================================================================== large ================
  it('a 5 000-node template applies and undoes in one go; timings recorded', async () => {
    const w = await world();
    const t = await store(w, bigBlueprint(4990));
    const t0 = Date.now();
    const r: any = await applier.apply(w.admin.id, t.id, { workspaceId: w.ws.id, variables: {} } as any, { today: TODAY });
    const applyMs = Date.now() - t0;
    expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(4990);
    expect(r.report.tasks).toBe(4990);
    const numbers = await prisma.task.aggregate({ where: { workspaceId: w.ws.id }, _min: { number: true }, _max: { number: true } });
    expect([numbers._min.number, numbers._max.number]).toEqual([1, 4990]);
    const t1 = Date.now();
    const u = await applier.undo(w.admin.id, r.installId);
    const undoMs = Date.now() - t1;
    expect(u.deleted.TASK).toBe(4990);
    expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[step 3.6] 4990 tasks: apply ${applyMs} ms, undo ${undoMs} ms`);
  });
});

/** A valid PROJECT blueprint with `n` tasks: every 10th a root with 9 subtasks hanging off the previous root (2 levels). */
function bigBlueprint(n: number) {
  const tasks: any[] = [];
  for (let i = 0; i < n; i += 10) {
    const root: any = { nodeKey: `r${i}`, title: `Root ${i}`, children: [] };
    for (let j = 1; j < 10 && i + j < n; j++) root.children.push({ nodeKey: `c${i}-${j}`, title: `Task ${i + j}` });
    tasks.push(root);
  }
  return { schemaVersion: 1, meta: { name: `Big ${n}`, kind: 'PROJECT' }, projects: [{ nodeKey: 'big', name: 'Big', tasks }] };
}
