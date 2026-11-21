import { Injectable } from '@nestjs/common';
import { CreationMode, DependencyType, FieldType, ImportIssueSeverity as Sev, Prisma } from '@prisma/client';
import { PlanLimitsService } from '../../access-control/plan-limits.service';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { WriteContext } from '../../domain-writer/write-context';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_ISSUE_TYPES_PER_WORKSPACE, MAX_ITERATIONS_PER_WORKSPACE } from '../../projects-tasks/iterations/iteration-rules';
import { CustomFieldsService } from '../../projects-tasks/custom-fields/custom-fields.service';
import { BulkTaskItem } from '../../projects-tasks/tasks/task-write.types';
import { normalizeStatusName } from '../../projects-tasks/workflow/workflow-name';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { ExternalRefService, NewExternalRef } from '../external-ref.service';
import { NewImportIssue } from '../import-issue.service';
import { ImportUsageService } from '../import-usage.service';
import { ImportOptions } from '../imports.types';
import { MappedPage, MappedProject, MappedTask, mappedTaskHash } from '../mapping';
import { classifyImportError, unwrap } from './import-errors';
import { ProgressTracker } from './import-progress';

/**
 * Step 4.4. Turns a MAPPED page into rows. It owns every write of an import except the finishing work (executor) and
 * rollback; it holds NO state between calls (everything it needs is in the database or in the PageContext), which is what
 * makes a crashed run resumable by simply fetching the same page again.
 *
 * Idempotency rule: each created row and its ExternalRef are committed in the SAME transaction. A re-run looks the refs up
 * first and skips what exists. Rows that were MATCHED rather than created (an issue type with the same name, a tag) get a
 * `:reused` ref, so a rollback never deletes something the import did not make.
 */
export interface RunJob {
  id: string;
  connectionId: string;
  workspaceId: string;
  accountId: string;
  createdById: string;
  options: ImportOptions;
}

export interface PageContext {
  job: RunJob;
  tracker: ProgressTracker;
  /** Collected per page; the executor records them (bounded) once the page is done. */
  issues: NewImportIssue[];
}

const TASK_CHUNK = 100;
const LINK_BATCH = 200;
const CYCLE_SEARCH_LIMIT = 5000;

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Workflow statuses are referenced PER PROJECT. Some providers (Jira) share one status id across many projects while each
 * project has its own workflow; keyed by the id alone, a second project's tasks would point at the first project's status.
 */
export const statusRefId = (projectExternalId: string, statusExternalId: string): string => `${projectExternalId}\u001f${statusExternalId}`;

export const REF = {
  project: 'project',
  status: 'status',
  issueType: 'issueType',
  customField: 'customField',
  iteration: 'iteration',
  tag: 'tag',
  task: 'task',
  /** Step 4.6. */
  comment: 'comment',
  /** One ref per TASK whose history was copied (externalId = the task's external id, localId = the task). */
  history: 'history',
  attachment: 'attachment',
} as const;
/** localType of a ref whose row existed already and was only matched. */
export const REUSED = ':reused';

interface TaskPlan {
  mapped: MappedTask;
  item: BulkTaskItem;
  /** In-page parent (by external id), resolved when its level has been written. */
  pageParent?: string;
  /** Parent that is on neither this page nor in the database yet -> pending link. */
  pendingParent?: string;
  tagIds: string[];
  values: Array<{ fieldId: string; value: unknown }>;
}

@Injectable()
export class ImportWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: DomainWriter,
    private readonly refs: ExternalRefService,
    private readonly usage: ImportUsageService,
    private readonly planLimits: PlanLimitsService,
    private readonly customFields: CustomFieldsService,
  ) {}

  // ================================================================================================ context

  private ctx(job: RunJob, tx?: Prisma.TransactionClient): WriteContext {
    return {
      origin: CreationMode.IMPORT,
      actorId: job.createdById,
      silent: true,
      importJobId: job.id,
      keepOriginalDates: job.options.keepDates,
      ...(tx ? { tx } : {}),
    };
  }

  private async lookup(job: RunJob, type: string, ids: readonly string[], db: Db = this.prisma) {
    return this.refs.lookup(job.connectionId, type, [...new Set(ids)], db);
  }

  private count(pc: PageContext, type: string, existing: { importJobId: string } | undefined): void {
    // already created by THIS job (a replay after a crash): counted when it was created; created earlier by another job: skipped
    if (existing && existing.importJobId !== pc.job.id) pc.tracker.add(type, 'skipped');
  }

  // ================================================================================================ structure

  async writeStructure(pc: PageContext, page: MappedPage): Promise<void> {
    for (const p of page.projects) await this.writeProject(pc, p);
    for (const t of page.issueTypes) await this.writeIssueType(pc, t);
    for (const f of page.customFields) await this.writeCustomField(pc, f);
    for (const it of page.iterations) await this.writeIteration(pc, it);
    await this.ensureTags(pc, [...page.tags.map((t) => t.name), ...page.tasks.flatMap((t) => t.tags)]);
  }

  private async writeProject(pc: PageContext, p: MappedProject): Promise<void> {
    const { job } = pc;
    const have = (await this.lookup(job, REF.project, [p.externalId])).get(p.externalId);
    if (have) return this.count(pc, 'project', have);

    await this.domain.run(this.ctx(job), async (c) => {
      const tx = c.tx as Prisma.TransactionClient;
      if (!(await this.planLimits.checkLimit('project', 'createProject', { accountId: job.accountId, workspaceId: job.workspaceId }, { additional: 1, db: tx }))) {
        throw new PlanLimitExceededException(`Project limit reached; "${p.name}" could not be created`);
      }
      const seed = p.statuses.length
        ? p.statuses.map((s) => ({
            name: s.name,
            color: s.color,
            category: s.category,
            excludeFromProgress: s.excludeFromProgress,
            isInitial: s.externalId === p.initialStatusExternalId,
          }))
        : undefined;
      const project = await this.domain.createProject(
        { workspaceId: job.workspaceId, name: p.name, ...(p.description ? { description: p.description } : {}) } as never,
        job.createdById,
        c,
        undefined,
        seed ? { workflow: { statuses: seed } } : undefined, // Phase 3's extras shape (it also carries transitions: Jira's, one day)
      );
      const rows: NewExternalRef[] = [{ externalType: REF.project, externalId: p.externalId, externalKey: p.key ?? null, localType: 'project', localId: project.id }];
      if (p.statuses.length) {
        const made = await tx.workflowStatus.findMany({ where: { projectId: project.id }, select: { id: true, nameKey: true } });
        const byKey = new Map(made.map((s) => [s.nameKey, s.id]));
        for (const s of p.statuses) {
          const id = byKey.get(normalizeStatusName(s.name).nameKey);
          if (id) rows.push({ externalType: REF.status, externalId: statusRefId(p.externalId, s.externalId), localType: 'workflowStatus', localId: id });
        }
      }
      await this.refs.upsertMany(job.connectionId, job.id, rows, tx);
    });
    pc.tracker.add('project', 'created');
  }

  private async writeIssueType(pc: PageContext, t: MappedPage['issueTypes'][number]): Promise<void> {
    const { job } = pc;
    const have = (await this.lookup(job, REF.issueType, [t.externalId])).get(t.externalId);
    if (have) return this.count(pc, 'issueType', have);
    const nameKey = foldName(t.name);
    await this.prisma.$transaction(async (tx) => {
      const same = await tx.issueType.findUnique({ where: { workspaceId_nameKey: { workspaceId: job.workspaceId, nameKey } }, select: { id: true } });
      if (same) {
        await this.refs.upsertMany(job.connectionId, job.id, [{ externalType: REF.issueType, externalId: t.externalId, localType: `issueType${REUSED}`, localId: same.id }], tx);
        pc.tracker.add('issueType', 'skipped');
        return;
      }
      if ((await tx.issueType.count({ where: { workspaceId: job.workspaceId } })) >= MAX_ISSUE_TYPES_PER_WORKSPACE) {
        pc.issues.push({ severity: Sev.ERROR, code: 'ISSUE_TYPE_LIMIT', externalRef: `issueType:${t.externalId}`, message: `A workspace can have ${MAX_ISSUE_TYPES_PER_WORKSPACE} issue types; "${t.name}" was not created and its tasks have no type` });
        pc.tracker.add('issueType', 'failed');
        return;
      }
      const row = await tx.issueType.create({ data: { workspaceId: job.workspaceId, name: t.name, nameKey, level: t.level, ...(t.color ? { color: t.color } : {}) } });
      await this.refs.upsertMany(job.connectionId, job.id, [{ externalType: REF.issueType, externalId: t.externalId, localType: 'issueType', localId: row.id }], tx);
      pc.tracker.add('issueType', 'created');
    });
  }

  private async writeCustomField(pc: PageContext, f: MappedPage['customFields'][number]): Promise<void> {
    const { job } = pc;
    const have = (await this.lookup(job, REF.customField, [f.externalId])).get(f.externalId);
    if (have) return this.count(pc, 'customField', have);
    await this.domain.run(this.ctx(job), async (c) => {
      const tx = c.tx as Prisma.TransactionClient;
      const taken = new Set((await tx.customField.findMany({ where: { workspaceId: job.workspaceId }, select: { key: true } })).map((k) => k.key));
      const key = uniqueKey(f.name, taken);
      const isSelect = f.dataType === FieldType.SELECT || f.dataType === FieldType.MULTI_SELECT;
      const row = await this.domain.createCustomField(
        job.workspaceId,
        { name: f.name.slice(0, 80), key, dataType: f.dataType, ...(isSelect && f.options ? { options: f.options } : {}) } as never,
        c,
      );
      await this.refs.upsertMany(job.connectionId, job.id, [{ externalType: REF.customField, externalId: f.externalId, localType: 'customField', localId: row.id }], tx);
    });
    pc.tracker.add('customField', 'created');
  }

  private async writeIteration(pc: PageContext, it: MappedPage['iterations'][number]): Promise<void> {
    const { job } = pc;
    const have = (await this.lookup(job, REF.iteration, [it.externalId])).get(it.externalId);
    if (have) return this.count(pc, 'iteration', have);
    const projectId = it.projectExternalId ? (await this.lookup(job, REF.project, [it.projectExternalId])).get(it.projectExternalId)?.localId : undefined;
    await this.prisma.$transaction(async (tx) => {
      if ((await tx.iteration.count({ where: { workspaceId: job.workspaceId } })) >= MAX_ITERATIONS_PER_WORKSPACE) {
        pc.issues.push({ severity: Sev.ERROR, code: 'ITERATION_LIMIT', externalRef: `iteration:${it.externalId}`, message: `A workspace can have ${MAX_ITERATIONS_PER_WORKSPACE} iterations; "${it.name}" was not created` });
        pc.tracker.add('iteration', 'failed');
        return;
      }
      const row = await tx.iteration.create({
        data: {
          workspaceId: job.workspaceId,
          projectId: projectId ?? null,
          kind: it.kind,
          name: it.name,
          goal: it.goal ?? null,
          startDate: it.startDate ? new Date(it.startDate) : null,
          endDate: it.endDate ? new Date(it.endDate) : null,
        },
      });
      await this.refs.upsertMany(job.connectionId, job.id, [{ externalType: REF.iteration, externalId: it.externalId, localType: 'iteration', localId: row.id }], tx);
    });
    pc.tracker.add('iteration', 'created');
  }

  /** Every tag name this page uses exists afterwards. Matched ones are reused (ref `:reused`), new ones are created + referenced. */
  private async ensureTags(pc: PageContext, names: string[]): Promise<void> {
    const { job } = pc;
    const byKey = new Map<string, string>();
    for (const n of names) {
      const name = n.replace(/\s+/g, ' ').trim();
      if (name !== '') byKey.set(foldName(name), name);
    }
    if (byKey.size === 0) return;
    await this.prisma.$transaction(async (tx) => {
      const have = new Set((await tx.tag.findMany({ where: { workspaceId: job.workspaceId, nameKey: { in: [...byKey.keys()] } }, select: { nameKey: true } })).map((t) => t.nameKey));
      const missing = [...byKey].filter(([k]) => !have.has(k));
      if (missing.length === 0) return;
      const made = await tx.tag.createManyAndReturn({ data: missing.map(([nameKey, name]) => ({ workspaceId: job.workspaceId, name, nameKey })), select: { id: true, nameKey: true } });
      await this.refs.upsertMany(job.connectionId, job.id, made.map((t) => ({ externalType: REF.tag, externalId: t.nameKey, localType: 'tag', localId: t.id })), tx);
      pc.tracker.add('tag', 'created', made.length);
    });
  }

  // ================================================================================================ tasks

  async writeTasks(pc: PageContext, page: MappedPage): Promise<void> {
    const { job } = pc;
    if (page.tasks.length === 0) return;

    // 1. what exists already
    const existing = await this.lookup(job, REF.task, page.tasks.map((t) => t.externalId));
    const todo: MappedTask[] = [];
    for (const t of page.tasks) {
      const have = existing.get(t.externalId);
      if (have) this.count(pc, 'task', have);
      else todo.push(t);
    }
    if (todo.length === 0) return;

    // 2. resolve references to rows (projects, statuses, types, iterations, tags, fields)
    const refIds = async (type: string, pick: (t: MappedTask) => Array<string | undefined>) =>
      this.lookup(job, type, todo.flatMap(pick).filter((x): x is string => !!x));
    const [projects, statuses, types, iterations] = await Promise.all([
      refIds(REF.project, (t) => [t.projectExternalId]),
      refIds(REF.status, (t) => [t.projectExternalId && t.workflowStatusExternalId ? statusRefId(t.projectExternalId, t.workflowStatusExternalId) : undefined]),
      refIds(REF.issueType, (t) => [t.issueType?.kind === 'create' ? t.issueType.externalId : undefined]),
      refIds(REF.iteration, (t) => [t.iterationExternalId]),
    ]);
    const tagKeys = [...new Set(todo.flatMap((t) => t.tags.map((x) => foldName(x))))];
    const tagIdByKey = new Map((tagKeys.length ? await this.prisma.tag.findMany({ where: { workspaceId: job.workspaceId, nameKey: { in: tagKeys } }, select: { id: true, nameKey: true } }) : []).map((t) => [t.nameKey, t.id]));
    const fieldRefs = await refIds(REF.customField, (t) => t.customValues.filter((v) => v.target.kind === 'create').map((v) => v.fieldExternalId));
    const fieldIds = new Set<string>();
    for (const t of todo) for (const v of t.customValues) {
      const id = v.target.kind === 'existing' ? v.target.id : fieldRefs.get(v.fieldExternalId)?.localId;
      if (id) fieldIds.add(id);
    }
    const fieldDefs = new Map((fieldIds.size ? await this.prisma.customField.findMany({ where: { id: { in: [...fieldIds] } } }) : []).map((f) => [f.id, f]));

    // 3. plan every task
    const inPage = new Map(todo.map((t) => [t.externalId, t]));
    const plans = new Map<string, TaskPlan>();
    const parentRefs = await this.lookup(job, REF.task, todo.map((t) => t.parentExternalId).filter((x): x is string => !!x && !inPage.has(x)));
    for (const t of todo) {
      let projectId: string | undefined;
      if (t.projectExternalId !== undefined) {
        projectId = projects.get(t.projectExternalId)?.localId;
        if (!projectId) {
          pc.issues.push({ severity: Sev.ERROR, code: 'TASK_PROJECT_MISSING', externalRef: `task:${t.externalId}`, message: `Its project (${t.projectExternalId}) was not imported, so the task was skipped` });
          pc.tracker.add('task', 'failed');
          continue;
        }
      }
      const item: BulkTaskItem = { title: t.title, priority: t.priority ?? undefined, ...(projectId ? { projectId } : {}) } as BulkTaskItem;
      if (t.description) item.description = t.description;
      const wsId = t.projectExternalId && t.workflowStatusExternalId ? statuses.get(statusRefId(t.projectExternalId, t.workflowStatusExternalId))?.localId : undefined;
      if (wsId) item.workflowStatusId = wsId;
      else item.status = t.status;
      if (t.issueType?.kind === 'existing') item.issueTypeId = t.issueType.id;
      else if (t.issueType?.kind === 'create') {
        const id = types.get(t.issueType.externalId)?.localId;
        if (id) item.issueTypeId = id;
        else pc.issues.push({ severity: Sev.INFO, code: 'ISSUE_TYPE_UNAVAILABLE', externalRef: `issueType:${t.issueType.externalId}`, message: 'An issue type could not be created, so tasks of that type have no type' });
      }
      const iterationId = t.iterationExternalId ? iterations.get(t.iterationExternalId)?.localId : undefined;
      if (iterationId) item.iterationId = iterationId;
      if (t.startDate) item.startDate = t.startDate;
      if (t.dueDate) item.dueDate = t.dueDate;
      if (t.estimate !== undefined) item.estimate = t.estimate;
      if (t.archived) item.archived = true;
      if (t.assigneeUserIds.length) item.assigneeIds = t.assigneeUserIds;
      if (job.options.keepDates) {
        if (t.createdAt) item.createdAt = new Date(t.createdAt);
        if (t.updatedAt) item.updatedAt = new Date(t.updatedAt);
      }
      const plan: TaskPlan = { mapped: t, item, tagIds: [], values: [] };
      for (const tag of t.tags) {
        const id = tagIdByKey.get(foldName(tag));
        if (id && !plan.tagIds.includes(id)) plan.tagIds.push(id);
      }
      for (const v of t.customValues) {
        const fieldId = v.target.kind === 'existing' ? v.target.id : fieldRefs.get(v.fieldExternalId)?.localId;
        const def = fieldId ? fieldDefs.get(fieldId) : undefined;
        if (!fieldId || !def) continue;
        try {
          this.customFields.validateValue(def.dataType, def.options as string[] | null, v.value);
          plan.values.push({ fieldId, value: v.value });
        } catch (e) {
          pc.issues.push({ severity: Sev.INFO, code: 'CUSTOM_VALUE_REJECTED', externalRef: `task:${t.externalId}`, message: `Field "${def.name}": ${(e as Error).message}; the value was left out` });
        }
      }
      if (t.parentExternalId !== undefined) {
        if (inPage.has(t.parentExternalId)) plan.pageParent = t.parentExternalId;
        else {
          const pid = parentRefs.get(t.parentExternalId)?.localId;
          if (pid) item.parentId = pid;
          else plan.pendingParent = t.parentExternalId;
        }
      }
      plans.set(t.externalId, plan);
    }

    // 4. write level by level: a child's parent is already committed (and referenced) when its level starts
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id) as number;
      const p = plans.get(id)?.pageParent;
      if (!p || !plans.has(p) || seen.has(id)) { depth.set(id, 0); return 0; }
      seen.add(id);
      const d = depthOf(p, seen) + 1;
      depth.set(id, d);
      return d;
    };
    const levels: TaskPlan[][] = [];
    for (const [id, plan] of plans) (levels[depthOf(id)] ??= []).push(plan);
    for (const level of levels) {
      if (!level?.length) continue;
      const parents = await this.lookup(job, REF.task, level.map((p) => p.pageParent).filter((x): x is string => !!x));
      const writable: TaskPlan[] = [];
      for (const plan of level) {
        if (plan.pageParent) {
          const pid = parents.get(plan.pageParent)?.localId;
          if (pid) plan.item.parentId = pid;
          else plan.pendingParent = plan.pageParent; // its parent was rejected above: becomes a (reported) missing link later
        }
        writable.push(plan);
      }
      await this.createBatch(pc, writable);
    }
  }

  /** One level of tasks. A refused item is isolated by bisection (the rest of the batch still commits). */
  private async createBatch(pc: PageContext, plans: TaskPlan[]): Promise<void> {
    if (plans.length === 0) return;
    try {
      await this.attempt(pc, plans);
    } catch (e) {
      await this.resetTracker(pc);
      if (classifyImportError(e).kind !== 'ITEM') throw e;
      if (plans.length > 1) {
        const mid = Math.ceil(plans.length / 2);
        await this.createBatch(pc, plans.slice(0, mid));
        await this.createBatch(pc, plans.slice(mid));
        return;
      }
      await this.createRefused(pc, plans[0], e);
    }
  }

  /** The actual bulk write of one batch. Throws whatever the writers throw; the caller decides what that means. */
  private async attempt(pc: PageContext, plans: TaskPlan[]): Promise<void> {
    const { job } = pc;
    const byItem = new Map(plans.map((p) => [p.item, p]));
    await this.domain.createTasksBulk(job.workspaceId, plans.map((p) => p.item), job.createdById, this.ctx(job), {
      chunkSize: TASK_CHUNK,
      filterChunk: async (tx, chunk) => {
        const have = await this.lookup(job, REF.task, chunk.map((i) => (byItem.get(i) as TaskPlan).mapped.externalId), tx);
        return chunk.filter((i) => {
          const ext = (byItem.get(i) as TaskPlan).mapped.externalId;
          const there = have.get(ext);
          if (there) this.count(pc, 'task', there); // another run got there first: reported as skipped, never created twice
          return !there;
        });
      },
      afterChunk: async (tx, kept, created) => this.afterTaskChunk(pc, tx, kept.map((i) => byItem.get(i) as TaskPlan), created),
    });
  }

  /** The row is the truth: forget whatever a failed attempt added to the in-memory counters. */
  private async resetTracker(pc: PageContext): Promise<void> {
    const fresh = await this.prisma.importJob.findUnique({ where: { id: pc.job.id }, select: { progress: true } });
    Object.assign(pc.tracker, new ProgressTracker(fresh?.progress));
  }

  /**
   * ONE task the writers refused. What matters is the task, not its associations: try it without each optional association in
   * turn (parent, iteration, issue type, workflow status), keep it with a warning naming what was left out, and fail it only
   * when none of that helps.
   */
  private async createRefused(pc: PageContext, plan: TaskPlan, first: unknown): Promise<void> {
    const cause = unwrap(first) as Error;
    const ref = `task:${plan.mapped.externalId}`;
    const OPTIONAL: Array<[keyof BulkTaskItem, string, string]> = [
      ['parentId', 'PARENT_REJECTED', 'placed under its parent'],
      ['iterationId', 'ITERATION_REJECTED', 'put in its iteration'],
      ['issueTypeId', 'ISSUE_TYPE_REJECTED', 'given its issue type'],
      ['workflowStatusId', 'STATUS_REJECTED', 'put in its status'],
    ];
    for (const [key, code, what] of OPTIONAL) {
      if (plan.item[key] === undefined) continue;
      const rest = { ...plan.item } as Record<string, unknown>;
      delete rest[key as string];
      if (key === 'workflowStatusId') rest.status = plan.mapped.status;
      const variant: TaskPlan = { ...plan, item: rest as unknown as BulkTaskItem };
      try {
        await this.attempt(pc, [variant]);
        pc.issues.push({ severity: Sev.WARN, code, externalRef: ref, message: `It could not be ${what} (${cause.message}); it was imported without` });
        return;
      } catch (e) {
        await this.resetTracker(pc);
        if (classifyImportError(e).kind !== 'ITEM') throw e;
      }
    }
    // more than one thing wrong at once: drop every optional association together
    const present = OPTIONAL.filter(([key]) => plan.item[key] !== undefined);
    if (present.length > 1) {
      const rest = { ...plan.item } as Record<string, unknown>;
      for (const [key] of present) delete rest[key as string];
      if (present.some(([key]) => key === 'workflowStatusId')) rest.status = plan.mapped.status;
      try {
        await this.attempt(pc, [{ ...plan, item: rest as unknown as BulkTaskItem }]);
        pc.issues.push({ severity: Sev.WARN, code: 'ASSOCIATIONS_REJECTED', externalRef: ref, message: `It could not be ${present.map(([, , what]) => what).join(', nor ')} (${cause.message}); it was imported without` });
        return;
      } catch (e) {
        await this.resetTracker(pc);
        if (classifyImportError(e).kind !== 'ITEM') throw e;
      }
    }
    pc.issues.push({ severity: Sev.ERROR, code: 'TASK_REJECTED', externalRef: ref, message: `The task could not be created: ${cause.message}` });
    pc.tracker.add('task', 'failed');
  }

  /** Inside each chunk's transaction: everything that must commit atomically with the tasks. */
  private async afterTaskChunk(pc: PageContext, tx: Prisma.TransactionClient, plans: TaskPlan[], created: Array<{ id: string }>): Promise<void> {
    const { job } = pc;
    await this.refs.upsertMany(
      job.connectionId,
      job.id,
      plans.map((p, n) => ({ externalType: REF.task, externalId: p.mapped.externalId, externalKey: p.mapped.key ?? null, localType: 'task', localId: created[n].id, contentHash: mappedTaskHash(p.mapped) })),
      tx,
    );
    const tagRows = plans.flatMap((p, n) => p.tagIds.map((tagId) => ({ taskId: created[n].id, tagId })));
    if (tagRows.length) await tx.taskTag.createMany({ data: tagRows, skipDuplicates: true });
    const valueRows = plans.flatMap((p, n) => p.values.map((v) => ({ taskId: created[n].id, fieldId: v.fieldId, value: v.value as Prisma.InputJsonValue })));
    if (valueRows.length) await tx.taskCustomValue.createMany({ data: valueRows, skipDuplicates: true });
    // step 4.6: the files of these tasks, queued in the same transaction (diagram 05: "enqueue file refs")
    if (job.options.attachments) {
      const files = plans.flatMap((p, n) =>
        p.mapped.attachments.map((a) => ({
          importJobId: job.id,
          externalId: a.externalId,
          taskId: created[n].id,
          fileName: a.fileName,
          mimeType: a.mimeType ?? null,
          sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : null,
          providerRef: a.providerRef,
          uploadedById: a.uploader.kind === 'user' ? a.uploader.userId : job.createdById,
          sourceCreatedAt: job.options.keepDates && a.createdAt ? new Date(a.createdAt) : null,
        })),
      );
      if (files.length) await tx.importFileItem.createMany({ data: files, skipDuplicates: true });
    }
    const pending = plans.filter((p) => p.pendingParent).map((p) => ({ importJobId: job.id, kind: 'PARENT', fromExternalId: p.mapped.externalId, toExternalId: p.pendingParent as string, depType: '' }));
    if (pending.length) await tx.importPendingLink.createMany({ data: pending, skipDuplicates: true });

    // the monthly meter and the counters move with the rows (a rollback refunds exactly what was charged)
    const period = await this.usage.charge(job.accountId, created.length, new Date(), tx);
    const before = pc.tracker.snapshot();
    pc.tracker.charge(period, created.length);
    pc.tracker.add('task', 'created', created.length);
    try {
      await tx.importJob.update({ where: { id: job.id }, data: { progress: pc.tracker.snapshot() as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      Object.assign(pc.tracker, new ProgressTracker(before));
      throw e;
    }
  }

  // ================================================================================================ links

  /** Dependencies of a page: both ends known -> created now; otherwise pending until the LINKS phase. */
  async writeDependencies(pc: PageContext, page: MappedPage): Promise<void> {
    const deps = page.dependencies;
    if (deps.length === 0) return;
    const { job } = pc;
    for (let i = 0; i < deps.length; i += LINK_BATCH) {
      const batch = deps.slice(i, i + LINK_BATCH);
      const known = await this.lookup(job, REF.task, batch.flatMap((d) => [d.fromExternalId, d.toExternalId]));
      await this.prisma.$transaction(async (tx) => {
        for (const d of batch) {
          const a = known.get(d.fromExternalId)?.localId;
          const b = known.get(d.toExternalId)?.localId;
          if (a && b) await this.insertDependency(pc, tx, d.externalId, a, b, d.type);
          else await tx.importPendingLink.createMany({ data: [{ importJobId: job.id, kind: 'DEPENDENCY', fromExternalId: d.fromExternalId, toExternalId: d.toExternalId, depType: d.type }], skipDuplicates: true });
        }
      });
    }
  }

  private async insertDependency(pc: PageContext, tx: Prisma.TransactionClient, extId: string, blockingId: string, blockedId: string, type: DependencyType): Promise<void> {
    if (blockingId === blockedId) return;
    if (type === DependencyType.BLOCKS && (await this.reaches(tx, blockedId, blockingId))) {
      pc.issues.push({ severity: Sev.WARN, code: 'DEPENDENCY_CYCLE', externalRef: `dependency:${extId}`, message: 'This link would make tasks block each other in a loop; it was skipped' });
      return;
    }
    const { count } = await tx.taskDependency.createMany({ data: [{ blockingTaskId: blockingId, blockedTaskId: blockedId, type }], skipDuplicates: true });
    if (count > 0) pc.tracker.add('dependency', 'created');
  }

  /** Does a chain of BLOCKS links lead from `from` to `to`? Bounded: a search that gets too wide counts as "no". */
  private async reaches(tx: Prisma.TransactionClient, from: string, to: string): Promise<boolean> {
    const seen = new Set<string>([from]);
    let frontier = [from];
    while (frontier.length && seen.size < CYCLE_SEARCH_LIMIT) {
      const next = await tx.taskDependency.findMany({ where: { blockingTaskId: { in: frontier }, type: DependencyType.BLOCKS }, select: { blockedTaskId: true } });
      frontier = [];
      for (const n of next) {
        if (n.blockedTaskId === to) return true;
        if (!seen.has(n.blockedTaskId)) { seen.add(n.blockedTaskId); frontier.push(n.blockedTaskId); }
      }
    }
    return false;
  }

  /** The LINKS phase: everything a task page could not do yet. Each link is resolved, applied or reported, then deleted. */
  async resolvePendingLinks(pc: PageContext, shouldStop: () => Promise<boolean>): Promise<void> {
    const { job } = pc;
    let after = '';
    for (;;) {
      if (await shouldStop()) return;
      const batch = await this.prisma.importPendingLink.findMany({ where: { importJobId: job.id, id: { gt: after } }, orderBy: { id: 'asc' }, take: LINK_BATCH });
      if (batch.length === 0) return;
      after = batch[batch.length - 1].id;
      const known = await this.lookup(job, REF.task, batch.flatMap((l) => [l.fromExternalId, l.toExternalId]));
      for (const l of batch) {
        const a = known.get(l.fromExternalId)?.localId;
        const b = known.get(l.toExternalId)?.localId;
        if (!a || !b) {
          pc.issues.push({ severity: Sev.WARN, code: l.kind === 'PARENT' ? 'PARENT_MISSING' : 'DEPENDENCY_MISSING', externalRef: `task:${l.fromExternalId}`, message: `${l.kind === 'PARENT' ? 'Its parent' : 'A task it is linked to'} (${!a ? l.fromExternalId : l.toExternalId}) was not imported, so the link was dropped` });
          pc.tracker.add('link', 'failed');
          continue;
        }
        try {
          await this.domain.run(this.ctx(job), async (c) => {
            const tx = c.tx as Prisma.TransactionClient;
            if (l.kind === 'PARENT') {
              if (await this.domain.attachImportedChild(job.workspaceId, a, b, c)) pc.tracker.add('link', 'created');
            } else await this.insertDependency(pc, tx, `${l.fromExternalId}>${l.toExternalId}`, a, b, l.depType as DependencyType);
          });
        } catch (e) {
          if (classifyImportError(e).kind !== 'ITEM') throw e;
          pc.issues.push({ severity: Sev.WARN, code: 'LINK_REJECTED', externalRef: `task:${l.fromExternalId}`, message: `A link could not be created: ${(unwrap(e) as Error).message}` });
          pc.tracker.add('link', 'failed');
        }
      }
      await this.prisma.importPendingLink.deleteMany({ where: { id: { in: batch.map((l) => l.id) } } });
    }
  }
}

/** A custom field key: lower-case letters, digits and underscores, unique among `taken` (which it extends). */
export function uniqueKey(name: string, taken: Set<string>): string {
  const base = foldName(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'field';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}
