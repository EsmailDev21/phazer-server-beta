/**
 * Step 5.1 on a real database: automations as data.
 *   create / update / get / list / delete, validation (structure + workspace), the enable rules,
 *   isolation between workspaces, permissions, the caps (also under concurrency), and the CHECKs
 *   the database enforces on its own.
 */
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AutomationOrigin, AutomationRunStatus, Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { UpdateAutomationDto } from '../../src/automations/dto/automation.dto';
import { AutomationsService } from '../../src/automations/automations.service';
import { WorkspaceContextLoader } from '../../src/automations/dsl/workspace-context.loader';
import { AUTOMATION_LIMITS } from '../../src/automations/dsl';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  addAccountMember,
  createAccount,
  createProject,
  createTask,
  createUser,
  createWorkspace,
} from './factories';
import {
  disconnectTestPrisma,
  getTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

jest.setTimeout(120_000);

describe('Automations (step 5.1)', () => {
  let prisma: PrismaService;
  let svc: AutomationsService;
  let resolver: PermissionResolver;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        PlanLimitsService,
        PermissionResolver,
        WorkspaceContextLoader,
        AutomationsService,
      ],
    }).compile();
    svc = moduleRef.get(AutomationsService);
    resolver = moduleRef.get(PermissionResolver);
  });
  beforeEach(() => resetDb(prisma));
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
    const [owner, admin, member, viewer] = [
      await mk(Role.OWNER),
      await mk(Role.ADMIN),
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
    const statusOf = async (projectId: string, category: string) =>
      (
        await prisma.workflowStatus.findFirstOrThrow({
          where: { projectId, category: category as any },
        })
      ).id;
    const tag = await prisma.tag.create({
      data: { workspaceId: ws.id, name: 'urgent', nameKey: 'urgent' },
    });
    const type = await prisma.issueType.create({
      data: {
        workspaceId: ws.id,
        name: 'bug',
        nameKey: 'bug',
        level: 'STANDARD',
      },
    });
    const field = (key: string, dataType: any, options?: string[]) =>
      prisma.customField.create({
        data: { workspaceId: ws.id, key, name: key, dataType, options },
      });
    const fNum = await field('score', 'NUMBER');
    const fSel = await field('colour', 'SELECT', ['red', 'blue']);
    return {
      account,
      owner,
      admin,
      member,
      viewer,
      outsider,
      ws,
      p1,
      p2,
      tag,
      type,
      fNum,
      fSel,
      done1: await statusOf(p1.id, 'DONE'),
      todo1: await statusOf(p1.id, 'TODO'),
      done2: await statusOf(p2.id, 'DONE'),
    };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const rule = (w: W, over: Record<string, unknown> = {}) => ({
    name: 'Tag urgent',
    trigger: { type: 'TASK_CREATED' },
    actions: [{ type: 'ADD_TAG', tagId: w.tag.id }],
    ...over,
  });
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e: any) {
      return { status: e.getStatus?.(), body: e.getResponse?.() };
    }
    throw new Error('expected a failure');
  };

  // =============================================================== create ======================
  describe('create', () => {
    it('stores a valid rule: normalised name, v1, off by default, written by the caller', async () => {
      const w = await world();
      const dto = await svc.create(
        w.ws.id,
        w.admin.id,
        rule(w, { name: '  Tag   URGENT  ' }),
      );
      expect(dto).toMatchObject({
        name: 'Tag URGENT',
        enabled: false,
        ruleVersion: 1,
        triggerType: 'TASK_CREATED',
        isRaw: false,
        createdVia: 'USER',
        createdById: w.admin.id,
        projectId: null,
        unsupported: [],
      });
      const row = await prisma.automation.findUniqueOrThrow({
        where: { id: dto.id },
      });
      expect(row.nameKey).toBe('tag urgent');
      expect(row.conditions).toEqual({});
      expect(row.actions).toEqual([{ type: 'ADD_TAG', tagId: w.tag.id }]);
    });

    it('can be created already enabled when fully valid', async () => {
      const w = await world();
      expect(
        (await svc.create(w.ws.id, w.owner.id, rule(w, { enabled: true })))
          .enabled,
      ).toBe(true);
    });

    it('a structurally invalid rule is refused with paths, and nothing is stored', async () => {
      const w = await world();
      const f = await failure(
        svc.create(
          w.ws.id,
          w.owner.id,
          rule(w, {
            trigger: { type: 'RUN_SCRIPT' },
            actions: [{ type: 'ADD_TAG' }],
          }) as any,
        ),
      );
      expect(f.status).toBe(422);
      expect(f.body.code).toBe('AUTOMATION_INVALID');
      expect(f.body.issues.map((i: any) => `${i.code}@${i.path}`)).toEqual(
        expect.arrayContaining([
          'UNKNOWN_TRIGGER@/trigger/type',
          'MISSING@/actions/0/tagId',
        ]),
      );
      expect(await prisma.automation.count()).toBe(0);
    });

    it('a rule naming things that do not exist is refused, with the path of each', async () => {
      const w = await world();
      const f = await failure(
        svc.create(
          w.ws.id,
          w.owner.id,
          rule(w, {
            conditions: {
              all: [
                { field: 'ISSUE_TYPE', op: 'IN', value: [w.type.id, 'ghost'] },
                {
                  field: 'CUSTOM',
                  customFieldId: w.fNum.id,
                  op: 'GT',
                  value: 'ten',
                },
              ],
            },
            actions: [
              { type: 'ADD_TAG', tagId: 'ghost-tag' },
              { type: 'ASSIGN', mode: 'ADD', users: [w.outsider.id] },
            ],
          }),
        ),
      );
      expect(f.body.issues.map((i: any) => `${i.code}@${i.path}`)).toEqual([
        'UNKNOWN_ISSUE_TYPE@/conditions/all/0/value/1',
        'VALUE_MISMATCH@/conditions/all/1/value',
        'UNKNOWN_TAG@/actions/0/tagId',
        'UNKNOWN_USER@/actions/1/users/0',
      ]);
    });

    it('accepts real references: members, custom fields of the right type, issue types, tags', async () => {
      const w = await world();
      const dto = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, {
          conditions: {
            all: [
              { field: 'ISSUE_TYPE', op: 'IN', value: [w.type.id] },
              {
                field: 'CUSTOM',
                customFieldId: w.fSel.id,
                op: 'EQ',
                value: 'red',
              },
              {
                field: 'CUSTOM',
                customFieldId: w.fNum.id,
                op: 'GTE',
                value: 3,
              },
            ],
          },
          actions: [
            { type: 'ADD_TAG', tagId: w.tag.id },
            { type: 'ASSIGN', mode: 'ADD', users: [w.member.id, 'CREATOR'] },
            {
              type: 'SET_CUSTOM_FIELD',
              customFieldId: w.fSel.id,
              value: 'blue',
            },
          ],
        }),
      );
      expect(dto.id).toBeDefined();
    });

    describe('statuses belong to a project', () => {
      it("a project rule can name its own project's status; a workspace-wide one only a category", async () => {
        const w = await world();
        await svc.create(
          w.ws.id,
          w.owner.id,
          rule(w, {
            name: 'own',
            projectId: w.p1.id,
            actions: [{ type: 'SET_STATUS', status: { statusId: w.done1 } }],
          }),
        );
        await svc.create(
          w.ws.id,
          w.owner.id,
          rule(w, {
            name: 'category',
            actions: [{ type: 'SET_STATUS', status: { category: 'DONE' } }],
          }),
        );
        const wide = await failure(
          svc.create(
            w.ws.id,
            w.owner.id,
            rule(w, {
              name: 'wide',
              actions: [{ type: 'SET_STATUS', status: { statusId: w.done1 } }],
            }),
          ),
        );
        expect(wide.body.issues[0].code).toBe('STATUS_NEEDS_PROJECT');
        const other = await failure(
          svc.create(
            w.ws.id,
            w.owner.id,
            rule(w, {
              name: 'other',
              projectId: w.p1.id,
              actions: [{ type: 'SET_STATUS', status: { statusId: w.done2 } }],
            }),
          ),
        );
        expect(other.body.issues[0].code).toBe('UNKNOWN_STATUS');
      });
    });

    describe('workspaces are isolated', () => {
      it('ids from ANOTHER workspace (tag, status, field, project, user) do not resolve', async () => {
        const a = await world();
        const b = await world();
        for (const [name, over, code] of [
          [
            'tag',
            { actions: [{ type: 'ADD_TAG', tagId: b.tag.id }] },
            'UNKNOWN_TAG',
          ],
          [
            'field',
            {
              conditions: {
                all: [
                  {
                    field: 'CUSTOM',
                    customFieldId: b.fNum.id,
                    op: 'GT',
                    value: 1,
                  },
                ],
              },
            },
            'UNKNOWN_CUSTOM_FIELD',
          ],
          [
            'project cond',
            {
              conditions: {
                all: [{ field: 'PROJECT', op: 'IN', value: [b.p1.id] }],
              },
            },
            'UNKNOWN_PROJECT',
          ],
          [
            'user',
            { actions: [{ type: 'ASSIGN', mode: 'ADD', users: [b.owner.id] }] },
            'UNKNOWN_USER',
          ],
          [
            'issue type',
            {
              conditions: {
                all: [{ field: 'ISSUE_TYPE', op: 'IN', value: [b.type.id] }],
              },
            },
            'UNKNOWN_ISSUE_TYPE',
          ],
        ] as const) {
          const f = await failure(
            svc.create(a.ws.id, a.owner.id, rule(a, { name, ...over })),
          );
          expect(f.body.issues[0].code).toBe(code);
        }
        const statusF = await failure(
          svc.create(
            a.ws.id,
            a.owner.id,
            rule(a, {
              name: 's',
              projectId: a.p1.id,
              actions: [{ type: 'SET_STATUS', status: { statusId: b.done1 } }],
            }),
          ),
        );
        expect(statusF.body.issues[0].code).toBe('UNKNOWN_STATUS');
        const projectF = await failure(
          svc.create(
            a.ws.id,
            a.owner.id,
            rule(a, { name: 'p', projectId: b.p1.id }),
          ),
        );
        expect(projectF.status).toBe(400);
        expect(await prisma.automation.count()).toBe(0);
      });

      it("one workspace cannot see, read, change or delete another's rules", async () => {
        const a = await world();
        const b = await world();
        const mine = await svc.create(a.ws.id, a.owner.id, rule(a));
        await svc.create(b.ws.id, b.owner.id, rule(b));
        expect(
          (await svc.list(a.ws.id, a.owner.id, {})).map((x) => x.id),
        ).toEqual([mine.id]);
        await expect(
          svc.get(b.ws.id, mine.id, b.owner.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.update(b.ws.id, mine.id, b.owner.id, { name: 'x' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(svc.remove(b.ws.id, mine.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(
          svc.listRuns(b.ws.id, mine.id, b.owner.id, {}),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await prisma.automation.count({ where: { id: mine.id } })).toBe(
          1,
        );
      });
    });

    it('the name is unique per workspace ("Close done" and "close  DONE" are one)', async () => {
      const w = await world();
      const w2 = await world();
      await svc.create(w.ws.id, w.owner.id, rule(w, { name: 'Close done' }));
      const f = await failure(
        svc.create(w.ws.id, w.owner.id, rule(w, { name: ' close   DONE ' })),
      );
      expect(f).toMatchObject({ status: 409, body: { code: 'NAME_TAKEN' } });
      await expect(
        svc.create(w2.ws.id, w2.owner.id, rule(w2, { name: 'Close done' })),
      ).resolves.toBeDefined();
    });

    it('rejects blank and control-character names', async () => {
      const w = await world();
      await expect(
        svc.create(w.ws.id, w.owner.id, rule(w, { name: '   ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.create(w.ws.id, w.owner.id, rule(w, { name: 'a\u0000b' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // =============================================================== unsupported ================
  describe('constructs this build cannot run', () => {
    const notify = (w: W) => [
      { type: 'ADD_TAG', tagId: w.tag.id },
      {
        type: 'NOTIFY_CHANNEL',
        channelLinkId: 'cl1',
        message: 'Done: {{task.title}}',
      },
    ];

    it('are stored, listed, and keep the rule off', async () => {
      const w = await world();
      const dto = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { actions: notify(w) }),
      );
      expect(dto.enabled).toBe(false);
      expect(dto.unsupported).toEqual([
        {
          path: '/actions/1',
          construct: 'NOTIFY_CHANNEL',
          reason: expect.stringContaining('Phase 2'),
        },
      ]);
    });

    it('cannot be switched on: not at creation, not by update', async () => {
      const w = await world();
      const f = await failure(
        svc.create(
          w.ws.id,
          w.owner.id,
          rule(w, { actions: notify(w), enabled: true }),
        ),
      );
      expect(f).toMatchObject({
        status: 409,
        body: {
          code: 'NOT_ENABLEABLE',
          unsupported: [{ construct: 'NOTIFY_CHANNEL' }],
        },
      });
      expect(await prisma.automation.count()).toBe(0);
      const stored = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { actions: notify(w) }),
      );
      expect(
        (
          await failure(
            svc.update(w.ws.id, stored.id, w.owner.id, { enabled: true }),
          )
        ).body.code,
      ).toBe('NOT_ENABLEABLE');
      expect(
        (
          await prisma.automation.findUniqueOrThrow({
            where: { id: stored.id },
          })
        ).enabled,
      ).toBe(false);
    });

    it('editing an ENABLED rule into one that uses them turns it off rather than leaving it half-valid', async () => {
      const w = await world();
      const on = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { enabled: true }),
      );
      const edited = await svc.update(w.ws.id, on.id, w.owner.id, {
        actions: notify(w),
      });
      expect(edited.enabled).toBe(false);
      expect(edited.unsupported).toHaveLength(1);
      const fixed = await svc.update(w.ws.id, on.id, w.owner.id, {
        actions: [{ type: 'ADD_TAG', tagId: w.tag.id }],
        enabled: true,
      });
      expect(fixed).toMatchObject({ enabled: true, unsupported: [] });
    });
  });

  // =============================================================== update =====================
  describe('update', () => {
    it('renames, re-checks the rule as a whole, and keeps triggerType in step with the trigger', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      const renamed = await svc.update(w.ws.id, a.id, w.owner.id, {
        name: 'Better name',
      });
      expect(renamed.name).toBe('Better name');
      const changed = await svc.update(w.ws.id, a.id, w.owner.id, {
        trigger: { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] },
      });
      expect(changed).toMatchObject({
        triggerType: 'STATUS_CHANGED',
        actions: [{ type: 'ADD_TAG', tagId: w.tag.id }],
      });
      expect(
        (await prisma.automation.findUniqueOrThrow({ where: { id: a.id } }))
          .triggerType,
      ).toBe('STATUS_CHANGED');
    });

    it('an invalid change is refused and the stored rule is untouched', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      const before = await prisma.automation.findUniqueOrThrow({
        where: { id: a.id },
      });
      for (const dto of [
        { actions: [] },
        { trigger: { type: 'NOPE' } },
        { actions: [{ type: 'ADD_TAG', tagId: 'ghost' }] },
        { conditions: { all: [{ field: 'X', op: 'Y' }] } },
      ]) {
        expect(
          (await failure(svc.update(w.ws.id, a.id, w.owner.id, dto as any)))
            .status,
        ).toBe(422);
      }
      expect(
        await prisma.automation.findUniqueOrThrow({ where: { id: a.id } }),
      ).toEqual(before);
    });

    it('the project of a rule cannot be changed (statuses are per project)', async () => {
      const w = await world();
      const a = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { projectId: w.p1.id }),
      );
      await svc.update(w.ws.id, a.id, w.owner.id, { name: 'still p1' });
      expect(
        (await prisma.automation.findUniqueOrThrow({ where: { id: a.id } }))
          .projectId,
      ).toBe(w.p1.id);
      expect(Object.keys(new UpdateAutomationDto())).not.toContain('projectId');
    });

    it('turns a rule off and on; renaming onto an existing name is a conflict', async () => {
      const w = await world();
      const a = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { name: 'A', enabled: true }),
      );
      await svc.create(w.ws.id, w.owner.id, rule(w, { name: 'B' }));
      expect(
        (await svc.update(w.ws.id, a.id, w.owner.id, { enabled: false }))
          .enabled,
      ).toBe(false);
      expect(
        (await svc.update(w.ws.id, a.id, w.owner.id, { enabled: true }))
          .enabled,
      ).toBe(true);
      expect(
        (await failure(svc.update(w.ws.id, a.id, w.owner.id, { name: 'b' })))
          .body.code,
      ).toBe('NAME_TAKEN');
    });

    it('an empty update changes nothing (not even updatedAt)', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      const again = await svc.update(w.ws.id, a.id, w.owner.id, {});
      expect(again.updatedAt).toEqual(a.updatedAt);
    });
  });

  // =============================================================== stale rules ================
  describe('a rule whose references were deleted later', () => {
    it('shows its problems on get, cannot be enabled, can still be renamed and fixed', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      expect((await svc.get(w.ws.id, a.id, w.owner.id)).problems).toEqual([]);
      await prisma.tag.delete({ where: { id: w.tag.id } });
      const got = await svc.get(w.ws.id, a.id, w.owner.id);
      expect(got.problems).toEqual([
        expect.objectContaining({
          code: 'UNKNOWN_TAG',
          path: '/actions/0/tagId',
        }),
      ]);
      expect(
        (
          await failure(
            svc.update(w.ws.id, a.id, w.owner.id, { enabled: true }),
          )
        ).body.code,
      ).toBe('NOT_ENABLEABLE');
      await expect(
        svc.update(w.ws.id, a.id, w.owner.id, { name: 'renamed anyway' }),
      ).resolves.toBeDefined();
      const tag2 = await prisma.tag.create({
        data: { workspaceId: w.ws.id, name: 'new', nameKey: 'new' },
      });
      await expect(
        svc.update(w.ws.id, a.id, w.owner.id, {
          actions: [{ type: 'ADD_TAG', tagId: tag2.id }],
          enabled: true,
        }),
      ).resolves.toMatchObject({ enabled: true });
    });
  });

  // =============================================================== dry run ====================
  describe('validate (dry run)', () => {
    it('reports without storing anything', async () => {
      const w = await world();
      const good = await svc.validate(w.ws.id, rule(w) as any);
      expect(good).toEqual({
        valid: true,
        issues: [],
        unsupported: [],
        enableable: true,
        triggerType: 'TASK_CREATED',
      });
      const bad = await svc.validate(
        w.ws.id,
        rule(w, { actions: [{ type: 'ADD_TAG', tagId: 'ghost' }] }) as any,
      );
      expect(bad).toMatchObject({
        valid: false,
        enableable: false,
        issues: [{ code: 'UNKNOWN_TAG' }],
      });
      const later = await svc.validate(
        w.ws.id,
        rule(w, {
          actions: [
            { type: 'NOTIFY_CHANNEL', channelLinkId: 'c', message: 'x' },
          ],
        }) as any,
      );
      expect(later).toMatchObject({
        valid: true,
        enableable: false,
        unsupported: [{ construct: 'NOTIFY_CHANNEL' }],
      });
      const broken = await svc.validate(w.ws.id, {
        trigger: {},
        actions: [],
      } as any);
      expect(broken.valid).toBe(false);
      expect(await prisma.automation.count()).toBe(0);
    });
    it('checks the project scope it is given', async () => {
      const w = await world();
      const r = await svc.validate(w.ws.id, {
        projectId: w.p1.id,
        ...rule(w, {
          actions: [{ type: 'SET_STATUS', status: { statusId: w.done1 } }],
        }),
      } as any);
      expect(r.valid).toBe(true);
      const wide = await svc.validate(
        w.ws.id,
        rule(w, {
          actions: [{ type: 'SET_STATUS', status: { statusId: w.done1 } }],
        }) as any,
      );
      expect(wide.issues[0].code).toBe('STATUS_NEEDS_PROJECT');
    });
  });

  // =============================================================== list / get =================
  describe('list and get', () => {
    it('filters by project, enabled and trigger type', async () => {
      const w = await world();
      await svc.create(w.ws.id, w.owner.id, rule(w, { name: 'a' }));
      await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { name: 'b', projectId: w.p1.id, enabled: true }),
      );
      await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { name: 'c', trigger: { type: 'STATUS_CHANGED' } }),
      );
      const names = async (q: any) =>
        (await svc.list(w.ws.id, w.owner.id, q)).map((x) => x.name);
      expect(await names({})).toEqual(['a', 'b', 'c']);
      expect(await names({ projectId: w.p1.id })).toEqual(['b']);
      expect(await names({ enabled: true })).toEqual(['b']);
      expect(await names({ enabled: false })).toEqual(['a', 'c']);
      expect(await names({ triggerType: 'STATUS_CHANGED' })).toEqual(['c']);
    });
    it('is readable by any workspace member and by nobody else', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      for (const u of [w.owner, w.admin, w.member, w.viewer])
        expect((await svc.get(w.ws.id, a.id, u.id)).id).toBe(a.id);
      await expect(svc.list(w.ws.id, w.outsider.id, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        svc.get(w.ws.id, a.id, w.outsider.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('lists the runs of a rule, newest first, filterable by status', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      const t0 = new Date('2026-10-17T10:00:00Z');
      for (const [i, status] of (
        ['OK', 'SKIPPED', 'FAILED'] as const
      ).entries()) {
        await prisma.automationRun.create({
          data: {
            automationId: a.id,
            workspaceId: w.ws.id,
            eventId: `e${i}`,
            status,
            ranAt: new Date(t0.getTime() + i * 1000),
          },
        });
      }
      expect(
        (await svc.listRuns(w.ws.id, a.id, w.owner.id, {})).map(
          (r) => r.eventId,
        ),
      ).toEqual(['e2', 'e1', 'e0']);
      expect(
        (
          await svc.listRuns(w.ws.id, a.id, w.owner.id, {
            status: AutomationRunStatus.OK,
          })
        ).map((r) => r.eventId),
      ).toEqual(['e0']);
      expect(
        await svc.listRuns(w.ws.id, a.id, w.owner.id, { limit: 2 }),
      ).toHaveLength(2);
    });
  });

  // =============================================================== permissions ================
  describe('who may manage automations', () => {
    it("admins and owners may; members, viewers and outsiders may not (the guard's own decision)", async () => {
      const w = await world();
      const can = async (u: { id: string }) =>
        (
          await resolver.resolve(
            u.id,
            'manageAutomations',
            'WORKSPACE',
            w.ws.id,
          )
        ).allowed;
      expect([
        await can(w.owner),
        await can(w.admin),
        await can(w.member),
        await can(w.viewer),
        await can(w.outsider),
      ]).toEqual([true, true, false, false, false]);
    });
  });

  // =============================================================== caps =======================
  describe('caps', () => {
    const fill = async (w: W, n: number, enabled: boolean) => {
      await prisma.automation.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          workspaceId: w.ws.id,
          name: `bulk ${i}`,
          nameKey: `bulk ${i}`,
          enabled,
          ruleVersion: 1,
          triggerType: 'TASK_CREATED',
          trigger: { type: 'TASK_CREATED' },
          actions: [{ type: 'ADD_TAG', tagId: w.tag.id }],
          createdById: w.owner.id,
        })),
      });
    };
    it(`at most ${AUTOMATION_LIMITS.maxAutomationsPerWorkspace} automations per workspace`, async () => {
      const w = await world();
      await fill(w, AUTOMATION_LIMITS.maxAutomationsPerWorkspace, false);
      expect(
        (await failure(svc.create(w.ws.id, w.owner.id, rule(w)))).body.code,
      ).toBe('AUTOMATION_LIMIT');
      const other = await world();
      await expect(
        svc.create(other.ws.id, other.owner.id, rule(other)),
      ).resolves.toBeDefined();
    });
    it(`at most ${AUTOMATION_LIMITS.maxEnabledPerWorkspace} on at once; turning one off makes room`, async () => {
      const w = await world();
      await fill(w, AUTOMATION_LIMITS.maxEnabledPerWorkspace, true);
      expect(
        (
          await failure(
            svc.create(w.ws.id, w.owner.id, rule(w, { enabled: true })),
          )
        ).body.code,
      ).toBe('AUTOMATION_ENABLED_LIMIT');
      const off = await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { name: 'off one' }),
      );
      expect(
        (
          await failure(
            svc.update(w.ws.id, off.id, w.owner.id, { enabled: true }),
          )
        ).body.code,
      ).toBe('AUTOMATION_ENABLED_LIMIT');
      const anOn = await prisma.automation.findFirstOrThrow({
        where: { workspaceId: w.ws.id, enabled: true },
      });
      await svc.update(w.ws.id, anOn.id, w.owner.id, { enabled: false });
      expect(
        (await svc.update(w.ws.id, off.id, w.owner.id, { enabled: true }))
          .enabled,
      ).toBe(true);
    });
    it('eight creates racing for the last slot: exactly one wins, the cap is never exceeded', async () => {
      const w = await world();
      await fill(w, AUTOMATION_LIMITS.maxAutomationsPerWorkspace - 1, false);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          svc.create(w.ws.id, w.owner.id, rule(w, { name: `racer ${i}` })),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.automation.count({ where: { workspaceId: w.ws.id } }),
      ).toBe(AUTOMATION_LIMITS.maxAutomationsPerWorkspace);
    });
    it('racing to switch on the last enabled slot: exactly one wins', async () => {
      const w = await world();
      await fill(w, AUTOMATION_LIMITS.maxEnabledPerWorkspace - 1, true);
      const off = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          svc.create(w.ws.id, w.owner.id, rule(w, { name: `off ${i}` })),
        ),
      );
      const results = await Promise.allSettled(
        off.map((o) =>
          svc.update(w.ws.id, o.id, w.owner.id, { enabled: true }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.automation.count({
          where: { workspaceId: w.ws.id, enabled: true },
        }),
      ).toBe(AUTOMATION_LIMITS.maxEnabledPerWorkspace);
    });
  });

  // =============================================================== cascades ===================
  describe('what goes when something else goes', () => {
    it('delete removes the rule and its run log', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      await prisma.automationRun.create({
        data: {
          automationId: a.id,
          workspaceId: w.ws.id,
          eventId: 'e',
          status: 'OK',
        },
      });
      await svc.remove(w.ws.id, a.id);
      expect(await prisma.automation.count()).toBe(0);
      expect(await prisma.automationRun.count()).toBe(0);
    });
    it('deleting a project removes the rules scoped to it, and only those', async () => {
      const w = await world();
      await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { name: 'p1 rule', projectId: w.p1.id }),
      );
      await svc.create(
        w.ws.id,
        w.owner.id,
        rule(w, { name: 'p2 rule', projectId: w.p2.id }),
      );
      await svc.create(w.ws.id, w.owner.id, rule(w, { name: 'wide rule' }));
      await prisma.project.delete({ where: { id: w.p1.id } });
      expect(
        (await prisma.automation.findMany({ orderBy: { name: 'asc' } })).map(
          (x) => x.name,
        ),
      ).toEqual(['p2 rule', 'wide rule']);
    });
    it('deleting a task keeps its runs (the pointer is cleared); deleting the workspace removes everything', async () => {
      const w = await world();
      const a = await svc.create(w.ws.id, w.owner.id, rule(w));
      const task = await createTask(prisma, {
        workspaceId: w.ws.id,
        createdById: w.owner.id,
        projectId: w.p1.id,
      });
      await prisma.automationRun.create({
        data: {
          automationId: a.id,
          workspaceId: w.ws.id,
          taskId: task.id,
          eventId: 'e',
          status: 'OK',
        },
      });
      await prisma.task.delete({ where: { id: task.id } });
      expect(
        await prisma.automationRun.findFirstOrThrow({
          where: { eventId: 'e' },
        }),
      ).toMatchObject({ taskId: null });
      await prisma.workspace.delete({ where: { id: w.ws.id } });
      expect(await prisma.automation.count()).toBe(0);
      expect(await prisma.automationRun.count()).toBe(0);
    });
    it('a user who wrote rules cannot be deleted out from under them', async () => {
      const w = await world();
      await svc.create(w.ws.id, w.admin.id, rule(w));
      await expect(
        prisma.user.delete({ where: { id: w.admin.id } }),
      ).rejects.toThrow();
    });
  });

  // =============================================================== raw rules ==================
  describe('raw (imported, untranslated) rules', () => {
    const raw = (w: W) =>
      prisma.automation.create({
        data: {
          workspaceId: w.ws.id,
          name: 'Imported',
          nameKey: 'imported',
          enabled: false,
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: {},
          conditions: {},
          actions: [],
          sourceDefinition: { jira: { when: 'issue_created' } },
          createdVia: AutomationOrigin.IMPORT,
          createdById: w.owner.id,
        },
      });
    it('are listed and shown as raw, never enabled, and untouched by a rename', async () => {
      const w = await world();
      const r = await raw(w);
      const got = await svc.get(w.ws.id, r.id, w.owner.id);
      expect(got).toMatchObject({
        isRaw: true,
        enabled: false,
        triggerType: 'RAW',
        problems: [],
      });
      expect(
        (
          await failure(
            svc.update(w.ws.id, r.id, w.owner.id, { enabled: true }),
          )
        ).body.code,
      ).toBe('NOT_ENABLEABLE');
      await svc.update(w.ws.id, r.id, w.owner.id, {
        name: 'Imported from Jira',
      });
      expect(
        await prisma.automation.findUniqueOrThrow({ where: { id: r.id } }),
      ).toMatchObject({
        ruleVersion: 0,
        name: 'Imported from Jira',
        sourceDefinition: { jira: { when: 'issue_created' } },
      });
    });
    it('become real rules when someone gives them a valid definition; the source is kept', async () => {
      const w = await world();
      const r = await raw(w);
      const t = await svc.update(w.ws.id, r.id, w.owner.id, {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tag.id }],
        enabled: true,
      });
      expect(t).toMatchObject({
        isRaw: false,
        ruleVersion: 1,
        triggerType: 'TASK_CREATED',
        enabled: true,
        createdVia: 'IMPORT',
      });
      expect(
        (await prisma.automation.findUniqueOrThrow({ where: { id: r.id } }))
          .sourceDefinition,
      ).toEqual({ jira: { when: 'issue_created' } });
    });
    it('an incomplete definition does not convert them', async () => {
      const w = await world();
      const r = await raw(w);
      expect(
        (
          await failure(
            svc.update(w.ws.id, r.id, w.owner.id, {
              trigger: { type: 'TASK_CREATED' },
            }),
          )
        ).status,
      ).toBe(422);
      expect(
        (await prisma.automation.findUniqueOrThrow({ where: { id: r.id } }))
          .ruleVersion,
      ).toBe(0);
    });
  });

  // =============================================================== database rules =============
  describe('database rules (what the service could get wrong, the database still refuses)', () => {
    const base = (w: W, over: Record<string, unknown> = {}) => ({
      workspaceId: w.ws.id,
      name: 'n',
      nameKey: 'n',
      enabled: false,
      ruleVersion: 1,
      triggerType: 'TASK_CREATED',
      trigger: { type: 'TASK_CREATED' },
      actions: [{ type: 'ADD_TAG', tagId: 'x' }],
      createdById: w.owner.id,
      ...over,
    });
    it.each([
      ['an unknown rule version', { ruleVersion: 2 }],
      [
        'a trigger that disagrees with trigger_type',
        { triggerType: 'STATUS_CHANGED' },
      ],
      ['an executable rule with no actions', { actions: [] }],
      [
        'an executable rule with 11 actions',
        { actions: Array(11).fill({ type: 'ADD_TAG', tagId: 'x' }) },
      ],
      [
        'a rule that is enabled but has unsupported constructs',
        {
          enabled: true,
          unsupported: [{ path: '/actions/0', construct: 'X', reason: 'r' }],
        },
      ],
      [
        'a raw rule without its source',
        { ruleVersion: 0, triggerType: 'RAW', trigger: {}, actions: [] },
      ],
      [
        'a raw rule that is enabled',
        {
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: {},
          actions: [],
          sourceDefinition: { a: 1 },
          enabled: true,
        },
      ],
      [
        'a raw rule with executable parts',
        {
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: { type: 'TASK_CREATED' },
          actions: [],
          sourceDefinition: { a: 1 },
        },
      ],
      ['a v1 rule typed RAW', { triggerType: 'RAW' }],
      ['a blank name', { name: '' }],
      ['an over-long name', { name: 'x'.repeat(121) }],
      ['a trigger that is not an object', { trigger: [1] }],
      ['actions that are not a list', { actions: { a: 1 } }],
      [
        'more than 64 KB of rule',
        { actions: [{ type: 'COMMENT', body: 'x'.repeat(70_000) }] },
      ],
    ])('refuses %s', async (_label, over) => {
      const w = await world();
      await expect(
        prisma.automation.create({ data: base(w, over) as any }),
      ).rejects.toThrow();
      expect(await prisma.automation.count()).toBe(0);
    });
    it('accepts the legitimate edge: exactly 10 actions, a raw rule with its source', async () => {
      const w = await world();
      await prisma.automation.create({
        data: base(w, {
          actions: Array(10).fill({ type: 'ADD_TAG', tagId: 'x' }),
        }) as any,
      });
      await prisma.automation.create({
        data: base(w, {
          name: 'r',
          nameKey: 'r',
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: {},
          actions: [],
          sourceDefinition: { a: 1 },
        }) as any,
      });
    });
    it('names are unique per workspace in the database too', async () => {
      const w = await world();
      await prisma.automation.create({ data: base(w) as any });
      await expect(
        prisma.automation.create({ data: base(w) as any }),
      ).rejects.toThrow();
    });
    it('a run is unique per (rule, event): the same event cannot run a rule twice', async () => {
      const w = await world();
      const a = await prisma.automation.create({ data: base(w) as any });
      const run = (eventId: string, extra: Record<string, unknown> = {}) =>
        prisma.automationRun.create({
          data: {
            automationId: a.id,
            workspaceId: w.ws.id,
            eventId,
            status: 'OK',
            ...extra,
          } as any,
        });
      await run('evt-1');
      await expect(run('evt-1')).rejects.toThrow();
      await run('evt-2');
      await expect(run('evt-3', { depth: 11 })).rejects.toThrow();
      await expect(run('evt-4', { actionsRun: 11 })).rejects.toThrow();
      await expect(run('evt-5', { error: 'x'.repeat(501) })).rejects.toThrow();
      await expect(run('')).rejects.toThrow();
    });
  });
});
