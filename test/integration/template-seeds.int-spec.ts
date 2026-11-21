/**
 * Step 3.9 on a real database: the first-party templates.
 *   seeder      - system account, idempotent (also concurrent), changed seed = new version, failure leaves nothing
 *   visibility  - PUBLIC is readable by every account, editable by none, and cannot be claimed by a customer
 *   applying    - every seed applies cleanly through the real applier, twice, and undoes to zero
 *   limits      - seeds cost the reader nothing; the system account is exempt from the plan limit
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AccountType, PlanKey, Role, TemplateVisibility } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { STORAGE_PROVIDER } from '../../src/attachments/storage/storage-provider.interface';
import { PlanLimitExceededException } from '../../src/common/exceptions/plan-limit-exceeded.exception';
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
import { AutomationsService } from '../../src/automations/automations.service';
import { WorkspaceContextLoader } from '../../src/automations/dsl/workspace-context.loader';
import { TemplateAssetsService } from '../../src/templates/assets/template-assets.service';
import { fixtureJson } from '../../src/templates/blueprint/blueprint.fixtures';
import { CreateTemplateDto } from '../../src/templates/dto/template.dto';
import { TemplateExtractionService } from '../../src/templates/extract';
import {
  SEED_DEFINITIONS,
  SeedDefinition,
  TemplateSeedService,
  prepareSeed,
} from '../../src/templates/seeds';
import { TemplatesModule } from '../../src/templates/templates.module';
import { TemplatesService } from '../../src/templates/templates.service';
import {
  addAccountMember,
  createAccount,
  createUser,
  createWorkspace,
} from './factories';
import { MemoryStorage } from './support/memory-storage';
import {
  disconnectTestPrisma,
  getTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

jest.setTimeout(180_000);
const TODAY = '2026-10-09';

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

describe('First-party templates (step 3.9)', () => {
  let prisma: PrismaService;
  let seeder: TemplateSeedService;
  let templates: TemplatesService;
  let applier: TemplateApplyService;
  let automations: AutomationsService;
  let resolver: PermissionResolver;
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
        WorkspaceContextLoader,
        AutomationsService,
        ProjectsService,
        CustomFieldsService,
        DomainWriter,
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
    templates = moduleRef.get(TemplatesService);
    applier = moduleRef.get(TemplateApplyService);
    automations = moduleRef.get(AutomationsService);
    resolver = moduleRef.get(PermissionResolver);
  });
  beforeEach(async () => {
    storage.reset();
    await resetDb(prisma);
  });
  afterAll(() => disconnectTestPrisma());

  // ------------------------------------------------------------------ helpers ------------
  /** A customer: a personal FREE account, its owner, and an empty workspace to apply into. */
  async function customer(plan: PlanKey = PlanKey.FREE_PERSONAL) {
    const account = await createAccount(prisma, {
      type: AccountType.PERSONAL,
      planType: plan,
    });
    const user = await createUser(prisma);
    await addAccountMember(prisma, {
      accountId: account.id,
      userId: user.id,
      role: Role.OWNER,
    });
    const ws = await createWorkspace(prisma, {
      accountId: account.id,
      name: 'Target',
      key: 'TGT',
    });
    return { account, user, ws };
  }
  const seedRows = () =>
    prisma.template.findMany({
      where: { seedKey: { not: null } },
      orderBy: { seedKey: 'asc' },
    });
  const dbCounts = async () => ({
    accounts: await prisma.account.count(),
    users: await prisma.user.count(),
    members: await prisma.accountMember.count(),
    templates: await prisma.template.count(),
    versions: await prisma.templateVersion.count(),
    assets: await prisma.templateAsset.count(),
    objects: storage.keys().length,
  });
  const wsCounts = async (workspaceId: string) => ({
    projects: await prisma.project.count({ where: { workspaceId } }),
    tasks: await prisma.task.count({ where: { workspaceId } }),
    tags: await prisma.tag.count({ where: { workspaceId } }),
    customFields: await prisma.customField.count({ where: { workspaceId } }),
    issueTypes: await prisma.issueType.count({ where: { workspaceId } }),
    iterations: await prisma.iteration.count({ where: { workspaceId } }),
    comments: await prisma.comment.count(),
    dependencies: await prisma.taskDependency.count(),
    attachments: await prisma.attachment.count({
      where: { storageKey: { startsWith: 'attachments/' } },
    }),
  });
  const variant = (key: string, description: string): SeedDefinition => {
    const d = JSON.parse(
      JSON.stringify(SEED_DEFINITIONS.find((x) => x.seedKey === key)),
    ) as SeedDefinition;
    (d.blueprint.meta as { description: string }).description = description;
    return d;
  };

  // =============================================================== seeder ==================
  describe('the seeder', () => {
    it('creates the system account, its owner (who cannot sign in) and the three templates, PUBLIC, version 1.0.0, with real files', async () => {
      const report = await seeder.seedAll();
      expect(report.systemAccountCreated).toBe(true);
      expect(
        report.results.map((r) => [r.seedKey, r.action, r.semver]),
      ).toEqual([
        ['student-workspace', 'created', '1.0.0'],
        ['sprint-board', 'created', '1.0.0'],
        ['content-calendar', 'created', '1.0.0'],
      ]);

      const account = await prisma.account.findUniqueOrThrow({
        where: { id: report.systemAccountId },
      });
      expect(account).toMatchObject({ isSystem: true, type: 'PERSONAL' });
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: account.personalOwnerId! },
      });
      expect(owner.password).toBeNull();
      expect(owner.googleId).toBeNull();
      expect(owner.email.endsWith('.invalid')).toBe(true);
      expect(
        await prisma.accountMember.count({
          where: { accountId: account.id, role: 'OWNER', userId: owner.id },
        }),
      ).toBe(1);

      const rows = await seedRows();
      expect(rows.map((r) => r.seedKey)).toEqual([
        'content-calendar',
        'sprint-board',
        'student-workspace',
      ]);
      for (const t of rows) {
        expect(t).toMatchObject({
          visibility: 'PUBLIC',
          ownerAccountId: account.id,
          createdById: owner.id,
          sourceTemplateId: null,
        });
        const versions = await prisma.templateVersion.findMany({
          where: { templateId: t.id },
        });
        expect(versions).toHaveLength(1);
        expect(await templates.verifyIntegrity(versions[0].id)).toEqual({
          ok: true,
        });
        const def = SEED_DEFINITIONS.find((d) => d.seedKey === t.seedKey)!;
        const prepared = prepareSeed(def);
        expect(prepared.ok && versions[0].checksum === prepared.checksum).toBe(
          true,
        );
      }
      // the student template's file is stored with its REAL bytes, under the template, with a matching row
      const student = rows.find((r) => r.seedKey === 'student-workspace')!;
      const asset = await prisma.templateAsset.findFirstOrThrow({
        where: { templateId: student.id },
      });
      expect(asset).toMatchObject({
        fileName: 'essay-rubric.md',
        mimeType: 'text/markdown',
      });
      const stored = await storage.getObject(asset.storageKey, 1 << 20);
      expect(stored.length).toBe(asset.sizeBytes);
      expect(stored.toString('utf8')).toContain('# Essay rubric');
    });

    it('running it again changes nothing: same rows, same checksums, same version ids, no new objects', async () => {
      await seeder.seedAll();
      const before = await dbCounts();
      const versionsBefore = await prisma.templateVersion.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, checksum: true, semver: true },
      });
      const puts = storage.count('put');

      const again = await seeder.seedAll();
      expect(again.systemAccountCreated).toBe(false);
      expect(again.results.map((r) => r.action)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
      ]);
      expect(again.results.every((r) => r.metaUpdated === false)).toBe(true);
      expect(await dbCounts()).toEqual(before);
      expect(
        await prisma.templateVersion.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, checksum: true, semver: true },
        }),
      ).toEqual(versionsBefore);
      expect(storage.count('put')).toBe(puts);
      await seeder.seedAll(); // and a third time
      expect(await dbCounts()).toEqual(before);
    });

    it('several instances seeding at the same moment still produce exactly one set', async () => {
      const reports = await Promise.all([
        seeder.seedAll(),
        seeder.seedAll(),
        seeder.seedAll(),
        seeder.seedAll(),
      ]);
      expect(await prisma.account.count({ where: { isSystem: true } })).toBe(1);
      expect(await prisma.template.count()).toBe(3);
      expect(await prisma.templateVersion.count()).toBe(3);
      expect(await prisma.templateAsset.count()).toBe(1);
      expect(new Set(reports.map((r) => r.systemAccountId)).size).toBe(1);
      expect(
        reports.flatMap((r) => r.results).filter((r) => r.action === 'created'),
      ).toHaveLength(3); // each created once, by exactly one run
    });

    it('a CHANGED seed publishes a new version through the normal path; the old version is untouched', async () => {
      await seeder.seedAll();
      const student = (await seedRows()).find(
        (r) => r.seedKey === 'student-workspace',
      )!;
      const v1 = await prisma.templateVersion.findFirstOrThrow({
        where: { templateId: student.id, sequence: 1 },
      });

      const changed = SEED_DEFINITIONS.map((d) =>
        d.seedKey === 'student-workspace'
          ? {
              ...variant(
                'student-workspace',
                'A semester of one course, now with a lab option.',
              ),
              changelog: 'Reworded.',
            }
          : d,
      );
      const r = await seeder.seedAll(changed);
      expect(r.results.map((x) => [x.seedKey, x.action])).toEqual([
        ['student-workspace', 'versioned'],
        ['sprint-board', 'unchanged'],
        ['content-calendar', 'unchanged'],
      ]);
      expect(r.results[0].semver).toBe('1.1.0');

      const versions = await prisma.templateVersion.findMany({
        where: { templateId: student.id },
        orderBy: { sequence: 'asc' },
      });
      expect(versions.map((v) => [v.sequence, v.semver])).toEqual([
        [1, '1.0.0'],
        [2, '1.1.0'],
      ]);
      expect(versions[0]).toMatchObject({ id: v1.id, checksum: v1.checksum });
      expect(versions[0].blueprint).toEqual(v1.blueprint); // never rewritten (the database trigger would refuse anyway)
      expect(versions[1].changelog).toBe('Reworded.');
      expect(
        await prisma.templateAsset.count({ where: { templateId: student.id } }),
      ).toBe(1); // same bytes = same row
      expect(
        (
          await templates.diffVersions(
            student.id,
            '1',
            '2',
            (await createUser(prisma)).id,
          )
        ).identical,
      ).toBe(false);

      // and back to the original definition: that is a change again (a third version), not a rewrite
      const back = await seeder.seedAll();
      expect(back.results[0]).toMatchObject({
        action: 'versioned',
        semver: '1.2.0',
      });
    });

    it('bump: "major" is honoured; the envelope (name/description/tags) is re-synced', async () => {
      await seeder.seedAll();
      const d = {
        ...variant(
          'sprint-board',
          'Epics, stories and bugs, two-week sprints.',
        ),
        bump: 'major' as const,
        tags: ['scrum', 'agile', 'team'],
      };
      const r = await seeder.seedAll(
        SEED_DEFINITIONS.map((x) => (x.seedKey === 'sprint-board' ? d : x)),
      );
      expect(r.results[1]).toMatchObject({
        action: 'versioned',
        semver: '2.0.0',
        metaUpdated: true,
      });
      const t = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'sprint-board' },
      });
      expect(t).toMatchObject({
        description: 'Epics, stories and bugs, two-week sprints.',
        tags: ['scrum', 'agile', 'team'],
        visibility: 'PUBLIC',
      });
      expect(await prisma.template.count()).toBe(3); // renamed/reworded, not duplicated
    });

    it('a new version that adds a file stores it through the upload path', async () => {
      await seeder.seedAll();
      const d = variant('sprint-board', 'With a definition of done.');
      d.files = [
        {
          key: 'dod',
          fileName: 'definition-of-done.md',
          mimeType: 'text/markdown',
          text: '# Definition of done\n\n- reviewed\n- tested\n',
        },
      ];
      (d.blueprint.projects as any[])[0].tasks[0].attachments = ['dod'];
      const r = await seeder.seedAll(
        SEED_DEFINITIONS.map((x) => (x.seedKey === 'sprint-board' ? d : x)),
      );
      expect(r.results[1].action).toBe('versioned');
      const t = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'sprint-board' },
      });
      expect(
        await prisma.templateAsset.count({ where: { templateId: t.id } }),
      ).toBe(1);
      const latest = await templates.getVersion(
        t.id,
        'latest',
        (await createUser(prisma)).id,
      );
      expect((latest.blueprint as any).assets).toHaveLength(1);
    });

    it('a definition that does not validate fails the whole run BEFORE anything is written', async () => {
      const broken = variant('sprint-board', 'x');
      (broken.blueprint as { schemaVersion: number }).schemaVersion = 99;
      await expect(
        seeder.seedAll([SEED_DEFINITIONS[0], broken]),
      ).rejects.toThrow(/sprint-board/);
      expect(await dbCounts()).toEqual({
        accounts: 0,
        users: 0,
        members: 0,
        templates: 0,
        versions: 0,
        assets: 0,
        objects: 0,
      });
      await expect(
        seeder.seedAll([SEED_DEFINITIONS[0], SEED_DEFINITIONS[0]]),
      ).rejects.toThrow(/used twice/);
    });

    it('a failure while creating one seed leaves no half-made template or stray file, and a retry succeeds', async () => {
      const original = storage.putObject.bind(storage);
      let n = 0;
      storage.putObject = async (...args) => {
        if (++n === 1) throw new Error('simulated storage outage');
        return original(...args);
      };
      try {
        await expect(seeder.seedAll()).rejects.toThrow(
          'simulated storage outage',
        );
      } finally {
        storage.putObject = original;
      }
      expect(await prisma.template.count()).toBe(0);
      expect(storage.keys('template-assets/')).toEqual([]);
      const r = await seeder.seedAll();
      expect(r.results.map((x) => x.action)).toEqual([
        'created',
        'created',
        'created',
      ]);
      expect(await prisma.template.count()).toBe(3);
    });

    it('refuses to adopt a template that has the seed key but belongs to someone else', async () => {
      const c = await customer();
      await templates
        .createFromBlueprint(c.account.id, c.user.id, {
          blueprint: fixtureJson('sprint-board'),
        })
        .then((t) =>
          prisma.template.update({
            where: { id: t.id },
            data: { seedKey: 'sprint-board' },
          }),
        );
      await expect(seeder.seedAll()).rejects.toThrow(
        /not owned by the system account/,
      );
    });

    it('is exempt from the plan limit: a FREE system account holds more than the 3 a customer could', async () => {
      const four = [
        ...SEED_DEFINITIONS,
        {
          ...variant('sprint-board', 'Another one.'),
          seedKey: 'sprint-board-two',
        },
      ];
      const r = await seeder.seedAll(four);
      expect(r.results).toHaveLength(4);
      const sys = await prisma.account.findUniqueOrThrow({
        where: { id: r.systemAccountId },
      });
      expect(sys.planType).toBe(PlanKey.FREE_PERSONAL);
      expect(
        await prisma.template.count({ where: { ownerAccountId: sys.id } }),
      ).toBe(4);
    });
  });

  // =============================================================== visibility ==============
  describe('who can do what with a seed', () => {
    it('any signed-in user, in any account, can read it: gallery, details, versions, a version, diff, lineage, files', async () => {
      await seeder.seedAll();
      const c = await customer();
      const gallery = await templates.listPublic();
      expect(gallery.map((t) => t.seedKey).sort()).toEqual([
        'content-calendar',
        'sprint-board',
        'student-workspace',
      ]);
      expect(
        gallery.every(
          (t) =>
            t.visibility === 'PUBLIC' && t.latestVersion?.semver === '1.0.0',
        ),
      ).toBe(true);

      const seed = gallery.find((t) => t.seedKey === 'student-workspace')!;
      expect(await templates.get(seed.id, c.user.id)).toMatchObject({
        id: seed.id,
        seedKey: 'student-workspace',
        forkCount: 0,
      });
      expect(await templates.listVersions(seed.id, c.user.id)).toHaveLength(1);
      expect(
        (await templates.getVersion(seed.id, 'latest', c.user.id)).blueprint,
      ).toBeDefined();
      expect(
        (await templates.diffVersions(seed.id, '1', 'latest', c.user.id))
          .identical,
      ).toBe(true);
      expect((await templates.lineage(seed.id, c.user.id)).ancestors).toEqual(
        [],
      );
      await templates.get(seed.id, c.user.id); // (the assets route authorises through `get`)
    });

    it('the gallery can be narrowed by kind and category', async () => {
      await seeder.seedAll();
      expect(
        (await templates.listPublic({ kind: 'PROJECT' as any })).map(
          (t) => t.seedKey,
        ),
      ).toEqual(['sprint-board']);
      expect(
        (await templates.listPublic({ category: 'education' })).map(
          (t) => t.seedKey,
        ),
      ).toEqual(['student-workspace']);
      expect(await templates.listPublic({ category: 'nothing' })).toEqual([]);
    });

    it('nobody outside the system account can edit or delete it - not even the owner of their own account', async () => {
      await seeder.seedAll();
      const seed = (await seedRows())[0];
      const c = await customer();
      for (const action of ['editTemplate', 'deleteTemplate'] as const) {
        expect(
          (await resolver.resolve(c.user.id, action, 'TEMPLATE', seed.id))
            .allowed,
        ).toBe(false);
      }
      const admin = await createUser(prisma);
      await addAccountMember(prisma, {
        accountId: c.account.id,
        userId: admin.id,
        role: Role.ADMIN,
      });
      expect(
        (await resolver.resolve(admin.id, 'editTemplate', 'TEMPLATE', seed.id))
          .allowed,
      ).toBe(false);
      // sanity: the very same check lets a customer edit THEIR OWN template
      const mine = await templates.createFromBlueprint(
        c.account.id,
        c.user.id,
        { blueprint: fixtureJson('sprint-board') },
      );
      expect(
        (await resolver.resolve(c.user.id, 'editTemplate', 'TEMPLATE', mine.id))
          .allowed,
      ).toBe(true);
    });

    it('the system account itself is not browsable: its template list answers 404 to outsiders', async () => {
      const r = await seeder.seedAll();
      const c = await customer();
      await expect(
        templates.list(r.systemAccountId, c.user.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a customer cannot make a template PUBLIC - on create, on edit, or through the API shape - and cannot claim a seed key', async () => {
      const c = await customer(PlanKey.ENTERPRISE_ORG);
      await expect(
        templates.createFromBlueprint(c.account.id, c.user.id, {
          blueprint: fixtureJson('sprint-board'),
          visibility: TemplateVisibility.PUBLIC,
        }),
      ).rejects.toMatchObject({ response: { code: 'PUBLIC_RESERVED' } });
      expect(await prisma.template.count()).toBe(0);

      const mine = await templates.createFromBlueprint(
        c.account.id,
        c.user.id,
        { blueprint: fixtureJson('sprint-board') },
      );
      await expect(
        templates.updateMeta(mine.id, {
          visibility: TemplateVisibility.PUBLIC,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        (await prisma.template.findUniqueOrThrow({ where: { id: mine.id } }))
          .visibility,
      ).toBe('PRIVATE');
      await expect(
        templates.updateMeta(mine.id, {
          visibility: TemplateVisibility.ACCOUNT,
        }),
      ).resolves.toMatchObject({ visibility: 'ACCOUNT' });

      // seed keys are the system account's alone
      await expect(
        templates.createFromBlueprint(
          c.account.id,
          c.user.id,
          { blueprint: fixtureJson('content-calendar') },
          undefined,
          { id: 'x'.repeat(10), assets: [], seedKey: 'content-calendar' },
        ),
      ).rejects.toMatchObject({ response: { code: 'SEED_RESERVED' } });
      expect(
        await prisma.template.count({ where: { seedKey: { not: null } } }),
      ).toBe(0);

      // the HTTP layer never lets PUBLIC through validation at all
      for (const visibility of ['PUBLIC', 'UNLISTED']) {
        const errors = validateSync(
          plainToInstance(CreateTemplateDto, { blueprint: {}, visibility }),
        );
        expect(errors.some((e) => e.property === 'visibility')).toBe(true);
      }
    });

    it('private and account templates of other accounts stay invisible (nothing else changed)', async () => {
      await seeder.seedAll();
      const a = await customer();
      const b = await customer();
      const t = await templates.createFromBlueprint(a.account.id, a.user.id, {
        blueprint: fixtureJson('sprint-board'),
        visibility: TemplateVisibility.ACCOUNT,
      });
      await expect(templates.get(t.id, b.user.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((await templates.listPublic()).map((x) => x.id)).not.toContain(
        t.id,
      );
    });
  });

  // =============================================================== applying ================
  describe('applying the seeds', () => {
    it.each(['student-workspace', 'sprint-board', 'content-calendar'] as const)(
      '%s applies cleanly into an empty workspace of ANOTHER account; counts match the blueprint',
      async (key) => {
        await seeder.seedAll();
        const c = await customer();
        const seed = await prisma.template.findUniqueOrThrow({
          where: { seedKey: key },
        });
        const version = await prisma.templateVersion.findFirstOrThrow({
          where: { templateId: seed.id },
        });
        const stats = version.stats as Record<string, number>;

        const before = await wsCounts(c.ws.id);
        const r: any = await applier.apply(
          c.user.id,
          seed.id,
          { workspaceId: c.ws.id, ...ANSWERS[key] } as any,
          { today: TODAY },
        );
        expect(r.dryRun).toBe(false);
        const install = await prisma.templateInstall.findUniqueOrThrow({
          where: { id: r.installId },
        });
        expect(install).toMatchObject({
          status: 'APPLIED',
          accountId: c.account.id,
          templateName: (
            await prisma.template.findUniqueOrThrow({ where: { id: seed.id } })
          ).name,
          versionSemver: '1.0.0',
        });
        expect(install.versionChecksum).toBe(version.checksum);

        const after = await wsCounts(c.ws.id);
        expect({
          projects: after.projects - before.projects,
          tasks: after.tasks - before.tasks,
          tags: after.tags - before.tags,
          customFields: after.customFields - before.customFields,
          issueTypes: after.issueTypes - before.issueTypes,
          iterations: after.iterations - before.iterations,
          comments: after.comments - before.comments,
          dependencies: after.dependencies - before.dependencies,
          attachments: after.attachments - before.attachments,
        }).toEqual({
          projects: stats.projects,
          tasks: stats.tasks,
          tags: stats.tags,
          customFields: stats.customFields,
          issueTypes: stats.issueTypes,
          iterations: stats.iterations,
          comments: stats.comments,
          dependencies: stats.dependencies,
          attachments: stats.attachments,
        });
        expect(r.plan.blockers ?? []).toEqual([]);
        // the workspace's own identity is untouched
        expect(
          await prisma.workspace.findUniqueOrThrow({ where: { id: c.ws.id } }),
        ).toMatchObject({ name: 'Target', key: 'TGT' });
      },
    );

    it('the student rubric arrives as a real file with the real bytes', async () => {
      await seeder.seedAll();
      const c = await customer();
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'student-workspace' },
      });
      await applier.apply(
        c.user.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['student-workspace'] } as any,
        { today: TODAY },
      );
      const att = await prisma.attachment.findFirstOrThrow({
        where: {
          storageKey: {
            startsWith: `attachments/${c.account.id}/TEMPLATE_INSTALL/`,
          },
        },
      });
      expect(att.status).toBe('CONFIRMED');
      const bytes = await storage.getObject(att.storageKey, 1 << 20);
      expect(bytes.toString('utf8')).toContain('# Essay rubric');
      // the copy is independent of the template's own object
      const tplKey = (
        await prisma.templateAsset.findFirstOrThrow({
          where: { templateId: seed.id },
        })
      ).storageKey;
      expect(att.storageKey).not.toBe(tplKey);
    });

    it('a second apply into another account works, and the seed itself is exactly as it was', async () => {
      await seeder.seedAll();
      const seedBefore = await prisma.templateVersion.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, checksum: true },
      });
      const first = await customer();
      const second = await customer();
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'student-workspace' },
      });
      const one: any = await applier.apply(
        first.user.id,
        seed.id,
        { workspaceId: first.ws.id, ...ANSWERS['student-workspace'] } as any,
        { today: TODAY },
      );
      const two: any = await applier.apply(
        second.user.id,
        seed.id,
        { workspaceId: second.ws.id, ...ANSWERS['student-workspace'] } as any,
        { today: TODAY },
      );
      expect(one.installId).not.toBe(two.installId);
      expect(await wsCounts(first.ws.id)).toMatchObject({ projects: 2 });
      expect(
        await prisma.task.count({ where: { workspaceId: first.ws.id } }),
      ).toBe(await prisma.task.count({ where: { workspaceId: second.ws.id } }));
      expect(
        await prisma.templateVersion.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, checksum: true },
        }),
      ).toEqual(seedBefore);
      expect(await prisma.templateAsset.count()).toBe(1);
    });

    it('applying the same seed twice into ONE workspace merges (new project names, shared tags) rather than failing', async () => {
      await seeder.seedAll();
      const c = await customer();
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'sprint-board' },
      });
      await applier.apply(
        c.user.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['sprint-board'] } as any,
        { today: TODAY },
      );
      const tagsAfterFirst = await prisma.tag.count({
        where: { workspaceId: c.ws.id },
      });
      await applier.apply(
        c.user.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['sprint-board'] } as any,
        { today: TODAY },
      );
      expect(
        await prisma.project.count({ where: { workspaceId: c.ws.id } }),
      ).toBe(2);
      expect(await prisma.tag.count({ where: { workspaceId: c.ws.id } })).toBe(
        tagsAfterFirst,
      );
    });

    it.each(['student-workspace', 'sprint-board', 'content-calendar'] as const)(
      '%s undoes to zero',
      async (key) => {
        await seeder.seedAll();
        const c = await customer();
        const seed = await prisma.template.findUniqueOrThrow({
          where: { seedKey: key },
        });
        const empty = await wsCounts(c.ws.id);
        const r: any = await applier.apply(
          c.user.id,
          seed.id,
          { workspaceId: c.ws.id, ...ANSWERS[key] } as any,
          { today: TODAY },
        );
        expect((await wsCounts(c.ws.id)).tasks).toBeGreaterThan(0);
        await applier.undo(c.user.id, r.installId);
        expect(await wsCounts(c.ws.id)).toEqual(empty);
        expect(
          await prisma.templateInstall.findUniqueOrThrow({
            where: { id: r.installId },
          }),
        ).toMatchObject({ status: 'UNDONE' });
        // the seed and its file survive an undo
        expect(await prisma.template.count({ where: { id: seed.id } })).toBe(1);
        expect(
          await prisma.templateAsset.count({ where: { templateId: seed.id } }),
        ).toBe(key === 'student-workspace' ? 1 : 0);
        expect(storage.keys(`template-assets/${seed.id}/`)).toHaveLength(
          key === 'student-workspace' ? 1 : 0,
        );
      },
    );

    it("the customer's attachment copy is removed by undo, and the quota comes back", async () => {
      await seeder.seedAll();
      const c = await customer();
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'student-workspace' },
      });
      const r: any = await applier.apply(
        c.user.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['student-workspace'] } as any,
        { today: TODAY },
      );
      expect(storage.keys(`attachments/${c.account.id}/`)).toHaveLength(1);
      await applier.undo(c.user.id, r.installId);
      expect(storage.keys(`attachments/${c.account.id}/`)).toHaveLength(0);
      expect(
        await prisma.attachment.count({
          where: { storageKey: { startsWith: `attachments/${c.account.id}/` } },
        }),
      ).toBe(0);
    });
  });

  // =============================================================== fork + limits ==========
  // =============================================================== automations and views ======
  describe('their automations and saved views (step 5.7)', () => {
    const EXPECT: Record<
      string,
      { automations: number; shared: number; personal: number }
    > = {
      'student-workspace': { automations: 4, shared: 3, personal: 2 },
      'sprint-board': { automations: 5, shared: 4, personal: 1 },
      'content-calendar': { automations: 4, shared: 3, personal: 1 },
    };
    const applyTo = async (
      c: Awaited<ReturnType<typeof customer>>,
      key: string,
      userId = c.user.id,
    ) => {
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: key },
      });
      const r: any = await applier.apply(
        userId,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS[key] } as any,
        { today: TODAY },
      );
      return { seed, r };
    };

    it.each(Object.keys(EXPECT))(
      '%s: an admin gets its automations (all OFF) and its views (team ones shared)',
      async (key) => {
        await seeder.seedAll();
        const c = await customer();
        const { r } = await applyTo(c, key);
        const want = EXPECT[key];
        expect(r.report).toMatchObject({
          automations: want.automations,
          savedViews: want.shared + want.personal,
          portableSkipped: 0,
        });
        const rows = await prisma.automation.findMany({
          where: { workspaceId: c.ws.id },
        });
        expect(rows).toHaveLength(want.automations);
        expect(
          rows.every(
            (a) =>
              !a.enabled &&
              a.ruleVersion === 1 &&
              a.createdVia === 'TEMPLATE' &&
              a.projectId !== null,
          ),
        ).toBe(true);
        const views = await prisma.savedView.findMany({
          where: { workspaceId: c.ws.id },
        });
        expect(views.filter((v) => v.isShared)).toHaveLength(want.shared);
        expect(views.filter((v) => !v.isShared)).toHaveLength(want.personal);
        expect(views.every((v) => v.ownerId === c.user.id)).toBe(true);
      },
    );

    it('the preview says the same thing, with no skipped item and the standing "they start off" note', async () => {
      await seeder.seedAll();
      const c = await customer();
      for (const key of Object.keys(EXPECT)) {
        const seed = await prisma.template.findUniqueOrThrow({
          where: { seedKey: key },
        });
        const plan = (
          (await applier.preview(
            c.user.id,
            seed.id,
            { workspaceId: c.ws.id, ...ANSWERS[key] } as any,
            { today: TODAY },
          )) as any
        ).plan;
        expect(plan.counts.automations).toEqual({
          create: EXPECT[key].automations,
          raw: 0,
          skip: 0,
        });
        expect(plan.counts.savedViews).toEqual({
          personal: EXPECT[key].personal,
          shared: EXPECT[key].shared,
          skip: 0,
        });
        expect(plan.warnings.map((w: any) => w.code)).toEqual(
          expect.arrayContaining(['AUTOMATIONS_CREATED_OFF']),
        );
        expect(plan.warnings.map((w: any) => w.code)).not.toEqual(
          expect.arrayContaining(['AUTOMATION_SKIPPED', 'VIEW_SKIPPED']),
        );
      }
    });

    it('every shipped rule can be switched on through the real service (valid in the workspace it landed in, nothing unsupported)', async () => {
      await seeder.seedAll();
      for (const key of Object.keys(EXPECT)) {
        const c = await customer();
        await applyTo(c, key);
        for (const a of await prisma.automation.findMany({
          where: { workspaceId: c.ws.id },
          orderBy: { name: 'asc' },
        })) {
          const on = await automations.update(c.ws.id, a.id, c.user.id, {
            enabled: true,
          });
          expect([key, a.name, on.enabled]).toEqual([key, a.name, true]);
          expect(
            (await automations.get(c.ws.id, a.id, c.user.id)).problems,
          ).toEqual([]);
        }
        expect(
          await prisma.automation.count({
            where: { workspaceId: c.ws.id, enabled: true },
          }),
        ).toBe(EXPECT[key].automations);
      }
    });

    it('someone who is not an admin gets every view as their own personal one, and a note saying so', async () => {
      await seeder.seedAll();
      const c = await customer();
      const member = await createUser(prisma);
      await addAccountMember(prisma, {
        accountId: c.account.id,
        userId: member.id,
        role: Role.MEMBER,
      });
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'sprint-board' },
      });
      // a seed is PUBLIC, so a member may apply it
      const plan = (
        (await applier.preview(
          member.id,
          seed.id,
          { workspaceId: c.ws.id, ...ANSWERS['sprint-board'] } as any,
          { today: TODAY },
        )) as any
      ).plan;
      expect(plan.warnings.map((w: any) => w.code)).toContain(
        'VIEW_NOT_SHARED',
      );
      await applier.apply(
        member.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['sprint-board'] } as any,
        { today: TODAY },
      );
      const views = await prisma.savedView.findMany({
        where: { workspaceId: c.ws.id },
      });
      expect(views).toHaveLength(5);
      expect(views.every((v) => !v.isShared && v.ownerId === member.id)).toBe(
        true,
      );
    });

    it('undo takes them away again', async () => {
      await seeder.seedAll();
      const c = await customer();
      const { r } = await applyTo(c, 'content-calendar');
      await applier.undo(c.user.id, r.installId);
      expect(
        await prisma.automation.count({ where: { workspaceId: c.ws.id } }),
      ).toBe(0);
      expect(
        await prisma.savedView.count({ where: { workspaceId: c.ws.id } }),
      ).toBe(0);
    });

    it('an existing deployment (seeds from before 5.7) gets them as a NEW version with a "what is new" note; version 1 is untouched', async () => {
      const stripped = SEED_DEFINITIONS.map((d) => {
        const copy = JSON.parse(JSON.stringify(d)) as SeedDefinition;
        for (const p of copy.blueprint.projects as Array<
          Record<string, unknown>
        >) {
          delete p.automations;
          delete p.views;
        }
        return copy;
      });
      const first = await seeder.seedAll(stripped);
      expect(first.results.map((x) => [x.action, x.semver])).toEqual([
        ['created', '1.0.0'],
        ['created', '1.0.0'],
        ['created', '1.0.0'],
      ]);
      const v1 = await prisma.templateVersion.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, checksum: true },
      });

      const upgraded = await seeder.seedAll();
      expect(
        upgraded.results.map((x) => [x.seedKey, x.action, x.semver]),
      ).toEqual([
        ['student-workspace', 'versioned', '1.1.0'],
        ['sprint-board', 'versioned', '1.1.0'],
        ['content-calendar', 'versioned', '1.1.0'],
      ]);
      for (const t of await prisma.template.findMany({
        where: { seedKey: { not: null } },
      })) {
        const versions = await prisma.templateVersion.findMany({
          where: { templateId: t.id },
          orderBy: { sequence: 'asc' },
        });
        expect(versions.map((v) => v.changelog)).toEqual([
          'First release.',
          'Adds ready-made automations (all start switched off) and saved views.',
        ]);
        expect(versions.map((v) => v.id)).toContain(
          v1.find((x) => x.id === versions[0].id)!.id,
        );
        expect(JSON.stringify(versions[0].blueprint)).not.toContain('rule.v1');
        expect(JSON.stringify(versions[1].blueprint)).toContain('rule.v1');
      }
      // applying now uses the newest version
      const c = await customer();
      const { r } = await applyTo(c, 'sprint-board');
      expect(r.report.automations).toBe(5);
      // and running the seeder again changes nothing
      expect(
        (await seeder.seedAll()).results.every((x) => x.action === 'unchanged'),
      ).toBe(true);
    });

    it('a fresh install starts at 1.0.0 with the full content and "First release."', async () => {
      await seeder.seedAll();
      for (const t of await prisma.template.findMany({
        where: { seedKey: { not: null } },
      })) {
        const versions = await prisma.templateVersion.findMany({
          where: { templateId: t.id },
        });
        expect(versions.map((v) => [v.semver, v.changelog])).toEqual([
          ['1.0.0', 'First release.'],
        ]);
        expect(JSON.stringify(versions[0].blueprint)).toContain('rule.v1');
      }
    });
  });

  describe('forking and plan limits', () => {
    it('a customer can fork a seed into their own account: a private copy with lineage, its own files, and no seed key', async () => {
      await seeder.seedAll();
      const c = await customer();
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'student-workspace' },
      });
      const fork = await templates.fork(seed.id, c.user.id, c.account.id);
      expect(fork).toMatchObject({
        visibility: 'PRIVATE',
        ownerAccountId: c.account.id,
        sourceTemplateId: seed.id,
        seedKey: null,
      });
      expect(fork.name).toBe('Student workspace (copy)');
      const row = await prisma.template.findUniqueOrThrow({
        where: { id: fork.id },
      });
      expect(row.seedKey).toBeNull();
      const forkAsset = await prisma.templateAsset.findFirstOrThrow({
        where: { templateId: fork.id },
      });
      expect(forkAsset.storageKey).toContain(fork.id);
      expect(storage.keys(`template-assets/${fork.id}/`)).toHaveLength(1);
      expect((await templates.lineage(fork.id, c.user.id)).ancestors).toEqual([
        {
          id: seed.id,
          name: 'Student workspace',
          versionId: expect.any(String),
        },
      ]);
      expect((await templates.get(seed.id, c.user.id)).forkCount).toBe(1);

      // the fork is the customer's to change; the seed is not touched by it
      await templates.updateMeta(fork.id, { name: 'My course' });
      expect(
        (await prisma.template.findUniqueOrThrow({ where: { id: seed.id } }))
          .name,
      ).toBe('Student workspace');
      expect(
        await prisma.templateVersion.count({ where: { templateId: seed.id } }),
      ).toBe(1);

      // and a fork of a non-public template still cannot cross accounts
      const other = await customer();
      await expect(
        templates.fork(fork.id, c.user.id, other.account.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reading and applying seeds costs the reader nothing: the 3-template cap of a FREE account is all theirs', async () => {
      await seeder.seedAll();
      const c = await customer(PlanKey.FREE_PERSONAL);
      const seeds = await prisma.template.findMany({
        where: { seedKey: { not: null } },
      });
      for (const s of seeds) await templates.get(s.id, c.user.id);
      const seed = seeds.find((s) => s.seedKey === 'sprint-board')!;
      await applier.apply(
        c.user.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['sprint-board'] } as any,
        { today: TODAY },
      );
      expect(
        await prisma.template.count({
          where: { ownerAccountId: c.account.id },
        }),
      ).toBe(0);

      const bp = fixtureJson('sprint-board');
      const variantBp = (i: number) => ({
        ...bp,
        meta: { ...bp.meta, name: `Mine ${i}` },
      });
      for (let i = 0; i < 3; i++)
        await templates.createFromBlueprint(c.account.id, c.user.id, {
          blueprint: variantBp(i),
        });
      await expect(
        templates.createFromBlueprint(c.account.id, c.user.id, {
          blueprint: variantBp(9),
        }),
      ).rejects.toBeInstanceOf(PlanLimitExceededException);
    });

    it("a fork DOES count against the reader's limit (it is their template)", async () => {
      await seeder.seedAll();
      const c = await customer(PlanKey.FREE_PERSONAL);
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'sprint-board' },
      });
      for (let i = 0; i < 3; i++)
        await templates.fork(seed.id, c.user.id, c.account.id);
      await expect(
        templates.fork(seed.id, c.user.id, c.account.id),
      ).rejects.toBeInstanceOf(PlanLimitExceededException);
    });

    it("deleting a customer's account leaves the seeds, their versions and their files alone", async () => {
      await seeder.seedAll();
      const c = await customer();
      const seed = await prisma.template.findUniqueOrThrow({
        where: { seedKey: 'student-workspace' },
      });
      await templates.fork(seed.id, c.user.id, c.account.id);
      await applier.apply(
        c.user.id,
        seed.id,
        { workspaceId: c.ws.id, ...ANSWERS['student-workspace'] } as any,
        { today: TODAY },
      );
      await prisma.account.delete({ where: { id: c.account.id } });
      expect(
        await prisma.template.count({ where: { seedKey: { not: null } } }),
      ).toBe(3);
      expect(await prisma.templateVersion.count()).toBe(3);
      expect(
        await prisma.templateAsset.count({ where: { templateId: seed.id } }),
      ).toBe(1);
    });
  });

  // =============================================================== database rules ==========
  describe('database rules', () => {
    it('there can be only one system account', async () => {
      await seeder.seedAll();
      await expect(
        createAccount(prisma, {
          type: AccountType.PERSONAL,
          isSystem: true,
          planType: PlanKey.FREE_PERSONAL,
        }),
      ).rejects.toThrow();
    });
    it('a seed key is unique and well-formed', async () => {
      const r = await seeder.seedAll();
      const u = await createUser(prisma);
      const any = await prisma.template.findFirstOrThrow({
        where: { seedKey: 'sprint-board' },
      });
      await expect(
        prisma.template.create({
          data: {
            ownerAccountId: r.systemAccountId,
            createdById: u.id,
            kind: 'PROJECT',
            name: 'dup',
            seedKey: 'sprint-board',
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.template.update({
          where: { id: any.id },
          data: { seedKey: 'Not Valid!' },
        }),
      ).rejects.toThrow();
    });
  });
});
