import { BadRequestException, Injectable } from '@nestjs/common';
import { ImportJob } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { checkConfig, parseConfig } from './mapping.config';
import { InventoryError, parseInventory } from './mapping.inventory';
import { Resolution, resolve } from './mapping.resolve';
import {
  AttentionItem,
  ConfigProblem,
  EMPTY_CONFIG,
  MappingConfigV1,
  MappingContext,
  MappingInventory,
  MappingSuggestions,
} from './mapping.types';

/** What the Map step shows: the saved overrides, what the engine would do, and what to look at. Serialisable. */
export interface MappingView {
  mappingConfig: MappingConfigV1;
  hasInventory: boolean;
  suggestions: MappingSuggestions | null;
  effective: {
    projects: Array<{ externalId: string; name: string }>;
    statuses: Array<{ statusExternalId: string; projectExternalId: string; name: string; category: string; excludeFromProgress: boolean; mergedInto: string | null }>;
    priorities: Array<{ key: string; priority: string | null }>;
    users: Array<{ externalId: string; name: string; target: unknown }>;
    issueTypes: Array<{ externalId: string; name: string; target: unknown; level: string }>;
    customFields: Array<{ externalId: string; name: string; dataType: string; target: unknown }>;
  } | null;
  attention: AttentionItem[];
  /** Saved rows that do not apply to the current selection (they are ignored, not lost: re-select and they apply again). */
  stale: number;
}

type JobRef = Pick<ImportJob, 'id' | 'connectionId' | 'workspaceId' | 'createdById' | 'mappingConfig' | 'inventory'>;

/**
 * Step 4.3. The database side of the mapping engine: builds the workspace context (who may be assigned, what already exists),
 * stores / reads the inventory and the saved overrides, and validates a config before it is saved. All decisions are the
 * pure engine's (mapping.*.ts); this class only fetches facts and enforces authority.
 */
@Injectable()
export class MappingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Who and what the engine may target. Members = the target workspace's account members plus accepted collaborators:
   * nobody outside it can ever be assigned work or credited with a comment by an import.
   */
  async context(job: Pick<JobRef, 'connectionId' | 'workspaceId' | 'createdById'>): Promise<MappingContext> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: job.workspaceId }, select: { accountId: true } });
    const [accountMembers, collaborators, links, issueTypes, customFields] = await Promise.all([
      this.prisma.accountMember.findMany({ where: { accountId: workspace.accountId }, select: { user: { select: { id: true, name: true, email: true, emailVerified: true } } } }),
      this.prisma.workspaceCollaborator.findMany({ where: { workspaceId: job.workspaceId, acceptedAt: { not: null } }, select: { invitedUser: { select: { id: true, name: true, email: true, emailVerified: true } } } }),
      this.prisma.identityLink.findMany({ where: { connectionId: job.connectionId, userId: { not: null } }, select: { externalUserId: true, userId: true } }),
      this.prisma.issueType.findMany({ where: { workspaceId: job.workspaceId }, select: { id: true, name: true, level: true } }),
      this.prisma.customField.findMany({ where: { workspaceId: job.workspaceId }, select: { id: true, name: true, dataType: true } }),
    ]);
    const members = new Map<string, MappingContext['members'][number]>();
    for (const u of [...accountMembers.map((m) => m.user), ...collaborators.map((c) => c.invitedUser)]) {
      members.set(u.id, { userId: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified });
    }
    return {
      importerUserId: job.createdById,
      members: [...members.values()],
      identityLinks: links.map((l) => ({ externalUserId: l.externalUserId, userId: l.userId as string })),
      issueTypes,
      customFields,
    };
  }

  /** The stored inventory, re-checked (it is data we persisted from an adapter). null = none stored / unusable. */
  inventoryOf(job: Pick<JobRef, 'inventory'>): MappingInventory | null {
    if (job.inventory === null || job.inventory === undefined) return null;
    try {
      return parseInventory(job.inventory);
    } catch {
      return null;
    }
  }

  /** The job's saved overrides; a stored config that no longer parses counts as "none" (never an exception on read). */
  savedConfig(job: Pick<JobRef, 'mappingConfig'>): MappingConfigV1 {
    const r = parseConfig(job.mappingConfig);
    return 'problems' in r ? { ...EMPTY_CONFIG } : r.config;
  }

  /** Validates a config the person is saving. Throws a 400 listing every problem. Returns the normalised config. */
  async validateForSave(job: JobRef, raw: unknown): Promise<MappingConfigV1> {
    const parsed = parseConfig(raw);
    if ('problems' in parsed) throw this.reject(parsed.problems);
    const problems = checkConfig(parsed.config, this.inventoryOf(job), await this.context(job));
    if (problems.length > 0) throw this.reject(problems);
    return parsed.config;
  }

  async resolution(job: JobRef, inventory: MappingInventory | null = this.inventoryOf(job)): Promise<Resolution | null> {
    if (!inventory) return null;
    return resolve(inventory, await this.context(job), this.savedConfig(job));
  }

  async view(job: JobRef): Promise<MappingView> {
    const config = this.savedConfig(job);
    const res = await this.resolution(job);
    if (!res) return { mappingConfig: config, hasInventory: false, suggestions: null, effective: null, attention: [], stale: 0 };
    const r = res.resolved;
    return {
      mappingConfig: config,
      hasInventory: true,
      suggestions: res.suggestions,
      effective: {
        projects: [...r.projects].map(([externalId, v]) => ({ externalId, name: v.name })),
        statuses: [...r.statuses.values()].map((s) => ({ statusExternalId: s.statusExternalId, projectExternalId: s.projectExternalId, name: s.name, category: s.category, excludeFromProgress: s.excludeFromProgress, mergedInto: s.rootExternalId === s.statusExternalId ? null : s.rootExternalId })),
        priorities: [...r.priorities].map(([key, priority]) => ({ key, priority })),
        users: [...r.users].map(([externalId, v]) => ({ externalId, name: v.name, target: v.target })),
        issueTypes: [...r.issueTypes].map(([externalId, v]) => ({ externalId, name: v.name, target: v.target, level: v.level })),
        customFields: [...r.customFields].map(([externalId, v]) => ({ externalId, name: v.name, dataType: v.dataType, target: v.target })),
      },
      attention: res.attention,
      stale: res.attention.filter((a) => a.code === 'CONFIG_ROW_IGNORED').length,
    };
  }

  /** For the executor (step 4.4): the resolved mapping as of now. null = the job has no inventory (nothing can be mapped). */
  async resolveForRun(job: JobRef) {
    return (await this.resolution(job))?.resolved ?? null;
  }

  /** Source people nobody matched or chose (not bots, not decided by a person): the preview report's list. External ids, capped. */
  unmappedUsers(res: Resolution): string[] {
    const out: string[] = [];
    for (const [id, u] of res.resolved.users) if (u.target.kind === 'importer' && !u.isBot && !u.decided) out.push(id);
    return out.slice(0, 200);
  }

  private reject(problems: ConfigProblem[]): BadRequestException {
    return new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: `The mapping has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0].message}`,
      problems: problems.slice(0, 50),
    });
  }
}

export { InventoryError };
