/**
 * Step 3.3 on a real database: the extractor reads a real workspace, deterministically, without
 * writing anything, and what it reads fits Blueprint v1 once sanitised.
 */
import { NotFoundException } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ExtractError } from '../../src/templates/extract/extract.types';
import { TemplateExtractionService } from '../../src/templates/extract/extract.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { createProject, createTask, createUserWithAccount, createWorkspace } from './factories';

describe('TemplateExtractionService (step 3.3)', () => {
  let prisma: PrismaService;
  let service: TemplateExtractionService;

  beforeAll(() => {
    prisma = getTestPrisma();
    service = new TemplateExtractionService(prisma);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const { user, account } = await createUserWithAccount(prisma, { accountType: AccountType.ORGANIZATION });
    const ws = await createWorkspace(prisma, { accountId: account.id, name: 'Bio', key: 'BIO' });
    const p1 = await createProject(prisma, { workspaceId: ws.id, createdById: user.id, name: 'Coursework' });
    const p2 = await createProject(prisma, { workspaceId: ws.id, createdById: user.id, name: 'Labs' });
    const tag = await prisma.tag.create({ data: { workspaceId: ws.id, name: 'exam', nameKey: 'exam' } });
    const field = await prisma.customField.create({
      data: { workspaceId: ws.id, key: 'prof review', name: 'Prof review', dataType: 'SELECT', options: ['pending', 'ok'], order: 1 },
    });
    const type = await prisma.issueType.create({ data: { workspaceId: ws.id, name: 'Exam', nameKey: 'exam', level: 'STANDARD' } });
    const iteration = await prisma.iteration.create({
      data: { workspaceId: ws.id, kind: 'MILESTONE', name: 'Midterm', startDate: new Date('2026-09-01'), endDate: new Date('2026-10-20') },
    });
    const parent = await createTask(prisma, { workspaceId: ws.id, createdById: user.id, projectId: p1.id, title: 'Midterm', description: 'ch 1-6', priority: 'HIGH', dueDate: new Date('2026-10-20T00:00:00Z'), issueType: { connect: { id: type.id } }, iteration: { connect: { id: iteration.id } } });
    const child = await createTask(prisma, { workspaceId: ws.id, createdById: user.id, projectId: p1.id, title: 'Review notes', parent: { connect: { id: parent.id } } });
    const other = await createTask(prisma, { workspaceId: ws.id, createdById: user.id, projectId: p1.id, title: 'Read ch 1', assignees: { connect: [{ id: user.id }] } });
    const lab = await createTask(prisma, { workspaceId: ws.id, createdById: user.id, projectId: p2.id, title: 'Lab 1' });
    const inbox = await createTask(prisma, { workspaceId: ws.id, createdById: user.id, title: 'Loose end' });
    await prisma.taskTag.create({ data: { taskId: parent.id, tagId: tag.id } });
    await prisma.taskCustomValue.create({ data: { taskId: parent.id, fieldId: field.id, value: 'pending' } });
    await prisma.taskDependency.createMany({
      data: [
        { blockingTaskId: other.id, blockedTaskId: parent.id, type: 'BLOCKS' },
        { blockingTaskId: parent.id, blockedTaskId: lab.id, type: 'BLOCKS' },
      ],
    });
    await prisma.comment.create({ data: { targetType: 'TASK', targetId: parent.id, authorId: user.id, content: 'cover ch 7 too' } });
    await prisma.attachment.createMany({
      data: [
        { accountId: account.id, targetType: 'TASK', targetId: parent.id, uploadedById: user.id, filename: 'syllabus.pdf', mimeType: 'application/pdf', sizeBytes: 100, storageKey: 'k/1', status: 'CONFIRMED' },
        { accountId: account.id, targetType: 'TASK', targetId: parent.id, uploadedById: user.id, filename: 'pending.bin', mimeType: 'application/octet-stream', sizeBytes: 1, storageKey: 'k/2', status: 'PENDING' },
      ],
    });
    return { user, ws, p1, p2, parent, child, other, lab, inbox };
  }

  it('extracts a workspace: tree, refs, workflow, dependencies, and reports what it left out', async () => {
    const { ws, user, parent, other } = await world();
    const { raw, report } = await service.extract(ws.id, { includeComments: true, includeAttachments: true });

    expect(raw.meta).toMatchObject({ name: 'Bio', kind: 'WORKSPACE' });
    expect(raw.projects.map((p) => p.nodeKey)).toEqual(['p-coursework', 'p-labs']);
    const cw = raw.projects[0];
    expect(cw.workflow!.statuses.map((s) => s.key)).toEqual(['to-do', 'in-progress', 'blocked', 'done']);
    const mid = cw.tasks.find((t) => t.title === 'Midterm')!;
    expect(mid).toMatchObject({ nodeKey: `t${parent.number}`, issueType: 'Exam', priority: 'HIGH', dueDate: '2026-10-20', iteration: 'i-midterm', tags: ['exam'], status: 'to-do' });
    expect(mid.customValues).toEqual({ 'prof-review': 'pending' });
    expect(mid.children.map((c) => c.title)).toEqual(['Review notes']);
    expect(mid.comments).toHaveLength(1);
    expect(mid.comments[0].authorUserId).toBe(user.id);
    expect(mid.attachments).toEqual(['a1']);
    expect(raw.assets).toHaveLength(1);
    expect(cw.tasks.find((t) => t.title === 'Read ch 1')!.assigneeUserIds).toEqual([user.id]);
    expect(cw.dependencies).toEqual([{ from: `t${other.number}`, to: `t${parent.number}`, type: 'BLOCKS' }]);

    expect(report.tasks).toMatchObject({ included: 4, inboxSkipped: 1 });
    expect(report.dependencies).toMatchObject({ included: 1, droppedOutsideProject: 1 });
    expect(report.attachments).toEqual({ included: 1, unconfirmedSkipped: 1 });
    expect(report.customFieldKeyChanges).toEqual([{ from: 'prof review', to: 'prof-review' }]);
  });

  it('extracts one project as a PROJECT template with only what it uses', async () => {
    const { ws, p2, p1 } = await world();
    const lab = await service.extract(ws.id, { projectId: p2.id });
    expect(lab.raw.meta.kind).toBe('PROJECT');
    expect(lab.raw.workspace.tags).toEqual([]);
    expect(lab.raw.workspace.iterations).toEqual([]);
    const cw = await service.extract(ws.id, { projectId: p1.id });
    expect(cw.raw.workspace.tags).toEqual([{ name: 'exam' }]);
    expect(cw.raw.workspace.iterations.map((i) => i.nodeKey)).toEqual(['i-midterm']);
  });

  it('is deterministic: the same workspace extracts to the same document every time', async () => {
    const { ws } = await world();
    const a = await service.extract(ws.id, { includeComments: true });
    const b = await service.extract(ws.id, { includeComments: true });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('is read-only: no rows change, none are added', async () => {
    const { ws } = await world();
    const count = async () => JSON.stringify(await Promise.all([
      prisma.task.count(), prisma.project.count(), prisma.tag.count(), prisma.activity.count(), prisma.auditLog.count(), prisma.comment.count(),
    ]));
    const before = await count();
    await service.extract(ws.id, { includeComments: true, includeAttachments: true });
    expect(await count()).toBe(before);
  });

  it('only reads its own workspace', async () => {
    const { ws } = await world();
    const { user, account } = await createUserWithAccount(prisma, { accountType: AccountType.ORGANIZATION });
    const other = await createWorkspace(prisma, { accountId: account.id, name: 'Other', key: 'OTH' });
    const op = await createProject(prisma, { workspaceId: other.id, createdById: user.id, name: 'Secret' });
    await createTask(prisma, { workspaceId: other.id, createdById: user.id, projectId: op.id, title: 'Not yours' });
    const { raw } = await service.extract(ws.id);
    expect(JSON.stringify(raw)).not.toContain('Not yours');
    expect(JSON.stringify(raw)).not.toContain('Secret');
    // a project id from another workspace is refused, not extracted
    await expect(service.extract(ws.id, { projectId: op.id })).rejects.toBeInstanceOf(ExtractError);
  });

  it('unknown workspace -> NotFound; archived tasks are skipped unless asked for', async () => {
    await expect(service.extract('nope')).rejects.toBeInstanceOf(NotFoundException);
    const { ws, other } = await world();
    await prisma.task.update({ where: { id: other.id }, data: { isArchived: true } });
    const skipped = await service.extract(ws.id);
    expect(skipped.report.tasks.archivedSkipped).toBe(1);
    expect(JSON.stringify(skipped.raw)).not.toContain('Read ch 1');
    expect(JSON.stringify((await service.extract(ws.id, { includeArchived: true })).raw)).toContain('Read ch 1');
  });
});
