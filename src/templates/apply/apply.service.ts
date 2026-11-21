import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AttachmentStatus,
  AttachmentableType,
  AutomationOrigin,
  CreationMode,
  Prisma,
  SavedViewLayout,
  TemplateInstallAction,
  TemplateInstallMode,
  TemplateInstallStatus,
} from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PlanLimitsService } from '../../access-control/plan-limits.service';
import { getPlanLimits } from '../../common/config/billing-tiers.config';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { WriteContext } from '../../domain-writer/write-context';
import { randomUUID } from 'crypto';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../../attachments/storage/storage-provider.interface';
import { PrismaService } from '../../prisma/prisma.service';
import {
  installAttachmentPrefix,
  reservationTarget,
} from '../assets/asset.policy';
import { SeedDefinition } from '../../projects-tasks/workflow/workflow.service';
import { BlueprintAsset, BlueprintV1, foldName } from '../blueprint';
import { ApplyTemplateDto } from '../dto/apply.dto';
import {
  resolveBlueprint,
  ResolvedBlueprint,
  ResolvedProject,
  ResolvedTask,
} from '../resolve';
import { TemplatesService } from '../templates.service';
import { planPortable, RealIds } from './apply.portable';
import { buildApplyPlan } from './apply.planner';
import {
  ApplyPlan,
  flattenTasks,
  LimitState,
  WorkspaceState,
} from './apply.types';

const SLICE = 100; // tasks per transaction (ADR-0003 decision 8)
const TX_TIMEOUT_MS = 120_000;
const dateOnly = (iso?: string) =>
  iso ? new Date(`${iso}T00:00:00.000Z`) : null;

export interface ApplyOptions {
  /** "YYYY-MM-DD"; the anchor falls back to it. Injected so tests and replays are exact. */
  today?: string;
  /** Build and return the plan; write nothing. */
  dryRun?: boolean;
}

export type ApplyOutcome =
  | { dryRun: true; plan: ApplyPlan }
  | {
      dryRun: false;
      installId: string;
      plan: ApplyPlan;
      report: Record<string, unknown>;
    };

type Reserved = { id: string; storageKey: string };
const reservedKey = (project: string, task: string, asset: string) =>
  `${project}|${task}|${asset}`;
type ItemRow = {
  entityType: string;
  entityId: string;
  nodeKey?: string;
  action: TemplateInstallAction;
};

/**
 * Step 3.6. Applies a template version to a workspace.
 *
 *  1. resolve (3.2) with the person's answers   2. plan (merge rules + limit preflight, no writes)
 *  3. blockers -> refuse   4. execute in CHUNKS via DomainWriter (tx 1: definitions + projects;
 *     then tasks 100 per transaction, parents first; then dependencies)   5. record every entity
 *     in TemplateInstallItem as it is created   6. one TEMPLATE_APPLIED summary.
 *
 * Why chunks and not one transaction: a task write holds the workspace's task-number row lock
 * for its whole transaction (ADR-0004). One transaction for 5 000 tasks would freeze every other
 * task write in a live workspace for the duration. If a chunk fails, everything created so far
 * is compensated (deleted) and the install is marked FAILED - the workspace is left as it was.
 */
@Injectable()
export class TemplateApplyService {
  private readonly logger = new Logger(TemplateApplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly writer: DomainWriter,
    private readonly resolver: PermissionResolver,
    private readonly limits: PlanLimitsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ================================================================ preview / apply ======

  preview(
    userId: string,
    templateId: string,
    dto: ApplyTemplateDto,
    opts: ApplyOptions = {},
  ) {
    return this.run(userId, templateId, dto, { ...opts, dryRun: true });
  }

  apply(
    userId: string,
    templateId: string,
    dto: ApplyTemplateDto,
    opts: ApplyOptions = {},
  ) {
    return this.run(userId, templateId, dto, { ...opts, dryRun: false });
  }

  private async run(
    userId: string,
    templateId: string,
    dto: ApplyTemplateDto,
    opts: ApplyOptions,
  ): Promise<ApplyOutcome> {
    // readable-by-the-caller, 404 otherwise
    const version = await this.templates.getVersion(
      templateId,
      dto.version ?? 'latest',
      userId,
    );
    const template = await this.prisma.template.findUniqueOrThrow({
      where: { id: templateId },
      select: { name: true },
    });
    const blueprint = version.blueprint as unknown as BlueprintV1;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: dto.workspaceId },
      select: { id: true, accountId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // Only people the apply may assign: those with real access to THIS workspace.
    const eligible = await this.eligibleUsers(dto.roles, workspace.id);
    const resolution = resolveBlueprint(blueprint, {
      variables: dto.variables,
      modules: dto.modules,
      roles: dto.roles,
      eligibleUserIds: eligible,
      today: opts.today ?? new Date().toISOString().slice(0, 10),
    });
    if (resolution.ok === false) {
      throw new UnprocessableEntityException({
        code: 'APPLY_INPUT_INVALID',
        message: 'The answers do not fit this template',
        issues: resolution.issues,
      });
    }
    const resolved = resolution.resolved;

    const mode: TemplateInstallMode =
      dto.mode === 'NEW_WORKSPACE'
        ? TemplateInstallMode.NEW_WORKSPACE
        : TemplateInstallMode.MERGE;
    const state = await this.loadState(this.prisma, workspace.id, userId);
    const limits = await this.loadLimits(
      workspace.accountId,
      workspace.id,
      resolved,
      templateId,
    );
    const plan = buildApplyPlan(
      resolved,
      { mode, kind: blueprint.meta.kind },
      state,
      limits,
    );

    if (opts.dryRun) return { dryRun: true, plan };
    if (plan.blockers.length > 0) {
      throw new ConflictException({
        code: 'APPLY_BLOCKED',
        message: 'This template cannot be applied here as it is',
        plan,
      });
    }

    const install = await this.createInstall({
      workspace,
      userId,
      mode,
      dto,
      version: {
        id: version.id,
        semver: version.semver,
        checksum: version.checksum,
      },
      templateName: template.name,
    });
    const started = Date.now();
    try {
      const reserved = await this.reserveStorage(
        install.id,
        workspace.accountId,
        userId,
        resolved,
      );
      const report = await this.execute(
        install.id,
        workspace,
        userId,
        resolved,
        plan,
        reserved,
        templateId,
      );
      await this.releaseReservations(install.id, workspace.accountId); // anything reserved but not used
      const finished = new Date();
      const full = {
        ...report,
        warnings: plan.warnings,
        durationMs: Date.now() - started,
      };
      await this.prisma.templateInstall.update({
        where: { id: install.id },
        data: {
          status: TemplateInstallStatus.APPLIED,
          finishedAt: finished,
          report: full as unknown as Prisma.InputJsonValue,
        },
      });
      await this.writer.recordJobSummary({
        actorId: userId,
        accountId: workspace.accountId,
        action: 'TEMPLATE_APPLIED',
        metadata: {
          installId: install.id,
          templateName: template.name,
          workspaceId: workspace.id,
          counts: plan.counts,
        } as Prisma.InputJsonValue,
      });
      return { dryRun: false, installId: install.id, plan, report: full };
    } catch (err) {
      await this.failInstall(install.id, err);
      throw err;
    }
  }

  // ================================================================ execution ============

  private async execute(
    installId: string,
    ws: { id: string; accountId: string },
    userId: string,
    resolved: ResolvedBlueprint,
    plan: ApplyPlan,
    reserved: Map<string, Reserved>,
    templateId: string,
  ): Promise<Record<string, unknown>> {
    const ctx: WriteContext = {
      origin: CreationMode.TEMPLATE,
      actorId: userId,
      silent: true,
      importJobId: installId,
    };
    const items: ItemRow[] = [];
    const flush = async () => {
      if (items.length === 0) return;
      await this.prisma.templateInstallItem.createMany({
        data: items.splice(0).map((i) => ({ installId, ...i })),
        skipDuplicates: true,
      });
    };

    // ---------- tx 1: definitions, projects, iterations ----------------------------------
    const tagId = new Map<string, string>(); // folded name -> id
    const typeId = new Map<string, string>();
    const field = new Map<
      string,
      { id: string; dataType: string; options?: string[] } | null
    >(); // key(lower) -> field | null (skipped)
    const projectId = new Map<string, string>(); // nodeKey -> id
    const statusId = new Map<string, Map<string, string>>(); // project nodeKey -> status key -> id
    const iterationId = new Map<string, string>();

    await this.writer.run(
      ctx,
      async (c) => {
        const tx = c.tx as Prisma.TransactionClient;
        for (const t of plan.tags) {
          if (t.action === 'REUSE') {
            tagId.set(foldName(t.name), t.existingId!);
            items.push({
              entityType: 'TAG',
              entityId: t.existingId!,
              action: 'REUSED',
            });
          } else {
            const name = t.name.replace(/\s+/g, ' ').trim();
            const row = await tx.tag.create({
              data: { workspaceId: ws.id, name, nameKey: foldName(name) },
            });
            tagId.set(foldName(t.name), row.id);
            items.push({
              entityType: 'TAG',
              entityId: row.id,
              action: 'CREATED',
            });
          }
        }
        for (const f of plan.customFields) {
          if (f.action === 'SKIP') {
            field.set(f.key.toLowerCase(), null);
            items.push({
              entityType: 'CUSTOM_FIELD',
              entityId: f.existingId!,
              nodeKey: f.key,
              action: 'SKIPPED',
            });
          } else if (f.action === 'REUSE') {
            field.set(f.key.toLowerCase(), {
              id: f.existingId!,
              dataType: f.dataType,
              options: f.existingOptions,
            });
            items.push({
              entityType: 'CUSTOM_FIELD',
              entityId: f.existingId!,
              nodeKey: f.key,
              action: 'REUSED',
            });
          } else {
            const row = await this.writer.createCustomField(
              ws.id,
              {
                key: f.key,
                name: f.name,
                dataType: f.dataType,
                options: f.options,
                order: f.order,
              },
              c,
            );
            field.set(f.key.toLowerCase(), {
              id: row.id,
              dataType: f.dataType,
              options: f.options,
            });
            items.push({
              entityType: 'CUSTOM_FIELD',
              entityId: row.id,
              nodeKey: f.key,
              action: 'CREATED',
            });
          }
        }
        const typeDefs = new Map(
          resolved.workspace.issueTypes.map((t) => [foldName(t.name), t]),
        );
        for (const t of plan.issueTypes) {
          if (t.action === 'REUSE') {
            typeId.set(foldName(t.name), t.existingId!);
            items.push({
              entityType: 'ISSUE_TYPE',
              entityId: t.existingId!,
              action: 'REUSED',
            });
          } else {
            const def = typeDefs.get(foldName(t.name))!;
            const name = t.name.replace(/\s+/g, ' ').trim();
            const row = await tx.issueType.create({
              data: {
                workspaceId: ws.id,
                name,
                nameKey: foldName(name),
                icon: def.icon,
                color: def.color,
                level: def.level,
              },
            });
            typeId.set(foldName(t.name), row.id);
            items.push({
              entityType: 'ISSUE_TYPE',
              entityId: row.id,
              action: 'CREATED',
            });
          }
        }
        for (const [i, p] of resolved.projects.entries()) {
          const planned = plan.projects[i];
          const created = await this.writer.createProject(
            {
              workspaceId: ws.id,
              name: planned.name,
              description: p.description,
            },
            userId,
            c,
            undefined,
            p.workflow ? this.workflowExtras(p) : undefined,
          );
          projectId.set(p.nodeKey, created.id);
          items.push({
            entityType: 'PROJECT',
            entityId: created.id,
            nodeKey: p.nodeKey,
            action: 'CREATED',
          });
          const rows = await tx.workflowStatus.findMany({
            where: { projectId: created.id },
            orderBy: { position: 'asc' },
            select: { id: true },
          });
          const byKey = new Map<string, string>();
          (p.workflow?.statuses ?? []).forEach((s, idx) =>
            byKey.set(s.key, rows[idx].id),
          );
          statusId.set(p.nodeKey, byKey);
        }
        for (const it of resolved.workspace.iterations) {
          const row = await tx.iteration.create({
            data: {
              workspaceId: ws.id,
              projectId: it.project
                ? (projectId.get(it.project) ?? null)
                : null,
              kind: it.kind,
              name: it.name,
              goal: it.goal,
              startDate: dateOnly(it.startDate),
              endDate: dateOnly(it.endDate),
            },
          });
          iterationId.set(it.nodeKey, row.id);
          items.push({
            entityType: 'ITERATION',
            entityId: row.id,
            nodeKey: it.nodeKey,
            action: 'CREATED',
          });
        }
        await tx.templateInstallItem.createMany({
          data: items.splice(0).map((i) => ({ installId, ...i })),
          skipDuplicates: true,
        });
      },
      { timeoutMs: TX_TIMEOUT_MS },
    );

    // ---------- tasks: 100 per transaction, parents before children ----------------------
    let tasks = 0;
    let comments = 0;
    let dependencies = 0;
    let droppedValues = 0;
    let attachments = 0;
    const assetShaByKey = new Map(
      resolved.assets.map((x) => [x.key, x.sha256]),
    );
    const storeRows =
      reserved.size > 0
        ? await this.prisma.templateAsset.findMany({
            where: { templateId },
            select: { sha256: true, storageKey: true },
          })
        : [];
    const storeKeyBySha = new Map(
      storeRows.map((r) => [r.sha256, r.storageKey]),
    );
    for (const p of resolved.projects) {
      const pid = projectId.get(p.nodeKey)!;
      const flat: Array<{ task: ResolvedTask; parent: number | undefined }> =
        [];
      const walk = (list: ResolvedTask[], parent: number | undefined) => {
        for (const t of list) {
          const idx = flat.push({ task: t, parent }) - 1;
          walk(t.children, idx);
        }
      };
      walk(p.tasks, undefined);
      const idOf: string[] = [];
      for (let a = 0; a < flat.length; a += SLICE) {
        const slice = flat.slice(a, a + SLICE);
        const bulk = slice.map(({ task: t, parent }) => ({
          projectId: pid,
          title: t.title,
          description: t.description,
          workflowStatusId: t.status
            ? statusId.get(p.nodeKey)?.get(t.status)
            : undefined,
          issueTypeId: t.issueType
            ? typeId.get(foldName(t.issueType))
            : undefined,
          iterationId: t.iteration ? iterationId.get(t.iteration) : undefined,
          priority: t.priority,
          estimate: t.estimate,
          startDate: t.startDate,
          dueDate: t.dueDate,
          assigneeIds: t.assigneeUserIds,
          ...(parent === undefined
            ? {}
            : parent >= a
              ? { parentIndex: parent - a }
              : { parentId: idOf[parent] }),
        }));
        const created = await this.writer.createTasksBulk(
          ws.id,
          bulk,
          userId,
          ctx,
          { chunkSize: SLICE + 1, timeoutMs: TX_TIMEOUT_MS },
        );
        created.createdIds.forEach((id, n) => {
          idOf[a + n] = id;
        });
        items.push(
          ...created.createdIds.map((id, n) => ({
            entityType: 'TASK',
            entityId: id,
            nodeKey: slice[n].task.nodeKey,
            action: 'CREATED' as const,
          })),
        );
        await flush();

        // Reference files of this slice: copy the bytes FIRST (outside any DB transaction), then
        // flip the reserved rows to CONFIRMED on the real task in the same transaction as the rest.
        const confirm: Array<{ id: string; taskId: string }> = [];
        const attachItems: ItemRow[] = [];
        for (const [n, { task: t }] of slice.entries()) {
          for (const assetKey of t.attachments) {
            const row = reserved.get(
              reservedKey(p.nodeKey, t.nodeKey, assetKey),
            );
            const from = storeKeyBySha.get(assetShaByKey.get(assetKey) ?? '');
            if (!row || !from) continue;
            await this.storage.copyObject(from, row.storageKey);
            confirm.push({ id: row.id, taskId: idOf[a + n] });
            attachItems.push({
              entityType: 'ATTACHMENT',
              entityId: row.id,
              nodeKey: `${t.nodeKey}/${assetKey}`,
              action: 'CREATED',
            });
          }
        }

        // tags, custom values and comments of this slice: one transaction
        await this.writer.run(
          ctx,
          async (c) => {
            const tx = c.tx as Prisma.TransactionClient;
            const tagRows: Array<{ taskId: string; tagId: string }> = [];
            const valueRows: Array<{
              taskId: string;
              fieldId: string;
              value: Prisma.InputJsonValue;
            }> = [];
            const commentRows: Array<{
              targetType: 'TASK';
              targetId: string;
              authorId: string;
              content: string;
            }> = [];
            slice.forEach(({ task: t }, n) => {
              const taskId = idOf[a + n];
              for (const name of t.tags) {
                const id = tagId.get(foldName(name));
                if (id) tagRows.push({ taskId, tagId: id });
              }
              for (const [key, value] of Object.entries(t.customValues)) {
                const f = field.get(key.toLowerCase());
                if (!f) {
                  droppedValues += 1;
                  continue;
                }
                if (
                  (f.dataType === 'SELECT' || f.dataType === 'MULTI_SELECT') &&
                  f.options
                ) {
                  const vs = Array.isArray(value) ? value : [value];
                  if (vs.some((v) => !f.options!.includes(v as string))) {
                    droppedValues += 1;
                    continue;
                  }
                }
                valueRows.push({
                  taskId,
                  fieldId: f.id,
                  value: value as Prisma.InputJsonValue,
                });
              }
              for (const cm of t.comments)
                commentRows.push({
                  targetType: 'TASK',
                  targetId: taskId,
                  authorId: userId,
                  content: cm.body,
                });
            });
            if (tagRows.length)
              await tx.taskTag.createMany({
                data: tagRows,
                skipDuplicates: true,
              });
            if (valueRows.length)
              await tx.taskCustomValue.createMany({
                data: valueRows,
                skipDuplicates: true,
              });
            if (commentRows.length)
              await tx.comment.createMany({ data: commentRows });
            comments += commentRows.length;
            if (confirm.length > 0) {
              await tx.$executeRaw`UPDATE attachments a SET target_id = v.task_id, status = 'CONFIRMED'::attachment_status, confirmed_at = now()
              FROM unnest(${confirm.map((x) => x.id)}::text[], ${confirm.map((x) => x.taskId)}::text[]) AS v(id, task_id)
              WHERE a.id = v.id AND a.status = 'PENDING'::attachment_status`;
            }
          },
          { timeoutMs: TX_TIMEOUT_MS },
        );
        if (attachItems.length > 0) {
          items.push(...attachItems);
          attachments += attachItems.length;
          await flush();
        }
      }
      tasks += flat.length;

      // dependencies, after every task of the project exists
      const idByKey = new Map(flat.map((f, i) => [f.task.nodeKey, idOf[i]]));
      const deps = p.dependencies.map((d) => ({
        blockingTaskId: idByKey.get(d.from)!,
        blockedTaskId: idByKey.get(d.to)!,
        type: d.type,
      }));
      for (let i = 0; i < deps.length; i += 1000) {
        await this.prisma.taskDependency.createMany({
          data: deps.slice(i, i + 1000),
          skipDuplicates: true,
        });
      }
      dependencies += deps.length;
    }

    // ---------- automations and saved views (step 5.5): the last stage, one transaction ------
    const portable = await this.createPortable(
      installId,
      ws,
      userId,
      resolved,
      plan,
      {
        tag: tagId,
        type: typeId,
        field,
        project: projectId,
        status: statusId,
        iteration: iterationId,
      },
    );

    return {
      tasks,
      comments,
      dependencies,
      droppedValues,
      attachments,
      projects: resolved.projects.length,
      automations: portable.automations,
      savedViews: portable.savedViews,
      portableSkipped: portable.skipped,
      counts: plan.counts,
    };
  }

  /**
   * Step 5.5. Creates the automations and saved views the template carries, bound to the ids this apply
   * just made or reused. Re-decided here against the workspace as it is NOW (under the workspace lock the
   * automation and view services also take), with the same pure pipeline the preview used:
   *   - automations are created OFF, always (createdVia TEMPLATE, by the person applying)
   *   - items that are not in the portable form are kept as inert imported rules
   *   - a view is shared only when the template wants it AND the person applying may share
   * If the workspace changed since the preview and a limit would now be exceeded, these extras are skipped
   * (counted in the report); the rest of the apply stands.
   */
  private async createPortable(
    installId: string,
    ws: { id: string },
    userId: string,
    resolved: ResolvedBlueprint,
    plan: ApplyPlan,
    real: RealIds,
  ): Promise<{ automations: number; savedViews: number; skipped: number }> {
    const hasAny = resolved.projects.some(
      (p) => p.automations.length > 0 || p.views.length > 0,
    );
    if (!hasAny) return { automations: 0, savedViews: 0, skipped: 0 };
    const key = (n: string) =>
      n.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ws.id} FOR UPDATE`;
        const state = await this.loadState(tx, ws.id, userId);
        const out = planPortable(resolved, plan, state, real);
        if (out.blockers.length > 0)
          return { automations: 0, savedViews: 0, skipped: out.work.length };

        const pos = {
          personal:
            ((
              await tx.savedView.aggregate({
                where: { workspaceId: ws.id, ownerId: userId, isShared: false },
                _max: { position: true },
              })
            )._max.position ?? -1) + 1,
          shared:
            ((
              await tx.savedView.aggregate({
                where: { workspaceId: ws.id, isShared: true },
                _max: { position: true },
              })
            )._max.position ?? -1) + 1,
        };
        const items: ItemRow[] = [];
        const seenViews = new Set<string>();
        let automations = 0;
        let savedViews = 0;
        for (const w of out.work) {
          const projectId = real.project.get(w.project)!;
          if (w.kind === 'view') {
            const dedupe = `${w.project}|${w.shared}|${key(w.name)}`;
            if (seenViews.has(dedupe)) continue;
            seenViews.add(dedupe);
            const row = await tx.savedView.create({
              data: {
                workspaceId: ws.id,
                projectId,
                ownerId: userId,
                name: w.name,
                nameKey: key(w.name),
                layout: w.layout as SavedViewLayout,
                config: w.config as unknown as Prisma.InputJsonValue,
                isShared: w.shared,
                position: Math.min(
                  w.shared ? pos.shared++ : pos.personal++,
                  100_000,
                ),
              },
              select: { id: true },
            });
            items.push({
              entityType: 'SAVED_VIEW',
              entityId: row.id,
              nodeKey: `${w.project}/${w.name}`,
              action: 'CREATED',
            });
            savedViews += 1;
          } else {
            const base = {
              workspaceId: ws.id,
              projectId,
              name: w.name,
              nameKey: key(w.name),
              enabled: false,
              createdVia: AutomationOrigin.TEMPLATE,
              createdById: userId,
            };
            const row = await tx.automation.create({
              data:
                w.kind === 'rule'
                  ? {
                      ...base,
                      ruleVersion: 1,
                      triggerType: w.triggerType,
                      trigger: w.rule
                        .trigger as unknown as Prisma.InputJsonValue,
                      conditions: w.rule
                        .conditions as unknown as Prisma.InputJsonValue,
                      actions: w.rule
                        .actions as unknown as Prisma.InputJsonValue,
                      unsupported:
                        w.unsupported as unknown as Prisma.InputJsonValue,
                    }
                  : {
                      ...base,
                      ruleVersion: 0,
                      triggerType: 'RAW',
                      trigger: {},
                      conditions: {},
                      actions: [],
                      sourceDefinition: w.item as Prisma.InputJsonValue,
                    },
              select: { id: true },
            });
            items.push({
              entityType: 'AUTOMATION',
              entityId: row.id,
              nodeKey: `${w.project}/${w.name}`,
              action: 'CREATED',
            });
            automations += 1;
          }
        }
        if (items.length > 0)
          await tx.templateInstallItem.createMany({
            data: items.map((i) => ({ installId, ...i })),
            skipDuplicates: true,
          });
        return {
          automations,
          savedViews,
          skipped: out.work.length - automations - savedViews,
        };
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  private workflowExtras(p: ResolvedProject) {
    const wf = p.workflow!;
    const index = new Map(wf.statuses.map((s, i) => [s.key, i]));
    const initial = wf.statuses.findIndex(
      (s) => s.category === 'TODO' && s.isDefault,
    );
    const statuses: SeedDefinition[] = wf.statuses.map((s, i) => ({
      name: s.name,
      color: s.color,
      category: s.category,
      excludeFromProgress: s.excludeFromProgress,
      isDefault: s.isDefault,
      isInitial: i === initial,
    }));
    return {
      workflow: {
        statuses,
        transitions: (wf.transitions ?? []).map((t) => ({
          from: index.get(t.from)!,
          to: index.get(t.to)!,
        })),
        enforceTransitions: wf.enforceTransitions,
      },
    };
  }

  // ================================================================ storage (step 3.7) ===

  /**
   * Reserves the storage the copies will take BEFORE any byte is copied: one PENDING attachment
   * row per copy, created under a per-account lock together with the limit check. The existing
   * storage sum already counts un-expired PENDING rows, so every other upload and every other
   * apply sees the reservation immediately; two applies cannot both take the last bytes.
   * A crash leaves PENDING rows that the 24 h abandoned-upload job removes.
   */
  private async reserveStorage(
    installId: string,
    accountId: string,
    userId: string,
    resolved: ResolvedBlueprint,
  ): Promise<Map<string, Reserved>> {
    const assetByKey = new Map(resolved.assets.map((x) => [x.key, x]));
    const wanted: Array<{ key: string; a: BlueprintAsset }> = [];
    for (const p of resolved.projects) {
      for (const t of flattenTasks(p.tasks)) {
        for (const k of t.attachments) {
          const a = assetByKey.get(k);
          if (a) wanted.push({ key: reservedKey(p.nodeKey, t.nodeKey, k), a });
        }
      }
    }
    const out = new Map<string, Reserved>();
    if (wanted.length === 0) return out;
    const total = wanted.reduce((n, w) => n + w.a.sizeBytes, 0);
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { planType: true },
    });
    const plan = getPlanLimits(account.planType);
    const limitBytes = plan.storageGB * 1024 * 1024 * 1024;

    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`storage:${accountId}`}, 0))`;
        const used = await this.usedBytes(tx, accountId);
        if (used + total > limitBytes) {
          throw new ConflictException({
            code: 'STORAGE_LIMIT',
            message: "This apply would exceed your plan's storage limit",
          });
        }
        const rows = wanted.map((w) => {
          const id = randomUUID();
          const safe = w.a.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const row: Reserved = {
            id,
            storageKey: `${installAttachmentPrefix(accountId, installId)}${randomUUID()}-${safe}`,
          };
          out.set(w.key, row);
          return {
            id,
            accountId,
            targetType: AttachmentableType.TASK,
            targetId: reservationTarget(installId),
            uploadedById: userId,
            filename: w.a.fileName,
            mimeType: w.a.mimeType,
            sizeBytes: w.a.sizeBytes,
            storageKey: row.storageKey,
            status: AttachmentStatus.PENDING,
          };
        });
        for (let i = 0; i < rows.length; i += 1000)
          await tx.attachment.createMany({ data: rows.slice(i, i + 1000) });
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
    );
    return out;
  }

  /** Same formula as the upload route: CONFIRMED plus PENDING that has not expired. */
  private async usedBytes(
    db: Prisma.TransactionClient | PrismaService,
    accountId: string,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sum = await db.attachment.aggregate({
      where: {
        accountId,
        OR: [
          { status: AttachmentStatus.CONFIRMED },
          { status: AttachmentStatus.PENDING, createdAt: { gte: cutoff } },
        ],
      },
      _sum: { sizeBytes: true },
    });
    return sum._sum.sizeBytes ?? 0;
  }

  /** Gives back what an install reserved and did not turn into a confirmed attachment (rows and any copied object). */
  private async releaseReservations(
    installId: string,
    accountId: string,
  ): Promise<void> {
    const left = await this.prisma.attachment.findMany({
      where: {
        accountId,
        status: AttachmentStatus.PENDING,
        targetId: reservationTarget(installId),
      },
      select: { id: true, storageKey: true },
    });
    if (left.length === 0) return;
    await this.prisma.attachment.deleteMany({
      where: { id: { in: left.map((l) => l.id) } },
    });
    await this.deleteObjects(left.map((l) => l.storageKey));
  }

  private async deleteObjects(keys: string[]): Promise<void> {
    for (const k of keys) {
      try {
        await this.storage.deleteObject(k);
      } catch (err) {
        this.logger.warn(
          `could not delete ${k}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // ================================================================ failure ==============

  private async failInstall(installId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    try {
      // nothing can have been edited yet: mark the apply finished NOW, then compensate
      await this.prisma.templateInstall.update({
        where: { id: installId },
        data: {
          status: TemplateInstallStatus.FAILED,
          finishedAt: new Date(),
          report: { error: message.slice(0, 500) },
        },
      });
      await this.undoCore(installId, {
        confirmEdited: true,
        compensation: true,
      });
      const owner = await this.prisma.templateInstall.findUnique({
        where: { id: installId },
        select: { accountId: true },
      });
      if (owner) await this.releaseReservations(installId, owner.accountId);
      await this.prisma.templateInstall.update({
        where: { id: installId },
        data: { report: { error: message.slice(0, 500), compensated: true } },
      });
    } catch (inner) {
      // quota must come back even when the rest of the cleanup did not work
      const owner = await this.prisma.templateInstall
        .findUnique({ where: { id: installId }, select: { accountId: true } })
        .catch(() => null);
      if (owner)
        await this.releaseReservations(installId, owner.accountId).catch(
          () => undefined,
        );
      this.logger.error(
        `apply ${installId} failed AND its cleanup failed: ${inner instanceof Error ? inner.message : inner}`,
      );
      await this.prisma.templateInstall
        .update({
          where: { id: installId },
          data: {
            report: { error: message.slice(0, 500), compensated: false },
          },
        })
        .catch(() => undefined);
    }
  }

  // ================================================================ undo =================

  /** `confirmEdited` previews the "also delete what I edited" choice; the default previews the safe one. */
  async previewUndo(
    userId: string,
    installId: string,
    opts: { confirmEdited?: boolean } = {},
  ) {
    await this.loadInstallFor(userId, installId);
    return this.undoCore(installId, {
      confirmEdited: opts.confirmEdited === true,
      dryRun: true,
    });
  }

  async undo(
    userId: string,
    installId: string,
    opts: { confirmEdited?: boolean } = {},
  ) {
    await this.loadInstallFor(userId, installId);
    return this.undoCore(installId, {
      confirmEdited: opts.confirmEdited === true,
    });
  }

  /**
   * Deletes what the install created and NOBODY ELSE depends on. Per entity:
   *   untouched  - deleted
   *   edited     - changed since the apply; deleted only with `confirmEdited`
   *   inUse      - other work depends on it (a task with its own subtasks/comments/attachments,
   *                a project with tasks that are not the template's, a tag/field/type/iteration
   *                that a remaining task uses): NEVER deleted
   *   gone       - already deleted by someone
   * REUSED and SKIPPED items are never touched. Runs in ONE transaction; a dry run rolls it back.
   */
  private async undoCore(
    installId: string,
    o: { confirmEdited: boolean; dryRun?: boolean; compensation?: boolean },
  ) {
    const install = await this.prisma.templateInstall.findUnique({
      where: { id: installId },
    });
    if (!install) throw new NotFoundException('Install not found');
    if (!o.compensation && install.status === TemplateInstallStatus.APPLYING) {
      throw new ConflictException({
        code: 'APPLY_IN_PROGRESS',
        message: 'This apply is still running',
      });
    }
    if (!o.compensation && install.status === TemplateInstallStatus.UNDONE) {
      throw new ConflictException({
        code: 'ALREADY_UNDONE',
        message: 'This install was already undone',
      });
    }
    const since = install.finishedAt ?? new Date();

    const storageKeys: string[] = []; // objects to delete AFTER the commit (never on a dry run)
    class Rollback extends Error {
      constructor(readonly result: UndoResult) {
        super('rollback');
      }
    }
    const work = async (tx: Prisma.TransactionClient): Promise<UndoResult> => {
      storageKeys.length = 0; // a retried transaction starts clean
      const result: UndoResult = {
        deleted: {},
        edited: {},
        inUse: {},
        gone: 0,
        examples: { edited: [], inUse: [] },
      };
      const count = (bucket: Record<string, number>, type: string, n = 1) => {
        bucket[type] = (bucket[type] ?? 0) + n;
      };
      const live = Prisma.sql`i.install_id = ${installId} AND i.action = 'CREATED' AND i.undone_at IS NULL`;
      const note = (
        kind: 'edited' | 'inUse',
        type: string,
        ids: string[],
        reason: string,
      ) => {
        count(result[kind], type, ids.length);
        for (const id of ids)
          if (result.examples[kind].length < 50)
            result.examples[kind].push({ type, id, reason });
      };

      // ---- tasks
      const taskRows = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT i.entity_id AS id FROM template_install_items i WHERE ${live} AND i.entity_type = 'TASK'`;
      const existing = new Set(
        (
          await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT t.id FROM template_install_items i JOIN tasks t ON t.id = i.entity_id WHERE ${live} AND i.entity_type = 'TASK'`
        ).map((r) => r.id),
      );
      const goneTasks = taskRows
        .filter((r) => !existing.has(r.id))
        .map((r) => r.id);
      result.gone += goneTasks.length;

      const edited = new Set(
        (
          await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT t.id FROM template_install_items i JOIN tasks t ON t.id = i.entity_id WHERE ${live} AND i.entity_type = 'TASK' AND t.updated_at > ${since}`
        ).map((r) => r.id),
      );
      const inUseTask = new Map<string, string>();
      const mark = (rows: Array<{ id: string }>, why: string) =>
        rows.forEach((r) => {
          if (!inUseTask.has(r.id)) inUseTask.set(r.id, why);
        });
      mark(
        await tx.$queryRaw`SELECT DISTINCT c.parent_id AS id FROM tasks c JOIN template_install_items p ON p.install_id = ${installId} AND p.entity_type = 'TASK' AND p.entity_id = c.parent_id WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM template_install_items ci WHERE ci.install_id = ${installId} AND ci.entity_type = 'TASK' AND ci.entity_id = c.id)`,
        "has subtasks that are not the template's",
      );
      mark(
        await tx.$queryRaw`SELECT DISTINCT cm.target_id AS id FROM comments cm JOIN template_install_items i ON i.entity_id = cm.target_id AND ${live} AND i.entity_type = 'TASK' WHERE cm.target_type = 'TASK' AND cm.created_at > ${since}`,
        'has comments added since',
      );
      mark(
        await tx.$queryRaw`SELECT DISTINCT a.target_id AS id FROM attachments a JOIN template_install_items i ON i.entity_id = a.target_id AND ${live} AND i.entity_type = 'TASK' WHERE a.target_type = 'TASK' AND NOT EXISTS (SELECT 1 FROM template_install_items ai WHERE ai.install_id = ${installId} AND ai.entity_type = 'ATTACHMENT' AND ai.entity_id = a.id)`,
        'has attachments',
      );
      const depEdited = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT DISTINCT i.entity_id AS id FROM template_install_items i JOIN task_dependencies d ON (d.blocking_task_id = i.entity_id OR d.blocked_task_id = i.entity_id) WHERE ${live} AND i.entity_type = 'TASK' AND d.created_at > ${since}`;
      depEdited.forEach((r) => edited.add(r.id));

      const deletableTasks: string[] = [];
      for (const r of taskRows) {
        if (!existing.has(r.id)) continue;
        if (inUseTask.has(r.id)) {
          note('inUse', 'TASK', [r.id], inUseTask.get(r.id)!);
          continue;
        }
        if (edited.has(r.id) && !o.confirmEdited) {
          note('edited', 'TASK', [r.id], 'changed since the apply');
          continue;
        }
        deletableTasks.push(r.id);
      }
      // A task cannot be deleted while a subtask of it stays (the parent link is a foreign key,
      // and the kept subtask must keep its parent): walk upwards, keeping every ancestor.
      const removeSet = new Set(deletableTasks);
      const links = new Map<string, string | null>();
      for (let i = 0; i < taskRows.length; i += 1000) {
        const rows = await tx.task.findMany({
          where: { id: { in: taskRows.slice(i, i + 1000).map((r) => r.id) } },
          select: { id: true, parentId: true },
        });
        rows.forEach((r) => links.set(r.id, r.parentId));
      }
      for (const [id, parentId] of links) {
        if (removeSet.has(id)) continue; // being deleted: no constraint on its parent
        let up = parentId;
        while (up && removeSet.has(up)) {
          removeSet.delete(up);
          note('inUse', 'TASK', [up], 'a subtask of it is being kept');
          up = links.get(up) ?? null;
        }
      }
      deletableTasks.length = 0;
      deletableTasks.push(...removeSet);
      for (let i = 0; i < deletableTasks.length; i += 1000) {
        const ids = deletableTasks.slice(i, i + 1000);
        await tx.comment.deleteMany({
          where: { targetType: 'TASK', targetId: { in: ids } },
        });
        await tx.task.deleteMany({ where: { id: { in: ids } } });
      }
      count(result.deleted, 'TASK', deletableTasks.length);
      const deletedSet = [...deletableTasks, ...goneTasks];

      // ---- reference files the install copied: they go with their task (rows now, objects after the commit)
      const gonePlusDeleted = new Set(deletedSet);
      const ours = await tx.$queryRaw<
        Array<{ id: string; target_id: string; storage_key: string | null }>
      >`SELECT i.entity_id AS id, a.target_id, a.storage_key FROM template_install_items i LEFT JOIN attachments a ON a.id = i.entity_id WHERE ${live} AND i.entity_type = 'ATTACHMENT'`;
      const removedAttachments: string[] = [];
      for (const r of ours) {
        if (r.storage_key === null) {
          result.gone += 1;
          removedAttachments.push(r.id);
          continue;
        } // row already deleted by someone
        if (!gonePlusDeleted.has(r.target_id)) continue; // its task stays, so does the file
        removedAttachments.push(r.id);
        storageKeys.push(r.storage_key);
      }
      for (let i = 0; i < removedAttachments.length; i += 1000) {
        await tx.attachment.deleteMany({
          where: { id: { in: removedAttachments.slice(i, i + 1000) } },
        });
      }
      count(result.deleted, 'ATTACHMENT', storageKeys.length);

      // ---- the rest: judged against the tasks that REMAIN
      const entity = async (
        type: string,
        table: string,
        refs: Prisma.Sql | null,
        ownCheck?: Prisma.Sql,
      ) => {
        const items = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT i.entity_id AS id FROM template_install_items i WHERE ${live} AND i.entity_type = ${type}`;
        if (items.length === 0) return [] as string[];
        const found = new Set(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM ${table} WHERE id = ANY($1::text[])`,
              items.map((r) => r.id),
            )
          ).map((r) => r.id),
        );
        result.gone += items.filter((r) => !found.has(r.id)).length;
        const blocked = refs
          ? new Set(
              (await tx.$queryRaw<Array<{ id: string }>>(refs)).map(
                (r) => r.id,
              ),
            )
          : new Set<string>();
        const editedIds = ownCheck
          ? new Set(
              (await tx.$queryRaw<Array<{ id: string }>>(ownCheck)).map(
                (r) => r.id,
              ),
            )
          : new Set<string>();
        const out: string[] = [];
        for (const r of items) {
          if (!found.has(r.id)) continue;
          if (blocked.has(r.id)) {
            note('inUse', type, [r.id], 'still used by other work');
            continue;
          }
          if (editedIds.has(r.id) && !o.confirmEdited) {
            note('edited', type, [r.id], 'changed since the apply');
            continue;
          }
          out.push(r.id);
        }
        return out;
      };

      // ---- automations and saved views the install created (step 5.5): gone first, so a project is judged by what REMAINS in it
      const automationIds = await entity(
        'AUTOMATION',
        'automations',
        null,
        Prisma.sql`SELECT a.id FROM automations a JOIN template_install_items i ON i.entity_id = a.id AND ${live} AND i.entity_type = 'AUTOMATION' WHERE a.updated_at > ${since}`,
      );
      if (automationIds.length)
        await tx.automation.deleteMany({
          where: { id: { in: automationIds } },
        });
      count(result.deleted, 'AUTOMATION', automationIds.length);
      const viewIds = await entity(
        'SAVED_VIEW',
        'saved_views',
        null,
        Prisma.sql`SELECT v.id FROM saved_views v JOIN template_install_items i ON i.entity_id = v.id AND ${live} AND i.entity_type = 'SAVED_VIEW' WHERE v.updated_at > ${since}`,
      );
      if (viewIds.length)
        await tx.savedView.deleteMany({ where: { id: { in: viewIds } } });
      count(result.deleted, 'SAVED_VIEW', viewIds.length);

      const iterations = await entity(
        'ITERATION',
        'iterations',
        Prisma.sql`SELECT DISTINCT t.iteration_id AS id FROM tasks t JOIN template_install_items i ON i.entity_id = t.iteration_id AND ${live} AND i.entity_type = 'ITERATION'`,
        Prisma.sql`SELECT it.id FROM iterations it JOIN template_install_items i ON i.entity_id = it.id AND ${live} AND i.entity_type = 'ITERATION' WHERE it.updated_at > ${since} OR it.state <> 'PLANNED'`,
      );
      if (iterations.length)
        await tx.iteration.deleteMany({ where: { id: { in: iterations } } });
      count(result.deleted, 'ITERATION', iterations.length);

      const projects = await entity(
        'PROJECT',
        'projects',
        Prisma.sql`SELECT DISTINCT t.project_id AS id FROM tasks t JOIN template_install_items i ON i.entity_id = t.project_id AND ${live} AND i.entity_type = 'PROJECT'
          UNION SELECT DISTINCT a.project_id FROM automations a JOIN template_install_items i ON i.entity_id = a.project_id AND ${live} AND i.entity_type = 'PROJECT'
          UNION SELECT DISTINCT v.project_id FROM saved_views v JOIN template_install_items i ON i.entity_id = v.project_id AND ${live} AND i.entity_type = 'PROJECT'`,
        Prisma.sql`SELECT p.id FROM projects p JOIN template_install_items i ON i.entity_id = p.id AND ${live} AND i.entity_type = 'PROJECT' WHERE p.updated_at > ${since} OR EXISTS (SELECT 1 FROM workflow_statuses s WHERE s.project_id = p.id AND s.updated_at > ${since})`,
      );
      if (projects.length)
        await tx.project.deleteMany({ where: { id: { in: projects } } });
      count(result.deleted, 'PROJECT', projects.length);

      const tags = await entity(
        'TAG',
        'tags',
        Prisma.sql`SELECT DISTINCT tt.tag_id AS id FROM task_tags tt JOIN template_install_items i ON i.entity_id = tt.tag_id AND ${live} AND i.entity_type = 'TAG'`,
      );
      if (tags.length) await tx.tag.deleteMany({ where: { id: { in: tags } } });
      count(result.deleted, 'TAG', tags.length);

      const fields = await entity(
        'CUSTOM_FIELD',
        'custom_fields',
        Prisma.sql`SELECT DISTINCT v.field_id AS id FROM task_custom_values v JOIN template_install_items i ON i.entity_id = v.field_id AND ${live} AND i.entity_type = 'CUSTOM_FIELD'`,
      );
      if (fields.length)
        await tx.customField.deleteMany({ where: { id: { in: fields } } });
      count(result.deleted, 'CUSTOM_FIELD', fields.length);

      const types = await entity(
        'ISSUE_TYPE',
        'issue_types',
        Prisma.sql`SELECT DISTINCT t.issue_type_id AS id FROM tasks t JOIN template_install_items i ON i.entity_id = t.issue_type_id AND ${live} AND i.entity_type = 'ISSUE_TYPE'`,
      );
      if (types.length)
        await tx.issueType.deleteMany({ where: { id: { in: types } } });
      count(result.deleted, 'ISSUE_TYPE', types.length);

      if (!o.dryRun) {
        const removed = [
          ...deletedSet,
          ...removedAttachments,
          ...automationIds,
          ...viewIds,
          ...iterations,
          ...projects,
          ...tags,
          ...fields,
          ...types,
        ];
        for (let i = 0; i < removed.length; i += 1000) {
          await tx.templateInstallItem.updateMany({
            where: {
              installId,
              entityId: { in: removed.slice(i, i + 1000) },
              undoneAt: null,
            },
            data: { undoneAt: new Date() },
          });
        }
        const remaining = await tx.templateInstallItem.count({
          where: { installId, action: 'CREATED', undoneAt: null },
        });
        if (remaining === 0 && !o.compensation) {
          await tx.templateInstall.update({
            where: { id: installId },
            data: {
              status: TemplateInstallStatus.UNDONE,
              undoneAt: new Date(),
            },
          });
        }
      } else {
        throw new Rollback(result);
      }
      return result;
    };

    try {
      const done = await this.prisma.$transaction(work, {
        timeout: TX_TIMEOUT_MS,
        maxWait: 10_000,
      });
      await this.deleteObjects(storageKeys); // the quota is freed by the row deletes above; this frees the bytes
      return done;
    } catch (err) {
      if (err instanceof Error && 'result' in err && err.message === 'rollback')
        return (err as unknown as { result: UndoResult }).result;
      throw err;
    }
  }

  // ================================================================ reads ================

  async getInstall(userId: string, installId: string) {
    const i = await this.loadInstallFor(userId, installId);
    const counts = await this.prisma.templateInstallItem.groupBy({
      by: ['entityType', 'action'],
      where: { installId },
      _count: true,
    });
    return {
      ...i,
      items: counts.map((c) => ({
        entityType: c.entityType,
        action: c.action,
        count: c._count,
      })),
    };
  }

  async listInstalls(userId: string, workspaceId: string) {
    if (!(await this.resolver.hasWorkspaceLevelAccess(userId, workspaceId)))
      throw new NotFoundException('Workspace not found');
    return this.prisma.templateInstall.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Anyone with access to the workspace may read its installs; UNDO additionally needs ADMIN (editWorkspace). */
  private async loadInstallFor(userId: string, installId: string) {
    const install = await this.prisma.templateInstall.findUnique({
      where: { id: installId },
    });
    if (
      !install ||
      !(await this.resolver.hasWorkspaceLevelAccess(
        userId,
        install.workspaceId,
      ))
    ) {
      throw new NotFoundException('Install not found');
    }
    return install;
  }

  async assertCanUndo(userId: string, installId: string): Promise<void> {
    const install = await this.loadInstallFor(userId, installId);
    const r = await this.resolver.resolve(
      userId,
      'editWorkspace',
      'WORKSPACE',
      install.workspaceId,
    );
    if (!r.allowed) throw new NotFoundException('Install not found');
  }

  // ================================================================ state ================

  private async createInstall(p: {
    workspace: { id: string; accountId: string };
    userId: string;
    mode: TemplateInstallMode;
    dto: ApplyTemplateDto;
    version: { id: string; semver: string; checksum: string };
    templateName: string;
  }) {
    try {
      return await this.prisma.templateInstall.create({
        data: {
          versionId: p.version.id,
          templateName: p.templateName,
          versionSemver: p.version.semver,
          versionChecksum: p.version.checksum,
          accountId: p.workspace.accountId,
          workspaceId: p.workspace.id,
          appliedById: p.userId,
          mode: p.mode,
          variables: (p.dto.variables ?? {}) as Prisma.InputJsonValue,
          roleAssignments: (p.dto.roles ?? {}) as Prisma.InputJsonValue,
          moduleSelection: (p.dto.modules ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          code: 'APPLY_IN_PROGRESS',
          message: 'A template is already being applied to this workspace',
        });
      }
      throw err;
    }
  }

  private async eligibleUsers(
    roles: Record<string, unknown> | undefined,
    workspaceId: string,
  ): Promise<Set<string>> {
    const candidates = new Set<string>();
    for (const v of Object.values(roles ?? {})) {
      const c = v as { type?: string; userId?: unknown };
      if (c && c.type === 'MEMBER' && typeof c.userId === 'string')
        candidates.add(c.userId);
    }
    const ok = new Set<string>();
    for (const id of candidates)
      if (await this.resolver.hasWorkspaceLevelAccess(id, workspaceId))
        ok.add(id);
    return ok;
  }

  private async loadState(
    db: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceState> {
    const [
      tags,
      customFields,
      issueTypes,
      projects,
      iterationCount,
      taskCount,
      automationRows,
      personalViews,
      sharedViews,
    ] = await Promise.all([
      db.tag.findMany({
        where: { workspaceId },
        select: { id: true, name: true },
      }),
      db.customField.findMany({
        where: { workspaceId },
        select: { id: true, key: true, dataType: true, options: true },
      }),
      db.issueType.findMany({
        where: { workspaceId },
        select: { id: true, name: true },
      }),
      db.project.findMany({ where: { workspaceId }, select: { name: true } }),
      db.iteration.count({ where: { workspaceId } }),
      db.task.count({ where: { workspaceId } }),
      db.automation.findMany({
        where: { workspaceId },
        select: { nameKey: true },
      }),
      db.savedView.count({
        where: { workspaceId, ownerId: userId, isShared: false },
      }),
      db.savedView.count({ where: { workspaceId, isShared: true } }),
    ]);
    // sharing a view is the team's call (an admin's), and so is anything a template wants shared
    const canShare = (
      await this.resolver.resolve(
        userId,
        'editWorkspace',
        'WORKSPACE',
        workspaceId,
      )
    ).allowed;
    return {
      tags,
      customFields,
      issueTypes,
      projectNames: projects.map((p) => p.name),
      projectCount: projects.length,
      iterationCount,
      taskCount,
      automations: {
        count: automationRows.length,
        nameKeys: automationRows.map((a) => a.nameKey),
      },
      savedViews: {
        personalOfUser: personalViews,
        shared: sharedViews,
        canShare,
      },
    };
  }

  private async loadLimits(
    accountId: string,
    workspaceId: string,
    resolved: ResolvedBlueprint,
    templateId: string,
  ): Promise<LimitState> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { planType: true },
    });
    const plan = getPlanLimits(account.planType);
    const n = resolved.projects.length;
    // how many MORE projects fit: probe the same check the guard uses
    let projectsRemaining: number | null = null;
    if (plan.projects !== null) {
      projectsRemaining = 0;
      while (
        projectsRemaining <= n &&
        (await this.limits.checkLimit(
          'project',
          'applyTemplate',
          { accountId, workspaceId },
          { additional: projectsRemaining + 1 },
        ))
      )
        projectsRemaining += 1;
    }
    const used = await this.usedBytes(this.prisma, accountId);
    const stored = new Set(
      (
        await this.prisma.templateAsset.findMany({
          where: { templateId },
          select: { sha256: true },
        })
      ).map((r) => r.sha256),
    );
    return {
      projectsRemaining,
      tasksPerProject: plan.tasks,
      storageRemainingBytes: plan.storageGB * 1024 * 1024 * 1024 - used,
      maxFileBytes: plan.maxFileSizeBytes,
      missingAssetShas: resolved.assets
        .filter((a) => !stored.has(a.sha256))
        .map((a) => a.sha256),
    };
  }
}

export interface UndoResult {
  deleted: Record<string, number>;
  edited: Record<string, number>;
  inUse: Record<string, number>;
  gone: number;
  examples: {
    edited: Array<{ type: string; id: string; reason: string }>;
    inUse: Array<{ type: string; id: string; reason: string }>;
  };
}
