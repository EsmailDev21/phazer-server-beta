/**
 * Step 5.5 on a real database: templates that carry automations and saved views.
 *   publish   - items that say what they are (kind rule.v1 / view.v1) must hold up; everything else stays opaque
 *   preview   - what each item will become, before anything is written
 *   apply     - automations always OFF, raw items kept inert, views personal unless an admin applies
 *   undo      - removes what it made, keeps what a person changed
 *   extract   - a workspace's rules and SHARED views go back into a template as names, no ids, no people
 */
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { AccountType, PlanKey, Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { AUTOMATION_LIMITS } from '../../src/automations/dsl';
import { STORAGE_PROVIDER } from '../../src/attachments/storage/storage-provider.interface';
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
import { TemplateAssetsService } from '../../src/templates/assets/template-assets.service';
import { fixtureJson } from '../../src/templates/blueprint/blueprint.fixtures';
import { TemplateExtractionService } from '../../src/templates/extract';
import { TemplatesModule } from '../../src/templates/templates.module';
import { TemplatesService } from '../../src/templates/templates.service';
import {
  addAccountMember,
  createAccount,
  createUser,
  createWorkspace,
} from './factories';
import { MemoryStorage } from './support/memory-storage';
import { stageDeclaredAssets } from './support/template-assets';
import {
  disconnectTestPrisma,
  getTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

jest.setTimeout(180_000);
const TODAY = '2026-10-09';
const STUDENT = { semesterStart: '2026-09-01', course: 'Biology 101' };

const RULES = {
  flagExams: {
    kind: 'rule.v1',
    name: 'Flag exams in review',
    trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 'review' }] },
    conditions: { all: [{ field: 'ISSUE_TYPE', op: 'IN', value: ['Exam'] }] },
    actions: [
      {
        type: 'SET_CUSTOM_FIELD',
        customFieldId: 'prof-review',
        value: 'pending',
      },
      { type: 'ADD_TAG', tagId: 'exam' },
      { type: 'COMMENT', body: '{{task.key}} is ready for review' },
    ],
  },
  readBrief: {
    kind: 'rule.v1',
    name: 'Read the brief first',
    trigger: { type: 'TASK_CREATED' },
    conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
    actions: [
      { type: 'CREATE_SUBTASK', title: 'Read the brief for {{task.title}}' },
    ],
  },
  titleWatcher: {
    kind: 'rule.v1',
    name: 'Watch titles',
    trigger: { type: 'FIELD_CHANGED', field: 'TITLE' },
    actions: [{ type: 'ADD_TAG', tagId: 'exam' }],
  }, // valid, cannot run yet
  legacy: { name: 'Legacy rule', when: 'status = done', then: 'set closedAt' }, // not portable: carried inert
};
const VIEWS = {
  examBoard: {
    kind: 'view.v1',
    name: 'Exams by status',
    layout: 'BOARD',
    shared: true,
    config: {
      group: { by: 'STATUS' },
      filters: { all: [{ field: 'ISSUE_TYPE', op: 'IN', value: ['Exam'] }] },
    },
  },
  mine: {
    kind: 'view.v1',
    name: 'My open work',
    layout: 'LIST',
    config: {
      filters: {
        all: [
          { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] },
          { field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] },
        ],
      },
      sort: [{ customFieldId: 'exam-weight', dir: 'DESC' }],
      columns: ['KEY', 'TITLE', 'custom:exam-weight'],
    },
  },
  legacy: { name: 'Legacy view', filter: { anything: true } },
};

describe('Templates that carry automations and saved views (step 5.5)', () => {
  let prisma: PrismaService;
  let templates: TemplatesService;
  let applier: TemplateApplyService;
  let extractor: TemplateExtractionService;
  const storage = new MemoryStorage();

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: WorkspacesService, useValue: {} },
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
        DomainWriter,
        TemplateExtractionService,
        TemplateAssetsService,
        TemplatesService,
        TemplateApplyService,
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();
    new TemplatesModule(moduleRef.get(PlanLimitsService)).onModuleInit();
    templates = moduleRef.get(TemplatesService);
    applier = moduleRef.get(TemplateApplyService);
    extractor = moduleRef.get(TemplateExtractionService);
  });
  beforeEach(async () => {
    storage.reset();
    await resetDb(prisma);
  });
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const account = await createAccount(prisma, {
      type: AccountType.ORGANIZATION,
      planType: PlanKey.ENTERPRISE_ORG,
    });
    const mk = async (role: Role) => {
      const u = await createUser(prisma);
      await addAccountMember(prisma, {
        accountId: account.id,
        userId: u.id,
        role,
      });
      return u;
    };
    const [admin, member] = [await mk(Role.OWNER), await mk(Role.MEMBER)];
    const ws = await createWorkspace(prisma, {
      accountId: account.id,
      name: 'Target',
      key: 'TGT',
    });
    return { account, admin, member, ws };
  }
  type W = Awaited<ReturnType<typeof world>>;

  /** The student blueprint with portable items on its "coursework" project. */
  const blueprint = (automations: unknown[], views: unknown[]) => {
    const bp = fixtureJson('student-workspace') as any;
    const p = bp.projects.find((x: any) => x.nodeKey === 'coursework');
    p.automations = automations;
    p.views = views;
    return bp;
  };
  const store = (w: W, bp: Record<string, unknown>) => {
    const staged = stageDeclaredAssets(storage, bp as any);
    return templates.createFromBlueprint(
      w.account.id,
      w.admin.id,
      { blueprint: bp, visibility: 'ACCOUNT' as any },
      undefined,
      { id: staged.id, assets: staged.assets },
    );
  };
  const rejected = async (w: W, bp: Record<string, unknown>) => {
    try {
      await store(w, bp);
    } catch (e: any) {
      return (e.getResponse?.().issues ?? []).map(
        (i: any) => `${i.code}@${i.path}`,
      ) as string[];
    }
    throw new Error('expected the template to be refused');
  };
  const applyAs = (
    userId: string,
    w: W,
    templateId: string,
    extra: Record<string, unknown> = {},
  ) =>
    applier.apply(
      userId,
      templateId,
      { workspaceId: w.ws.id, variables: STUDENT, ...extra } as any,
      { today: TODAY },
    ) as Promise<any>;
  const previewAs = (userId: string, w: W, templateId: string) =>
    applier.preview(
      userId,
      templateId,
      { workspaceId: w.ws.id, variables: STUDENT } as any,
      { today: TODAY },
    ) as Promise<any>;
  /** The fixture names its projects "{{course}}: coursework", so the applied one is "Biology 101: coursework". */
  const courseworkOf = (w: W) =>
    prisma.project.findFirstOrThrow({
      where: { workspaceId: w.ws.id, name: 'Biology 101: coursework' },
    });
  const FULL = () =>
    blueprint(
      [RULES.flagExams, RULES.readBrief, RULES.titleWatcher, RULES.legacy],
      [VIEWS.examBoard, VIEWS.mine, VIEWS.legacy],
    );

  // =============================================================== publish ======================
  describe('publishing a template that carries them', () => {
    it('accepts valid portable items, and raw ones stay opaque (as they always were)', async () => {
      const w = await world();
      const t = await store(w, FULL());
      expect(t.latestVersion?.semver).toBe('1.0.0');
    });

    it.each([
      [
        'an unknown tag',
        { ...RULES.flagExams, actions: [{ type: 'ADD_TAG', tagId: 'nope' }] },
        'AUTOMATION_INVALID@/projects/0/automations/0/actions/0/tagId',
      ],
      [
        'a status the project does not define',
        {
          ...RULES.flagExams,
          trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 'nowhere' }] },
        },
        'AUTOMATION_INVALID@/projects/0/automations/0/trigger/to/0/statusId',
      ],
      [
        'a person',
        {
          ...RULES.flagExams,
          actions: [{ type: 'ASSIGN', mode: 'ADD', users: ['u123'] }],
        },
        'AUTOMATION_INVALID@/projects/0/automations/0/actions/0/users/0',
      ],
      [
        'a chat channel',
        {
          ...RULES.flagExams,
          actions: [
            { type: 'NOTIFY_CHANNEL', channelLinkId: 'cl', message: 'x' },
          ],
        },
        'AUTOMATION_INVALID@/projects/0/automations/0/actions/0/channelLinkId',
      ],
      [
        'a value the field cannot hold',
        {
          ...RULES.flagExams,
          actions: [
            {
              type: 'SET_CUSTOM_FIELD',
              customFieldId: 'prof-review',
              value: 'maybe',
            },
          ],
        },
        'AUTOMATION_INVALID@/projects/0/automations/0/actions/0/value',
      ],
      [
        'a rule that creates what triggers it',
        {
          kind: 'rule.v1',
          name: 'Loop',
          trigger: { type: 'TASK_CREATED' },
          actions: RULES.readBrief.actions,
        },
        'AUTOMATION_INVALID@/projects/0/automations/0/actions/0',
      ],
      [
        'an unknown key',
        { ...RULES.flagExams, extra: 1 },
        'AUTOMATION_INVALID@/projects/0/automations/0/extra',
      ],
    ])(
      'refuses an automation with %s, naming where',
      async (_l, rule, expected) => {
        const w = await world();
        expect(await rejected(w, blueprint([rule], []))).toContain(expected);
        expect(await prisma.template.count()).toBe(0);
      },
    );

    it.each([
      [
        'an unknown layout',
        { ...VIEWS.mine, layout: 'GANTT' },
        'VIEW_INVALID@/projects/0/views/0/layout',
      ],
      [
        'a calendar without its date',
        { ...VIEWS.mine, layout: 'CALENDAR', config: {} },
        'VIEW_INVALID@/projects/0/views/0/config/calendar',
      ],
      [
        'an unknown iteration',
        {
          ...VIEWS.mine,
          config: {
            filters: {
              all: [{ field: 'ITERATION', op: 'IN', value: ['nope'] }],
            },
          },
        },
        'VIEW_INVALID@/projects/0/views/0/config/filters/all/0/value/0',
      ],
      [
        'a custom field it cannot group by',
        { ...VIEWS.mine, config: { group: { customFieldId: 'exam-weight' } } },
        'VIEW_INVALID@/projects/0/views/0/config/group/customFieldId',
      ],
      [
        'the rule token ME replaced by a rule token',
        {
          ...VIEWS.mine,
          config: {
            filters: {
              all: [
                {
                  field: 'ASSIGNEES',
                  op: 'INCLUDES_ANY',
                  value: ['TRIGGERER'],
                },
              ],
            },
          },
        },
        'VIEW_INVALID@/projects/0/views/0/config/filters/all/0/value/0',
      ],
    ])('refuses a view with %s', async (_l, view, expected) => {
      const w = await world();
      expect(await rejected(w, blueprint([], [view]))).toContain(expected);
    });

    it('names must be unique within a project, for each kind', async () => {
      const w = await world();
      expect(
        await rejected(
          w,
          blueprint(
            [
              RULES.flagExams,
              { ...RULES.readBrief, name: ' FLAG   exams in review' },
            ],
            [],
          ),
        ),
      ).toContain('DUPLICATE@/projects/0/automations/1/name');
      expect(
        await rejected(
          w,
          blueprint(
            [],
            [VIEWS.mine, { ...VIEWS.examBoard, name: 'my open work' }],
          ),
        ),
      ).toContain('DUPLICATE@/projects/0/views/1/name');
    });

    it('an item with no recognised kind is never interpreted, whatever it contains', async () => {
      const w = await world();
      await expect(
        store(
          w,
          blueprint(
            [
              {
                trigger: { type: 'RUN_SCRIPT' },
                actions: [{ type: 'ADD_TAG', tagId: 'nope' }],
              },
              { kind: 'rule.v9', anything: [1, 2] },
            ],
            [{ kind: 'view.v9' }],
          ),
        ),
      ).resolves.toBeDefined();
    });
  });

  // =============================================================== preview ======================
  describe('the preview says what each item becomes', () => {
    it('counts, names and warnings: created OFF, raw kept, unsupported flagged, unreadable views skipped', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await previewAs(w.admin.id, w, t.id);
      expect(r.plan.counts.automations).toEqual({ create: 3, raw: 1, skip: 0 });
      expect(r.plan.counts.savedViews).toEqual({
        personal: 1,
        shared: 1,
        skip: 1,
      });
      expect(
        r.plan.automations.map((a: any) => [a.name, a.action, a.unsupported]),
      ).toEqual([
        ['Flag exams in review', 'CREATE', 0],
        ['Read the brief first', 'CREATE', 0],
        ['Watch titles', 'CREATE', 1],
        ['Legacy rule', 'RAW', 0],
      ]);
      const codes = r.plan.warnings.map((x: any) => x.code);
      expect(codes).toEqual(
        expect.arrayContaining(['AUTOMATIONS_CREATED_OFF', 'VIEW_SKIPPED']),
      );
      expect(codes).not.toContain('VIEW_NOT_SHARED');
      expect(JSON.stringify(r.plan)).not.toContain('Read the brief for'); // a plan has names and counts, never the rules' text
      expect(await prisma.automation.count()).toBe(0); // and writes nothing
    });
    it('a person who cannot share is told their shared views become personal', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await previewAs(w.member.id, w, t.id);
      expect(r.plan.counts.savedViews).toEqual({
        personal: 2,
        shared: 0,
        skip: 1,
      });
      expect(r.plan.warnings.map((x: any) => x.code)).toContain(
        'VIEW_NOT_SHARED',
      );
    });
    it("an item that cannot bind HERE is skipped with the reason: the workspace's own field wins, so its options decide", async () => {
      const w = await world();
      await prisma.customField.create({
        data: {
          workspaceId: w.ws.id,
          key: 'prof-review',
          name: 'Review',
          dataType: 'SELECT',
          options: ['open', 'closed'],
        },
      });
      const t = await store(w, FULL());
      const r = await previewAs(w.admin.id, w, t.id);
      const skipped = r.plan.automations.filter(
        (a: any) => a.action === 'SKIP',
      );
      expect(skipped.map((a: any) => a.name)).toEqual(['Flag exams in review']);
      expect(skipped[0].reason).toMatch(/VALUE_MISMATCH/);
      expect(r.plan.warnings.map((x: any) => x.code)).toContain(
        'AUTOMATION_SKIPPED',
      );
    });
    it('a name already used in the workspace gets a number, in the preview and in the result', async () => {
      const w = await world();
      await prisma.automation.create({
        data: {
          workspaceId: w.ws.id,
          name: 'Watch titles',
          nameKey: 'watch titles',
          enabled: false,
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: {},
          sourceDefinition: { a: 1 },
          createdById: w.admin.id,
        },
      });
      const t = await store(w, FULL());
      const plan = (await previewAs(w.admin.id, w, t.id)).plan;
      expect(
        plan.automations.find((a: any) => a.name === 'Watch titles'),
      ).toMatchObject({ finalName: 'Watch titles (2)' });
      expect(plan.warnings.map((x: any) => x.code)).toContain(
        'AUTOMATION_RENAMED',
      );
      await applyAs(w.admin.id, w, t.id);
      expect(
        (
          await prisma.automation.findMany({
            where: { workspaceId: w.ws.id },
            orderBy: { name: 'asc' },
          })
        ).map((a) => a.name),
      ).toEqual(expect.arrayContaining(['Watch titles', 'Watch titles (2)']));
    });
    it('limits are blockers: too many automations, too many personal views', async () => {
      const w = await world();
      await prisma.automation.createMany({
        data: Array.from(
          { length: AUTOMATION_LIMITS.maxAutomationsPerWorkspace - 2 },
          (_, i) => ({
            workspaceId: w.ws.id,
            name: `bulk ${i}`,
            nameKey: `bulk ${i}`,
            enabled: false,
            ruleVersion: 0,
            triggerType: 'RAW',
            trigger: {},
            sourceDefinition: { i },
            createdById: w.admin.id,
          }),
        ),
      });
      const t = await store(w, FULL());
      const r = await previewAs(w.admin.id, w, t.id);
      expect(r.plan.blockers.map((b: any) => b.code)).toContain(
        'AUTOMATION_LIMIT',
      );
      await expect(applyAs(w.admin.id, w, t.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        await prisma.project.count({ where: { workspaceId: w.ws.id } }),
      ).toBe(0);
    });
  });

  // =============================================================== apply ========================
  describe('applying', () => {
    it("creates the automations OFF, bound to the workspace's own ids, attributed to the person applying", async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await applyAs(w.admin.id, w, t.id);
      expect(r.report).toMatchObject({
        automations: 4,
        savedViews: 2,
        portableSkipped: 0,
      });

      const coursework = await courseworkOf(w);
      const rows = await prisma.automation.findMany({
        where: { workspaceId: w.ws.id },
        orderBy: { name: 'asc' },
      });
      expect(
        rows.map((a) => [
          a.name,
          a.enabled,
          a.ruleVersion,
          a.createdVia,
          a.projectId === coursework.id,
          a.createdById === w.admin.id,
        ]),
      ).toEqual([
        ['Flag exams in review', false, 1, 'TEMPLATE', true, true],
        ['Legacy rule', false, 0, 'TEMPLATE', true, true],
        ['Read the brief first', false, 1, 'TEMPLATE', true, true],
        ['Watch titles', false, 1, 'TEMPLATE', true, true],
      ]);
      const flag = rows.find((a) => a.name === 'Flag exams in review')!;
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: {
          projectId: coursework.id,
          name: { contains: 'review', mode: 'insensitive' },
        },
      });
      const exam = await prisma.issueType.findFirstOrThrow({
        where: { workspaceId: w.ws.id, name: 'Exam' },
      });
      const field = await prisma.customField.findFirstOrThrow({
        where: { workspaceId: w.ws.id, key: 'prof-review' },
      });
      const tag = await prisma.tag.findFirstOrThrow({
        where: { workspaceId: w.ws.id, name: 'exam' },
      });
      expect(flag.trigger).toEqual({
        type: 'STATUS_CHANGED',
        to: [{ statusId: review.id }],
      });
      expect(flag.conditions).toEqual({
        all: [{ field: 'ISSUE_TYPE', op: 'IN', value: [exam.id] }],
      });
      expect(flag.actions).toEqual([
        { type: 'SET_CUSTOM_FIELD', customFieldId: field.id, value: 'pending' },
        { type: 'ADD_TAG', tagId: tag.id },
        { type: 'COMMENT', body: '{{task.key}} is ready for review' },
      ]);
      expect(flag.unsupported).toEqual([]);
      // what cannot run yet is stored with its reason; the raw item is kept exactly as received, inert
      expect(
        (rows.find((a) => a.name === 'Watch titles')!.unsupported as any[]).map(
          (u) => u.construct,
        ),
      ).toEqual(['FIELD_CHANGED(TITLE)']);
      const legacy = rows.find((a) => a.name === 'Legacy rule')!;
      expect(legacy).toMatchObject({
        triggerType: 'RAW',
        trigger: {},
        actions: [],
        sourceDefinition: RULES.legacy,
      });
    });

    it('nothing a template creates can run: not now, and not by being a database row (CHECKs hold)', async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.admin.id, w, t.id);
      expect(
        await prisma.automation.count({
          where: { workspaceId: w.ws.id, enabled: true },
        }),
      ).toBe(0);
      await expect(
        prisma.automation.updateMany({
          where: { workspaceId: w.ws.id, ruleVersion: 0 },
          data: { enabled: true },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.automation.updateMany({
          where: { workspaceId: w.ws.id, name: 'Watch titles' },
          data: { enabled: true },
        }),
      ).rejects.toThrow();
    });

    it('views: an admin gets the shared one shared; the other is theirs; everything is bound to this workspace', async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.admin.id, w, t.id);
      const views = await prisma.savedView.findMany({
        where: { workspaceId: w.ws.id },
        orderBy: { name: 'asc' },
      });
      const coursework = await courseworkOf(w);
      expect(
        views.map((v) => [
          v.name,
          v.layout,
          v.isShared,
          v.ownerId === w.admin.id,
          v.projectId === coursework.id,
        ]),
      ).toEqual([
        ['Exams by status', 'BOARD', true, true, true],
        ['My open work', 'LIST', false, true, true],
      ]);
      const weight = await prisma.customField.findFirstOrThrow({
        where: { workspaceId: w.ws.id, key: 'exam-weight' },
      });
      const mine = views.find((v) => v.name === 'My open work')!;
      expect(mine.config).toEqual({
        filters: {
          all: [
            { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] },
            { field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] },
          ],
        },
        sort: [{ customFieldId: weight.id, dir: 'DESC' }],
        columns: ['KEY', 'TITLE', `custom:${weight.id}`],
      });
    });

    it('a member applying cannot share: the "shared" view becomes theirs alone', async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.member.id, w, t.id);
      const views = await prisma.savedView.findMany({
        where: { workspaceId: w.ws.id },
      });
      expect(views).toHaveLength(2);
      expect(views.every((v) => !v.isShared && v.ownerId === w.member.id)).toBe(
        true,
      );
    });

    it('the result equals the preview, item for item', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const plan = (await previewAs(w.admin.id, w, t.id)).plan;
      const r = await applyAs(w.admin.id, w, t.id);
      expect(r.report.automations).toBe(
        plan.counts.automations.create + plan.counts.automations.raw,
      );
      expect(r.report.savedViews).toBe(
        plan.counts.savedViews.personal + plan.counts.savedViews.shared,
      );
      expect(r.plan.counts).toEqual(plan.counts);
    });

    it('a template that carries none behaves exactly as before', async () => {
      const w = await world();
      const t = await store(w, fixtureJson('student-workspace') as any);
      const r = await applyAs(w.admin.id, w, t.id);
      expect(r.report).toMatchObject({
        automations: 0,
        savedViews: 0,
        portableSkipped: 0,
      });
      expect(await prisma.automation.count()).toBe(0);
      expect(await prisma.savedView.count()).toBe(0);
    });

    it('applying twice into the same workspace merges: second set of names get numbers, none collide', async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.admin.id, w, t.id);
      await applyAs(w.admin.id, w, t.id, { mode: 'MERGE' });
      const names = (
        await prisma.automation.findMany({
          where: { workspaceId: w.ws.id },
          orderBy: { name: 'asc' },
        })
      ).map((a) => a.name);
      expect(names).toEqual([
        'Flag exams in review',
        'Flag exams in review (2)',
        'Legacy rule',
        'Legacy rule (2)',
        'Read the brief first',
        'Read the brief first (2)',
        'Watch titles',
        'Watch titles (2)',
      ]);
      expect(
        await prisma.savedView.count({ where: { workspaceId: w.ws.id } }),
      ).toBe(4);
    });
  });

  // =============================================================== undo =========================
  describe('undo', () => {
    it('removes the automations and views it created, with the project; the template is untouched', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await applyAs(w.admin.id, w, t.id);
      const done = await applier.undo(w.admin.id, r.installId);
      expect(done).toMatchObject({
        deleted: expect.objectContaining({ AUTOMATION: 4, SAVED_VIEW: 2 }),
      });
      expect(await prisma.automation.count()).toBe(0);
      expect(await prisma.savedView.count()).toBe(0);
      expect(
        await prisma.project.count({ where: { workspaceId: w.ws.id } }),
      ).toBe(0);
      expect(await prisma.template.count({ where: { id: t.id } })).toBe(1);
    });

    it('one a person has since changed (an admin turned it on) is kept with its project, unless they confirm', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await applyAs(w.admin.id, w, t.id);
      await prisma.automation.updateMany({
        where: { workspaceId: w.ws.id, name: 'Flag exams in review' },
        data: { enabled: true },
      });
      const preview = await applier.previewUndo(w.admin.id, r.installId);
      expect(JSON.stringify(preview)).toContain('AUTOMATION');
      await applier.undo(w.admin.id, r.installId);
      expect(
        (
          await prisma.automation.findMany({ where: { workspaceId: w.ws.id } })
        ).map((a) => a.name),
      ).toEqual(['Flag exams in review']);
      expect(
        await prisma.project.count({
          where: { workspaceId: w.ws.id, name: 'Biology 101: coursework' },
        }),
      ).toBe(1); // still holds a rule somebody uses
    });

    it('confirming removes the edited one too', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await applyAs(w.admin.id, w, t.id);
      await prisma.automation.updateMany({
        where: { workspaceId: w.ws.id, name: 'Flag exams in review' },
        data: { enabled: true },
      });
      await prisma.savedView.updateMany({
        where: { workspaceId: w.ws.id, name: 'My open work' },
        data: { name: 'Renamed by me' },
      });
      await applier.undo(w.admin.id, r.installId, { confirmEdited: true });
      expect(await prisma.automation.count()).toBe(0);
      expect(await prisma.savedView.count()).toBe(0);
    });

    it('a rule or view someone ELSE added to the same project is never removed by an undo, and keeps the project', async () => {
      const w = await world();
      const t = await store(w, FULL());
      const r = await applyAs(w.admin.id, w, t.id);
      const project = await courseworkOf(w);
      await prisma.automation.create({
        data: {
          workspaceId: w.ws.id,
          projectId: project.id,
          name: 'Mine',
          nameKey: 'mine',
          enabled: false,
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: {},
          sourceDefinition: { x: 1 },
          createdById: w.member.id,
        },
      });
      await applier.undo(w.admin.id, r.installId);
      expect(
        await prisma.automation.findMany({ where: { workspaceId: w.ws.id } }),
      ).toHaveLength(1);
      expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
    });

    it('undo of a failed apply leaves nothing behind (compensation covers the new entity types)', async () => {
      const w = await world();
      const t = await store(w, FULL());
      // the last stage fails after every task, project and tag exists
      const spy = jest
        .spyOn(applier as any, 'createPortable')
        .mockRejectedValueOnce(
          new Error('simulated failure while creating automations'),
        );
      await expect(applyAs(w.admin.id, w, t.id)).rejects.toBeDefined();
      spy.mockRestore();
      expect(await prisma.automation.count()).toBe(0);
      expect(await prisma.savedView.count()).toBe(0);
      expect(
        await prisma.project.count({ where: { workspaceId: w.ws.id } }),
      ).toBe(0);
    });
  });

  // =============================================================== extract ======================
  describe('exporting a workspace', () => {
    it('carries project-scoped automations and SHARED views as names; never ids, people or personal views', async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.admin.id, w, t.id);
      const { raw, report } = await extractor.extract(w.ws.id, {});
      const project = raw.projects.find(
        (p) => p.name === 'Biology 101: coursework',
      )!;
      expect(project.automations?.map((a) => a.name)).toEqual([
        'Flag exams in review',
        'Legacy rule',
        'Read the brief first',
        'Watch titles',
      ]);
      expect(project.views?.map((v) => v.name)).toEqual(['Exams by status']); // the personal "My open work" is not exported
      expect(report.automations).toMatchObject({
        included: 3,
        raw: 1,
        skipped: [],
      });
      expect(report.views).toMatchObject({ included: 1, skipped: [] });
      const text = JSON.stringify([project.automations, project.views]);
      for (const row of [
        ...(await prisma.tag.findMany()),
        ...(await prisma.issueType.findMany()),
        ...(await prisma.workflowStatus.findMany()),
        ...(await prisma.customField.findMany()),
      ])
        expect(text).not.toContain(row.id);
      expect(text).not.toContain(w.admin.id);
      expect(
        project.automations?.find((a) => a.name === 'Flag exams in review'),
      ).toMatchObject({
        kind: 'rule.v1',
        trigger: {
          type: 'STATUS_CHANGED',
          to: [{ statusId: expect.stringMatching(/review/) }],
        },
      });
      expect(
        project.automations?.find((a) => a.name === 'Legacy rule'),
      ).toEqual(RULES.legacy);
    });

    it('what cannot be named is left out and reported: a person, a deleted tag', async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.admin.id, w, t.id);
      const project = await courseworkOf(w);
      await prisma.automation.create({
        data: {
          workspaceId: w.ws.id,
          projectId: project.id,
          name: 'Assign Ana',
          nameKey: 'assign ana',
          ruleVersion: 1,
          triggerType: 'TASK_CREATED',
          trigger: { type: 'TASK_CREATED' },
          actions: [{ type: 'ASSIGN', mode: 'ADD', users: [w.member.id] }],
          createdById: w.admin.id,
        },
      });
      const tag = await prisma.tag.findFirstOrThrow({
        where: { workspaceId: w.ws.id, name: 'exam' },
      });
      await prisma.automation.updateMany({
        where: { name: 'Watch titles' },
        data: { actions: [{ type: 'ADD_TAG', tagId: 'deleted-tag-id' }] },
      });
      const { raw, report } = await extractor.extract(w.ws.id, {});
      const names = raw.projects
        .find((p) => p.name === 'Biology 101: coursework')!
        .automations!.map((a) => a.name);
      expect(names).not.toContain('Assign Ana');
      expect(names).not.toContain('Watch titles');
      expect(
        report.automations.skipped
          .map((s) => [s.name, s.reason.split(' ')[0]])
          .sort(),
      ).toEqual([
        ['Assign Ana', 'NOT_PORTABLE'],
        ['Watch titles', 'UNKNOWN_REF'],
      ]);
      expect(tag.id).toBeDefined();
    });

    it("a secret inside a rule's text is caught like any other text (block by default, redact on request)", async () => {
      const w = await world();
      const t = await store(w, FULL());
      await applyAs(w.admin.id, w, t.id);
      await prisma.automation.updateMany({
        where: { name: 'Flag exams in review' },
        data: {
          actions: [
            { type: 'COMMENT', body: 'use AKIAIOSFODNN7EXAMPLE to deploy' },
          ],
        },
      });
      await expect(
        templates.exportFromWorkspace(w.ws.id, w.admin.id, {
          onSecret: 'block',
        } as any),
      ).rejects.toBeDefined();
    });

    it('THE round trip: workspace -> template -> another workspace gives the same automations and views, still OFF', async () => {
      const a = await world();
      const t1 = await store(a, FULL());
      await applyAs(a.admin.id, a, t1.id);
      const exported = (
        await templates.exportFromWorkspace(a.ws.id, a.admin.id, {})
      ).template;

      const ws2 = await createWorkspace(prisma, {
        accountId: a.account.id,
        name: 'Second',
        key: 'SEC',
      });
      const b = { ...a, ws: ws2 };
      const r: any = await applier.apply(
        b.admin.id,
        exported.id,
        { workspaceId: ws2.id, variables: { startDate: '2026-09-01' } } as any,
        { today: TODAY },
      );
      expect(r.report).toMatchObject({ portableSkipped: 0 });
      const rowsA = await prisma.automation.findMany({
        where: { workspaceId: a.ws.id },
        orderBy: { name: 'asc' },
      });
      const rowsB = await prisma.automation.findMany({
        where: { workspaceId: b.ws.id },
        orderBy: { name: 'asc' },
      });
      expect(
        rowsB.map((x) => [x.name, x.ruleVersion, x.triggerType, x.enabled]),
      ).toEqual(
        rowsA.map((x) => [x.name, x.ruleVersion, x.triggerType, false]),
      );
      // the same rule, in the other workspace's own ids
      const flagB = rowsB.find((x) => x.name === 'Flag exams in review')!;
      const tagB = await prisma.tag.findFirstOrThrow({
        where: { workspaceId: b.ws.id, name: 'exam' },
      });
      expect((flagB.actions as any[])[1]).toEqual({
        type: 'ADD_TAG',
        tagId: tagB.id,
      });
      expect(JSON.stringify(flagB)).not.toContain(
        (
          await prisma.tag.findFirstOrThrow({
            where: { workspaceId: a.ws.id, name: 'exam' },
          })
        ).id,
      );
      expect(
        await prisma.savedView.findMany({
          where: { workspaceId: b.ws.id, isShared: true },
        }),
      ).toHaveLength(1);
    });
  });
});
