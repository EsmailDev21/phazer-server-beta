/**
 * Step 0.8. Unit level: normalization, service logic over a Prisma double,
 * the route -> permission wiring, and the fan-out no-op. The database-level
 * guarantees (case-insensitive unique index, concurrent create, cascade) are
 * in test/integration/tags.int-spec.ts and the migration was verified on a
 * real Postgres (see PROGRESS.md).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActivityAction, Prisma } from '@prisma/client';
import { REQUIRE_ACCESS_KEY } from '../../access-control/decorators/require-access.decorator';
import { FanoutService } from '../../activity-notifications/fanout/fanout.service';
import { normalizeTagName, TAG_NAME_MAX_LENGTH } from './tag-name';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });

describe('normalizeTagName', () => {
  it.each([
    ['Bug', 'Bug', 'bug'],
    ['  bug ', 'bug', 'bug'],
    ['BUG', 'BUG', 'bug'],
    ['Two   Words', 'Two Words', 'two words'],
    ['two\twords\n', 'two words', 'two words'],
    ['\u00a0Bug\u00a0', 'Bug', 'bug'], // non-breaking spaces
    ['ＢＵＧ', 'ＢＵＧ', 'bug'], // full-width: NFKC folds the KEY, display is kept
    ['ﬁx', 'ﬁx', 'fix'], // ligature
    ['Über', 'Über', 'über'],
  ])('%j -> name %j, key %j', (raw, name, key) => {
    expect(normalizeTagName(raw)).toEqual({ name, nameKey: key });
  });

  it('Bug / bug / " BUG " share one key (the whole point)', () => {
    const keys = ['Bug', 'bug', ' BUG '].map(
      (n) => normalizeTagName(n).nameKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('rejects blank, over-long and control-character names', () => {
    expect(() => normalizeTagName('   ')).toThrow(BadRequestException);
    expect(() => normalizeTagName('')).toThrow(BadRequestException);
    expect(() => normalizeTagName('x'.repeat(TAG_NAME_MAX_LENGTH + 1))).toThrow(
      BadRequestException,
    );
    expect(() =>
      normalizeTagName('x'.repeat(TAG_NAME_MAX_LENGTH)),
    ).not.toThrow();
    expect(() => normalizeTagName('a\u0000b')).toThrow(/control/);
    expect(() => normalizeTagName('a\u0007b')).toThrow(/control/);
  });

  it('length is measured AFTER collapsing whitespace', () => {
    const raw = 'a' + ' '.repeat(80) + 'b';
    expect(normalizeTagName(raw).name).toBe('a b');
  });
});

function build(
  over: { allowManage?: boolean; workspaceAccess?: boolean } = {},
) {
  const tag = { id: 'tg1', workspaceId: 'w1', name: 'bug', nameKey: 'bug' };
  const db: any = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: 'w1' }) },
    task: {
      findUnique: jest.fn().mockResolvedValue({ id: 't1', workspaceId: 'w1' }),
    },
    tag: {
      findUnique: jest.fn().mockResolvedValue(tag),
      findMany: jest.fn(),
      create: jest
        .fn()
        .mockImplementation(async ({ data }) => ({ id: 'new', ...data })),
      update: jest
        .fn()
        .mockImplementation(async ({ data }) => ({ ...tag, ...data })),
      delete: jest.fn().mockResolvedValue(tag),
    },
    taskTag: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const resolver: any = {
    resolve: jest.fn().mockResolvedValue({
      allowed: over.allowManage ?? true,
      reason: 'nope',
    }),
    hasWorkspaceLevelAccess: jest
      .fn()
      .mockResolvedValue(over.workspaceAccess ?? true),
  };
  const activity: any = { record: jest.fn().mockResolvedValue({}) };
  return {
    db,
    resolver,
    activity,
    tag,
    svc: new TagsService(db, resolver, activity),
  };
}

describe('TagsService.create', () => {
  it('stores display name + normalized key, and never returns the key', async () => {
    const s = build();
    const res = await s.svc.create('w1', { name: '  My   Tag ' });
    expect(s.db.tag.create).toHaveBeenCalledWith({
      data: { workspaceId: 'w1', name: 'My Tag', nameKey: 'my tag' },
    });
    expect(res).toEqual({ id: 'new', name: 'My Tag', workspaceId: 'w1' });
    expect(res).not.toHaveProperty('nameKey');
  });

  it('maps the unique violation to 409 (no pre-check: race-free)', async () => {
    const s = build();
    s.db.tag.create.mockRejectedValue(p2002());
    await expect(s.svc.create('w1', { name: 'BUG' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.db.tag.findUnique).not.toHaveBeenCalled(); // no check-then-insert
  });

  it('lets any other database error through untouched', async () => {
    const s = build();
    const boom = new Error('connection lost');
    s.db.tag.create.mockRejectedValue(boom);
    await expect(s.svc.create('w1', { name: 'x' })).rejects.toBe(boom);
  });

  it('404 for a missing workspace; 400 for a blank name before touching the db', async () => {
    const s = build();
    s.db.workspace.findUnique.mockResolvedValue(null);
    await expect(s.svc.create('w1', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(s.svc.create('w1', { name: '  ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('TagsService.update / delete (permission resolved from the tag)', () => {
  it('denied -> 403 and no write', async () => {
    const s = build({ allowManage: false });
    await expect(
      s.svc.update('tg1', { name: 'x' }, 'u1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.svc.delete('tg1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(s.db.tag.update).not.toHaveBeenCalled();
    expect(s.db.tag.delete).not.toHaveBeenCalled();
    expect(s.resolver.resolve).toHaveBeenCalledWith(
      'u1',
      'manageTags',
      'WORKSPACE',
      'w1',
    );
  });

  it('unknown tag -> 404 before any permission lookup', async () => {
    const s = build();
    s.db.tag.findUnique.mockResolvedValue(null);
    await expect(
      s.svc.update('nope', { name: 'x' }, 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(s.resolver.resolve).not.toHaveBeenCalled();
  });

  it('identical rename is a no-op; case-only rename updates the display name', async () => {
    const s = build();
    await s.svc.update('tg1', { name: 'bug' }, 'u1');
    expect(s.db.tag.update).not.toHaveBeenCalled();
    const res = await s.svc.update('tg1', { name: 'Bug' }, 'u1');
    expect(s.db.tag.update).toHaveBeenCalledWith({
      where: { id: 'tg1' },
      data: { name: 'Bug', nameKey: 'bug' },
    });
    expect(res.name).toBe('Bug');
  });

  it("rename onto another tag's key -> 409", async () => {
    const s = build();
    s.db.tag.update.mockRejectedValue(p2002());
    await expect(
      s.svc.update('tg1', { name: 'Feature' }, 'u1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('delete removes the definition', async () => {
    const s = build();
    await s.svc.delete('tg1', 'u1');
    expect(s.db.tag.delete).toHaveBeenCalledWith({ where: { id: 'tg1' } });
  });
});

describe('TagsService.listByWorkspace', () => {
  it('403 without workspace-level access, no query issued', async () => {
    const s = build({ workspaceAccess: false });
    await expect(s.svc.listByWorkspace('w1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(s.db.tag.findMany).not.toHaveBeenCalled();
  });

  it('sorted by key, taskCount flattened, key not exposed', async () => {
    const s = build();
    s.db.tag.findMany.mockResolvedValue([
      { id: 'a', name: 'Alpha', workspaceId: 'w1', _count: { tasks: 3 } },
    ]);
    const res = await s.svc.listByWorkspace('w1', 'u1');
    expect(s.db.tag.findMany.mock.calls[0][0].orderBy).toEqual({
      nameKey: 'asc',
    });
    expect(res).toEqual([
      { id: 'a', name: 'Alpha', workspaceId: 'w1', taskCount: 3 },
    ]);
  });
});

describe('TagsService.attach / detach', () => {
  it('attach: first time logs TAG_ADDED with tag metadata', async () => {
    const s = build();
    const res = await s.svc.attach('t1', 'tg1', 'u1');
    expect(s.db.taskTag.createMany).toHaveBeenCalledWith({
      data: [{ taskId: 't1', tagId: 'tg1' }],
      skipDuplicates: true,
    });
    expect(s.activity.record).toHaveBeenCalledWith({
      actorId: 'u1',
      action: ActivityAction.TAG_ADDED,
      targetType: 'TASK',
      targetId: 't1',
      workspaceId: 'w1',
      metadata: { tagId: 'tg1', tagName: 'bug' },
    });
    expect(res).toEqual({ id: 'tg1', name: 'bug', workspaceId: 'w1' });
  });

  it('attach is idempotent: already attached -> success, NO second activity', async () => {
    const s = build();
    s.db.taskTag.createMany.mockResolvedValue({ count: 0 });
    await expect(s.svc.attach('t1', 'tg1', 'u1')).resolves.toBeDefined();
    expect(s.activity.record).not.toHaveBeenCalled();
  });

  it('attach rejects a tag from another workspace (400) and unknown ids (404)', async () => {
    const s = build();
    s.db.tag.findUnique.mockResolvedValue({
      id: 'tg1',
      workspaceId: 'OTHER',
      name: 'x',
    });
    await expect(s.svc.attach('t1', 'tg1', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s.db.taskTag.createMany).not.toHaveBeenCalled();
    s.db.tag.findUnique.mockResolvedValue(null);
    await expect(s.svc.attach('t1', 'tg1', 'u1')).rejects.toThrow(
      'Tag not found',
    );
    s.db.task.findUnique.mockResolvedValue(null);
    await expect(s.svc.attach('t1', 'tg1', 'u1')).rejects.toThrow(
      'Task not found',
    );
  });

  it('detach: logs TAG_REMOVED; not attached -> 404 and no activity', async () => {
    const s = build();
    await s.svc.detach('t1', 'tg1', 'u1');
    expect(s.activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ActivityAction.TAG_REMOVED,
        metadata: { tagId: 'tg1', tagName: 'bug' },
      }),
    );
    s.activity.record.mockClear();
    s.db.taskTag.deleteMany.mockResolvedValue({ count: 0 });
    await expect(s.svc.detach('t1', 'tg1', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s.activity.record).not.toHaveBeenCalled();
  });
});

describe('TagsController permission wiring', () => {
  const meta = (fn: unknown) =>
    Reflect.getMetadata(REQUIRE_ACCESS_KEY, fn as object);
  const proto = TagsController.prototype;

  it('create is guarded by manageTags on the workspace', () => {
    expect(meta(proto.create)).toMatchObject({
      action: 'manageTags',
      targetType: 'WORKSPACE',
    });
  });
  it('attach/detach reuse editTask on the TASK (action-config.ts says so)', () => {
    expect(meta(proto.attach)).toMatchObject({
      action: 'editTask',
      targetType: 'TASK',
    });
    expect(meta(proto.detach)).toMatchObject({
      action: 'editTask',
      targetType: 'TASK',
    });
  });
  it('list/update/delete carry NO route guard on purpose (checked in the service); pinned so it is not "fixed" into a wrong-resource check', () => {
    expect(meta(proto.list)).toBeUndefined();
    expect(meta(proto.update)).toBeUndefined();
    expect(meta(proto.delete)).toBeUndefined();
  });
});

describe('FanoutService ignores tag activity quietly', () => {
  it.each([
    ActivityAction.TAG_ADDED,
    ActivityAction.TAG_REMOVED,
    ActivityAction.PARENT_CHANGED,
    ActivityAction.TASK_MOVED,
  ])('%s: no notification, no "unmapped" warning', async (action) => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const prisma: any = new Proxy(
      {},
      {
        get: () => {
          throw new Error('fanout touched the db');
        },
      },
    );
    const notifications: any = { createMany: jest.fn(), create: jest.fn() };
    const fanout = new FanoutService(prisma, notifications);
    await fanout.handleActivityCreated({
      id: 'a',
      action,
      targetType: 'TASK',
      targetId: 't1',
      workspaceId: 'w1',
      actorId: 'u1',
      metadata: null,
      visibility: 'TIMELINE',
      createdAt: new Date(),
    } as any);
    expect(warn).not.toHaveBeenCalled();
    expect(notifications.createMany).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
