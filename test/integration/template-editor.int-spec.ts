/**
 * Step 3.8 on a real database: the template editor (drafts, operations, revisions, publish) and
 * the version diff. The pure engines have their own unit tests; these prove the parts that need
 * Postgres: row locks, the revision protocol under real concurrency, the never-reused key counter,
 * publish being one transaction, and an edited template really applying.
 */
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { AccountType, PlanKey, Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
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
import { blueprintChecksum } from '../../src/templates/blueprint';
import { fixtureJson } from '../../src/templates/blueprint/blueprint.fixtures';
import { TemplateEditorService } from '../../src/templates/editor/template-editor.service';
import { TemplateExtractionService } from '../../src/templates/extract';
import { TemplatesModule } from '../../src/templates/templates.module';
import { TemplatesService } from '../../src/templates/templates.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { MemoryStorage } from './support/memory-storage';
import { addAccountMember, createAccount, createUser, createWorkspace } from './factories';

jest.setTimeout(180_000);
type Any = any;
const tasksOf = (b: Any): Any[] => { const out: Any[] = []; const w = (l: Any[]) => l.forEach((t) => { out.push(t); w(t.children ?? []); }); b.projects.forEach((p: Any) => w(p.tasks)); return out; };

describe('Template editor (step 3.8)', () => {
  let prisma: PrismaService;
  let templates: TemplatesService;
  let editor: TemplateEditorService;
  let assets: TemplateAssetsService;
  let applier: TemplateApplyService;
  const storage = new MemoryStorage();

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: WorkspacesService, useValue: {} },
        { provide: STORAGE_PROVIDER, useValue: storage },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, TaskVisibilityService, TasksService,
        TaskTreeService, WorkflowService, TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter,
        TemplateExtractionService, TemplateAssetsService, TemplatesService, TemplateEditorService, TemplateApplyService,
      ],
    }).compile();
    new TemplatesModule(moduleRef.get(PlanLimitsService)).onModuleInit();
    templates = moduleRef.get(TemplatesService);
    editor = moduleRef.get(TemplateEditorService);
    assets = moduleRef.get(TemplateAssetsService);
    applier = moduleRef.get(TemplateApplyService);
  });
  beforeEach(async () => { storage.reset(); await resetDb(prisma); });
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const account = await createAccount(prisma, { type: AccountType.ORGANIZATION, planType: PlanKey.ENTERPRISE_ORG });
    const admin = await createUser(prisma);
    await addAccountMember(prisma, { accountId: account.id, userId: admin.id, role: Role.OWNER });
    const ws = await createWorkspace(prisma, { accountId: account.id, name: 'Target', key: 'TGT' });
    const t = await templates.createFromBlueprint(account.id, admin.id, { blueprint: fixtureJson('sprint-board') });
    return { account, admin, ws, t };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const draftOf = (w: W) => editor.getDraft(w.t.id) as Promise<Any>;
  const rootTasks = async (w: W) => ((await draftOf(w)).blueprint as Any).projects[0].tasks as Any[];
  const seqOf = async (w: W) => (await prisma.template.findUniqueOrThrow({ where: { id: w.t.id }, select: { nodeKeySeq: true } })).nodeKeySeq;
  const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Any; } throw new Error('expected a rejection'); };

  // ================================================================== lifecycle ===========
  describe('draft lifecycle', () => {
    it('starts from the latest version, one draft per template, and leaves the version alone', async () => {
      const w = await world();
      const d = await editor.createDraft(w.t.id, w.admin.id);
      const v = await prisma.templateVersion.findFirstOrThrow({ where: { templateId: w.t.id } });
      expect(d).toMatchObject({ revision: 1, baseSequence: 1 });
      expect(blueprintChecksum(d.blueprint)).toBe(v.checksum);

      const again = await rejects(editor.createDraft(w.t.id, w.admin.id));
      expect(again).toBeInstanceOf(ConflictException);
      expect(again.response).toMatchObject({ code: 'DRAFT_EXISTS', revision: 1 });

      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: (await rootTasks(w))[0].nodeKey, set: { title: 'Changed' } }] });
      expect(blueprintChecksum((await prisma.templateVersion.findFirstOrThrow({ where: { templateId: w.t.id } })).blueprint)).toBe(v.checksum); // the VERSION is immutable
      expect((await draftOf(w)).revision).toBe(2);
    });

    it('a template without a draft says so; a missing template cannot get one', async () => {
      const w = await world();
      expect((await rejects(editor.getDraft(w.t.id))).response).toMatchObject({ code: 'NO_DRAFT' });
      expect(await rejects(editor.createDraft('nope', w.admin.id))).toBeInstanceOf(NotFoundException);
    });

    it('deleting the template deletes its draft', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      await templates.delete(w.t.id);
      expect(await prisma.templateDraft.count()).toBe(0);
    });

    it('discard removes the draft (and honours ifRevision)', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      expect((await rejects(editor.discardDraft(w.t.id, 5))).response).toMatchObject({ code: 'DRAFT_REVISION_CONFLICT', currentRevision: 1 });
      await editor.discardDraft(w.t.id, 1);
      expect(await prisma.templateDraft.count()).toBe(0);
      expect((await rejects(editor.discardDraft(w.t.id))).response).toMatchObject({ code: 'NO_DRAFT' });
    });
  });

  // ================================================================== revisions ===========
  describe('revisions: no silent overwrites', () => {
    it('a stale ifRevision is refused with the current revision and changes nothing', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const t0 = (await rootTasks(w))[0].nodeKey;
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'first' } }] });
      const before = await draftOf(w);
      const e = await rejects(editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'second' } }] }));
      expect(e.response).toMatchObject({ code: 'DRAFT_REVISION_CONFLICT', currentRevision: 2 });
      const after = await draftOf(w);
      expect(after.revision).toBe(2);
      expect(after.blueprint).toEqual(before.blueprint);
    });

    it('a rejected batch (bad op, or a result that would not validate) leaves the draft AND the key counter untouched', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const before = await draftOf(w);
      const seq = await seqOf(w);
      const p = before.blueprint.projects[0].nodeKey;
      const bad1 = await rejects(editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', project: p, task: { title: 'ok' } }, { op: 'removeTask', nodeKey: 'nope' }] }));
      expect(bad1).toBeInstanceOf(UnprocessableEntityException);
      expect(bad1.response).toMatchObject({ code: 'OP_FAILED', error: { index: 1, code: 'NOT_FOUND' } });
      const bad2 = await rejects(editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', project: p, task: { title: 'x', status: 'no-such-status' } }] }));
      expect(bad2.response).toMatchObject({ code: 'BLUEPRINT_INVALID' });
      expect(await draftOf(w)).toMatchObject({ revision: 1, blueprint: before.blueprint });
      expect(await seqOf(w)).toBe(seq); // the key minted inside the failed batch was not spent
    });

    it('SAME revision from many writers at once: exactly one wins, the rest get 409, nothing is lost or duplicated', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const p = (await draftOf(w)).blueprint.projects[0].nodeKey;
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', project: p, task: { title: `racer ${i}` } }] })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) expect(r.reason.response.code).toBe('DRAFT_REVISION_CONFLICT');
      const d = await draftOf(w);
      expect(d.revision).toBe(2);
      expect(tasksOf(d.blueprint).filter((t) => /^racer/.test(t.title))).toHaveLength(1);
    });

    it('writers that RETRY on conflict all get through: every change present, every minted key unique, the counter ahead of all of them', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const p = (await draftOf(w)).blueprint.projects[0].nodeKey;
      const write = async (i: number) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          const rev = (await draftOf(w)).revision;
          try { return await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: rev, ops: [{ op: 'addTask', ref: 'x', project: p, task: { title: `writer ${i}` } }] }); }
          catch (e) { if ((e as Any).response?.code !== 'DRAFT_REVISION_CONFLICT') throw e; }
        }
        throw new Error('starved');
      };
      const done = await Promise.all(Array.from({ length: 6 }, (_, i) => write(i)));
      const d = await draftOf(w);
      expect(d.revision).toBe(1 + 6);
      const mine = tasksOf(d.blueprint).filter((t) => /^writer/.test(t.title));
      expect(mine).toHaveLength(6);
      const keys = tasksOf(d.blueprint).map((t) => t.nodeKey);
      expect(new Set(keys).size).toBe(keys.length);
      const minted = done.map((r) => r.created.x);
      expect(new Set(minted).size).toBe(6);
      expect(await seqOf(w)).toBeGreaterThanOrEqual(Math.max(...minted.map((k) => Number(k.slice(1)))) + 1);
    });
  });

  // ================================================================== keys ================
  describe('node keys never come back', () => {
    it('the counter survives discarding the draft: a new draft does not hand out the same key again', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const p = (await draftOf(w)).blueprint.projects[0].nodeKey;
      const first = await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', ref: 'a', project: p, task: { title: 'x' } }] });
      await editor.discardDraft(w.t.id);
      await editor.createDraft(w.t.id, w.admin.id);
      const second = await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', ref: 'a', project: p, task: { title: 'y' } }] });
      expect(second.created.a).not.toBe(first.created.a);
    });

    it('nor after publish + delete of the node: a removed task\'s key is not reused by a later task in a later version', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const p = (await draftOf(w)).blueprint.projects[0].nodeKey;
      const a = await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', ref: 'k', project: p, task: { title: 'temp' } }] });
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      await editor.createDraft(w.t.id, w.admin.id);
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'removeTask', nodeKey: a.created.k }] });
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      await editor.createDraft(w.t.id, w.admin.id);
      const b = await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', ref: 'k', project: p, task: { title: 'new' } }] });
      expect(b.created.k).not.toBe(a.created.k);
      // so v1 -> v4 never mistakes the new task for the old one
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      const d: Any = await templates.diffVersions(w.t.id, '2', '4', w.admin.id);
      expect(d.changes.filter((c: Any) => c.entity === 'task').map((c: Any) => `${c.id}:${c.kind}`).sort()).toEqual([`${a.created.k}:removed`, `${b.created.k}:added`].sort());
    });

    it('a template created from (or given a version with) n<k> keys starts its counter past them', async () => {
      const w = await world();
      const bp: Any = fixtureJson('content-calendar');
      bp.projects[0].tasks.push({ nodeKey: 'n41', title: 'hand-made key' });
      const t = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: bp });
      expect((await prisma.template.findUniqueOrThrow({ where: { id: t.id } })).nodeKeySeq).toBe(41);
      const bp2 = JSON.parse(JSON.stringify(bp)); bp2.projects[0].tasks.push({ nodeKey: 'n77', title: 'more' });
      await templates.addVersion(t.id, w.admin.id, { blueprint: bp2 });
      expect((await prisma.template.findUniqueOrThrow({ where: { id: t.id } })).nodeKeySeq).toBe(77);
      await editor.createDraft(t.id, w.admin.id);
      const r = await editor.patchDraft(t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addTask', ref: 'z', project: bp.projects[0].nodeKey, task: { title: 'x' } }] });
      expect(r.created.z).toBe('n78');
    });
  });

  // ================================================================== publish =============
  describe('publish', () => {
    it('is ONE step: the next version has exactly the draft\'s blueprint, the draft is gone, the integrity check passes', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const t0 = (await rootTasks(w))[0].nodeKey;
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'Edited title' } }] });
      const draft = await draftOf(w);
      const v = await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2, bump: 'minor' });
      expect(v).toMatchObject({ sequence: 2, semver: '1.1.0' });
      expect(v.changelog).toBe('Edited in the template editor: 1 modified');
      const stored = await prisma.templateVersion.findFirstOrThrow({ where: { templateId: w.t.id, sequence: 2 } });
      expect(stored.checksum).toBe(blueprintChecksum(draft.blueprint));
      expect(await templates.verifyIntegrity(stored.id)).toEqual({ ok: true });
      expect(await prisma.templateDraft.count()).toBe(0);
      // an explicit changelog wins over the generated one
      await editor.createDraft(w.t.id, w.admin.id);
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'Again' } }] });
      expect((await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2, changelog: 'my words' })).changelog).toBe('my words');
    });

    it('refuses a draft with no changes (and keeps it), a wrong revision, and a draft whose base is no longer the latest version', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      expect((await rejects(editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 1 }))).response).toMatchObject({ code: 'NO_CHANGES' });
      expect(await prisma.templateDraft.count()).toBe(1);
      expect((await rejects(editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 9 }))).response).toMatchObject({ code: 'DRAFT_REVISION_CONFLICT', currentRevision: 1 });

      // somebody publishes a version through the full-blueprint route meanwhile
      const other: Any = JSON.parse(JSON.stringify((await draftOf(w)).blueprint));
      other.projects[0].tasks[0].title = 'from the other route';
      await templates.addVersion(w.t.id, w.admin.id, { blueprint: other });
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: other.projects[0].tasks[1].nodeKey, set: { title: 'mine' } }] });
      const stale = await rejects(editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 }));
      expect(stale.response).toMatchObject({ code: 'DRAFT_STALE', baseSequence: 1, latestSequence: 2 });
      expect(await prisma.templateVersion.count({ where: { templateId: w.t.id } })).toBe(2); // nothing was published over theirs
      expect(await prisma.templateDraft.count()).toBe(1); // and the draft is still there to look at
    });

    it('two publishes at once create ONE version; publish racing a patch: exactly one of them wins and no half-state remains', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const t0 = (await rootTasks(w))[0].nodeKey;
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'X' } }] });
      const twice = await Promise.allSettled([editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 }), editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 })]);
      expect(twice.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.templateVersion.count({ where: { templateId: w.t.id } })).toBe(2);

      await editor.createDraft(w.t.id, w.admin.id);
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'Y' } }] });
      const race = await Promise.allSettled([
        editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 }),
        editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 2, ops: [{ op: 'updateTask', nodeKey: t0, set: { title: 'Z' } }] }),
      ]);
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const versions = await prisma.templateVersion.findMany({ where: { templateId: w.t.id }, orderBy: { sequence: 'asc' } });
      if (race[0].status === 'fulfilled') {
        expect(versions).toHaveLength(3);
        expect(tasksOf(versions[2].blueprint).find((t) => t.nodeKey === t0)!.title).toBe('Y'); // the patch did not sneak into it
        expect(await prisma.templateDraft.count()).toBe(0);
      } else {
        expect(versions).toHaveLength(2);
        expect(tasksOf((await draftOf(w)).blueprint).find((t) => t.nodeKey === t0)!.title).toBe('Z');
      }
    });
  });

  // ================================================================== diff ================
  describe('diff', () => {
    it('draft diff and version diff agree, and report an edit as what it is', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const list = await rootTasks(w);
      const p = (await draftOf(w)).blueprint.projects[0].nodeKey;
      await editor.patchDraft(w.t.id, w.admin.id, {
        ifRevision: 1,
        ops: [
          { op: 'updateTask', nodeKey: list[0].nodeKey, set: { title: 'Renamed' } },
          { op: 'moveTask', nodeKey: list[list.length - 1].nodeKey, index: 0 },
          { op: 'addTask', ref: 'n', project: p, task: { title: 'Brand new' } },
        ],
      });
      const dd: Any = await editor.diffDraft(w.t.id);
      expect(dd).toMatchObject({ baseSequence: 1, revision: 2, identical: false });
      expect(dd.summary).toMatchObject({ added: 1, modified: 1, reordered: 1, removed: 0, moved: 0 });
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      const vd: Any = await templates.diffVersions(w.t.id, '1', 'latest', w.admin.id);
      expect(vd.from.sequence).toBe(1);
      expect(vd.to.sequence).toBe(2);
      expect(JSON.stringify(vd.changes)).toBe(JSON.stringify(dd.changes));
      expect((await templates.diffVersions(w.t.id, 'latest', 'latest', w.admin.id)).identical).toBe(true);
      expect(await rejects(templates.diffVersions(w.t.id, 'x', '2', w.admin.id))).toBeInstanceOf(BadRequestException);
      expect(await rejects(templates.diffVersions(w.t.id, '1', '9', w.admin.id))).toBeInstanceOf(NotFoundException);
    });

    it('a person who cannot read the template cannot read its diff', async () => {
      const w = await world();
      const stranger = await createUser(prisma);
      expect(await rejects(templates.diffVersions(w.t.id, '1', '1', stranger.id))).toBeInstanceOf(NotFoundException);
    });

    it('a big edit is diffed correctly end to end (v1 -> v2 through the editor, then back-to-back versions)', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const d0: Any = (await draftOf(w)).blueprint;
      const p = d0.projects[0].nodeKey;
      const ops: Any[] = [];
      tasksOf(d0).forEach((t, i) => ops.push({ op: 'updateTask', nodeKey: t.nodeKey, set: { title: `${t.title} v2` } }));
      ops.push({ op: 'duplicateTask', nodeKey: d0.projects[0].tasks[0].nodeKey });
      ops.push({ op: 'removeTask', nodeKey: d0.projects[0].tasks.at(-1).nodeKey });
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops });
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      const d: Any = await templates.diffVersions(w.t.id, '1', '2', w.admin.id);
      const removed = d.changes.filter((c: Any) => c.entity === 'task' && c.kind === 'removed').length;
      const added = d.changes.filter((c: Any) => c.entity === 'task' && c.kind === 'added').length;
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(added).toBeGreaterThanOrEqual(1);
      // every surviving task was renamed, not recreated
      expect(d.changes.filter((c: Any) => c.entity === 'task' && c.kind === 'modified').length).toBe(tasksOf(d0).length - removed);
    });
  });

  // ================================================================== files + apply =======
  describe('files and applying an edited template', () => {
    it('a file is uploaded, attached through the editor (addAsset + updateTask), published, and copied by an apply', async () => {
      const w = await world();
      const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 3)]);
      const up = await assets.upload(w.t.id, w.admin.id, { fileName: 'brief.pdf', mimeType: 'application/pdf', bytes });
      await editor.createDraft(w.t.id, w.admin.id);
      const t0 = (await rootTasks(w))[0].nodeKey;
      expect((await rejects(editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addAsset', sha256: '9'.repeat(64) }] }))).response).toMatchObject({ code: 'OP_FAILED', error: { code: 'ASSET_NOT_STORED' } });
      // one batch: add the stored file and attach it, using the ref for its key
      await editor.patchDraft(w.t.id, w.admin.id, { ifRevision: 1, ops: [{ op: 'addAsset', ref: 'f', sha256: up.sha256 }, { op: 'updateTask', nodeKey: t0, set: { attachments: ['$f'] } }] });
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      const res: Any = await applier.apply(w.admin.id, w.t.id, { workspaceId: w.ws.id } as Any, { today: '2026-10-09' });
      expect(res.report.attachments).toBe(1);
      expect(await prisma.attachment.count({ where: { accountId: w.account.id, status: 'CONFIRMED' } })).toBe(1);
    });

    it('an edited template applies: the added task is created, the renamed one carries its new title', async () => {
      const w = await world();
      await editor.createDraft(w.t.id, w.admin.id);
      const d0: Any = (await draftOf(w)).blueprint;
      const p = d0.projects[0].nodeKey;
      const before = tasksOf(d0).length;
      await editor.patchDraft(w.t.id, w.admin.id, {
        ifRevision: 1,
        ops: [
          { op: 'addTask', ref: 'e', project: p, task: { title: 'Added in the editor' } },
          { op: 'addTask', parent: '$e', task: { title: 'Its sub-task' } },
          { op: 'updateTask', nodeKey: d0.projects[0].tasks[0].nodeKey, set: { title: 'Renamed in the editor' } },
        ],
      });
      await editor.publishDraft(w.t.id, w.admin.id, { ifRevision: 2 });
      await applier.apply(w.admin.id, w.t.id, { workspaceId: w.ws.id } as Any, { today: '2026-10-09' });
      const titles = (await prisma.task.findMany({ where: { workspaceId: w.ws.id } })).map((t) => t.title);
      expect(titles).toHaveLength(before + 2);
      expect(titles).toEqual(expect.arrayContaining(['Added in the editor', 'Its sub-task', 'Renamed in the editor']));
    });
  });
});
