import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Role, TemplateKind, TemplateVisibility } from '@prisma/client';
import { PlanLimitsService } from '../access-control/plan-limits.service';
import { PlanLimitExceededException } from '../common/exceptions/plan-limit-exceeded.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  blueprintChecksum,
  BlueprintV1,
  canonicalJson,
  validateBlueprint,
} from './blueprint';
import { ExtractError, TemplateExtractionService } from './extract';
import { sanitize, SanitizeOptions, SanitizeReport } from './sanitize';
import {
  CreateTemplateDto,
  ExportTemplateDto,
  ListPublicTemplatesQueryDto,
  ListTemplatesQueryDto,
  NewVersionDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { bumpSemver } from './templates.semver';
import { randomUUID } from 'crypto';
import {
  StagedAsset,
  TemplateAssetsService,
} from './assets/template-assets.service';
import { maxEditorKey } from './editor/editor.apply';
import { diffBlueprints } from './diff';

type Db = Prisma.TransactionClient | PrismaService;

const ADMIN_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

const versionSummary = {
  id: true,
  sequence: true,
  semver: true,
  schemaVersion: true,
  checksum: true,
  stats: true,
  sizeBytes: true,
  changelog: true,
  createdById: true,
  createdAt: true,
} satisfies Prisma.TemplateVersionSelect;

export interface TemplateDto {
  id: string;
  ownerAccountId: string;
  createdById: string;
  kind: TemplateKind;
  visibility: TemplateVisibility;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  sourceTemplateId: string | null;
  sourceVersionId: string | null;
  /** Step 3.9. Set only on first-party templates (the stable id of the seed); null on everything else. */
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  latestVersion: VersionSummaryDto | null;
}
export type VersionSummaryDto = Prisma.TemplateVersionGetPayload<{
  select: typeof versionSummary;
}>;

const versionRow = (bp: BlueprintV1, stats: unknown) => {
  const canonical = canonicalJson(bp);
  return {
    schemaVersion: bp.schemaVersion,
    blueprint: JSON.parse(canonical) as Prisma.InputJsonValue,
    checksum: blueprintChecksum(bp),
    stats: stats as Prisma.InputJsonValue,
    sizeBytes: Buffer.byteLength(canonical, 'utf8'),
  };
};

const toDto = (
  t: Prisma.TemplateGetPayload<object> & { versions?: VersionSummaryDto[] },
): TemplateDto => ({
  id: t.id,
  ownerAccountId: t.ownerAccountId,
  createdById: t.createdById,
  kind: t.kind,
  visibility: t.visibility,
  name: t.name,
  description: t.description,
  category: t.category,
  tags: t.tags,
  sourceTemplateId: t.sourceTemplateId,
  sourceVersionId: t.sourceVersionId,
  seedKey: t.seedKey,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  latestVersion: t.versions?.[0] ?? null,
});

/**
 * Step 3.5. Templates: the mutable envelope (name, visibility, tags) around immutable versions.
 *
 *  - Step 3.9: a PUBLIC template (first-party seeds only) is readable by every signed-in user,
 *    membership or not; nothing else about authorisation changes (editing and deleting still need
 *    a role in the OWNING account, which for a seed is the system account nobody signs in to).
 *    Only the system account may own a PUBLIC template: see `assertVisibilityAllowed`.
 *
 *  - A version's blueprint is VALIDATED here (validateBlueprint) and its checksum computed from
 *    the canonical form; the database trigger then guarantees it is never changed.
 *  - Reading: the creator, the account's OWNER/ADMIN, and (visibility ACCOUNT) its MEMBERs - and
 *    only people who are still members of the account. Anything else is a 404, not a 403: a
 *    template you cannot read does not announce that it exists.
 *  - Editing/deleting is authorised by the route's guard (editTemplate / deleteTemplate: ADMIN+
 *    or the creator); creating by createTemplate (+ the plan limit, re-checked here under a lock
 *    so two requests cannot both take the last slot).
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: PlanLimitsService,
    private readonly extraction: TemplateExtractionService,
    private readonly assets: TemplateAssetsService,
  ) {}

  // ================================================================ create ===============

  async createFromBlueprint(
    accountId: string,
    userId: string,
    input: CreateTemplateDto,
    source?: { templateId: string; versionId: string },
    /** Server-side only: the id chosen up front and the assets already stored under it (export, fork). */
    extras?: { id: string; assets: StagedAsset[]; seedKey?: string },
  ): Promise<TemplateDto> {
    const { bp, version } = this.validated(input.blueprint);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId);
      const owner = await tx.account.findUnique({
        where: { id: accountId },
        select: { isSystem: true },
      });
      this.assertVisibilityAllowed(owner?.isSystem === true, input.visibility);
      if (extras?.seedKey !== undefined && owner?.isSystem !== true) {
        throw new ForbiddenException({
          code: 'SEED_RESERVED',
          message: 'Only the system account owns seed templates',
        });
      }
      // the system account's templates are the product's, not a customer's: no plan limit applies
      if (owner?.isSystem !== true) await this.assertQuota(tx, accountId);
      // a NEW template has no stored files: a blueprint that lists some is only valid with `extras`
      await this.assets.assertBlueprintAssets(
        tx,
        null,
        bp,
        extras?.assets ?? [],
      );
      const template = await tx.template.create({
        data: {
          ...(extras ? { id: extras.id } : {}),
          nodeKeySeq: maxEditorKey(bp),
          ...(extras?.seedKey !== undefined ? { seedKey: extras.seedKey } : {}),
          ownerAccountId: accountId,
          createdById: userId,
          kind: bp.meta.kind,
          visibility: input.visibility ?? TemplateVisibility.PRIVATE,
          // a blank name (spaces only) falls back to the blueprint's own name instead of storing ""
          name: input.name?.trim() || bp.meta.name.trim(),
          description: input.description ?? bp.meta.description ?? null,
          category: input.category ?? bp.meta.category ?? null,
          tags: input.tags ?? [],
          sourceTemplateId: source?.templateId ?? null,
          sourceVersionId: source?.versionId ?? null,
        },
      });
      if (extras && extras.assets.length > 0) {
        const used = new Set((bp.assets ?? []).map((a) => a.sha256));
        await tx.templateAsset.createMany({
          data: extras.assets
            .filter((a) => used.has(a.sha256))
            .map((a) => ({
              templateId: template.id,
              sha256: a.sha256,
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              storageKey: a.storageKey,
              createdById: userId,
            })),
        });
      }
      const v = await tx.templateVersion.create({
        data: {
          templateId: template.id,
          sequence: 1,
          semver: '1.0.0',
          createdById: userId,
          changelog: input.changelog ?? null,
          ...version,
        },
        select: versionSummary,
      });
      return toDto({ ...template, versions: [v] });
    });
  }

  /** Workspace (or one project) -> extract -> sanitize -> a new private template. */
  async exportFromWorkspace(
    workspaceId: string,
    userId: string,
    dto: ExportTemplateDto,
  ): Promise<{
    template: TemplateDto;
    report: SanitizeReport;
    warnings: unknown[];
    assets: {
      stored: number;
      refused: Array<{ sourceAttachmentId: string; reason: string }>;
    };
  }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { accountId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    let extracted;
    try {
      extracted = await this.extraction.extract(workspaceId, dto);
    } catch (err) {
      if (err instanceof ExtractError) {
        throw new UnprocessableEntityException({
          code: err.code,
          message: err.message,
        });
      }
      throw err;
    }
    // Reference files: read, check, hash and store BEFORE sanitizing (the sanitizer only keeps
    // files that have a hash). Anything stored is removed again if the export does not finish.
    const templateId = randomUUID();
    const stage = await this.assets.stageFromAttachments(
      templateId,
      extracted.raw,
    );
    const discard = () =>
      this.assets.deleteObjects(stage.staged.map((s) => s.storageKey));
    try {
      return await this.finishExport(
        workspace.accountId,
        userId,
        dto,
        templateId,
        extracted.raw,
        stage,
      );
    } catch (err) {
      await discard();
      throw err;
    }
  }

  private async finishExport(
    accountId: string,
    userId: string,
    dto: ExportTemplateDto,
    templateId: string,
    raw: Parameters<typeof sanitize>[0],
    stage: Awaited<ReturnType<TemplateAssetsService['stageFromAttachments']>>,
  ) {
    for (const a of raw.assets) {
      const actual = stage.actualSizes.get(a.sourceAttachmentId);
      if (actual !== undefined) a.sizeBytes = actual; // the declared size of an attachment is not trusted
    }
    const options: SanitizeOptions = {
      anchorDate: dto.anchorDate,
      onSecret: dto.onSecret,
      assetHashes: stage.hashes,
    };
    const result = sanitize(raw, options);
    if (result.ok === false) {
      throw new UnprocessableEntityException(
        result.reason === 'SECRETS_FOUND'
          ? {
              code: 'TEMPLATE_BLOCKED',
              message:
                'The workspace contains what looks like a credential. Remove it, or export again choosing to redact it.',
              report: result.report,
            }
          : {
              code: 'TEMPLATE_INVALID',
              message: 'The workspace cannot be turned into a valid template.',
              issues: result.issues,
              report: result.report,
            },
      );
    }
    const keep = new Set((result.blueprint.assets ?? []).map((a) => a.sha256));
    const unused = stage.staged.filter((s) => !keep.has(s.sha256)); // stored, then dropped by the sanitizer
    const template = await this.createFromBlueprint(
      accountId,
      userId,
      {
        blueprint: result.blueprint as unknown as Record<string, unknown>,
        name: dto.name,
        description: dto.description,
        category: dto.category,
        visibility: dto.visibility,
      },
      undefined,
      {
        id: templateId,
        assets: stage.staged.filter((s) => keep.has(s.sha256)),
      },
    );
    await this.assets.deleteObjects(unused.map((s) => s.storageKey));
    return {
      template,
      report: result.report,
      warnings: result.warnings,
      assets: { stored: keep.size, refused: stage.refused },
    };
  }

  // ================================================================ versions =============

  async addVersion(
    templateId: string,
    userId: string,
    dto: NewVersionDto,
  ): Promise<VersionSummaryDto> {
    const { bp, version: data } = this.validated(dto.blueprint);
    return this.prisma.$transaction((tx) =>
      this.addVersionInTx(tx, templateId, userId, bp, data, dto),
    );
  }

  /**
   * The one place a version is written (the version route and the editor's publish both come here).
   * Takes the per-template version lock (re-entrant: a caller may already hold it), checks assets,
   * kind and "no changes", and keeps the editor's key counter ahead of every key in the blueprint.
   */
  async addVersionInTx(
    tx: Prisma.TransactionClient,
    templateId: string,
    userId: string,
    bp: BlueprintV1,
    data: ReturnType<typeof versionRow>,
    opts: { bump?: 'major' | 'minor' | 'patch'; changelog?: string },
  ): Promise<VersionSummaryDto> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`template-versions:${templateId}`}, 0))`;
    const template = await tx.template.findUnique({
      where: { id: templateId },
      select: { id: true, kind: true },
    });
    if (!template) throw new NotFoundException('Template not found');
    await this.assets.assertBlueprintAssets(tx, templateId, bp);
    if (template.kind !== bp.meta.kind) {
      throw new ConflictException({
        code: 'TEMPLATE_KIND_MISMATCH',
        message: `This is a ${template.kind} template; the blueprint is a ${bp.meta.kind}`,
      });
    }
    const latest = await tx.templateVersion.findFirst({
      where: { templateId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, semver: true, checksum: true },
    });
    if (latest && latest.checksum === data.checksum) {
      throw new ConflictException({
        code: 'NO_CHANGES',
        message: 'This blueprint is identical to the latest version',
      });
    }
    const created = await tx.templateVersion.create({
      data: {
        templateId,
        sequence: (latest?.sequence ?? 0) + 1,
        semver: bumpSemver(latest?.semver ?? null, opts.bump),
        createdById: userId,
        changelog: opts.changelog ?? null,
        ...data,
      },
      select: versionSummary,
    });
    // keep the editor's key counter ahead of any n<k> / a<k> key this blueprint carries
    await tx.$executeRaw`UPDATE templates SET updated_at = now(), node_key_seq = GREATEST(node_key_seq, ${maxEditorKey(bp)}) WHERE id = ${templateId}`;
    return created;
  }

  async listVersions(
    templateId: string,
    userId: string,
  ): Promise<VersionSummaryDto[]> {
    await this.loadReadable(templateId, userId);
    return this.prisma.templateVersion.findMany({
      where: { templateId },
      orderBy: { sequence: 'desc' },
      select: versionSummary,
    });
  }

  /** One version WITH its blueprint. `sequence` of "latest" or a number. */
  async getVersion(
    templateId: string,
    sequence: number | 'latest',
    userId: string,
  ) {
    await this.loadReadable(templateId, userId);
    const v = await this.prisma.templateVersion.findFirst({
      where: sequence === 'latest' ? { templateId } : { templateId, sequence },
      orderBy: { sequence: 'desc' },
      select: { ...versionSummary, blueprint: true },
    });
    if (!v) throw new NotFoundException('Version not found');
    return v;
  }

  /**
   * What changed between two versions (`from`, `to`: a sequence number or "latest"). Readable by
   * anyone who can read the template. Identity is the nodeKey, see diff/.
   */
  async diffVersions(
    templateId: string,
    from: string,
    to: string,
    userId: string,
  ) {
    const parse = (v: string): number | 'latest' => {
      if (v === 'latest') return 'latest';
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1)
        throw new BadRequestException(
          `"${v}" is not a version number or "latest"`,
        );
      return n;
    };
    const [a, b] = [
      await this.getVersion(templateId, parse(from), userId),
      await this.getVersion(templateId, parse(to), userId),
    ];
    const d = diffBlueprints(
      a.blueprint as unknown as BlueprintV1,
      b.blueprint as unknown as BlueprintV1,
    );
    return {
      from: { sequence: a.sequence, semver: a.semver },
      to: { sequence: b.sequence, semver: b.semver },
      ...d,
    };
  }

  /** Re-derives the checksum from what is stored and re-validates it. For tests and audits. */
  async verifyIntegrity(
    versionId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const v = await this.prisma.templateVersion.findUnique({
      where: { id: versionId },
    });
    if (!v) throw new NotFoundException('Version not found');
    if (blueprintChecksum(v.blueprint) !== v.checksum)
      return { ok: false, reason: 'checksum mismatch' };
    if (Buffer.byteLength(canonicalJson(v.blueprint), 'utf8') !== v.sizeBytes)
      return { ok: false, reason: 'size mismatch' };
    const check = validateBlueprint(v.blueprint);
    return check.ok === true
      ? { ok: true }
      : {
          ok: false,
          reason: `blueprint no longer validates: ${check.issues[0]?.code}`,
        };
  }

  // ================================================================ read =================

  async list(
    accountId: string,
    userId: string,
    query: ListTemplatesQueryDto = {},
  ): Promise<TemplateDto[]> {
    const member = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
      select: { role: true },
    });
    if (!member) throw new NotFoundException('Account not found');

    const admin = ADMIN_ROLES.includes(member.role);
    const sees: Prisma.TemplateWhereInput = admin
      ? {}
      : member.role === Role.MEMBER
        ? {
            OR: [
              { createdById: userId },
              { visibility: TemplateVisibility.ACCOUNT },
            ],
          }
        : { createdById: userId };
    const rows = await this.prisma.template.findMany({
      where: {
        ownerAccountId: accountId,
        ...sees,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.visibility ? { visibility: query.visibility } : {}),
        ...(query.mine ? { createdById: userId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        versions: {
          orderBy: { sequence: 'desc' },
          take: 1,
          select: versionSummary,
        },
      },
    });
    return rows.map(toDto);
  }

  /**
   * The gallery: every PUBLIC template, for any signed-in user. Newest versions only (summary, no
   * blueprint). Capped; the seed set is a handful and Phase 6 brings real search and paging.
   */
  async listPublic(
    query: ListPublicTemplatesQueryDto = {},
  ): Promise<TemplateDto[]> {
    const rows = await this.prisma.template.findMany({
      where: {
        visibility: TemplateVisibility.PUBLIC,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.category ? { category: query.category } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 100,
      include: {
        versions: {
          orderBy: { sequence: 'desc' },
          take: 1,
          select: versionSummary,
        },
      },
    });
    return rows.map(toDto);
  }

  async get(
    templateId: string,
    userId: string,
  ): Promise<TemplateDto & { forkCount: number }> {
    const t = await this.loadReadable(templateId, userId);
    const [latest, forkCount] = await Promise.all([
      this.prisma.templateVersion.findFirst({
        where: { templateId },
        orderBy: { sequence: 'desc' },
        select: versionSummary,
      }),
      this.prisma.template.count({ where: { sourceTemplateId: templateId } }),
    ]);
    return { ...toDto({ ...t, versions: latest ? [latest] : [] }), forkCount };
  }

  // ================================================================ edit / delete ========

  async updateMeta(
    templateId: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateDto> {
    const data: Prisma.TemplateUpdateInput = {};
    if (dto.name !== undefined) {
      if (dto.name.trim() === '')
        throw new UnprocessableEntityException({
          code: 'NAME_BLANK',
          message: 'The name must not be blank',
        });
      data.name = dto.name.trim();
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.visibility !== undefined) {
      const owner = await this.prisma.template.findUnique({
        where: { id: templateId },
        select: { ownerAccount: { select: { isSystem: true } } },
      });
      if (!owner) throw new NotFoundException('Template not found');
      this.assertVisibilityAllowed(owner.ownerAccount.isSystem, dto.visibility);
      data.visibility = dto.visibility;
    }
    try {
      const t = await this.prisma.template.update({
        where: { id: templateId },
        data,
        include: {
          versions: {
            orderBy: { sequence: 'desc' },
            take: 1,
            select: versionSummary,
          },
        },
      });
      return toDto(t);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025')
        throw new NotFoundException('Template not found');
      throw err;
    }
  }

  async delete(templateId: string): Promise<void> {
    const keys = await this.assets.keysOf(templateId);
    const r = await this.prisma.template.deleteMany({
      where: { id: templateId },
    });
    if (r.count === 0) throw new NotFoundException('Template not found');
    await this.assets.deleteObjects(keys); // rows went with the template; the objects are removed after the commit
  }

  // ================================================================ fork =================

  /**
   * A private copy owned by the CALLER'S account. Phase 3 forks inside one account only (the
   * marketplace, Phase 6, is what makes cross-account sources readable). The copy carries the
   * latest version's blueprint verbatim - same checksum - and remembers where it came from.
   */
  async fork(
    templateId: string,
    userId: string,
    accountId: string,
    name?: string,
  ): Promise<TemplateDto> {
    const source = await this.loadReadable(templateId, userId);
    // a PUBLIC template (a seed) may be forked into ANY account the caller can create in; everything
    // else only inside its own account (the marketplace, Phase 6, is what widens that)
    if (
      source.visibility !== TemplateVisibility.PUBLIC &&
      source.ownerAccountId !== accountId
    ) {
      throw new NotFoundException('Template not found'); // not readable from that account
    }
    const latest = await this.prisma.templateVersion.findFirst({
      where: { templateId },
      orderBy: { sequence: 'desc' },
      select: { id: true, blueprint: true },
    });
    if (!latest) throw new NotFoundException('Template has no versions');
    const id = randomUUID();
    const copied = await this.assets.copyAll(source.id, id);
    try {
      return await this.createFromBlueprint(
        accountId,
        userId,
        {
          blueprint: latest.blueprint as Record<string, unknown>,
          name: name?.trim() || `${source.name} (copy)`.slice(0, 120),
          description: source.description ?? undefined,
          category: source.category ?? undefined,
          tags: source.tags,
          visibility: TemplateVisibility.PRIVATE,
          changelog: `Forked from "${source.name}"`.slice(0, 2000),
        },
        { templateId: source.id, versionId: latest.id },
        { id, assets: copied },
      );
    } catch (err) {
      await this.assets.deleteObjects(copied.map((c) => c.storageKey));
      throw err;
    }
  }

  /** Where this template came from, nearest first. Ancestors you cannot read are shown as unavailable. */
  async lineage(templateId: string, userId: string) {
    const start = await this.loadReadable(templateId, userId);
    const chain: Array<
      | { id: string; name: string; versionId: string | null }
      | { unavailable: true }
    > = [];
    let next = start.sourceTemplateId;
    let versionId = start.sourceVersionId;
    for (let hops = 0; next && hops < 25; hops++) {
      const t = await this.prisma.template.findUnique({ where: { id: next } });
      if (!t) break; // deleted: the pointer was cleared by the database, so this is a race only
      if (!(await this.canRead(t, userId))) {
        chain.push({ unavailable: true });
        break;
      }
      chain.push({ id: t.id, name: t.name, versionId });
      next = t.sourceTemplateId;
      versionId = t.sourceVersionId;
    }
    return { template: { id: start.id, name: start.name }, ancestors: chain };
  }

  // ================================================================ helpers ==============

  /** Validates once; returns the blueprint and the data every new version row needs. */
  /** Validates and derives what a version row stores. Public for the editor's publish. */
  validated(input: unknown): {
    bp: BlueprintV1;
    version: ReturnType<typeof versionRow>;
  } {
    const r = validateBlueprint(input);
    if (r.ok === false) {
      throw new UnprocessableEntityException({
        code: 'BLUEPRINT_INVALID',
        message: 'The blueprint is not valid',
        issues: r.issues,
        truncated: r.truncated,
      });
    }
    return { bp: r.blueprint, version: versionRow(r.blueprint, r.stats) };
  }

  /** PUBLIC is reserved for the system account. Everything else is free to choose. */
  private assertVisibilityAllowed(
    ownerIsSystem: boolean,
    visibility: TemplateVisibility | undefined,
  ): void {
    if (visibility === TemplateVisibility.PUBLIC && !ownerIsSystem) {
      throw new ForbiddenException({
        code: 'PUBLIC_RESERVED',
        message: 'Public templates are published by the platform only',
      });
    }
  }

  private async lockAccount(tx: Db, accountId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`templates:${accountId}`}, 0))`;
  }

  private async assertQuota(tx: Db, accountId: string): Promise<void> {
    const allowed = await this.limits.checkLimit(
      'template',
      'createTemplate',
      { accountId },
      { db: tx },
    );
    if (!allowed) {
      throw new PlanLimitExceededException(
        'Your plan has reached its limit of private templates',
      );
    }
  }

  private async canRead(
    t: {
      ownerAccountId: string;
      createdById: string;
      visibility: TemplateVisibility;
    },
    userId: string,
  ): Promise<boolean> {
    if (t.visibility === TemplateVisibility.PUBLIC) return true; // any signed-in user; the controller has already authenticated
    const member = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId: t.ownerAccountId, userId } },
      select: { role: true },
    });
    if (!member) return false; // leaving the account ends access, even to what you made
    if (t.createdById === userId || ADMIN_ROLES.includes(member.role))
      return true;
    return (
      t.visibility === TemplateVisibility.ACCOUNT && member.role === Role.MEMBER
    );
  }

  private async loadReadable(templateId: string, userId: string) {
    const t = await this.prisma.template.findUnique({
      where: { id: templateId },
    });
    if (!t || !(await this.canRead(t, userId)))
      throw new NotFoundException('Template not found');
    return t;
  }
}
