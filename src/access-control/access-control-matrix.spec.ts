/**
 * Step 0.10. The role x action matrix, as data.
 *
 * Two kinds of check on purpose. The SNAPSHOT only detects change (it is
 * generated from the code, so on its own it would happily bless a wrong
 * matrix); the DERIVED-FROM-minRole and completeness checks are what say the
 * matrix is RIGHT. Changing a grant should fail a test, be read in the diff of
 * the snapshot, and be a decision.
 */
import { Role } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { ACTION_CONFIG } from './config/action-config';
import {
  COLLABORATOR_ROLE_PERMISSIONS,
  ROLE_PERMISSIONS,
} from './config/role-permissions';
import { PermissionResolver } from './access-control.service';
import {
  ALL_TARGET_TYPES,
  ActionName,
} from './interfaces/access-control.types';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'CLIENT'];
const RANK: Record<Role, number> = {
  OWNER: 5,
  ADMIN: 4,
  MEMBER: 3,
  VIEWER: 2,
  CLIENT: 1,
};
const COLLABS = ['CONTRIBUTOR', 'COMMENTER', 'VIEWER'] as const;
const actions = Object.keys(ACTION_CONFIG) as ActionName[];

/** The 12 added in step 0.10, written out independently of the config. */
const NEW_ACTIONS: ActionName[] = [
  'manageIntegrations',
  'runImport',
  'exportWorkspaceTemplate',
  'createTemplate',
  'editTemplate',
  'deleteTemplate',
  'applyTemplate',
  'publishTemplate',
  'manageWorkflow',
  'manageAutomations',
  'manageSavedViews',
  'linkChannel',
];

describe('matrix completeness', () => {
  it.each(ROLES)(
    '%s has an explicit boolean for every action, and none unknown',
    (role) => {
      const entries = ROLE_PERMISSIONS[role];
      // A missing entry is a silent DENY at runtime (`?? false`) - never leave one.
      expect(actions.filter((a) => typeof entries[a] !== 'boolean')).toEqual(
        [],
      );
      expect(Object.keys(entries).filter((a) => !(a in ACTION_CONFIG))).toEqual(
        [],
      );
    },
  );

  it.each(COLLABS)(
    'collaborator %s: explicit boolean for every action that is not account-only; no unknown actions',
    (role) => {
      const entries = COLLABORATOR_ROLE_PERMISSIONS[role];
      // Collaborators are workspace-level; account-scoped actions are
      // deliberately ABSENT (= deny), the convention since Tenancy.
      const required = actions.filter((a) =>
        ACTION_CONFIG[a].scopes.some((s) => s !== 'ACCOUNT'),
      );
      expect(required.filter((a) => typeof entries[a] !== 'boolean')).toEqual(
        [],
      );
      expect(Object.keys(entries).filter((a) => !(a in ACTION_CONFIG))).toEqual(
        [],
      );
    },
  );

  it('a collaborator NEVER holds an account-only action (absent or false)', () => {
    for (const role of COLLABS) {
      for (const a of actions) {
        if (ACTION_CONFIG[a].scopes.every((s) => s === 'ACCOUNT')) {
          expect(COLLABORATOR_ROLE_PERMISSIONS[role][a] ?? false).toBe(false);
        }
      }
    }
  });

  it('every target type an action is scoped to is a known TargetType', () => {
    for (const a of actions) {
      for (const s of ACTION_CONFIG[a].scopes) {
        expect(ALL_TARGET_TYPES).toContain(s);
      }
    }
  });
});

describe('the 12 step-0.10 actions follow their minRole', () => {
  it('exactly these 12 are new (guards against an action added without a decision here)', () => {
    for (const a of NEW_ACTIONS) expect(ACTION_CONFIG[a]).toBeDefined();
    expect(actions).toHaveLength(40 + NEW_ACTIONS.length);
  });

  it.each(NEW_ACTIONS)('%s: a role is granted iff its rank >= minRole', (a) => {
    const min = ACTION_CONFIG[a].minRole;
    expect(min).toBeDefined();
    for (const role of ROLES) {
      expect({ role, granted: ROLE_PERMISSIONS[role][a] }).toEqual({
        role,
        granted: RANK[role] >= RANK[min as Role],
      });
    }
  });

  it.each(NEW_ACTIONS)(
    '%s: no collaborator role is granted it (least privilege; widening later is additive, narrowing is breaking)',
    (a) => {
      for (const role of COLLABS) {
        expect(COLLABORATOR_ROLE_PERMISSIONS[role][a] ?? false).toBe(false);
      }
    },
  );

  it('OWNER >= ADMIN >= MEMBER >= VIEWER >= CLIENT for every new action', () => {
    for (const a of NEW_ACTIONS) {
      const grants = ROLES.map((r) => (ROLE_PERMISSIONS[r][a] ? 1 : 0));
      expect([...grants].sort((x, y) => y - x)).toEqual(grants);
    }
  });

  it('template editing: matrix says ADMIN+, ownership adds the creator', () => {
    for (const a of ['editTemplate', 'deleteTemplate'] as const) {
      expect(ACTION_CONFIG[a].ownershipField).toBe('createdById');
      expect(ROLE_PERMISSIONS.MEMBER[a]).toBe(false); // a MEMBER gets in only as the creator
    }
  });

  it('new-workspace apply relies on createWorkspace being ADMIN+: pin it', () => {
    expect(ROLE_PERMISSIONS.OWNER.createWorkspace).toBe(true);
    expect(ROLE_PERMISSIONS.ADMIN.createWorkspace).toBe(true);
    expect(ROLE_PERMISSIONS.MEMBER.createWorkspace).toBe(false);
    expect(ACTION_CONFIG.createWorkspace.planLimit).toBe('workspace');
  });
});

describe('plan limits attached to actions', () => {
  it('createTemplate is limited by "template"', () => {
    expect(ACTION_CONFIG.createTemplate.planLimit).toBe('template');
  });

  it('manageIntegrations / manageAutomations deliberately carry NO planLimit (it would block disconnect/disable at the cap); create paths check explicitly', () => {
    expect(ACTION_CONFIG.manageIntegrations.planLimit).toBeUndefined();
    expect(ACTION_CONFIG.manageAutomations.planLimit).toBeUndefined();
  });

  it('runImport / applyTemplate carry none either (preflight + DomainWriter own those limits)', () => {
    expect(ACTION_CONFIG.runImport.planLimit).toBeUndefined();
    expect(ACTION_CONFIG.applyTemplate.planLimit).toBeUndefined();
  });
});

describe('TEMPLATE target (step 3.5 replaced the 0.10 stub)', () => {
  const resolverWith = (template: unknown) => {
    const findUnique = jest.fn().mockResolvedValue(template);
    const resolver: any = new PermissionResolver({ template: { findUnique } } as any, {} as any);
    return { resolver, findUnique };
  };

  it('resolves to the OWNER account, and the creator is the ownerId (that is what ownershipField uses)', async () => {
    const { resolver, findUnique } = resolverWith({
      createdById: 'creator1',
      ownerAccount: { id: 'acc1', type: 'ORGANIZATION' },
    });
    for (const action of ['editTemplate', 'deleteTemplate'] as const) {
      await expect(resolver.resolveTargetAndOwner(action, 'TEMPLATE', 'tpl_1')).resolves.toEqual({
        context: { accountId: 'acc1', accountType: 'ORGANIZATION' },
        ownerId: 'creator1',
      });
    }
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'tpl_1' } }));
  });

  it('an unknown template is NotFound, not an authorization answer', async () => {
    const { resolver } = resolverWith(null);
    await expect(resolver.resolveTargetAndOwner('editTemplate', 'TEMPLATE', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('both template actions are still ownership-aware in the config (creator may edit/delete)', () => {
    expect(ACTION_CONFIG.editTemplate.ownershipField).toBe('createdById');
    expect(ACTION_CONFIG.deleteTemplate.ownershipField).toBe('createdById');
  });
});

describe('step 8 wiring for createTemplate', () => {
  it('a granted createTemplate asks PlanLimitsService about "template" and surfaces the cap as planLimitExceeded', async () => {
    const checkLimit = jest.fn().mockResolvedValue(false);
    const resolver: any = new PermissionResolver(
      {} as any,
      { checkLimit } as any,
    );
    jest.spyOn(resolver, 'resolveTargetAndOwner').mockResolvedValue({
      context: { accountId: 'a1', accountType: 'ORGANIZATION' },
      ownerId: null,
    });
    jest.spyOn(resolver, 'findFirstMatchingTier').mockResolvedValue({
      vocab: 'ROLE',
      role: 'MEMBER',
      tier: 3,
    });
    const res = await resolver.resolve('u1', 'createTemplate', 'ACCOUNT', 'a1');
    expect(checkLimit).toHaveBeenCalledWith('template', 'createTemplate', {
      accountId: 'a1',
      workspaceId: undefined,
      projectId: undefined,
    });
    expect(res).toMatchObject({ allowed: false, planLimitExceeded: true });
  });

  it('a DENIED role never reaches the limit check', async () => {
    const checkLimit = jest.fn();
    const resolver: any = new PermissionResolver(
      {} as any,
      { checkLimit } as any,
    );
    jest.spyOn(resolver, 'resolveTargetAndOwner').mockResolvedValue({
      context: { accountId: 'a1', accountType: 'ORGANIZATION' },
      ownerId: null,
    });
    jest
      .spyOn(resolver, 'findFirstMatchingTier')
      .mockResolvedValue({ vocab: 'ROLE', role: 'VIEWER', tier: 3 });
    const res = await resolver.resolve('u1', 'createTemplate', 'ACCOUNT', 'a1');
    expect(res.allowed).toBe(false);
    expect(checkLimit).not.toHaveBeenCalled();
  });
});

describe('the whole matrix (snapshot: any grant change must show up in review)', () => {
  it('ROLE_PERMISSIONS + COLLABORATOR_ROLE_PERMISSIONS', () => {
    const cols = [...ROLES, ...COLLABS.map((c) => `collab:${c}`)];
    const cell = (a: ActionName, col: string): string => {
      const v = col.startsWith('collab:')
        ? COLLABORATOR_ROLE_PERMISSIONS[
            col.slice(7) as (typeof COLLABS)[number]
          ][a]
        : ROLE_PERMISSIONS[col as Role][a];
      return v === undefined ? '-' : v ? 'Y' : 'n';
    };
    const lines = [
      ['action'.padEnd(26), ...cols.map((c) => c.padEnd(13))].join(' '),
      ...[...actions]
        .sort()
        .map((a) =>
          [
            a.padEnd(26),
            ...cols.map((c) => cell(a, c).padEnd(13)),
            `scopes=${ACTION_CONFIG[a].scopes.join('|')}`,
            ACTION_CONFIG[a].planLimit
              ? `limit=${ACTION_CONFIG[a].planLimit}`
              : '',
            ACTION_CONFIG[a].ownershipField
              ? `owner=${ACTION_CONFIG[a].ownershipField}`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        ),
    ];
    expect(lines.join('\n')).toMatchSnapshot();
  });
});
