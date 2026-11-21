/**
 * Step 3.7 on a real database: reference files carried by templates.
 *   export   - bytes read, policy applied to the BYTES, hashed, stored; nothing blocked reaches storage
 *   store    - upload caps (under a lock), version/asset integrity, fork copy, delete
 *   apply    - storage preflight, quota RESERVED before any copy, released on failure and on undo
 */
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { AccountType, AttachmentStatus, PlanKey, Role } from '@prisma/client';
import { createHash } from 'crypto';
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
import { installAttachmentPrefix, templateAssetKey } from '../../src/templates/assets/asset.policy';
import { TemplateAssetsService } from '../../src/templates/assets/template-assets.service';
import { BLUEPRINT_LIMITS } from '../../src/templates/blueprint';
import { fixtureJson } from '../../src/templates/blueprint/blueprint.fixtures';
import { TemplateExtractionService } from '../../src/templates/extract';
import { TemplatesModule } from '../../src/templates/templates.module';
import { TemplatesService } from '../../src/templates/templates.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { MemoryStorage } from './support/memory-storage';
import { addAccountMember, createAccount, createProject, createTask, createUser, createWorkspace } from './factories';

jest.setTimeout(180_000);
const TODAY = '2026-10-09';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const GB = 1024 * 1024 * 1024;

describe('Template assets (step 3.7)', () => {
  let prisma: PrismaService;
  let templates: TemplatesService;
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
        TemplateExtractionService, TemplateAssetsService, TemplatesService, TemplateApplyService,
      ],
    }).compile();
    new TemplatesModule(moduleRef.get(PlanLimitsService)).onModuleInit();
    templates = moduleRef.get(TemplatesService);
    assets = moduleRef.get(TemplateAssetsService);
    applier = moduleRef.get(TemplateApplyService);
  });
  beforeEach(async () => { storage.reset(); await resetDb(prisma); });
  afterAll(() => disconnectTestPrisma());

  // ------------------------------------------------------------------ world --------------
  async function world(planType: PlanKey = PlanKey.ENTERPRISE_ORG, type: AccountType = AccountType.ORGANIZATION) {
    const account = await createAccount(prisma, { type, planType });
    const admin = await createUser(prisma);
    await addAccountMember(prisma, { accountId: account.id, userId: admin.id, role: Role.OWNER });
    const ws = await createWorkspace(prisma, { accountId: account.id, name: 'Target', key: 'TGT' });
    return { account, admin, ws };
  }
  type W = Awaited<ReturnType<typeof world>>;

  /** A workspace with one project and tasks that carry the given files (bytes seeded in storage). */
  async function sourceWorkspace(w: W, files: Array<{ name: string; mime: string; bytes: Buffer; declaredSize?: number; onTask?: number; missing?: boolean }>) {
    const ws = await createWorkspace(prisma, { accountId: w.account.id, name: 'Source', key: 'SRC' });
    const project = await createProject(prisma, { workspaceId: ws.id, createdById: w.admin.id, name: 'P' });
    const tasks = [await createTask(prisma, { workspaceId: ws.id, createdById: w.admin.id, projectId: project.id, title: 'one' }), await createTask(prisma, { workspaceId: ws.id, createdById: w.admin.id, projectId: project.id, title: 'two' })];
    let n = 0;
    for (const f of files) {
      const key = `attachments/${w.account.id}/TASK/${tasks[f.onTask ?? 0].id}/${n++}-${f.name}`;
      if (!f.missing) storage.seed(key, f.bytes, f.mime);
      await prisma.attachment.create({
        data: { accountId: w.account.id, targetType: 'TASK', targetId: tasks[f.onTask ?? 0].id, uploadedById: w.admin.id, filename: f.name, mimeType: f.mime, sizeBytes: f.declaredSize ?? f.bytes.length, storageKey: key, status: AttachmentStatus.CONFIRMED, confirmedAt: new Date() },
      });
    }
    return ws;
  }
  const exportOf = (w: W, workspaceId: string, extra = {}) =>
    templates.exportFromWorkspace(workspaceId, w.admin.id, { includeAttachments: true, ...extra } as any);

  /** A project template (sprint board) whose first `copies` top-level tasks each attach the one stored file. */
  async function templateWithFile(w: W, bytes: Buffer, copies: number, name = 'brief.pdf') {
    const bp: any = fixtureJson('sprint-board');
    const t = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: fixtureJson('sprint-board') });
    const file = await assets.upload(t.id, w.admin.id, { fileName: name, mimeType: 'application/pdf', bytes });
    bp.assets = [{ key: 'a1', fileName: name, mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: file.sha256 }];
    for (let i = 0; i < copies; i++) bp.projects[0].tasks[i].attachments = ['a1'];
    await templates.addVersion(t.id, w.admin.id, { blueprint: bp, bump: 'minor' });
    return { template: t, sha: file.sha256 };
  }
  const usedBytes = async (accountId: string) =>
    (await prisma.attachment.aggregate({ where: { accountId }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
  const pdf = (n: number, fill = 7) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, fill)]);
  const apply = (w: W, templateId: string, extra: Record<string, unknown> = {}) =>
    applier.apply(w.admin.id, templateId, { workspaceId: w.ws.id, ...extra } as any, { today: TODAY }) as Promise<any>;

  // ================================================================== export ==============
  describe('export', () => {
    it('hashes the real bytes, stores them under the template, and the hash survives a Postgres round trip', async () => {
      const w = await world();
      const bytes = pdf(500);
      const src = await sourceWorkspace(w, [{ name: 'brief.pdf', mime: 'application/pdf', bytes }]);
      const r = await exportOf(w, src.id);
      expect(r.assets.stored).toBe(1);

      const v = await prisma.templateVersion.findFirstOrThrow({ where: { templateId: r.template.id } });
      const declared = (v.blueprint as any).assets;
      expect(declared).toHaveLength(1);
      expect(declared[0]).toMatchObject({ fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: sha(bytes) });
      expect(await templates.verifyIntegrity(v.id)).toEqual({ ok: true });

      const row = await prisma.templateAsset.findUniqueOrThrow({ where: { templateId_sha256: { templateId: r.template.id, sha256: sha(bytes) } } });
      expect(row.storageKey).toBe(templateAssetKey(r.template.id, sha(bytes)));
      expect(storage.objects.get(row.storageKey)!.body.equals(bytes)).toBe(true);
    });

    it('trusts the bytes, not the attachment row: a lying declared size is corrected', async () => {
      const w = await world();
      const bytes = pdf(500);
      const src = await sourceWorkspace(w, [{ name: 'brief.pdf', mime: 'application/pdf', bytes, declaredSize: 10 }]);
      const r = await exportOf(w, src.id);
      const v = await prisma.templateVersion.findFirstOrThrow({ where: { templateId: r.template.id } });
      expect((v.blueprint as any).assets[0].sizeBytes).toBe(bytes.length);
    });

    it('a blocked file never reaches storage: by declared type, by extension, or by CONTENT under an innocent name', async () => {
      const w = await world();
      const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(100)]);
      const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);
      const script = Buffer.from('#!/bin/sh\nrm -rf /\n');
      const src = await sourceWorkspace(w, [
        { name: 'fine.pdf', mime: 'application/pdf', bytes: pdf(50) },
        { name: 'tool.exe', mime: 'application/octet-stream', bytes: pdf(60, 1) }, // extension
        { name: 'data.bin2', mime: 'application/x-msdownload', bytes: pdf(61, 2) }, // declared type
        { name: 'notes.pdf', mime: 'application/pdf', bytes: elf }, // ELF dressed as a pdf
        { name: 'photo.png', mime: 'image/png', bytes: mz }, // PE dressed as a png
        { name: 'readme.txt', mime: 'text/plain', bytes: script }, // shebang script
      ]);
      const r = await exportOf(w, src.id);
      expect(r.assets.stored).toBe(1);
      expect(r.assets.refused.map((x: any) => x.reason).sort()).toEqual(['BLOCKED_CONTENT', 'BLOCKED_CONTENT', 'BLOCKED_CONTENT', 'BLOCKED_TYPE', 'BLOCKED_TYPE']);
      // the ONLY object written to the template store is the allowed one
      expect(storage.keys('template-assets/')).toEqual([templateAssetKey(r.template.id, sha(pdf(50)))]);
      expect(storage.log.filter((l) => l.op === 'put').map((l) => l.key)).toEqual(storage.keys('template-assets/'));
      expect(await prisma.templateAsset.count()).toBe(1);
    });

    it('files over the per-file cap are not read into memory and are left out; unreadable ones too; the export still succeeds', async () => {
      const w = await world();
      const big = Buffer.alloc(BLUEPRINT_LIMITS.maxAssetBytes + 1, 3);
      const src = await sourceWorkspace(w, [
        { name: 'ok.pdf', mime: 'application/pdf', bytes: pdf(20) },
        { name: 'huge.pdf', mime: 'application/pdf', bytes: big },
        { name: 'gone.pdf', mime: 'application/pdf', bytes: pdf(30), missing: true },
      ]);
      const r = await exportOf(w, src.id);
      expect(r.assets.stored).toBe(1);
      expect(r.assets.refused.map((x: any) => x.reason).sort()).toEqual(['TOO_LARGE', 'UNREADABLE']);
      expect(storage.keys('template-assets/')).toHaveLength(1);
    });

    it('the same bytes attached twice are stored once', async () => {
      const w = await world();
      const bytes = pdf(80);
      const src = await sourceWorkspace(w, [{ name: 'a.pdf', mime: 'application/pdf', bytes, onTask: 0 }, { name: 'b.pdf', mime: 'application/pdf', bytes, onTask: 1 }]);
      const r = await exportOf(w, src.id);
      expect(storage.count('put')).toBe(1);
      expect(await prisma.templateAsset.count({ where: { templateId: r.template.id } })).toBe(1);
      const bp: any = (await prisma.templateVersion.findFirstOrThrow({ where: { templateId: r.template.id } })).blueprint;
      expect(bp.assets).toHaveLength(2); // two blueprint entries, one stored object
      expect(new Set(bp.assets.map((a: any) => a.sha256)).size).toBe(1);
    });

    it('an export that fails leaves nothing in storage (a credential blocks it after the files were stored)', async () => {
      const w = await world();
      const src = await sourceWorkspace(w, [{ name: 'a.pdf', mime: 'application/pdf', bytes: pdf(40) }]);
      const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: src.id } });
      const fake = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
      await prisma.task.update({ where: { id: task.id }, data: { description: `key ${fake}` } });
      await expect(exportOf(w, src.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(storage.keys('template-assets/')).toEqual([]);
      expect(await prisma.template.count()).toBe(0);
    });
  });

  // ================================================================== the store ===========
  describe('the template store', () => {
    it('upload stores the file, is idempotent for the same bytes, and refuses blocked content without storing it', async () => {
      const w = await world();
      const t = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: fixtureJson('sprint-board') });
      const a = await assets.upload(t.id, w.admin.id, { fileName: 'a.pdf', mimeType: 'application/pdf', bytes: pdf(10) });
      const again = await assets.upload(t.id, w.admin.id, { fileName: 'other-name.pdf', mimeType: 'application/pdf', bytes: pdf(10) });
      expect(again.id).toBe(a.id);
      expect(storage.keys('template-assets/')).toHaveLength(1);

      const before = storage.count('put');
      for (const bad of [
        { fileName: 'x.exe', mimeType: 'application/octet-stream', bytes: pdf(5) },
        { fileName: 'x.pdf', mimeType: 'application/x-msdownload', bytes: pdf(5) },
        { fileName: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(9)]) },
        { fileName: '../x.pdf', mimeType: 'application/pdf', bytes: pdf(5) },
        { fileName: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(0) },
        { fileName: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(BLUEPRINT_LIMITS.maxAssetBytes + 1, 1) },
      ]) {
        await expect(assets.upload(t.id, w.admin.id, bad)).rejects.toMatchObject({ response: { code: 'ASSET_REFUSED' } });
      }
      expect(storage.count('put')).toBe(before); // not a single byte of any of them was written
    });

    it('the per-template file cap holds under concurrency: racing uploads cannot take more than the last slots', async () => {
      const w = await world();
      const t = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: fixtureJson('sprint-board') });
      const max = BLUEPRINT_LIMITS.maxAssets;
      // fill all but 2 slots directly (fast), then race 6 uploads
      await prisma.templateAsset.createMany({
        data: Array.from({ length: max - 2 }, (_, i) => ({ templateId: t.id, sha256: sha(`filler-${i}`), fileName: `f${i}`, mimeType: 'text/plain', sizeBytes: 1, storageKey: `template-assets/${t.id}/filler${i}` })),
      });
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => assets.upload(t.id, w.admin.id, { fileName: `n${i}.txt`, mimeType: 'text/plain', bytes: Buffer.from(`new-${i}`) })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(await prisma.templateAsset.count({ where: { templateId: t.id } })).toBe(max);
      expect(storage.keys(`template-assets/${t.id}/`).filter((k) => !k.includes('filler'))).toHaveLength(2); // refused ones were never written
    });

    it('a version may only list files the template really stores (same hash AND size)', async () => {
      const w = await world();
      const t = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: fixtureJson('sprint-board') });
      const bp: any = fixtureJson('sprint-board');
      bp.assets = [{ key: 'a1', fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: sha('nothing') }];
      bp.projects[0].tasks[0].attachments = ['a1'];
      await expect(templates.addVersion(t.id, w.admin.id, { blueprint: bp })).rejects.toMatchObject({ response: { code: 'ASSET_MISSING' } });
      // a NEW template cannot list files either (nothing is stored yet)
      await expect(templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: bp })).rejects.toMatchObject({ response: { code: 'ASSET_MISSING' } });

      const bytes = pdf(10);
      const up = await assets.upload(t.id, w.admin.id, { fileName: 'x.pdf', mimeType: 'application/pdf', bytes });
      bp.assets[0].sha256 = up.sha256;
      bp.assets[0].sizeBytes = bytes.length + 1; // right hash, wrong size
      await expect(templates.addVersion(t.id, w.admin.id, { blueprint: bp })).rejects.toMatchObject({ response: { code: 'ASSET_MISSING' } });
      bp.assets[0].sizeBytes = bytes.length;
      await expect(templates.addVersion(t.id, w.admin.id, { blueprint: bp })).resolves.toMatchObject({ sequence: 2 });
      // and files of ANOTHER template do not count
      const other = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: fixtureJson('content-calendar') });
      const bp2: any = fixtureJson('content-calendar');
      bp2.assets = bp.assets;
      bp2.projects[0].tasks[0].attachments = ['a1'];
      await expect(templates.addVersion(other.id, w.admin.id, { blueprint: bp2 })).rejects.toMatchObject({ response: { code: 'ASSET_MISSING' } });
    });

    it('a fork gets its own copy of the files; deleting either does not touch the other', async () => {
      const w = await world();
      const { template, sha: h } = await templateWithFile(w, pdf(100), 1);
      const fork = await templates.fork(template.id, w.admin.id, w.account.id);
      expect(storage.keys('template-assets/').sort()).toEqual([templateAssetKey(template.id, h), templateAssetKey(fork.id, h)].sort());
      expect(await prisma.templateAsset.count({ where: { templateId: fork.id } })).toBe(1);

      await templates.delete(fork.id);
      expect(storage.keys('template-assets/')).toEqual([templateAssetKey(template.id, h)]);
      await templates.delete(template.id);
      expect(storage.keys('template-assets/')).toEqual([]);
      expect(await prisma.templateAsset.count()).toBe(0);
    });

    it('a fork that fails to copy leaves no stray objects', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(100), 1);
      storage.failCopyAfter = 0;
      await expect(templates.fork(template.id, w.admin.id, w.account.id)).rejects.toThrow('simulated copy failure');
      expect(storage.keys('template-assets/')).toHaveLength(1);
      expect(await prisma.template.count()).toBe(1);
    });
  });

  // ================================================================== apply ===============
  describe('apply: copy with quota', () => {
    it('copies one attachment per task that carries the file, CONFIRMED, on the real task, recorded for undo', async () => {
      const w = await world();
      const bytes = pdf(300);
      const { template } = await templateWithFile(w, bytes, 2);
      const preview: any = await applier.preview(w.admin.id, template.id, { workspaceId: w.ws.id } as any, { today: TODAY });
      expect(preview.plan.counts.assets).toEqual({ copies: 2, bytes: 2 * bytes.length });
      expect(preview.plan.warnings.map((x: any) => x.code)).not.toContain('ASSETS_NOT_COPIED');

      const r = await apply(w, template.id);
      expect(r.report.attachments).toBe(2);
      const rows = await prisma.attachment.findMany({ where: { accountId: w.account.id } });
      expect(rows).toHaveLength(2);
      expect(rows.every((a) => a.status === AttachmentStatus.CONFIRMED && a.confirmedAt && a.targetType === 'TASK' && a.sizeBytes === bytes.length && a.filename === 'brief.pdf')).toBe(true);
      const tasks = await prisma.task.findMany({ where: { id: { in: rows.map((a) => a.targetId) }, workspaceId: w.ws.id } });
      expect(tasks).toHaveLength(2); // each points at a real task of the target workspace
      for (const a of rows) {
        expect(a.storageKey.startsWith(installAttachmentPrefix(w.account.id, r.installId))).toBe(true);
        expect(storage.objects.get(a.storageKey)!.body.equals(bytes)).toBe(true);
      }
      expect(await prisma.attachment.count({ where: { status: AttachmentStatus.PENDING } })).toBe(0); // nothing left reserved
      expect(await prisma.templateInstallItem.count({ where: { installId: r.installId, entityType: 'ATTACHMENT', action: 'CREATED' } })).toBe(2);
      expect(storage.count('copy')).toBe(2);
    });

    it('RESERVES the quota before the first byte is copied (other uploads already see it)', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(300), 2);
      const seen: Array<{ pending: number; pendingBytes: number }> = [];
      const original = storage.copyObject.bind(storage);
      storage.copyObject = async (from, to) => {
        const rows = await prisma.attachment.findMany({ where: { accountId: w.account.id, status: AttachmentStatus.PENDING } });
        seen.push({ pending: rows.length, pendingBytes: rows.reduce((n, r) => n + r.sizeBytes, 0) });
        return original(from, to);
      };
      try {
        await apply(w, template.id);
      } finally {
        storage.copyObject = original;
      }
      // at the FIRST copy both files were already reserved (2 x 309 bytes); the second copy only has one left to confirm
      expect(seen[0]).toEqual({ pending: 2, pendingBytes: 2 * pdf(300).length });
    });

    it('preflight blocks with STORAGE_LIMIT when the files do not fit, and writes nothing', async () => {
      const w = await world(PlanKey.FREE_PERSONAL, AccountType.PERSONAL);
      const { template } = await templateWithFile(w, pdf(300), 2);
      // use up all but 100 bytes of the plan's 5 GB (rows only; sizeBytes is a 32-bit column, so several)
      const other = await createUser(prisma);
      const fill = 5 * GB - 100;
      const piece = 1_500_000_000;
      for (let left = fill; left > 0; left -= piece) {
        await prisma.attachment.create({ data: { accountId: w.account.id, targetType: 'TASK', targetId: 'x', uploadedById: other.id, filename: 'f', mimeType: 'text/plain', sizeBytes: Math.min(piece, left), storageKey: `k${left}`, status: AttachmentStatus.CONFIRMED, confirmedAt: new Date() } });
      }
      const preview: any = await applier.preview(w.admin.id, template.id, { workspaceId: w.ws.id } as any, { today: TODAY });
      expect(preview.plan.blockers.map((b: any) => b.code)).toEqual(['STORAGE_LIMIT']);
      await expect(apply(w, template.id)).rejects.toMatchObject({ response: { code: 'APPLY_BLOCKED' } });
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      expect(await prisma.templateInstall.count()).toBe(0);
      expect(storage.count('copy')).toBe(0);
    });

    it('two applies cannot both reserve the last bytes (the check and the reservation are one step under a lock)', async () => {
      const w = await world(PlanKey.FREE_PERSONAL, AccountType.PERSONAL);
      const { template } = await templateWithFile(w, pdf(300), 1); // 309 bytes per apply
      const ws2 = await createWorkspace(prisma, { accountId: w.account.id, name: 'Second', key: 'SEC' });
      const other = await createUser(prisma);
      const room = 309 + 100; // fits ONE apply, not two
      const fill = 5 * GB - room;
      for (let left = fill; left > 0; left -= 1_500_000_000) {
        await prisma.attachment.create({ data: { accountId: w.account.id, targetType: 'TASK', targetId: 'x', uploadedById: other.id, filename: 'f', mimeType: 'text/plain', sizeBytes: Math.min(1_500_000_000, left), storageKey: `k${left}`, status: AttachmentStatus.CONFIRMED, confirmedAt: new Date() } });
      }
      const resolved: any = { assets: [{ key: 'a1', fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 309, sha256: 'x' }], projects: [{ nodeKey: 'p', tasks: [{ nodeKey: 't1', attachments: ['a1'], children: [] }] }] };
      const reserve = (installId: string) => (applier as any).reserveStorage(installId, w.account.id, w.admin.id, resolved);
      const results = await Promise.allSettled([reserve('inst-a'), reserve('inst-b'), reserve('inst-c'), reserve('inst-d')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]) {
        expect(r.reason).toBeInstanceOf(ConflictException);
        expect(r.reason.response.code).toBe('STORAGE_LIMIT');
      }
      expect(await usedBytes(w.account.id)).toBeLessThanOrEqual(5 * GB);
      expect(ws2.id).toBeDefined();
    });

    it('two real applies racing for room for one: exactly one wins, the other leaves nothing behind', async () => {
      const w = await world(PlanKey.FREE_PERSONAL, AccountType.PERSONAL);
      const { template } = await templateWithFile(w, pdf(300), 1);
      const ws2 = await createWorkspace(prisma, { accountId: w.account.id, name: 'Second', key: 'SEC' });
      const other = await createUser(prisma);
      const fill = 5 * GB - (309 + 100);
      for (let left = fill; left > 0; left -= 1_500_000_000) {
        await prisma.attachment.create({ data: { accountId: w.account.id, targetType: 'TASK', targetId: 'x', uploadedById: other.id, filename: 'f', mimeType: 'text/plain', sizeBytes: Math.min(1_500_000_000, left), storageKey: `k${left}`, status: AttachmentStatus.CONFIRMED, confirmedAt: new Date() } });
      }
      const before = await usedBytes(w.account.id);
      const results = await Promise.allSettled([
        applier.apply(w.admin.id, template.id, { workspaceId: w.ws.id } as any, { today: TODAY }),
        applier.apply(w.admin.id, template.id, { workspaceId: ws2.id } as any, { today: TODAY }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await usedBytes(w.account.id)).toBe(before + 309); // only the winner's file
      expect(await prisma.attachment.count({ where: { status: AttachmentStatus.PENDING } })).toBe(0);
      const loserWs = results[0].status === 'fulfilled' ? ws2.id : w.ws.id;
      expect(await prisma.task.count({ where: { workspaceId: loserWs } })).toBe(0);
    });

    it('a failure part-way releases everything: reserved rows, copied objects, quota, and the workspace is as before', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(300), 2);
      const before = await usedBytes(w.account.id);
      storage.failCopyAfter = 1; // the first copy lands, the second fails
      await expect(apply(w, template.id)).rejects.toThrow('simulated copy failure');

      expect(await usedBytes(w.account.id)).toBe(before);
      expect(await prisma.attachment.count({ where: { accountId: w.account.id } })).toBe(0);
      expect(storage.keys('attachments/')).toEqual([]); // the object that DID get copied is deleted too
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      const install = await prisma.templateInstall.findFirstOrThrow();
      expect(install.status).toBe('FAILED');
      expect(install.report).toMatchObject({ compensated: true });
      // and the same apply works once the store is healthy again
      storage.failCopyAfter = null;
      await expect(apply(w, template.id)).resolves.toMatchObject({ dryRun: false });
      expect(await prisma.attachment.count({ where: { status: AttachmentStatus.CONFIRMED } })).toBe(2);
    });

    it('quota comes back even if the compensation itself fails', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(300), 2);
      storage.failCopyAfter = 0;
      const undo = jest.spyOn(applier as any, 'undoCore').mockRejectedValueOnce(new Error('cleanup broke'));
      try {
        await expect(apply(w, template.id)).rejects.toThrow('simulated copy failure');
      } finally {
        undo.mockRestore();
      }
      expect(await prisma.attachment.count({ where: { status: AttachmentStatus.PENDING } })).toBe(0);
      expect(await usedBytes(w.account.id)).toBe(0);
    });

    it('a template whose bytes are gone is blocked (ASSET_MISSING), not half-applied', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(300), 1);
      await prisma.templateAsset.deleteMany({ where: { templateId: template.id } });
      const preview: any = await applier.preview(w.admin.id, template.id, { workspaceId: w.ws.id } as any, { today: TODAY });
      expect(preview.plan.blockers.map((b: any) => b.code)).toContain('ASSET_MISSING');
      await expect(apply(w, template.id)).rejects.toMatchObject({ response: { code: 'APPLY_BLOCKED' } });
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });
  });

  // ================================================================== undo ================
  describe('undo', () => {
    it('deletes the copies (rows AND objects) and frees the quota; a dry run deletes nothing', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(300), 2);
      const r = await apply(w, template.id);
      const used = await usedBytes(w.account.id);
      expect(used).toBe(2 * pdf(300).length);

      const dry: any = await applier.previewUndo(w.admin.id, r.installId);
      expect(dry.deleted.ATTACHMENT).toBe(2);
      expect(await usedBytes(w.account.id)).toBe(used);
      expect(storage.keys('attachments/')).toHaveLength(2); // the preview touched nothing

      const done: any = await applier.undo(w.admin.id, r.installId);
      expect(done.deleted.ATTACHMENT).toBe(2);
      expect(await usedBytes(w.account.id)).toBe(0);
      expect(await prisma.attachment.count()).toBe(0);
      expect(storage.keys('attachments/')).toEqual([]);
      expect(storage.keys('template-assets/')).toHaveLength(1); // the template's own copy is untouched
      expect(await prisma.templateInstall.findUniqueOrThrow({ where: { id: r.installId } })).toMatchObject({ status: 'UNDONE' });
    });

    it('the template\'s own files do not make a task "in use"; a file the PERSON added does, and keeps everything above it', async () => {
      const w = await world();
      const { template } = await templateWithFile(w, pdf(300), 2);
      const r = await apply(w, template.id);
      const mine = await prisma.attachment.findFirstOrThrow({ where: { accountId: w.account.id } });
      // the person attaches their own file to the task of that copy
      await prisma.attachment.create({ data: { accountId: w.account.id, targetType: 'TASK', targetId: mine.targetId, uploadedById: w.admin.id, filename: 'mine.txt', mimeType: 'text/plain', sizeBytes: 5, storageKey: 'attachments/own/mine.txt', status: AttachmentStatus.CONFIRMED, confirmedAt: new Date() } });
      storage.seed('attachments/own/mine.txt', 'hello');

      const out: any = await applier.undo(w.admin.id, r.installId, { confirmEdited: true });
      expect(out.inUse.TASK).toBeGreaterThanOrEqual(1);
      // the person's file and the template copy on THAT task stay; the other task's copy went with its task
      const left = await prisma.attachment.findMany({ where: { accountId: w.account.id }, orderBy: { filename: 'asc' } });
      expect(left.map((a) => a.filename)).toEqual(['brief.pdf', 'mine.txt']);
      expect(left.every((a) => a.targetId === mine.targetId)).toBe(true);
      expect(storage.objects.has('attachments/own/mine.txt')).toBe(true);
      expect(storage.objects.has(mine.storageKey)).toBe(true);
    });

    it('an apply that copied nothing (no files) never touches storage', async () => {
      const w = await world();
      const t = await templates.createFromBlueprint(w.account.id, w.admin.id, { blueprint: fixtureJson('sprint-board') });
      const r = await apply(w, t.id);
      expect(r.report.attachments).toBe(0);
      expect(storage.log).toEqual([]);
      await applier.undo(w.admin.id, r.installId);
      expect(storage.log).toEqual([]);
    });
  });
});
