import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountType, PlanKey, Role, TemplateVisibility } from '@prisma/client';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../../attachments/storage/storage-provider.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { templateAssetKey } from '../assets/asset.policy';
import {
  StagedAsset,
  TemplateAssetsService,
} from '../assets/template-assets.service';
import { TemplatesService } from '../templates.service';
import { SEED_DEFINITIONS } from './definitions';
import { PreparedSeed, prepareSeed } from './seed.prepare';
import { SeedDefinition, SeedReport, SeedResult } from './seed.types';
import { randomUUID } from 'crypto';

/** Never receives mail (RFC 2606 reserves .invalid) and has no password or Google id: nobody can sign in as it. */
export const SYSTEM_USER_EMAIL = 'system@templates.invalid';
const SYSTEM_USERNAME = 'templates-system';

/**
 * Step 3.9. Publishes the first-party templates under the system account. Safe to run any number
 * of times, from any number of instances at once:
 *
 *   - the whole run holds one advisory lock;
 *   - a seed is found by its `seedKey`, never by name;
 *   - same checksum as the latest version  -> nothing is written;
 *   - different checksum                   -> a NEW version through `addVersionInTx` (the normal path:
 *     immutable versions, semver, file checks). A published version is never touched;
 *   - the envelope (name, description, category, tags, visibility) is re-synced from the definition.
 *
 * Every definition is prepared (validated, files checked) BEFORE anything is written, so a broken
 * definition fails the run with nothing half-done.
 */
@Injectable()
export class TemplateSeedService {
  private readonly logger = new Logger(TemplateSeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly assets: TemplateAssetsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async seedAll(
    definitions: SeedDefinition[] = SEED_DEFINITIONS,
  ): Promise<SeedReport> {
    const prepared = definitions.map(prepareSeed);
    const bad = prepared.filter(
      (p): p is Extract<PreparedSeed, { ok: false }> => p.ok === false,
    );
    if (bad.length > 0) {
      throw new Error(
        `Seed definitions are invalid: ${bad.map((b) => `${b.seedKey}: ${b.problems.join('; ')}`).join(' | ')}`,
      );
    }
    const keys = definitions.map((d) => d.seedKey);
    if (new Set(keys).size !== keys.length)
      throw new Error('Seed definitions: a seedKey is used twice');

    return this.prisma.$transaction(
      async (lock) => {
        await lock.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'template-seeds'}, 0))`;
        const system = await this.ensureSystemAccount();
        const results: SeedResult[] = [];
        for (let i = 0; i < definitions.length; i++) {
          results.push(
            await this.ensureSeed(
              system.accountId,
              system.userId,
              definitions[i],
              prepared[i] as Extract<PreparedSeed, { ok: true }>,
            ),
          );
        }
        this.logger.log(
          `Seeded templates: ${results.map((r) => `${r.seedKey}=${r.action}@${r.semver}`).join(', ')}`,
        );
        return {
          systemAccountId: system.accountId,
          systemAccountCreated: system.created,
          results,
        };
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }

  // ------------------------------------------------------------------ system account ------------

  /** The one system account and its (unusable-login) owner. Called under the seed lock. */
  private async ensureSystemAccount(): Promise<{
    accountId: string;
    userId: string;
    created: boolean;
  }> {
    const existing = await this.prisma.account.findFirst({
      where: { isSystem: true },
      select: { id: true, personalOwnerId: true },
    });
    if (existing?.personalOwnerId)
      return {
        accountId: existing.id,
        userId: existing.personalOwnerId,
        created: false,
      };
    if (existing)
      throw new Error(
        'The system account has no owner user; repair it by hand',
      );

    return this.prisma.$transaction(async (tx) => {
      const user =
        (await tx.user.findUnique({
          where: { email: SYSTEM_USER_EMAIL },
          select: { id: true },
        })) ??
        (await tx.user.create({
          data: {
            email: SYSTEM_USER_EMAIL,
            username: SYSTEM_USERNAME,
            name: 'First-party templates',
            emailVerified: true,
          },
          select: { id: true },
        }));
      const account = await tx.account.create({
        data: {
          type: AccountType.PERSONAL,
          planType: PlanKey.FREE_PERSONAL,
          isSystem: true,
          personalOwnerId: user.id,
        },
        select: { id: true },
      });
      await tx.accountMember.create({
        data: { accountId: account.id, userId: user.id, role: Role.OWNER },
      });
      return { accountId: account.id, userId: user.id, created: true };
    });
  }

  // ------------------------------------------------------------------ one seed ------------------

  private async ensureSeed(
    accountId: string,
    userId: string,
    def: SeedDefinition,
    prep: Extract<PreparedSeed, { ok: true }>,
  ): Promise<SeedResult> {
    const existing = await this.prisma.template.findUnique({
      where: { seedKey: def.seedKey },
      select: {
        id: true,
        ownerAccountId: true,
        name: true,
        description: true,
        category: true,
        tags: true,
        visibility: true,
      },
    });
    const meta = prep.blueprint.meta;
    const envelope = {
      name: meta.name.trim(),
      description: meta.description ?? null,
      category: meta.category ?? null,
      tags: def.tags,
      visibility: TemplateVisibility.PUBLIC,
    };

    if (!existing) {
      const id = randomUUID();
      const staged = await this.storeNewFiles(id, prep);
      try {
        const created = await this.templates.createFromBlueprint(
          accountId,
          userId,
          {
            blueprint: prep.blueprint as unknown as Record<string, unknown>,
            name: envelope.name,
            description: envelope.description ?? undefined,
            category: envelope.category ?? undefined,
            tags: envelope.tags,
            visibility: TemplateVisibility.PUBLIC,
            changelog: def.initialChangelog ?? 'First release.',
          },
          undefined,
          { id, assets: staged, seedKey: def.seedKey },
        );
        return {
          seedKey: def.seedKey,
          templateId: created.id,
          action: 'created',
          semver: created.latestVersion?.semver ?? '1.0.0',
          checksum: prep.checksum,
          metaUpdated: false,
        };
      } catch (err) {
        await Promise.all(
          staged.map((s) =>
            this.storage.deleteObject(s.storageKey).catch(() => undefined),
          ),
        );
        throw err;
      }
    }

    if (existing.ownerAccountId !== accountId) {
      throw new Error(
        `Template with seedKey "${def.seedKey}" exists but is not owned by the system account`,
      );
    }

    // Is the latest published version already this one?
    const latest = await this.prisma.templateVersion.findFirst({
      where: { templateId: existing.id },
      orderBy: { sequence: 'desc' },
      select: { semver: true, checksum: true },
    });
    let action: SeedResult['action'] = 'unchanged';
    let semver = latest?.semver ?? '1.0.0';
    if (!latest || latest.checksum !== prep.checksum) {
      // files first through the normal upload path (policy, caps, same bytes = same row), then the normal version path
      for (const f of prep.files)
        await this.assets.upload(existing.id, userId, {
          fileName: f.fileName,
          mimeType: f.mimeType,
          bytes: f.bytes,
        });
      const { bp, version } = this.templates.validated(prep.blueprint);
      const v = await this.prisma.$transaction((tx) =>
        this.templates.addVersionInTx(tx, existing.id, userId, bp, version, {
          bump: def.bump ?? 'minor',
          changelog: def.changelog,
        }),
      );
      action = 'versioned';
      semver = v.semver;
    }

    const metaUpdated =
      existing.name !== envelope.name ||
      existing.description !== envelope.description ||
      existing.category !== envelope.category ||
      existing.visibility !== envelope.visibility ||
      existing.tags.join('\u0000') !== envelope.tags.join('\u0000');
    if (metaUpdated) {
      await this.prisma.template.update({
        where: { id: existing.id },
        data: envelope,
      });
    }
    return {
      seedKey: def.seedKey,
      templateId: existing.id,
      action,
      semver,
      checksum: prep.checksum,
      metaUpdated,
    };
  }

  /** For a NEW template: stores the objects (the rows are written by `createFromBlueprint`, in its transaction). */
  private async storeNewFiles(
    templateId: string,
    prep: Extract<PreparedSeed, { ok: true }>,
  ): Promise<StagedAsset[]> {
    const out: StagedAsset[] = [];
    for (const f of prep.files) {
      const storageKey = templateAssetKey(templateId, f.sha256);
      await this.storage.putObject(storageKey, f.bytes, f.mimeType);
      out.push({
        sha256: f.sha256,
        fileName: f.fileName,
        mimeType: f.mimeType,
        sizeBytes: f.bytes.length,
        storageKey,
      });
    }
    return out;
  }
}
