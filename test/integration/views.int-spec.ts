/**
 * Step 5.4 on a real database: saved views.
 *   create / update / get / list / delete / duplicate, validation against the workspace, personal vs
 *   shared (visibility and who may change what), scopes, caps (also under races), lifecycle, and the
 *   rules the database enforces on its own.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { WorkspaceContextLoader } from '../../src/automations/dsl/workspace-context.loader';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UpdateViewDto } from '../../src/views/dto/view.dto';
import { VIEW_LIMITS } from '../../src/views/dsl';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TaskQueryService } from '../../src/views/run/task-query.service';
import { ViewsService } from '../../src/views/views.service';
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

jest.setTimeout(120_000);

describe('Saved views (step 5.4)', () => {
  let prisma: PrismaService;
  let svc: ViewsService;
  let resolver: PermissionResolver;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        PlanLimitsService,
        PermissionResolver,
        WorkspaceContextLoader,
        TaskVisibilityService,
        TaskQueryService,
        ViewsService,
      ],
    }).compile();
    svc = moduleRef.get(ViewsService);
    resolver = moduleRef.get(PermissionResolver);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

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
    const [owner, admin, member, member2, viewer] = [
      await mk(Role.OWNER),
      await mk(Role.ADMIN),
      await mk(Role.MEMBER),
      await mk(Role.MEMBER),
      await mk(Role.VIEWER),
    ];
    const outsider = await createUser(prisma);
    await addAccountMember(prisma, {
      accountId: (await createAccount(prisma, {})).id,
      userId: outsider.id,
      role: Role.OWNER,
    });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const p1 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const p2 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const tag = await prisma.tag.create({
      data: { workspaceId: ws.id, name: 'urgent', nameKey: 'urgent' },
    });
    const iteration = await prisma.iteration.create({
      data: {
        workspaceId: ws.id,
        name: 'Sprint 1',
        kind: 'SPRINT',
        startDate: new Date('2026-10-01'),
        endDate: new Date('2026-10-14'),
      } as any,
    });
    const field = (key: string, dataType: any, options?: string[]) =>
      prisma.customField.create({
        data: { workspaceId: ws.id, key, name: key, dataType, options },
      });
    const fSel = await field('colour', 'SELECT', ['red', 'blue']);
    const fNum = await field('score', 'NUMBER');
    const fMulti = await field('labels', 'MULTI_SELECT', ['a', 'b']);
    const todo1 = await prisma.workflowStatus.findFirstOrThrow({
      where: { projectId: p1.id, category: 'TODO' },
    });
    const todo2 = await prisma.workflowStatus.findFirstOrThrow({
      where: { projectId: p2.id, category: 'TODO' },
    });
    return {
      account,
      owner,
      admin,
      member,
      member2,
      viewer,
      outsider,
      ws,
      p1,
      p2,
      tag,
      iteration,
      fSel,
      fNum,
      fMulti,
      todo1,
      todo2,
    };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const view = (over: Record<string, unknown> = {}) =>
    ({ name: 'My view', layout: 'LIST', config: {}, ...over }) as any;
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e: any) {
      return { status: e.getStatus?.(), body: e.getResponse?.() };
    }
    throw new Error('expected a failure');
  };
  const names = async (w: W, userId: string, q: any = {}) =>
    (await svc.list(w.ws.id, userId, q)).map((v) => v.name);

  // =============================================================== create ======================
  describe('create', () => {
    it('a member makes a personal view: normalised name, owner, first position, editable by them', async () => {
      const w = await world();
      const v = await svc.create(
        w.ws.id,
        w.member.id,
        view({
          name: '  My   Open  Work ',
          config: {
            filters: {
              all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
            },
            sort: [{ field: 'DUE_DATE', dir: 'ASC' }],
          },
        }),
      );
      expect(v).toMatchObject({
        name: 'My Open Work',
        layout: 'LIST',
        isShared: false,
        ownerId: w.member.id,
        projectId: null,
        position: 0,
        canEdit: true,
      });
      const row = await prisma.savedView.findUniqueOrThrow({
        where: { id: v.id },
      });
      expect(row.nameKey).toBe('my open work');
      expect(row.config).toEqual({
        filters: {
          all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
        },
        sort: [{ field: 'DUE_DATE', dir: 'ASC' }],
      });
    });

    it('every layout', async () => {
      const w = await world();
      const cfg: Record<string, unknown> = {
        LIST: {},
        TABLE: { columns: ['KEY', 'TITLE'] },
        BOARD: { group: { by: 'PRIORITY' } },
        CALENDAR: { calendar: { dateField: 'DUE_DATE' } },
        TIMELINE: {
          timeline: { startField: 'START_DATE', endField: 'DUE_DATE' },
        },
      };
      for (const layout of Object.keys(cfg))
        await svc.create(
          w.ws.id,
          w.member.id,
          view({ name: layout, layout, config: cfg[layout] }),
        );
      expect(await names(w, w.member.id)).toEqual([
        'LIST',
        'TABLE',
        'BOARD',
        'CALENDAR',
        'TIMELINE',
      ]);
    });

    it('an invalid config is refused with paths; nothing is stored', async () => {
      const w = await world();
      const f = await failure(
        svc.create(
          w.ws.id,
          w.member.id,
          view({
            layout: 'CALENDAR',
            config: { group: { by: 'STATUS' }, bogus: 1 },
          }),
        ),
      );
      expect(f.status).toBe(422);
      expect(f.body.code).toBe('VIEW_INVALID');
      expect(f.body.issues.map((i: any) => `${i.code}@${i.path}`)).toEqual(
        expect.arrayContaining([
          'UNKNOWN_KEY@/bogus',
          'NOT_FOR_LAYOUT@/group',
          'MISSING@/calendar',
        ]),
      );
      expect(await prisma.savedView.count()).toBe(0);
    });

    it('checks the config against the workspace: ids, custom field types, iterations', async () => {
      const w = await world();
      const f = await failure(
        svc.create(
          w.ws.id,
          w.member.id,
          view({
            config: {
              filters: {
                all: [
                  {
                    field: 'ITERATION',
                    op: 'IN',
                    value: [w.iteration.id, 'ghost'],
                  },
                  { field: 'TAGS', op: 'HAS_ANY', value: ['nope'] },
                  {
                    field: 'ASSIGNEES',
                    op: 'INCLUDES_ANY',
                    value: ['TRIGGERER'],
                  },
                ],
              },
              group: { customFieldId: w.fNum.id },
              sort: [{ customFieldId: w.fMulti.id, dir: 'ASC' }],
              columns: ['custom:missing'],
            },
          }),
        ),
      );
      expect(f.body.issues.map((i: any) => `${i.code}@${i.path}`)).toEqual([
        'UNKNOWN_ITERATION@/filters/all/0/value/1',
        'UNKNOWN_TAG@/filters/all/1/value/0',
        'UNKNOWN_USER@/filters/all/2/value/0',
        'GROUP_TYPE_MISMATCH@/group/customFieldId',
        'SORT_TYPE_MISMATCH@/sort/0/customFieldId',
        'UNKNOWN_CUSTOM_FIELD@/columns/0',
      ]);
      await expect(
        svc.create(
          w.ws.id,
          w.member.id,
          view({
            layout: 'BOARD',
            config: { group: { customFieldId: w.fSel.id } },
          }),
        ),
      ).resolves.toBeDefined();
      await expect(
        svc.create(
          w.ws.id,
          w.member.id,
          view({
            name: 'v2',
            config: {
              filters: {
                all: [
                  { field: 'ITERATION', op: 'IN', value: [w.iteration.id] },
                  { field: 'TAGS', op: 'HAS_ANY', value: [w.tag.id] },
                  {
                    field: 'ASSIGNEES',
                    op: 'INCLUDES_ANY',
                    value: [w.member2.id, 'ME'],
                  },
                ],
              },
            },
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('ids from ANOTHER workspace do not resolve', async () => {
      const a = await world();
      const b = await world();
      for (const filter of [
        { field: 'TAGS', op: 'HAS_ANY', value: [b.tag.id] },
        { field: 'ITERATION', op: 'IN', value: [b.iteration.id] },
        { field: 'CUSTOM', customFieldId: b.fNum.id, op: 'GT', value: 1 },
        { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: [b.owner.id] },
      ]) {
        const f = await failure(
          svc.create(
            a.ws.id,
            a.member.id,
            view({ config: { filters: { all: [filter] } } }),
          ),
        );
        expect(f.status).toBe(422);
      }
      expect(
        (
          await failure(
            svc.create(a.ws.id, a.member.id, view({ projectId: b.p1.id })),
          )
        ).status,
      ).toBe(400);
      expect(await prisma.savedView.count()).toBe(0);
    });

    describe('scope', () => {
      it("a project view may name that project's statuses; a workspace view only categories", async () => {
        const w = await world();
        const cfg = {
          filters: {
            all: [{ field: 'STATUS', op: 'IN', value: [w.todo1.id] }],
          },
        };
        await expect(
          svc.create(
            w.ws.id,
            w.member.id,
            view({ projectId: w.p1.id, config: cfg }),
          ),
        ).resolves.toMatchObject({ projectId: w.p1.id });
        expect(
          (
            await failure(
              svc.create(
                w.ws.id,
                w.member.id,
                view({ name: 'wide', config: cfg }),
              ),
            )
          ).body.issues[0].code,
        ).toBe('STATUS_NEEDS_PROJECT');
        expect(
          (
            await failure(
              svc.create(
                w.ws.id,
                w.member.id,
                view({ name: 'other', projectId: w.p2.id, config: cfg }),
              ),
            )
          ).body.issues[0].code,
        ).toBe('UNKNOWN_STATUS');
        expect(w.todo2.id).not.toBe(w.todo1.id);
      });
    });

    describe('names', () => {
      it('unique per owner within a scope; free across owners, scopes, and between personal and shared', async () => {
        const w = await world();
        await svc.create(w.ws.id, w.member.id, view({ name: 'Sprint' }));
        expect(
          (
            await failure(
              svc.create(w.ws.id, w.member.id, view({ name: ' sprint ' })),
            )
          ).body.code,
        ).toBe('NAME_TAKEN');
        await expect(
          svc.create(w.ws.id, w.member2.id, view({ name: 'Sprint' })),
        ).resolves.toBeDefined(); // another owner
        await expect(
          svc.create(
            w.ws.id,
            w.member.id,
            view({ name: 'Sprint', projectId: w.p1.id }),
          ),
        ).resolves.toBeDefined(); // another scope
        await expect(
          svc.create(
            w.ws.id,
            w.admin.id,
            view({ name: 'Sprint', isShared: true }),
          ),
        ).resolves.toBeDefined(); // shared namespace
        expect(
          (
            await failure(
              svc.create(
                w.ws.id,
                w.owner.id,
                view({ name: 'SPRINT', isShared: true }),
              ),
            )
          ).body.code,
        ).toBe('NAME_TAKEN');
      });
      it('rejects blank and control-character names', async () => {
        const w = await world();
        await expect(
          svc.create(w.ws.id, w.member.id, view({ name: '   ' })),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          svc.create(w.ws.id, w.member.id, view({ name: 'a\u0000b' })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('positions: each new view goes to the end of its own list; an explicit one is kept', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.member.id, view({ name: 'a' }));
      const b = await svc.create(w.ws.id, w.member.id, view({ name: 'b' }));
      const other = await svc.create(
        w.ws.id,
        w.member2.id,
        view({ name: 'a' }),
      );
      const pinned = await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'pinned', position: 50 }),
      );
      const c = await svc.create(w.ws.id, w.member.id, view({ name: 'c' }));
      expect([
        a.position,
        b.position,
        other.position,
        pinned.position,
        c.position,
      ]).toEqual([0, 1, 0, 50, 51]);
    });
  });

  // =============================================================== personal vs shared ===========
  describe('personal and shared', () => {
    it('only an admin or owner can make a shared view; members get a clear 403', async () => {
      const w = await world();
      const f = await failure(
        svc.create(w.ws.id, w.member.id, view({ isShared: true })),
      );
      expect(f).toMatchObject({
        status: 403,
        body: { code: 'SHARED_NEEDS_ADMIN' },
      });
      expect(await prisma.savedView.count()).toBe(0);
      expect(
        (
          await svc.create(
            w.ws.id,
            w.admin.id,
            view({ name: 'Team', isShared: true }),
          )
        ).isShared,
      ).toBe(true);
      expect(
        (
          await svc.create(
            w.ws.id,
            w.owner.id,
            view({ name: 'Owner team', isShared: true }),
          )
        ).isShared,
      ).toBe(true);
    });

    it('a personal view is invisible to everyone else - including admins - and answers 404, not 403', async () => {
      const w = await world();
      const mine = await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'Private' }),
      );
      for (const other of [w.member2, w.admin, w.owner, w.viewer]) {
        expect(await names(w, other.id)).toEqual([]);
        await expect(
          svc.get(w.ws.id, mine.id, other.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.update(w.ws.id, mine.id, other.id, { name: 'x' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.remove(w.ws.id, mine.id, other.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.duplicate(w.ws.id, mine.id, other.id),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(await prisma.savedView.count()).toBe(1);
      expect((await svc.get(w.ws.id, mine.id, w.member.id)).id).toBe(mine.id);
    });

    it('a shared view is visible to every member; only admins can change or delete it, whoever made it', async () => {
      const w = await world();
      const team = await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 'Team', isShared: true }),
      );
      for (const u of [w.owner, w.admin, w.member, w.member2, w.viewer])
        expect((await svc.get(w.ws.id, team.id, u.id)).id).toBe(team.id);
      expect((await svc.get(w.ws.id, team.id, w.member.id)).canEdit).toBe(
        false,
      );
      expect((await svc.get(w.ws.id, team.id, w.owner.id)).canEdit).toBe(true); // an admin who did not make it
      for (const u of [w.member, w.viewer]) {
        expect(
          (
            await failure(
              svc.update(w.ws.id, team.id, u.id, { name: 'hacked' }),
            )
          ).status,
        ).toBe(403);
        expect((await failure(svc.remove(w.ws.id, team.id, u.id))).status).toBe(
          403,
        );
      }
      expect(
        (
          await svc.update(w.ws.id, team.id, w.owner.id, {
            name: 'Renamed by another admin',
          })
        ).name,
      ).toBe('Renamed by another admin');
      await svc.remove(w.ws.id, team.id, w.owner.id);
      expect(await prisma.savedView.count()).toBe(0);
    });

    it('an outsider cannot list or read anything', async () => {
      const w = await world();
      const team = await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 'Team', isShared: true }),
      );
      await expect(svc.list(w.ws.id, w.outsider.id, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        svc.get(w.ws.id, team.id, w.outsider.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('workspaces are isolated', async () => {
      const a = await world();
      const b = await world();
      const team = await svc.create(
        a.ws.id,
        a.admin.id,
        view({ name: 'Team', isShared: true }),
      );
      await expect(
        svc.get(b.ws.id, team.id, b.admin.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.update(b.ws.id, team.id, b.admin.id, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.remove(b.ws.id, team.id, b.admin.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await names(b, b.admin.id)).toEqual([]);
    });

    it('who the guard lets write: members and up, not viewers or outsiders', async () => {
      const w = await world();
      const can = async (u: { id: string }) =>
        (await resolver.resolve(u.id, 'manageSavedViews', 'WORKSPACE', w.ws.id))
          .allowed;
      expect([
        await can(w.owner),
        await can(w.admin),
        await can(w.member),
        await can(w.viewer),
        await can(w.outsider),
      ]).toEqual([true, true, true, false, false]);
    });
  });

  // =============================================================== update =======================
  describe('update', () => {
    it('renames, repositions, and re-checks the config as a whole', async () => {
      const w = await world();
      const v = await svc.create(
        w.ws.id,
        w.member.id,
        view({ config: { sort: [{ field: 'TITLE', dir: 'ASC' }] } }),
      );
      const u = await svc.update(w.ws.id, v.id, w.member.id, {
        name: 'Better',
        position: 7,
        config: { group: { by: 'STATUS' } },
      });
      expect(u).toMatchObject({
        name: 'Better',
        position: 7,
        config: { group: { by: 'STATUS' } },
      });
      const bad = await failure(
        svc.update(w.ws.id, v.id, w.member.id, {
          config: { group: { by: 'NOPE' } },
        }),
      );
      expect(bad.status).toBe(422);
      expect((await svc.get(w.ws.id, v.id, w.member.id)).config).toEqual({
        group: { by: 'STATUS' },
      });
    });
    it('changing the layout re-validates the stored config against it', async () => {
      const w = await world();
      const v = await svc.create(
        w.ws.id,
        w.member.id,
        view({ layout: 'BOARD', config: { group: { by: 'PRIORITY' } } }),
      );
      const f = await failure(
        svc.update(w.ws.id, v.id, w.member.id, { layout: 'CALENDAR' }),
      );
      expect(f.body.issues.map((i: any) => i.code)).toEqual(
        expect.arrayContaining(['NOT_FOR_LAYOUT', 'MISSING']),
      );
      const ok = await svc.update(w.ws.id, v.id, w.member.id, {
        layout: 'CALENDAR',
        config: { calendar: { dateField: 'START_DATE' } },
      });
      expect(ok).toMatchObject({
        layout: 'CALENDAR',
        config: { calendar: { dateField: 'START_DATE' } },
      });
    });
    it('the scope of a view cannot be changed', async () => {
      const w = await world();
      const v = await svc.create(
        w.ws.id,
        w.member.id,
        view({ projectId: w.p1.id }),
      );
      await svc.update(w.ws.id, v.id, w.member.id, { name: 'still p1' });
      expect(
        (await prisma.savedView.findUniqueOrThrow({ where: { id: v.id } }))
          .projectId,
      ).toBe(w.p1.id);
      expect(Object.keys(new UpdateViewDto())).not.toContain('projectId');
    });
    it('a rename onto an existing name conflicts; an empty update changes nothing', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.member.id, view({ name: 'A' }));
      await svc.create(w.ws.id, w.member.id, view({ name: 'B' }));
      expect(
        (await failure(svc.update(w.ws.id, a.id, w.member.id, { name: 'b' })))
          .body.code,
      ).toBe('NAME_TAKEN');
      expect(
        (await svc.update(w.ws.id, a.id, w.member.id, {})).updatedAt,
      ).toEqual(a.updatedAt);
    });

    describe('sharing and unsharing', () => {
      it("a member cannot share their own view; an admin can share an admin's own, which then belongs to the team", async () => {
        const w = await world();
        const mine = await svc.create(
          w.ws.id,
          w.member.id,
          view({ name: 'Mine' }),
        );
        expect(
          (
            await failure(
              svc.update(w.ws.id, mine.id, w.member.id, { isShared: true }),
            )
          ).body.code,
        ).toBe('SHARED_NEEDS_ADMIN');
        expect(
          (await prisma.savedView.findUniqueOrThrow({ where: { id: mine.id } }))
            .isShared,
        ).toBe(false);
        const adm = await svc.create(
          w.ws.id,
          w.admin.id,
          view({ name: 'Admin personal' }),
        );
        expect(
          (await svc.update(w.ws.id, adm.id, w.admin.id, { isShared: true }))
            .isShared,
        ).toBe(true);
        expect(await names(w, w.member.id, { shared: true })).toEqual([
          'Admin personal',
        ]);
        expect(
          (
            await failure(
              svc.update(w.ws.id, adm.id, w.member.id, { isShared: false }),
            )
          ).status,
        ).toBe(403);
      });
      it('sharing onto a name already shared conflicts; sharing respects the shared cap', async () => {
        const w = await world();
        await svc.create(
          w.ws.id,
          w.admin.id,
          view({ name: 'Team', isShared: true }),
        );
        const mine = await svc.create(
          w.ws.id,
          w.admin.id,
          view({ name: 'Team' }),
        );
        expect(
          (
            await failure(
              svc.update(w.ws.id, mine.id, w.admin.id, { isShared: true }),
            )
          ).body.code,
        ).toBe('NAME_TAKEN');
      });
      it("unsharing makes it personal; an ownerless shared view becomes the unsharer's", async () => {
        const w = await world();
        const t = await svc.create(
          w.ws.id,
          w.member2.id.length ? w.admin.id : w.admin.id,
          view({ name: 'Team', isShared: true }),
        );
        await prisma.savedView.update({
          where: { id: t.id },
          data: { ownerId: null },
        });
        const back = await svc.update(w.ws.id, t.id, w.owner.id, {
          isShared: false,
        });
        expect(back).toMatchObject({ isShared: false, ownerId: w.owner.id });
        expect(await names(w, w.member.id)).toEqual([]);
        expect(await names(w, w.owner.id)).toEqual(['Team']);
      });
    });
  });

  // =============================================================== delete / duplicate ===========
  describe('delete and duplicate', () => {
    it('the owner deletes their personal view', async () => {
      const w = await world();
      const v = await svc.create(w.ws.id, w.member.id, view());
      await svc.remove(w.ws.id, v.id, w.member.id);
      expect(await prisma.savedView.count()).toBe(0);
    });
    it('"save as my own": a member copies a shared view into a personal one they can change', async () => {
      const w = await world();
      const team = await svc.create(
        w.ws.id,
        w.admin.id,
        view({
          name: 'Team board',
          layout: 'BOARD',
          projectId: w.p1.id,
          config: { group: { by: 'ASSIGNEE' }, hideCompleted: true },
          isShared: true,
        }),
      );
      const copy = await svc.duplicate(w.ws.id, team.id, w.member.id);
      expect(copy).toMatchObject({
        name: 'Team board (copy)',
        layout: 'BOARD',
        projectId: w.p1.id,
        isShared: false,
        ownerId: w.member.id,
        config: { group: { by: 'ASSIGNEE' }, hideCompleted: true },
        canEdit: true,
      });
      const copy2 = await svc.duplicate(w.ws.id, team.id, w.member.id);
      expect(copy2.name).toBe('Team board (copy 2)');
      expect(copy2.position).toBe(copy.position + 1);
      expect(
        (
          await svc.update(w.ws.id, copy.id, w.member.id, {
            config: { group: { by: 'PRIORITY' } },
          })
        ).config,
      ).toEqual({ group: { by: 'PRIORITY' } });
      expect((await svc.get(w.ws.id, team.id, w.member.id)).config).toEqual({
        group: { by: 'ASSIGNEE' },
        hideCompleted: true,
      }); // the original is untouched
    });
    it('a long name still gets a unique copy name within the limit', async () => {
      const w = await world();
      const v = await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'x'.repeat(120) }),
      );
      const c = await svc.duplicate(w.ws.id, v.id, w.member.id);
      expect(c.name.length).toBeLessThanOrEqual(120);
      expect(c.name.endsWith(' (copy)')).toBe(true);
    });
  });

  // =============================================================== list =========================
  describe('list', () => {
    it("shows shared + my own (shared first, each by its own position), with canEdit per caller; never others' personal", async () => {
      const w = await world();
      await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 'Team', isShared: true, position: 5 }),
      );
      await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'Mine', position: 1 }),
      );
      await svc.create(
        w.ws.id,
        w.member2.id,
        view({ name: 'Theirs', position: 0 }),
      );
      const asMember = await svc.list(w.ws.id, w.member.id, {});
      expect(asMember.map((v) => [v.name, v.canEdit])).toEqual([
        ['Team', false],
        ['Mine', true],
      ]); // shared first, then my own
      expect(
        (await svc.list(w.ws.id, w.admin.id, {})).map((v) => [
          v.name,
          v.canEdit,
        ]),
      ).toEqual([['Team', true]]);
      expect(
        (await svc.list(w.ws.id, w.viewer.id, {})).map((v) => [
          v.name,
          v.canEdit,
        ]),
      ).toEqual([['Team', false]]);
    });
    it('filters by project (its own and the workspace-wide ones), layout and shared', async () => {
      const w = await world();
      await svc.create(w.ws.id, w.member.id, view({ name: 'wide' }));
      await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'p1', projectId: w.p1.id }),
      );
      await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'p2 board', projectId: w.p2.id, layout: 'BOARD' }),
      );
      await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 'team', isShared: true }),
      );
      expect(await names(w, w.member.id, { projectId: w.p1.id })).toEqual([
        'team',
        'wide',
        'p1',
      ]);
      expect(await names(w, w.member.id, { projectId: w.p2.id })).toEqual([
        'team',
        'wide',
        'p2 board',
      ]);
      expect(await names(w, w.member.id, { layout: 'BOARD' })).toEqual([
        'p2 board',
      ]);
      expect(await names(w, w.member.id, { shared: true })).toEqual(['team']);
      expect(await names(w, w.member.id, { shared: false })).toEqual([
        'wide',
        'p1',
        'p2 board',
      ]);
    });
  });

  // =============================================================== stale configs ================
  describe('a view whose references were deleted later', () => {
    it('shows its problems on get, can still be renamed and fixed', async () => {
      const w = await world();
      const v = await svc.create(
        w.ws.id,
        w.member.id,
        view({
          config: {
            filters: {
              all: [
                { field: 'TAGS', op: 'HAS_ANY', value: [w.tag.id] },
                { field: 'ITERATION', op: 'IN', value: [w.iteration.id] },
              ],
            },
            group: { customFieldId: w.fSel.id },
          },
        }),
      );
      expect((await svc.get(w.ws.id, v.id, w.member.id)).problems).toEqual([]);
      await prisma.tag.delete({ where: { id: w.tag.id } });
      await prisma.iteration.delete({ where: { id: w.iteration.id } });
      await prisma.customField.delete({ where: { id: w.fSel.id } });
      expect(
        (await svc.get(w.ws.id, v.id, w.member.id)).problems!.map(
          (p) => p.code,
        ),
      ).toEqual(['UNKNOWN_TAG', 'UNKNOWN_ITERATION', 'UNKNOWN_CUSTOM_FIELD']);
      await expect(
        svc.update(w.ws.id, v.id, w.member.id, { name: 'renamed anyway' }),
      ).resolves.toBeDefined();
      await expect(
        svc.update(w.ws.id, v.id, w.member.id, { config: {} }),
      ).resolves.toMatchObject({ config: {} });
      expect((await svc.get(w.ws.id, v.id, w.member.id)).problems).toEqual([]);
    });
    it('a stored config that no longer parses is reported, not a crash', async () => {
      const w = await world();
      const v = await svc.create(w.ws.id, w.member.id, view());
      await prisma.savedView.update({
        where: { id: v.id },
        data: { config: { nonsense: true } },
      });
      expect((await svc.get(w.ws.id, v.id, w.member.id)).problems).toEqual([
        expect.objectContaining({ code: 'UNKNOWN_KEY' }),
      ]);
      expect(await names(w, w.member.id)).toEqual(['My view']);
    });
  });

  // =============================================================== dry run ======================
  it('validate reports without storing anything', async () => {
    const w = await world();
    expect(
      await svc.validate(w.ws.id, w.member.id, {
        layout: 'LIST',
        config: {},
      } as any),
    ).toEqual({ valid: true, issues: [] });
    const bad = await svc.validate(w.ws.id, w.member.id, {
      layout: 'BOARD',
      config: { group: { by: 'DUE_DATE' } },
    } as any);
    expect(bad).toMatchObject({
      valid: false,
      issues: [{ code: 'BAD_BOARD_GROUP' }],
    });
    expect(
      (
        await svc.validate(w.ws.id, w.member.id, {
          layout: 'LIST',
          config: {
            filters: {
              all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['ghost'] }],
            },
          },
        } as any)
      ).issues[0].code,
    ).toBe('UNKNOWN_TAG');
    expect(
      (
        await failure(
          svc.validate(w.ws.id, w.member.id, {
            layout: 'LIST',
            projectId: 'nope',
            config: {},
          } as any),
        )
      ).status,
    ).toBe(400);
    expect(await prisma.savedView.count()).toBe(0);
  });

  // =============================================================== caps =========================
  describe('caps', () => {
    const fill = (w: W, ownerId: string, n: number, shared: boolean) =>
      prisma.savedView.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          workspaceId: w.ws.id,
          ownerId,
          name: `bulk ${i}`,
          nameKey: `bulk ${i}`,
          layout: 'LIST' as const,
          config: {},
          isShared: shared,
          position: i,
        })),
      });
    it(`${VIEW_LIMITS.maxPersonalPerUserPerWorkspace} personal views per person per workspace (others unaffected)`, async () => {
      const w = await world();
      await fill(
        w,
        w.member.id,
        VIEW_LIMITS.maxPersonalPerUserPerWorkspace,
        false,
      );
      expect(
        (await failure(svc.create(w.ws.id, w.member.id, view()))).body.code,
      ).toBe('VIEW_LIMIT');
      await expect(
        svc.create(w.ws.id, w.member2.id, view()),
      ).resolves.toBeDefined();
      expect(
        (
          await failure(
            svc.duplicate(
              w.ws.id,
              (
                await svc.create(
                  w.ws.id,
                  w.admin.id,
                  view({ name: 'T', isShared: true }),
                )
              ).id,
              w.member.id,
            ),
          )
        ).body.code,
      ).toBe('VIEW_LIMIT');
    });
    it(`${VIEW_LIMITS.maxSharedPerWorkspace} shared views per workspace`, async () => {
      const w = await world();
      await fill(w, w.admin.id, VIEW_LIMITS.maxSharedPerWorkspace, true);
      expect(
        (
          await failure(
            svc.create(w.ws.id, w.admin.id, view({ isShared: true })),
          )
        ).body.code,
      ).toBe('VIEW_LIMIT');
      const mine = await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 'to share' }),
      );
      expect(
        (
          await failure(
            svc.update(w.ws.id, mine.id, w.admin.id, { isShared: true }),
          )
        ).body.code,
      ).toBe('VIEW_LIMIT');
      await expect(
        svc.create(w.ws.id, w.admin.id, view({ name: 'personal still ok' })),
      ).resolves.toBeDefined();
    });
    it('eight creates racing for the last personal slot: exactly one wins', async () => {
      const w = await world();
      await fill(
        w,
        w.member.id,
        VIEW_LIMITS.maxPersonalPerUserPerWorkspace - 1,
        false,
      );
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          svc.create(w.ws.id, w.member.id, view({ name: `racer ${i}` })),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.savedView.count({
          where: { ownerId: w.member.id, isShared: false },
        }),
      ).toBe(VIEW_LIMITS.maxPersonalPerUserPerWorkspace);
    });
  });

  // =============================================================== lifecycle ====================
  describe('what goes when something else goes', () => {
    it('deleting a project removes the views scoped to it, only those', async () => {
      const w = await world();
      await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'p1 view', projectId: w.p1.id }),
      );
      await svc.create(
        w.ws.id,
        w.member.id,
        view({ name: 'p2 view', projectId: w.p2.id }),
      );
      await svc.create(w.ws.id, w.member.id, view({ name: 'wide' }));
      await prisma.project.delete({ where: { id: w.p1.id } });
      expect(
        (await prisma.savedView.findMany({ orderBy: { name: 'asc' } })).map(
          (v) => v.name,
        ),
      ).toEqual(['p2 view', 'wide']);
    });
    it('deleting a user removes their personal views; shared ones they made survive, ownerless', async () => {
      const w = await world();
      await svc.create(w.ws.id, w.admin.id, view({ name: 'mine' }));
      const team = await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 'team', isShared: true }),
      );
      await svc.create(w.ws.id, w.member.id, view({ name: 'someone else' }));
      await prisma.user.delete({ where: { id: w.admin.id } });
      expect(
        (await prisma.savedView.findMany({ orderBy: { name: 'asc' } })).map(
          (v) => [v.name, v.ownerId],
        ),
      ).toEqual([
        ['someone else', w.member.id],
        ['team', null],
      ]);
      expect((await svc.get(w.ws.id, team.id, w.member.id)).ownerId).toBeNull();
    });
    it('deleting the workspace removes everything', async () => {
      const w = await world();
      await svc.create(w.ws.id, w.member.id, view());
      await svc.create(
        w.ws.id,
        w.admin.id,
        view({ name: 't', isShared: true }),
      );
      await prisma.workspace.delete({ where: { id: w.ws.id } });
      expect(await prisma.savedView.count()).toBe(0);
    });
  });

  // =============================================================== database rules ================
  describe('database rules (what the service could get wrong, the database still refuses)', () => {
    const base = (w: W, over: Record<string, unknown> = {}) => ({
      workspaceId: w.ws.id,
      ownerId: w.member.id,
      name: 'n',
      nameKey: 'n',
      layout: 'LIST',
      config: {},
      ...over,
    });
    it.each([
      ['a personal view with no owner', { ownerId: null }],
      ['a blank name', { name: '', nameKey: '' }],
      ['an over-long name', { name: 'x'.repeat(121) }],
      ['a config that is not an object', { config: [1] }],
      ['a config over 16 KB', { config: { junk: 'x'.repeat(17_000) } }],
      ['a negative position', { position: -1 }],
      ['a position over the limit', { position: 100_001 }],
    ])('refuses %s', async (_l, over) => {
      const w = await world();
      await expect(
        prisma.savedView.create({ data: base(w, over) as any }),
      ).rejects.toThrow();
      expect(await prisma.savedView.count()).toBe(0);
    });
    it('allows what is legitimate: a shared view with no owner, exactly 16 KB-ish config, position 100000', async () => {
      const w = await world();
      await prisma.savedView.create({
        data: base(w, { ownerId: null, isShared: true }) as any,
      });
      await prisma.savedView.create({
        data: base(w, {
          name: 'p',
          nameKey: 'p',
          position: 100_000,
          config: { junk: 'x'.repeat(16_000) },
        }) as any,
      });
    });
    it('names are unique per owner / per workspace within a scope, in the database too', async () => {
      const w = await world();
      await prisma.savedView.create({ data: base(w) as any });
      await expect(
        prisma.savedView.create({ data: base(w) as any }),
      ).rejects.toThrow(); // same owner, same scope
      await prisma.savedView.create({
        data: base(w, { ownerId: w.member2.id }) as any,
      }); // another owner
      await prisma.savedView.create({
        data: base(w, { projectId: w.p1.id }) as any,
      }); // another scope
      await prisma.savedView.create({
        data: base(w, { isShared: true }) as any,
      }); // shared namespace
      await expect(
        prisma.savedView.create({
          data: base(w, { isShared: true, ownerId: w.member2.id }) as any,
        }),
      ).rejects.toThrow(); // shared twice
      await prisma.savedView.create({
        data: base(w, { isShared: true, projectId: w.p1.id }) as any,
      }); // shared, other scope
    });
  });
});
