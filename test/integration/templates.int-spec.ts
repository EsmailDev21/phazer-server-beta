/**
 * Step 3.5 on a real database: versions are immutable (by trigger, not by good behaviour), the
 * plan limit holds under concurrency, reading follows the visibility rules, forks keep lineage,
 * and the export flow (extract -> sanitize -> store) works end to end.
 */
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountType, PlanKey, Role, TemplateVisibility } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { PlanLimitExceededException } from '../../src/common/exceptions/plan-limit-exceeded.exception';
import { PrismaService } from '../../src/prisma/prisma.service';
import { blueprintChecksum } from '../../src/templates/blueprint';
import { fixtureJson, GOLDEN_FIXTURES } from '../../src/templates/blueprint/blueprint.fixtures';
import { TemplateExtractionService } from '../../src/templates/extract';
import { TemplatesModule } from '../../src/templates/templates.module';
import { STORAGE_PROVIDER } from '../../src/attachments/storage/storage-provider.interface';
import { TemplateAssetsService } from '../../src/templates/assets/template-assets.service';
import { MemoryStorage } from './support/memory-storage';
import { stageDeclaredAssets } from './support/template-assets';
import { TemplatesService } from '../../src/templates/templates.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { addAccountMember, createAccount, createProject, createTask, createUser, createWorkspace } from './factories';

describe('Templates (step 3.5)', () => {
  let prisma: PrismaService;
  const storage = new MemoryStorage();
  let service: TemplatesService;
  let resolver: PermissionResolver;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        PermissionResolver,
        PlanLimitsService,
        TemplateExtractionService,
        TemplateAssetsService,
        { provide: STORAGE_PROVIDER, useValue: storage },
        TemplatesService,
      ],
    }).compile();
    const limits = moduleRef.get(PlanLimitsService);
    new TemplatesModule(limits).onModuleInit(); // the real counter registration
    service = moduleRef.get(TemplatesService);
    resolver = moduleRef.get(PermissionResolver);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function org(planType: PlanKey = PlanKey.ENTERPRISE_ORG) {
    const account = await createAccount(prisma, { type: AccountType.ORGANIZATION, planType });
    const mk = async (role: Role) => {
      const user = await createUser(prisma);
      await addAccountMember(prisma, { accountId: account.id, userId: user.id, role });
      return user;
    };
    return {
      account,
      owner: await mk(Role.OWNER),
      admin: await mk(Role.ADMIN),
      alice: await mk(Role.MEMBER),
      bob: await mk(Role.MEMBER),
      viewer: await mk(Role.VIEWER),
      outsider: await createUser(prisma),
    };
  }
  const bp = (name = 'sprint-board') => fixtureJson(name as (typeof GOLDEN_FIXTURES)[number]);
  const variant = (n: number) => {
    const b = fixtureJson('sprint-board');
    b.meta.description = `variant ${n}`;
    return b;
  };

  // ============================================================== storage ================
  describe('storing a version', () => {
    it.each(GOLDEN_FIXTURES)('%s: stored, then re-read from Postgres, still has its checksum and validates', async (name) => {
      const w = await org();
      const staged = stageDeclaredAssets(storage, bp(name) as any);
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: bp(name) }, undefined, { id: staged.id, assets: staged.assets });
      const row = await prisma.templateVersion.findFirstOrThrow({ where: { templateId: t.id } });
      expect(row.semver).toBe('1.0.0');
      expect(row.sequence).toBe(1);
      expect(row.checksum).toBe(blueprintChecksum(bp(name)));
      // jsonb reorders keys and drops whitespace: the canonical form must not care
      expect(blueprintChecksum(row.blueprint)).toBe(row.checksum);
      expect(await service.verifyIntegrity(row.id)).toEqual({ ok: true });
      expect(row.stats).toMatchObject({ projects: expect.any(Number), tasks: expect.any(Number) });
      expect(t.kind).toBe(name === 'sprint-board' ? 'PROJECT' : 'WORKSPACE');
      expect(t.latestVersion!.checksum).toBe(row.checksum);
    });

    it('rejects an invalid blueprint with the validator\'s issues, and stores nothing', async () => {
      const w = await org();
      const bad = bp();
      bad.projects[0].tasks[0].nodeKey = bad.projects[0].tasks[1].nodeKey;
      const err = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: bad }).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({ code: 'BLUEPRINT_INVALID', issues: [expect.objectContaining({ code: 'DUPLICATE' })] });
      expect(await prisma.template.count()).toBe(0);
    });

    it('the template takes name/description/category from the blueprint unless overridden', async () => {
      const w = await org();
      const a = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: bp() });
      expect(a).toMatchObject({ name: 'Scrum sprint board', category: 'software', visibility: 'PRIVATE', tags: [] });
      const b = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: bp(), name: '  Mine  ', category: 'team', tags: ['x'], visibility: TemplateVisibility.ACCOUNT });
      expect(b).toMatchObject({ name: 'Mine', category: 'team', tags: ['x'], visibility: 'ACCOUNT' });
    });
  });

  // ============================================================== immutability ===========
  describe('versions are immutable (database trigger)', () => {
    async function one() {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: bp() });
      const v = await prisma.templateVersion.findFirstOrThrow({ where: { templateId: t.id } });
      return { w, t, v };
    }

    it.each([
      ['the blueprint', (id: string) => prisma.$executeRaw`UPDATE template_versions SET blueprint = '{}'::jsonb WHERE id = ${id}`],
      ['the checksum', (id: string) => prisma.$executeRaw`UPDATE template_versions SET checksum = ${'sha256:' + 'a'.repeat(64)} WHERE id = ${id}`],
      ['the changelog', (id: string) => prisma.$executeRaw`UPDATE template_versions SET changelog = 'edited' WHERE id = ${id}`],
      ['the semver', (id: string) => prisma.$executeRaw`UPDATE template_versions SET semver = '9.9.9' WHERE id = ${id}`],
      ['nothing at all (a no-op update)', (id: string) => prisma.$executeRaw`UPDATE template_versions SET sequence = sequence WHERE id = ${id}`],
    ])('refuses an UPDATE of %s - even from raw SQL', async (_n, update) => {
      const { v } = await one();
      await expect(update(v.id)).rejects.toThrow(/immutable/);
    });

    it('refuses an UPDATE through Prisma too', async () => {
      const { v } = await one();
      await expect(prisma.templateVersion.update({ where: { id: v.id }, data: { changelog: 'x' } })).rejects.toThrow(/immutable/);
      await expect(prisma.templateVersion.updateMany({ data: { changelog: 'x' } })).rejects.toThrow(/immutable/);
    });

    it('refuses deleting a version on its own, but deleting the TEMPLATE removes its versions', async () => {
      const { t, v } = await one();
      await expect(prisma.templateVersion.delete({ where: { id: v.id } })).rejects.toThrow(/cannot be deleted on its own/);
      await expect(prisma.$executeRaw`DELETE FROM template_versions`).rejects.toThrow(/cannot be deleted on its own/);
      expect(await prisma.templateVersion.count()).toBe(1);
      await service.delete(t.id);
      expect(await prisma.templateVersion.count()).toBe(0);
    });

    it('deleting the whole ACCOUNT cascades through templates to versions', async () => {
      const { w } = await one();
      await prisma.account.delete({ where: { id: w.account.id } });
      expect(await prisma.template.count()).toBe(0);
      expect(await prisma.templateVersion.count()).toBe(0);
    });

    it('the TEMPLATE envelope stays editable', async () => {
      const { t, w } = await one();
      const u = await service.updateMeta(t.id, { name: 'Renamed', visibility: TemplateVisibility.ACCOUNT, tags: ['a', 'b'] });
      expect(u).toMatchObject({ name: 'Renamed', visibility: 'ACCOUNT', tags: ['a', 'b'] });
      expect(u.latestVersion!.checksum).toBe(t.latestVersion!.checksum);
      expect(w.account.id).toBe(u.ownerAccountId);
    });

    it('the database also enforces the shape of a row (CHECK constraints)', async () => {
      const { t, w } = await one();
      const insert = (over: Record<string, string | number>) => prisma.$executeRawUnsafe(
        `INSERT INTO template_versions (id, template_id, sequence, semver, schema_version, blueprint, checksum, stats, size_bytes, created_by_id, created_at)
         VALUES ($1, $2, $3, $4, 1, '{}'::jsonb, $5, '{}'::jsonb, $6, $7, now())`,
        `v${Math.random()}`, t.id, over.sequence ?? 5, over.semver ?? '5.0.0', over.checksum ?? `sha256:${'b'.repeat(64)}`, over.size ?? 10, w.alice.id,
      );
      await insert({}); // control: a well-formed row goes in
      await expect(insert({ sequence: 0, semver: '0.0.1' })).rejects.toThrow(/ck_template_versions_sequence/);
      await expect(insert({ sequence: 6, semver: '1.0' })).rejects.toThrow(/ck_template_versions_semver/);
      await expect(insert({ sequence: 7, semver: '7.0.0', checksum: 'md5:abc' })).rejects.toThrow(/ck_template_versions_checksum/);
      await expect(insert({ sequence: 8, semver: '8.0.0', size: 3 * 1024 * 1024 })).rejects.toThrow(/ck_template_versions_size/);
      await expect(insert({ sequence: 5, semver: '9.0.0' })).rejects.toThrow(/uq_template_versions_template_sequence/);
      await expect(insert({ sequence: 9, semver: '5.0.0' })).rejects.toThrow(/uq_template_versions_template_semver/);
    });
  });

  // ============================================================== new versions ===========
  describe('adding versions', () => {
    it('bumps semver, increments the sequence, and refuses an identical blueprint', async () => {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      const v2 = await service.addVersion(t.id, w.alice.id, { blueprint: variant(1), changelog: 'second' });
      const v3 = await service.addVersion(t.id, w.alice.id, { blueprint: variant(2), bump: 'major' });
      const v4 = await service.addVersion(t.id, w.alice.id, { blueprint: variant(3), bump: 'patch' });
      expect([v2, v3, v4].map((v) => [v.sequence, v.semver])).toEqual([[2, '1.1.0'], [3, '2.0.0'], [4, '2.0.1']]);
      expect(v2.changelog).toBe('second');
      const err = await service.addVersion(t.id, w.alice.id, { blueprint: variant(3) }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: 'NO_CHANGES' });
      expect((await service.listVersions(t.id, w.alice.id)).map((v) => v.sequence)).toEqual([4, 3, 2, 1]);
      expect((await service.get(t.id, w.alice.id)).latestVersion!.semver).toBe('2.0.1');
      // older versions are still there, unchanged
      expect((await service.getVersion(t.id, 1, w.alice.id)).blueprint).toMatchObject({ meta: { description: 'variant 0' } });
      expect((await service.getVersion(t.id, 'latest', w.alice.id)).sequence).toBe(4);
    });

    it('a PROJECT template cannot receive a WORKSPACE blueprint; an invalid one is refused', async () => {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: bp('sprint-board') });
      const err = await service.addVersion(t.id, w.alice.id, { blueprint: bp('content-calendar') }).catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: 'TEMPLATE_KIND_MISMATCH' });
      const bad = bp();
      bad.bogus = 1;
      await expect(service.addVersion(t.id, w.alice.id, { blueprint: bad })).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(await prisma.templateVersion.count({ where: { templateId: t.id } })).toBe(1);
    });

    it('concurrent new versions get distinct, gapless sequence numbers', async () => {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => service.addVersion(t.id, w.alice.id, { blueprint: variant(i + 1) })));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const rows = await prisma.templateVersion.findMany({ where: { templateId: t.id }, orderBy: { sequence: 'asc' } });
      expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(rows.map((r) => r.semver)).size).toBe(9);
    });

    it('an unknown template is NotFound', async () => {
      const w = await org();
      await expect(service.addVersion('nope', w.alice.id, { blueprint: bp() })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ============================================================== plan limit =============
  describe('the template-count plan limit', () => {
    it('FREE_PERSONAL allows 3, then answers 402 - and deleting one frees a slot', async () => {
      const w = await org(PlanKey.FREE_PERSONAL);
      const made = [];
      for (let i = 0; i < 3; i++) made.push(await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(i) }));
      await expect(service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(9) })).rejects.toBeInstanceOf(PlanLimitExceededException);
      await service.delete(made[0].id);
      await expect(service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(10) })).resolves.toBeDefined();
    });

    it('holds under concurrency: 8 racing creates on a 3-template plan make exactly 3', async () => {
      const w = await org(PlanKey.FREE_PERSONAL);
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(i) })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason instanceof PlanLimitExceededException)).toBe(true);
      expect(await prisma.template.count({ where: { ownerAccountId: w.account.id } })).toBe(3);
    });

    it('counts per ACCOUNT, not per user or workspace; another account is unaffected; fork counts too', async () => {
      const w = await org(PlanKey.FREE_PERSONAL);
      const other = await org(PlanKey.FREE_PERSONAL);
      const a = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      await service.createFromBlueprint(w.account.id, w.bob.id, { blueprint: variant(1) });
      await service.fork(a.id, w.alice.id, w.account.id); // the 3rd
      await expect(service.createFromBlueprint(w.account.id, w.bob.id, { blueprint: variant(2) })).rejects.toBeInstanceOf(PlanLimitExceededException);
      await expect(service.fork(a.id, w.alice.id, w.account.id)).rejects.toBeInstanceOf(PlanLimitExceededException);
      await expect(service.createFromBlueprint(other.account.id, other.alice.id, { blueprint: variant(0) })).resolves.toBeDefined();
    });

    it('an unlimited tier needs no slot', async () => {
      const w = await org(PlanKey.ENTERPRISE_ORG);
      for (let i = 0; i < 6; i++) await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(i) });
      expect(await prisma.template.count()).toBe(6);
    });
  });

  // ============================================================== who can see what =======
  describe('reading and listing', () => {
    it('PRIVATE: creator and account OWNER/ADMIN only; ACCOUNT: also every MEMBER; VIEWERs and outsiders never', async () => {
      const w = await org();
      const priv = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      const shared = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(1), visibility: TemplateVisibility.ACCOUNT });
      const can = async (user: { id: string }, id: string) => service.get(id, user.id).then(() => true, (e) => (e instanceof NotFoundException ? false : Promise.reject(e)));
      expect(await Promise.all([w.alice, w.owner, w.admin, w.bob, w.viewer, w.outsider].map((u) => can(u, priv.id)))).toEqual([true, true, true, false, false, false]);
      expect(await Promise.all([w.alice, w.owner, w.admin, w.bob, w.viewer, w.outsider].map((u) => can(u, shared.id)))).toEqual([true, true, true, true, false, false]);
    });

    it('an unreadable template is indistinguishable from one that does not exist', async () => {
      const w = await org();
      const priv = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      const a = await service.get(priv.id, w.bob.id).catch((e) => e);
      const b = await service.get('does-not-exist', w.bob.id).catch((e) => e);
      expect(a).toBeInstanceOf(NotFoundException);
      expect(a.getResponse()).toEqual(b.getResponse());
      for (const f of [() => service.listVersions(priv.id, w.bob.id), () => service.getVersion(priv.id, 'latest', w.bob.id), () => service.lineage(priv.id, w.bob.id)]) {
        await expect(f()).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('list shows each person exactly what they may read, newest first, with the latest version', async () => {
      const w = await org();
      await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0), name: 'alice-private' });
      await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(1), name: 'alice-shared', visibility: TemplateVisibility.ACCOUNT });
      await service.createFromBlueprint(w.account.id, w.bob.id, { blueprint: variant(2), name: 'bob-private' });
      const names = async (u: { id: string }, q = {}) => (await service.list(w.account.id, u.id, q)).map((t) => t.name);
      expect(await names(w.alice)).toEqual(['alice-shared', 'alice-private']);
      expect(await names(w.bob)).toEqual(['bob-private', 'alice-shared']);
      expect(await names(w.admin)).toEqual(['bob-private', 'alice-shared', 'alice-private']);
      expect(await names(w.viewer)).toEqual([]);
      expect(await names(w.bob, { mine: true })).toEqual(['bob-private']);
      expect(await names(w.admin, { visibility: TemplateVisibility.ACCOUNT })).toEqual(['alice-shared']);
      expect(await names(w.admin, { kind: 'WORKSPACE' as const })).toEqual([]);
      await expect(service.list(w.account.id, w.outsider.id)).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.list(w.account.id, w.alice.id))[0].latestVersion).toMatchObject({ semver: '1.0.0' });
    });

    it('leaving the account ends access, even to what you made', async () => {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      await prisma.accountMember.delete({ where: { accountId_userId: { accountId: w.account.id, userId: w.alice.id } } });
      await expect(service.get(t.id, w.alice.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('another account\'s templates never appear', async () => {
      const a = await org();
      const b = await org();
      await service.createFromBlueprint(b.account.id, b.alice.id, { blueprint: variant(0), visibility: TemplateVisibility.ACCOUNT });
      expect(await service.list(a.account.id, a.admin.id)).toEqual([]);
    });
  });

  // ============================================================== permissions ============
  describe('permissions through the real resolver (createTemplate / editTemplate / deleteTemplate)', () => {
    it('the creator may edit and delete their own even as a MEMBER; another MEMBER may not; ADMIN/OWNER may', async () => {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      const allowed = async (u: { id: string }, action: 'editTemplate' | 'deleteTemplate') =>
        (await resolver.resolve(u.id, action, 'TEMPLATE', t.id)).allowed;
      for (const action of ['editTemplate', 'deleteTemplate'] as const) {
        expect(await Promise.all([w.alice, w.bob, w.viewer, w.admin, w.owner].map((u) => allowed(u, action)))).toEqual([true, false, false, true, true]);
      }
    });

    it('an outsider is refused; an unknown template is NotFound', async () => {
      const w = await org();
      const t = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      expect((await resolver.resolve(w.outsider.id, 'editTemplate', 'TEMPLATE', t.id)).allowed).toBe(false);
      await expect(resolver.resolve(w.alice.id, 'editTemplate', 'TEMPLATE', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('createTemplate: MEMBER and up, not VIEWER; the plan limit is step 8 of the same check', async () => {
      const w = await org(PlanKey.FREE_PERSONAL);
      const can = async (u: { id: string }) => resolver.resolve(u.id, 'createTemplate', 'ACCOUNT', w.account.id);
      expect((await can(w.alice)).allowed).toBe(true);
      expect((await can(w.viewer)).allowed).toBe(false);
      for (let i = 0; i < 3; i++) await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(i) });
      const full = await can(w.alice);
      expect(full.allowed).toBe(false);
      expect(full.planLimitExceeded).toBe(true);
    });
  });

  // ============================================================== forks ==================
  describe('fork lineage', () => {
    it('a fork is a private copy with the same blueprint (same checksum), pointing at its source version', async () => {
      const w = await org();
      const src = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0), visibility: TemplateVisibility.ACCOUNT, tags: ['t'], category: 'software' });
      const v2 = await service.addVersion(src.id, w.alice.id, { blueprint: variant(1) });
      const copy = await service.fork(src.id, w.bob.id, w.account.id);
      expect(copy).toMatchObject({ name: 'Scrum sprint board (copy)', visibility: 'PRIVATE', createdById: w.bob.id, sourceTemplateId: src.id, sourceVersionId: v2.id, tags: ['t'], category: 'software' });
      expect(copy.latestVersion!.checksum).toBe(v2.checksum);
      expect(copy.latestVersion!.semver).toBe('1.0.0');
      expect((await service.getVersion(copy.id, 1, w.bob.id)).blueprint).toEqual((await service.getVersion(src.id, 2, w.alice.id)).blueprint);
      expect((await service.get(src.id, w.alice.id)).forkCount).toBe(1);
      // the copy is independent: a new version of the source does not touch it
      await service.addVersion(src.id, w.alice.id, { blueprint: variant(2) });
      expect((await service.get(copy.id, w.bob.id)).latestVersion!.checksum).toBe(v2.checksum);
    });

    it('you can only fork what you can read, and only inside the owning account', async () => {
      const w = await org();
      const other = await org();
      const priv = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      await expect(service.fork(priv.id, w.bob.id, w.account.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.fork(priv.id, w.alice.id, other.account.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.fork(priv.id, other.alice.id, other.account.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await prisma.template.count()).toBe(1);
    });

    it('lineage lists ancestors nearest first and hides the ones you cannot read', async () => {
      const w = await org();
      const a = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0), name: 'A', visibility: TemplateVisibility.ACCOUNT });
      const b = await service.fork(a.id, w.alice.id, w.account.id);
      await service.updateMeta(b.id, { name: 'B', visibility: TemplateVisibility.ACCOUNT });
      const c = await service.fork(b.id, w.bob.id, w.account.id);
      await service.updateMeta(c.id, { name: 'C' });
      expect((await service.lineage(c.id, w.bob.id)).ancestors).toEqual([
        { id: b.id, name: 'B', versionId: c.sourceVersionId }, { id: a.id, name: 'A', versionId: b.sourceVersionId },
      ]);
      await service.updateMeta(a.id, { visibility: TemplateVisibility.PRIVATE });
      expect((await service.lineage(c.id, w.bob.id)).ancestors).toEqual([{ id: b.id, name: 'B', versionId: c.sourceVersionId }, { unavailable: true }]);
      expect((await service.lineage(a.id, w.alice.id)).ancestors).toEqual([]);
    });

    it('deleting the source clears the pointers but the fork keeps working; deleting a fork does not touch the source', async () => {
      const w = await org();
      const a = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      const b = await service.fork(a.id, w.alice.id, w.account.id);
      await service.delete(a.id);
      const after = await service.get(b.id, w.alice.id);
      expect(after.sourceTemplateId).toBeNull();
      expect(after.sourceVersionId).toBeNull();
      expect(after.latestVersion).not.toBeNull();
      expect(await service.verifyIntegrity(after.latestVersion!.id)).toEqual({ ok: true });
      const c = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(5) });
      const d = await service.fork(c.id, w.alice.id, w.account.id);
      await service.delete(d.id);
      expect((await service.get(c.id, w.alice.id)).forkCount).toBe(0);
    });

    it('a template cannot be its own source (CHECK)', async () => {
      const w = await org();
      const a = await service.createFromBlueprint(w.account.id, w.alice.id, { blueprint: variant(0) });
      await expect(prisma.$executeRaw`UPDATE templates SET source_template_id = id WHERE id = ${a.id}`).rejects.toThrow(/ck_templates_not_own_fork/);
    });
  });

  // ============================================================== export flow ============
  describe('export from a workspace (extract -> sanitize -> store)', () => {
    async function workspaceWith(org_: Awaited<ReturnType<typeof org>>, description = 'ch 1-6') {
      const ws = await createWorkspace(prisma, { accountId: org_.account.id, name: 'Bio', key: 'BIO' });
      const p = await createProject(prisma, { workspaceId: ws.id, createdById: org_.alice.id, name: 'Coursework' });
      await prisma.tag.create({ data: { workspaceId: ws.id, name: 'exam', nameKey: 'exam' } });
      await createTask(prisma, { workspaceId: ws.id, createdById: org_.alice.id, projectId: p.id, title: 'Midterm', description, dueDate: new Date('2026-10-20T00:00:00Z'), assignees: { connect: [{ id: org_.alice.id }] } });
      await createTask(prisma, { workspaceId: ws.id, createdById: org_.alice.id, projectId: p.id, title: 'Read ch 1', startDate: new Date('2026-09-01T00:00:00Z') });
      return { ws, p };
    }

    it('produces a stored, validated, sanitised template and returns the report', async () => {
      const w = await org();
      const { ws } = await workspaceWith(w);
      const r = await service.exportFromWorkspace(ws.id, w.alice.id, { name: 'My semester' });
      expect(r.template).toMatchObject({ name: 'My semester', kind: 'WORKSPACE', visibility: 'PRIVATE', ownerAccountId: w.account.id, createdById: w.alice.id });
      expect(r.report).toMatchObject({ blocked: false, anchor: { date: '2026-09-01', source: 'earliest' }, roles: { created: 1 } });
      const v = await service.getVersion(r.template.id, 'latest', w.alice.id);
      const json = JSON.stringify(v.blueprint);
      expect(json).not.toContain(w.alice.id);
      expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(await service.verifyIntegrity(v.id)).toEqual({ ok: true });
    });

    it('a credential in the workspace BLOCKS the export: nothing is stored, and the report never contains it', async () => {
      const w = await org();
      const token = 'gh' + 'p_' + 'aB3dE5'.repeat(7);
      const { ws } = await workspaceWith(w, `deploy with ${token}`);
      const err = await service.exportFromWorkspace(ws.id, w.alice.id, {}).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({ code: 'TEMPLATE_BLOCKED', report: { blocked: true } });
      expect(JSON.stringify(err.getResponse())).not.toContain(token);
      expect(await prisma.template.count()).toBe(0);
      // the exporter may choose to redact and continue
      const ok = await service.exportFromWorkspace(ws.id, w.alice.id, { onSecret: 'redact' });
      const v = await service.getVersion(ok.template.id, 'latest', w.alice.id);
      expect(JSON.stringify(v.blueprint)).not.toContain(token);
      expect(JSON.stringify(v.blueprint)).toContain('[secret removed]');
    });

    it('exports one project as a PROJECT template; an unknown project is refused', async () => {
      const w = await org();
      const { ws, p } = await workspaceWith(w);
      const r = await service.exportFromWorkspace(ws.id, w.alice.id, { projectId: p.id });
      expect(r.template.kind).toBe('PROJECT');
      await expect(service.exportFromWorkspace(ws.id, w.alice.id, { projectId: 'nope' })).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(service.exportFromWorkspace('nope', w.alice.id, {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is subject to the plan limit', async () => {
      const w = await org(PlanKey.FREE_PERSONAL);
      const { ws } = await workspaceWith(w);
      for (let i = 0; i < 3; i++) await service.exportFromWorkspace(ws.id, w.alice.id, { name: `t${i}` });
      await expect(service.exportFromWorkspace(ws.id, w.alice.id, {})).rejects.toBeInstanceOf(PlanLimitExceededException);
    });
  });
});
