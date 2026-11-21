/**
 * Step 4.3 - the mapping engine against a real Postgres: who counts as a member, what the Map step shows, what a save
 * refuses, what survives a selection change, and (the security property) that membership is judged AGAIN at run time.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  CollaboratorRole,
  FieldType,
  IdentityLinkMethod,
  IntegrationProvider,
  IssueTypeLevel,
  Role,
} from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { AuthorizeContext, CallbackParams, Capability, ExchangeContext, INTEGRATION_ADAPTERS } from '../../src/integrations/core/integration.types';
import { CanonicalBundle, validateBundle } from '../../src/imports/canonical';
import { ExternalRefService } from '../../src/imports/external-ref.service';
import { ImportAdapterContext, ImportCapableAdapter } from '../../src/imports/import-adapter';
import { ImportIssueService } from '../../src/imports/import-issue.service';
import { ImportUsageService } from '../../src/imports/import-usage.service';
import { ImportsService } from '../../src/imports/imports.service';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../src/imports/imports.types';
import { applyMapping } from '../../src/imports/mapping';
import { MappingInventory } from '../../src/imports/mapping/mapping.types';
import { MappingService } from '../../src/imports/mapping/mapping.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QueueService } from '../../src/queue/queue.service';
import { createUser, createUserWithAccount, createWorkspace } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

const INVENTORY: MappingInventory = {
  system: 'jira',
  displayName: 'Jira',
  projects: [{ externalId: 'ENG', name: 'Engineering', statuses: [
    { externalId: 's-todo', name: 'To Do', category: 'TODO' }, { externalId: 's-prog', name: 'In Progress', category: 'IN_PROGRESS' },
    { externalId: 's-rev', name: 'In Review', category: 'IN_PROGRESS' }, { externalId: 's-blk', name: 'Blocked', category: 'IN_PROGRESS' }, { externalId: 's-done', name: 'Done', category: 'DONE' },
  ] }],
  priorities: ['High', 'Showstopper'],
  users: [
    { externalId: 'j-ana', name: 'Ana', email: 'ana@example.com' },
    { externalId: 'j-ben', name: 'Ben', email: 'ben@example.com' },
    { externalId: 'j-cleo', name: 'Cleo', email: 'cleo@example.com' },
    { externalId: 'j-dan', name: 'Dan', email: 'dan@example.com' },
    { externalId: 'j-eve', name: 'Eve', email: 'eve@example.com' },
    { externalId: 'j-bot', name: 'Bot', isBot: true },
  ],
  issueTypes: [{ externalId: 'bug', name: 'Bug' }, { externalId: 'epic', name: 'Epic', level: 'EPIC' }],
  customFields: [{ externalId: 'cf-sev', name: 'Severity', dataType: 'SELECT', options: [{ label: 'S1' }] }, { externalId: 'cf-pts', name: 'Points', dataType: 'NUMBER' }],
};

class Adapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.LINEAR;
  readonly capabilities = new Set<Capability>(['IMPORT']);
  readonly usesPkce = false;
  inventory: unknown = INVENTORY;
  withUsers = false;
  isConfigured() { return true; }
  authorizeUrl(_c: AuthorizeContext) { return 'x'; }
  async exchangeCode(_p: CallbackParams, _c: ExchangeContext): Promise<never> { throw new Error('unused'); }
  async revoke() { /* unused */ }
  async fetchBundle(): Promise<never> { throw new Error('unused'); }
  async discover(_c: ImportAdapterContext): Promise<SourceTree> {
    return { nodes: [{ id: 'proj-a', type: 'project', name: 'A', selectable: true }, { id: 'proj-b', type: 'project', name: 'B', selectable: true }] };
  }
  async estimate(_c: ImportAdapterContext, _s: ImportSelection, _o: ImportOptions): Promise<ImportEstimate> {
    const e: ImportEstimate = { projects: [{ sourceId: 'proj-a', name: 'A', tasks: 3 }] };
    if (this.inventory !== undefined) e.inventory = this.inventory as MappingInventory;
    if (this.withUsers) e.users = 99;
    return e;
  }
}

describe('import mapping (step 4.3)', () => {
  let prisma: PrismaService;
  let adapter: Adapter;
  let imports: ImportsService;
  let mapping: MappingService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new Adapter();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: WorkspacesService, useValue: {} },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: QueueService, useValue: { enqueue: async () => ({ id: 'x' }) } },
        { provide: CredentialService, useValue: { getAccessToken: async () => 'tok' } },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter] },
        AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportsService,
      ],
    }).compile();
    await moduleRef.init();
    imports = moduleRef.get(ImportsService);
    mapping = moduleRef.get(MappingService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.inventory = INVENTORY;
    adapter.withUsers = false;
  });
  afterAll(() => disconnectTestPrisma());

  /**
   * An owner; Ana (account member, verified), Ben (account member, e-mail NOT verified), Cleo (accepted workspace
   * collaborator, verified), Dan (collaborator whose invitation is still pending), Eve (verified, in neither); a
   * workspace and an ACTIVE connection.
   */
  async function world() {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'PRO_PERSONAL' as never } });
    const mk = (email: string, emailVerified: boolean) => createUser(prisma, { email, emailVerified, name: email.split('@')[0] });
    const [ana, ben, cleo, dan, eve] = await Promise.all([mk('ana@example.com', true), mk('ben@example.com', false), mk('cleo@example.com', true), mk('dan@example.com', true), mk('eve@example.com', true)]);
    await prisma.accountMember.createMany({ data: [{ accountId: w.account.id, userId: ana.id, role: Role.MEMBER }, { accountId: w.account.id, userId: ben.id, role: Role.MEMBER }] });
    const workspace = await createWorkspace(prisma, { accountId: w.account.id });
    await prisma.workspaceCollaborator.createMany({ data: [
      { workspaceId: workspace.id, invitedUserId: cleo.id, role: CollaboratorRole.CONTRIBUTOR, acceptedAt: new Date() },
      { workspaceId: workspace.id, invitedUserId: dan.id, role: CollaboratorRole.CONTRIBUTOR, acceptedAt: null },
    ] });
    const connection = await prisma.integrationConnection.create({
      data: { accountId: w.account.id, provider: IntegrationProvider.LINEAR, externalAccountId: 'org', externalAccountName: 'Org', scopes: ['read'], createdById: w.user.id },
    });
    return { ...w, ana, ben, cleo, dan, eve, workspace, connection };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function previewed(w: World) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id }, w.user.id);
    await imports.setSelection(job.id, { sources: [{ id: 'proj-a', type: 'project' }] }, w.user.id);
    await imports.preview(job.id, w.user.id);
    return job.id;
  }
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const targets = async (w: World, id: string) => {
    const v = await imports.getMapping(id, w.user.id);
    return Object.fromEntries(v.effective!.users.map((u) => [u.externalId, (u.target as { kind: string; userId?: string }).userId ?? (u.target as { kind: string }).kind]));
  };

  // ------------------------------------------------------------------------------------------------------------
  describe('preview stores the inventory and reports what needs a look', () => {
    it('the inventory is persisted, NEVER part of the job view, and the summary lists attention + unmapped people', async () => {
      const w = await world();
      const id = await previewed(w);
      expect((await row(id)).inventory).toMatchObject({ system: 'jira', projects: [{ externalId: 'ENG' }] });
      const view = await imports.get(id, w.user.id);
      expect(Object.keys(view)).not.toContain('inventory');
      const summary = view.previewSummary as { unmappedUsers: string[]; mapping: { attention: Array<{ code: string }> }; counts: { users: number } };
      expect(summary.unmappedUsers.sort()).toEqual(['j-ben', 'j-dan', 'j-eve']); // Ana and Cleo matched; the bot is not "unmatched"
      expect(summary.mapping.attention.map((a) => a.code).sort()).toEqual(['CUSTOM_FIELD_NAME_CONFLICT'].filter(() => false).concat(['PRIORITY_UNMATCHED', 'STATUS_BLOCKED_GUESS', 'USERS_UNMAPPED']).sort());
      expect(summary.counts.users).toBe(6); // the adapter gave no count: taken from the inventory
    });

    it('an adapter-supplied count wins over the inventory\'s', async () => {
      const w = await world();
      adapter.withUsers = true;
      const id = await previewed(w);
      expect(((await imports.get(id, w.user.id)).previewSummary as { counts: { users: number } }).counts.users).toBe(99);
    });

    it('without an inventory the preview works as in 4.1: no mapping section, nothing stored', async () => {
      const w = await world();
      adapter.inventory = undefined;
      const id = await previewed(w);
      expect((await row(id)).inventory).toBeNull();
      expect((await imports.get(id, w.user.id)).previewSummary).not.toHaveProperty('mapping');
      expect(await imports.getMapping(id, w.user.id)).toMatchObject({ hasInventory: false, suggestions: null, effective: null, attention: [] });
    });

    it('an inventory the engine cannot use is a 422 and leaves the job exactly as it was', async () => {
      const w = await world();
      const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id }, w.user.id);
      await imports.setSelection(job.id, { sources: [{ id: 'proj-a', type: 'project' }] }, w.user.id);
      for (const bad of [{ ...INVENTORY, users: [{ externalId: 'u', name: 'n', nickname: 'x' }] }, { ...INVENTORY, system: 'Bad Slug' }, 'nonsense']) {
        adapter.inventory = bad;
        await expect(imports.preview(job.id, w.user.id)).rejects.toThrow(/could not be read for mapping/);
      }
      expect(await row(job.id)).toMatchObject({ status: 'SOURCES_SELECTED', inventory: null, previewSummary: null });
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('who counts as a member (the only people an import can assign work to or credit)', () => {
    it('account members and ACCEPTED collaborators with a VERIFIED address match; unverified, pending, outsiders and bots do not', async () => {
      const w = await world();
      const id = await previewed(w);
      expect(await targets(w, id)).toEqual({ 'j-ana': w.ana.id, 'j-ben': 'importer', 'j-cleo': w.cleo.id, 'j-dan': 'importer', 'j-eve': 'importer', 'j-bot': 'importer' });
      const sug = (await imports.getMapping(id, w.user.id)).suggestions!.users;
      expect(sug.find((u) => u.externalId === 'j-ana')).toMatchObject({ reason: 'VERIFIED_EMAIL', confidence: 'MEDIUM' });
      expect(sug.find((u) => u.externalId === 'j-bot')).toMatchObject({ reason: 'BOT' });
    });

    it('an IdentityLink on THIS connection wins and reaches people the e-mail cannot; links to non-members, empty links and other connections\' links do nothing', async () => {
      const w = await world();
      const other = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: IntegrationProvider.LINEAR, externalAccountId: 'org2', externalAccountName: 'O2', scopes: [], createdById: w.user.id } });
      await prisma.identityLink.createMany({ data: [
        { connectionId: w.connection.id, externalUserId: 'j-ben', userId: w.ben.id, method: IdentityLinkMethod.MANUAL }, // a member, found by link although unverified
        { connectionId: w.connection.id, externalUserId: 'j-eve', userId: w.eve.id, method: IdentityLinkMethod.MANUAL }, // NOT a member: ignored
        { connectionId: w.connection.id, externalUserId: 'j-dan', userId: null, method: IdentityLinkMethod.SKIPPED }, // no user
        { connectionId: other.id, externalUserId: 'j-ana', userId: w.cleo.id, method: IdentityLinkMethod.MANUAL }, // another connection
      ] });
      const id = await previewed(w);
      const t = await targets(w, id);
      expect(t['j-ben']).toBe(w.ben.id);
      expect(t['j-eve']).toBe('importer');
      expect(t['j-dan']).toBe('importer');
      expect(t['j-ana']).toBe(w.ana.id); // by e-mail, not the other connection's link to Cleo
    });

    it('MEMBERSHIP IS JUDGED AGAIN AT RUN TIME: someone removed after the preview is no longer assigned or credited', async () => {
      const w = await world();
      const id = await previewed(w);
      expect((await mapping.resolveForRun(await row(id)))!.users.get('j-ana')?.target).toEqual({ kind: 'user', userId: w.ana.id });
      await prisma.accountMember.delete({ where: { accountId_userId: { accountId: w.account.id, userId: w.ana.id } } });
      expect((await mapping.resolveForRun(await row(id)))!.users.get('j-ana')?.target).toEqual({ kind: 'importer' });
    });

    it('a saved override to someone who has since left is ignored (reported), not followed', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.setMapping(id, { version: 1, users: [{ externalId: 'j-eve', target: { kind: 'user', userId: w.ben.id } }] }, w.user.id);
      await prisma.accountMember.delete({ where: { accountId_userId: { accountId: w.account.id, userId: w.ben.id } } });
      const v = await imports.getMapping(id, w.user.id);
      expect(v.stale).toBe(1);
      expect(v.attention.map((a) => a.code)).toContain('CONFIG_ROW_IGNORED');
      expect(((await targets(w, id)))['j-eve']).toBe('importer');
    });

    it('the workspace\'s own issue types and fields are matched; another workspace\'s are not', async () => {
      const w = await world();
      const other = await createWorkspace(prisma, { accountId: w.account.id });
      await prisma.issueType.create({ data: { workspaceId: w.workspace.id, name: 'bug', nameKey: 'bug', level: IssueTypeLevel.STANDARD } });
      await prisma.issueType.create({ data: { workspaceId: other.id, name: 'Epic', nameKey: 'epic', level: IssueTypeLevel.EPIC } });
      await prisma.customField.create({ data: { workspaceId: w.workspace.id, name: 'points', key: 'points', dataType: FieldType.NUMBER } });
      await prisma.customField.create({ data: { workspaceId: other.id, name: 'Severity', key: 'severity', dataType: FieldType.SELECT } });
      const id = await previewed(w);
      const eff = (await imports.getMapping(id, w.user.id)).effective!;
      expect(eff.issueTypes.map((t) => [t.externalId, (t.target as { kind: string }).kind])).toEqual([['bug', 'existing'], ['epic', 'create']]);
      expect(eff.customFields.map((f) => [f.externalId, (f.target as { kind: string }).kind])).toEqual([['cf-sev', 'create'], ['cf-pts', 'existing']]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('saving a mapping', () => {
    const problemsOf = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { return (e as { response: { problems: Array<{ code: string; path: string }> } }).response.problems; }
      throw new Error('expected a 400');
    };

    it('a valid config is saved normalised, moves the job to MAPPING, drops the stale preview, and shows up in the Map step', async () => {
      const w = await world();
      const id = await previewed(w);
      const v = await imports.setMapping(id, {
        version: 1,
        statuses: [{ statusExternalId: 's-blk', category: 'BLOCKED' }, { statusExternalId: 's-rev', mergeInto: 's-prog' }],
        priorities: [{ raw: 'Showstopper', priority: 'URGENT' }],
        users: [{ externalId: 'j-ben', target: { kind: 'user', userId: w.ben.id } }],
        issueTypes: [{ externalId: 'epic', target: { kind: 'skip' } }],
      }, w.user.id);
      expect(v).toMatchObject({ status: 'MAPPING', previewSummary: null });
      const m = await imports.getMapping(id, w.user.id);
      expect(m.effective!.statuses.find((s) => s.statusExternalId === 's-rev')).toMatchObject({ mergedInto: 's-prog', name: 'In Progress' });
      expect(m.effective!.priorities.find((p) => p.key === 'showstopper')).toEqual({ key: 'showstopper', priority: 'URGENT' });
      expect((await targets(w, id))['j-ben']).toBe(w.ben.id);
      expect(m.attention.map((a) => a.code)).not.toContain('STATUS_BLOCKED_GUESS'); // confirmed
      expect(m.attention.map((a) => a.code)).not.toContain('PRIORITY_UNMATCHED');
    });

    it('re-previewing after saving updates the report: the people the person decided are no longer "unmapped"', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.setMapping(id, { version: 1, users: [{ externalId: 'j-ben', target: { kind: 'user', userId: w.ben.id } }, { externalId: 'j-dan', target: { kind: 'importer' } }] }, w.user.id);
      await imports.preview(id, w.user.id);
      const s = (await imports.get(id, w.user.id)).previewSummary as { unmappedUsers: string[]; mapping: { attention: Array<{ message: string }> } };
      expect(s.unmappedUsers.sort()).toEqual(['j-eve']); // Ben and Dan were decided by hand (Dan: deliberately the importer)
    });

    it.each([
      ['a person who is not a member', (w: World) => ({ version: 1, users: [{ externalId: 'j-ana', target: { kind: 'user', userId: w.eve.id } }] }), 'NOT_A_MEMBER'],
      ['a collaborator whose invitation is still pending', (w: World) => ({ version: 1, users: [{ externalId: 'j-ana', target: { kind: 'user', userId: w.dan.id } }] }), 'NOT_A_MEMBER'],
      ['a source entity that is not in this import', () => ({ version: 1, statuses: [{ statusExternalId: 'nope', category: 'DONE' }] }), 'UNKNOWN_SOURCE_ENTITY'],
      ['the same status twice', () => ({ version: 1, statuses: [{ statusExternalId: 's-blk' }, { statusExternalId: 's-blk' }] }), 'DUPLICATE_KEY'],
      ['a merge into a merged status (chain)', () => ({ version: 1, statuses: [{ statusExternalId: 's-rev', mergeInto: 's-prog' }, { statusExternalId: 's-prog', mergeInto: 's-todo' }] }), 'MERGE_INVALID'],
      ['two statuses renamed to one name', () => ({ version: 1, statuses: [{ statusExternalId: 's-rev', name: 'in progress' }] }), 'NAME_COLLISION'],
      ['excluding a non-Done status from progress', () => ({ version: 1, statuses: [{ statusExternalId: 's-prog', excludeFromProgress: true }] }), 'CATEGORY_INVALID'],
      ['an existing issue type that does not exist here', () => ({ version: 1, issueTypes: [{ externalId: 'bug', target: { kind: 'existing', id: 'ghost' } }] }), 'UNKNOWN_TARGET'],
      ['a field of the wrong type', () => ({ version: 1, customFields: [{ externalId: 'cf-sev', target: { kind: 'existing', id: 'FIELD' } }] }), 'TYPE_MISMATCH'],
      ['an unknown key (a typo must not silently do nothing)', () => ({ version: 1, statusses: [] }), 'INVALID_SHAPE'],
    ])('refuses %s (400 with the problem listed) and changes nothing', async (_n, make, code) => {
      const w = await world();
      const field = await prisma.customField.create({ data: { workspaceId: w.workspace.id, name: 'Sev', key: 'sev', dataType: FieldType.TEXT } });
      const id = await previewed(w);
      await imports.setMapping(id, { version: 1, matchByEmail: false }, w.user.id);
      const raw = JSON.parse(JSON.stringify(make(w)).replace('FIELD', field.id));
      const problems = await problemsOf(imports.setMapping(id, raw, w.user.id));
      expect(problems.map((p) => p.code)).toContain(code);
      expect(await row(id)).toMatchObject({ status: 'MAPPING', mappingConfig: { version: 1, matchByEmail: false } });
    });

    it('works without an inventory too (shape, duplicates and membership are still enforced)', async () => {
      const w = await world();
      adapter.inventory = undefined;
      const id = await previewed(w);
      await imports.setMapping(id, { version: 1, priorities: [{ raw: 'x', priority: null }] }, w.user.id);
      const problems = await problemsOf(imports.setMapping(id, { version: 1, users: [{ externalId: 'any', target: { kind: 'user', userId: w.eve.id } }] }, w.user.id));
      expect(problems.map((p) => p.code)).toEqual(['NOT_A_MEMBER']);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('the selection changes: the inventory goes, the choices stay', () => {
    it('a new selection clears the inventory (the next preview rebuilds it) but keeps the saved rows; rows that no longer apply are counted as stale', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.setMapping(id, { version: 1, statuses: [{ statusExternalId: 's-blk', category: 'BLOCKED' }] }, w.user.id);
      await imports.setSelection(id, { sources: [{ id: 'proj-b', type: 'project' }] }, w.user.id);
      expect((await row(id)).inventory).toBeNull();
      expect(await imports.getMapping(id, w.user.id)).toMatchObject({ hasInventory: false, mappingConfig: { version: 1, statuses: [{ statusExternalId: 's-blk', category: 'BLOCKED' }] }, stale: 0 });
      adapter.inventory = { ...INVENTORY, projects: [{ externalId: 'OTHER', name: 'Other', statuses: [{ externalId: 's-x', name: 'X', category: 'TODO' }] }] };
      await imports.preview(id, w.user.id);
      expect(await imports.getMapping(id, w.user.id)).toMatchObject({ hasInventory: true, stale: 1 }); // s-blk is not part of the new selection
      // and it applies again if the old selection comes back
      await imports.setSelection(id, { sources: [{ id: 'proj-a', type: 'project' }] }, w.user.id);
      adapter.inventory = INVENTORY;
      await imports.preview(id, w.user.id);
      expect(await imports.getMapping(id, w.user.id)).toMatchObject({ stale: 0 });
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('end to end: what the executor will get', () => {
    it('resolveForRun + applyMapping on a validated page: tasks assigned to real members, others credited to the importer', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.setMapping(id, { version: 1, priorities: [{ raw: 'Showstopper', priority: 'URGENT' }], statuses: [{ statusExternalId: 's-rev', mergeInto: 's-prog' }] }, w.user.id);
      const resolved = (await mapping.resolveForRun(await row(id)))!;
      expect(resolved.importerUserId).toBe(w.user.id);

      const v = validateBundle({
        schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' },
        projects: [{ externalId: 'ENG', name: 'Engineering', statuses: INVENTORY.projects[0].statuses }],
        tasks: [
          { externalId: 'T1', title: 'One', projectExternalId: 'ENG', statusExternalId: 's-rev', priority: 'Showstopper', assigneeExternalIds: ['j-ana', 'j-eve'], creatorExternalId: 'j-cleo', comments: [{ externalId: 'c1', body: 'hi', authorExternalId: 'j-eve' }] },
        ],
      });
      const out = applyMapping((v as unknown as { bundle: CanonicalBundle }).bundle, resolved);
      expect(out.tasks[0]).toMatchObject({
        status: 'IN_PROGRESS', workflowStatusExternalId: 's-prog', priority: 'URGENT', assigneeUserIds: [w.ana.id], creator: { kind: 'user', userId: w.cleo.id },
      });
      expect(out.tasks[0].comments[0]).toMatchObject({ author: { kind: 'importer', label: 'Eve (via Jira)' }, body: '**Eve (via Jira)**\n\nhi' });
      expect(out.issues.map((i) => i.code)).toEqual(['USER_UNMAPPED']);
      expect(out.projects[0].statuses.map((s) => s.externalId)).toEqual(['s-todo', 's-prog', 's-blk', 's-done']);
    });

    it('a job with no inventory resolves to nothing (the executor must not guess)', async () => {
      const w = await world();
      adapter.inventory = undefined;
      const id = await previewed(w);
      expect(await mapping.resolveForRun(await row(id))).toBeNull();
    });
  });
});
