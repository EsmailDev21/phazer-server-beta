import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  Prisma,
  TaskStatus,
} from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { newEntityId } from '../../domain-writer/entity-id';
import { ActivityService } from '../../events/activity.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateWorkflowStatusDto,
  SetTransitionsDto,
  UpdateWorkflowSettingsDto,
  UpdateWorkflowStatusDto,
} from './dto/workflow.dto';
import { normalizeStatusName } from './workflow-name';
import {
  CurrentTaskStatus,
  DEFAULT_WORKFLOW,
  ResolveResult,
  StatusRow,
  WorkflowSnapshot,
  WriteRequest,
  assertWorkflowValid,
  electDefaults,
  findStatusOrThrow,
  remapForProject,
  renumber,
  resolveWrite,
} from './workflow-rules';

type Db = Prisma.TransactionClient | PrismaService;

export interface SeedDefinition {
  name: string;
  color?: string;
  category: TaskStatus;
  excludeFromProgress?: boolean;
  /** Flag as its category's default (otherwise the first of the category is). */
  isDefault?: boolean;
  /** The status new tasks start in (at most one; must be To Do). Default: the To Do default. */
  isInitial?: boolean;
}

/**
 * ADR-0006. Everything that reads or writes a project's workflow. TasksService
 * and ProjectsService call the resolve/seed methods; nothing else may write
 * `Task.status` / `Task.workflowStatusId` together.
 *
 * LOCKING. Task writes that resolve a status take a SHARED per-project advisory
 * lock (many may run together); every workflow edit takes the EXCLUSIVE one.
 * A task write therefore never reads a status that an edit is deleting or
 * re-categorising. Callers take the lock BEFORE writing any task row, so a
 * task write and an edit cannot wait on each other's row locks.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityService: ActivityService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  // ---------------------------------------------------------------- locks

  async lockShared(tx: Prisma.TransactionClient, projectId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`workflow:${projectId}`}, 0))`;
  }

  async lockExclusive(tx: Prisma.TransactionClient, projectId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow:${projectId}`}, 0))`;
  }

  // ------------------------------------------------------------- snapshots

  async loadSnapshot(
    db: Db,
    projectId: string,
    opts: { withTransitions?: boolean } = {},
  ): Promise<WorkflowSnapshot> {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        enforceTransitions: true,
        defaultWorkflowStatusId: true,
        workflowStatuses: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    const needTransitions = opts.withTransitions ?? project.enforceTransitions;
    const transitions = needTransitions
      ? await db.workflowTransition.findMany({
          where: { projectId },
          select: { fromStatusId: true, toStatusId: true },
        })
      : [];
    return {
      projectId,
      statuses: project.workflowStatuses.map(toRow),
      initialStatusId: project.defaultWorkflowStatusId,
      enforceTransitions: project.enforceTransitions,
      transitions,
    };
  }

  // ----------------------------------------------------------------- seed

  /**
   * Creates a project's statuses (decision 2) and points the project at its
   * initial one. Runs on the caller's client, normally the project-create
   * transaction. `definitions` lets templates/importers (3.x/4.x) bring their own.
   */
  async seedDefaults(
    db: Db,
    projectId: string,
    definitions?: SeedDefinition[],
  ): Promise<void> {
    const defs: SeedDefinition[] = definitions ?? [...DEFAULT_WORKFLOW];
    const rows: StatusRow[] = defs.map((d, i) => {
      const { name, nameKey } = normalizeStatusName(d.name);
      return {
        id: newEntityId(),
        name,
        nameKey,
        color: d.color ?? '#94A3B8',
        position: i,
        category: d.category,
        isDefault: d.isDefault ?? false,
        excludeFromProgress: d.excludeFromProgress ?? false,
      };
    });
    const elected = electDefaults(rows);
    const initialIndex = defs.findIndex((d) => d.isInitial);
    const initialId =
      initialIndex >= 0
        ? elected[initialIndex].id
        : (elected.find((s) => s.category === TaskStatus.TODO && s.isDefault)
            ?.id ?? null);
    assertWorkflowValid(elected, initialId);
    await db.workflowStatus.createMany({
      data: elected.map((s) => ({ ...s, projectId })),
    });
    await db.project.update({
      where: { id: projectId },
      data: { defaultWorkflowStatusId: initialId },
    });
  }

  // -------------------------------------------------- task-side resolution

  /**
   * The (status, workflowStatusId) a NEW task gets. Inbox (no project) has no
   * workflow: it keeps only the category. Never restricted by transitions.
   */
  async resolveForCreate(
    tx: Prisma.TransactionClient,
    projectId: string | null | undefined,
    req: WriteRequest,
  ): Promise<{ status: TaskStatus; workflowStatusId: string | null }> {
    if (!projectId) return this.inboxResult(req);
    await this.lockShared(tx, projectId);
    const snap = await this.loadSnapshot(tx, projectId, {
      withTransitions: false,
    });
    const r = resolveWrite(snap, null, req, { enforce: false });
    return { status: r.status, workflowStatusId: r.workflowStatusId };
  }

  /**
   * An EXISTING task's status after `req`. `enforce` false is for system writers
   * (IMPORT / TEMPLATE) that reproduce history (decision 7).
   */
  async resolveForUpdate(
    tx: Prisma.TransactionClient,
    projectId: string | null,
    current: CurrentTaskStatus,
    req: WriteRequest,
    opts: { enforce: boolean },
  ): Promise<ResolveResult & { workflowStatusId: string | null }> {
    if (!projectId) {
      const r = this.inboxResult(req, current);
      return { ...r, changed: r.status !== current.status };
    }
    await this.lockShared(tx, projectId);
    const snap = await this.loadSnapshot(tx, projectId);
    return resolveWrite(snap, current, req, opts);
  }

  /**
   * Bulk create (DomainWriter chunks): one snapshot per distinct project, locks
   * taken in id order so two chunks cannot deadlock on each other.
   */
  async resolveForBulk(
    tx: Prisma.TransactionClient,
    items: Array<{
      projectId?: string | null;
      status?: TaskStatus;
      workflowStatusId?: string;
    }>,
  ): Promise<Array<{ status: TaskStatus; workflowStatusId: string | null }>> {
    const ids = Array.from(
      new Set(items.map((i) => i.projectId).filter((p): p is string => !!p)),
    ).sort();
    const snaps = new Map<string, WorkflowSnapshot>();
    for (const id of ids) {
      await this.lockShared(tx, id);
      snaps.set(
        id,
        await this.loadSnapshot(tx, id, { withTransitions: false }),
      );
    }
    return items.map((item) => {
      if (!item.projectId) return this.inboxResult(item);
      const r = resolveWrite(snaps.get(item.projectId)!, null, item, {
        enforce: false,
      });
      return { status: r.status, workflowStatusId: r.workflowStatusId };
    });
  }

  /**
   * Decision 6. After tasks moved into `targetProjectId` (or the Inbox, null),
   * point each at the right status there. Category never changes. Caller holds
   * the tree lock; this takes the shared workflow lock FIRST (before any task row
   * it writes) only if the caller has not - see TasksService.update.
   */
  async remapTasksToProject(
    tx: Prisma.TransactionClient,
    taskIds: string[],
    targetProjectId: string | null,
  ): Promise<void> {
    if (taskIds.length === 0) return;
    if (targetProjectId === null) {
      await tx.task.updateMany({
        where: { id: { in: taskIds } },
        data: { workflowStatusId: null },
      });
      return;
    }
    const target = await this.loadSnapshot(tx, targetProjectId, {
      withTransitions: false,
    });
    const tasks = await tx.task.findMany({
      where: { id: { in: taskIds } },
      select: {
        id: true,
        status: true,
        workflowStatus: { select: { nameKey: true } },
      },
    });
    const groups = new Map<string, string[]>(); // target status id -> task ids
    for (const t of tasks) {
      const targetId = remapForProject(target.statuses, {
        category: t.status,
        nameKey: t.workflowStatus?.nameKey ?? null,
      });
      if (!targetId) continue;
      groups.set(targetId, [...(groups.get(targetId) ?? []), t.id]);
    }
    for (const [workflowStatusId, ids] of groups) {
      await tx.task.updateMany({
        where: { id: { in: ids } },
        data: { workflowStatusId },
      });
    }
  }

  private inboxResult(
    req: WriteRequest,
    current?: CurrentTaskStatus,
  ): { status: TaskStatus; workflowStatusId: string | null } {
    if (req.workflowStatusId !== undefined) {
      throw new BadRequestException(
        'A task without a project has no workflow: workflowStatusId needs a projectId',
      );
    }
    return {
      status: req.status ?? current?.status ?? TaskStatus.TODO,
      workflowStatusId: null,
    };
  }

  // ------------------------------------------------------------------ reads

  async getWorkflow(projectId: string, userId: string) {
    if (
      !(await this.permissionResolver.hasProjectLevelAccess(userId, projectId))
    ) {
      // Same answer as a missing project: do not reveal which ids exist.
      throw new NotFoundException('Project not found');
    }
    return this.describe(this.prisma, projectId);
  }

  private async describe(db: Db, projectId: string) {
    const snap = await this.loadSnapshot(db, projectId, {
      withTransitions: true,
    });
    const counts = await db.task.groupBy({
      by: ['workflowStatusId'],
      where: { projectId },
      _count: true,
    });
    const countBy = new Map(counts.map((c) => [c.workflowStatusId, c._count]));
    return {
      projectId,
      enforceTransitions: snap.enforceTransitions,
      defaultStatusId: snap.initialStatusId,
      statuses: [...snap.statuses]
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          position: s.position,
          category: s.category,
          isDefault: s.isDefault,
          excludeFromProgress: s.excludeFromProgress,
          taskCount: countBy.get(s.id) ?? 0,
        })),
      transitions: snap.transitions,
    };
  }

  // ---------------------------------------------------------------- edits

  async createStatus(
    projectId: string,
    dto: CreateWorkflowStatusDto,
    actorId: string,
  ) {
    const { name, nameKey } = normalizeStatusName(dto.name);
    const result = await this.edit(projectId, async (tx, snap) => {
      const row: StatusRow = {
        id: newEntityId(),
        name,
        nameKey,
        color: dto.color ?? '#94A3B8',
        position: 0,
        category: dto.category,
        isDefault: dto.isDefault === true,
        excludeFromProgress: dto.excludeFromProgress === true,
      };
      const ordered = [...snap.statuses].sort(byOrder);
      const at = Math.min(dto.position ?? ordered.length, ordered.length);
      ordered.splice(at, 0, row);
      const after = this.settleDefaults(
        renumber(ordered),
        row.id,
        dto.isDefault,
      );
      return {
        after,
        initialStatusId: snap.initialStatusId,
        meta: {
          op: 'status_created',
          statusId: row.id,
          name,
          category: row.category,
        },
      };
    });
    await this.audit(result.workspaceId, projectId, actorId, result.meta);
    return this.describe(this.prisma, projectId);
  }

  async updateStatus(
    projectId: string,
    statusId: string,
    dto: UpdateWorkflowStatusDto,
    actorId: string,
  ) {
    if (dto.isDefault === false) {
      throw new BadRequestException(
        'A category must always have a default: make ANOTHER status the default instead',
      );
    }
    const renamed =
      dto.name !== undefined ? normalizeStatusName(dto.name) : null;
    const result = await this.edit(projectId, async (tx, snap) => {
      const before = findStatusOrThrow(snap.statuses, statusId);
      const categoryChanges =
        dto.category !== undefined && dto.category !== before.category;
      const patched: StatusRow = {
        ...before,
        ...(renamed ? renamed : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.excludeFromProgress !== undefined
          ? { excludeFromProgress: dto.excludeFromProgress }
          : {}),
        ...(categoryChanges
          ? { category: dto.category as TaskStatus, isDefault: false }
          : {}),
      };
      const after = this.settleDefaults(
        snap.statuses.map((s) => (s.id === statusId ? patched : s)),
        statusId,
        dto.isDefault,
      );
      let tasksAffected = 0;
      if (categoryChanges) {
        // Decision 9: recompute the tasks' category in the same transaction.
        // Progress is computed at read time, so nothing else needs fixing.
        const r = await tx.task.updateMany({
          where: { workflowStatusId: statusId },
          data: { status: patched.category },
        });
        tasksAffected = r.count;
      }
      return {
        after,
        initialStatusId: snap.initialStatusId,
        meta: {
          op: 'status_updated',
          statusId,
          ...(categoryChanges
            ? { from: before.category, to: patched.category, tasksAffected }
            : {}),
          ...(renamed ? { renamedFrom: before.name } : {}),
        },
      };
    });
    await this.audit(result.workspaceId, projectId, actorId, result.meta);
    return this.describe(this.prisma, projectId);
  }

  async deleteStatus(
    projectId: string,
    statusId: string,
    reassignTo: string | undefined,
    actorId: string,
  ) {
    const result = await this.edit(projectId, async (tx, snap) => {
      const doomed = findStatusOrThrow(snap.statuses, statusId);
      const used = await tx.task.count({
        where: { workflowStatusId: statusId },
      });
      if (used > 0 && !reassignTo) {
        throw new ConflictException({
          message: `${used} task(s) use this status: pass reassignTo=<another status id> to move them`,
          code: 'REASSIGN_REQUIRED',
          details: { taskCount: used },
        });
      }
      let target: StatusRow | null = null;
      if (reassignTo) {
        if (reassignTo === statusId) {
          throw new BadRequestException(
            'reassignTo must be a different status',
          );
        }
        target = snap.statuses.find((s) => s.id === reassignTo) ?? null;
        if (!target) {
          throw new BadRequestException(
            'reassignTo does not belong to this project',
          );
        }
      }
      let initialStatusId = snap.initialStatusId;
      if (doomed.id === initialStatusId) {
        if (target && target.category !== TaskStatus.TODO) {
          throw new ConflictException(
            'This is the status new tasks start in: reassign to a To Do status, which then becomes the initial one',
          );
        }
        initialStatusId = target?.id ?? null; // else re-derived below
      }
      let after = electDefaults(snap.statuses.filter((s) => s.id !== statusId));
      if (initialStatusId === null) {
        initialStatusId =
          after.find((s) => s.category === TaskStatus.TODO && s.isDefault)
            ?.id ?? null;
      }
      let tasksAffected = 0;
      if (used > 0 && target) {
        const r = await tx.task.updateMany({
          where: { workflowStatusId: statusId },
          data: { workflowStatusId: target.id, status: target.category },
        });
        tasksAffected = r.count;
      }
      after = renumber([...after].sort(byOrder));
      return {
        after,
        initialStatusId,
        meta: {
          op: 'status_deleted',
          statusId,
          name: doomed.name,
          reassignedTo: target?.id ?? null,
          from: doomed.category,
          to: target?.category ?? null,
          tasksAffected,
        },
      };
    });
    await this.audit(result.workspaceId, projectId, actorId, result.meta);
    return this.describe(this.prisma, projectId);
  }

  async reorder(projectId: string, statusIds: string[], actorId: string) {
    const result = await this.edit(projectId, async (_tx, snap) => {
      const ids = new Set(snap.statuses.map((s) => s.id));
      if (
        statusIds.length !== ids.size ||
        new Set(statusIds).size !== statusIds.length ||
        statusIds.some((id) => !ids.has(id))
      ) {
        throw new BadRequestException(
          'statusIds must list every status of the project exactly once',
        );
      }
      const byId = new Map(snap.statuses.map((s) => [s.id, s]));
      return {
        after: renumber(statusIds.map((id) => byId.get(id)!)),
        initialStatusId: snap.initialStatusId,
        meta: { op: 'statuses_reordered' },
      };
    });
    await this.audit(result.workspaceId, projectId, actorId, result.meta);
    return this.describe(this.prisma, projectId);
  }

  async setTransitions(
    projectId: string,
    dto: SetTransitionsDto,
    actorId: string,
  ) {
    const { workspaceId } = await this.prisma.$transaction(async (tx) => {
      await this.lockExclusive(tx, projectId);
      const snap = await this.loadSnapshot(tx, projectId, {
        withTransitions: false,
      });
      const ids = new Set(snap.statuses.map((s) => s.id));
      const seen = new Set<string>();
      const pairs: Array<{ fromStatusId: string; toStatusId: string }> = [];
      for (const t of dto.transitions) {
        if (!ids.has(t.fromStatusId) || !ids.has(t.toStatusId)) {
          throw new BadRequestException(
            'Every transition must connect two statuses of this project',
          );
        }
        if (t.fromStatusId === t.toStatusId) {
          throw new BadRequestException(
            'A transition from a status to itself is meaningless',
          );
        }
        const key = `${t.fromStatusId}>${t.toStatusId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(t);
      }
      if (snap.enforceTransitions && pairs.length === 0) {
        throw new ConflictException(
          'Transitions are enforced: an empty set would freeze every task. Turn enforcement off first',
        );
      }
      await tx.workflowTransition.deleteMany({ where: { projectId } });
      await tx.workflowTransition.createMany({
        data: pairs.map((p) => ({ ...p, projectId })),
      });
      const project = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { workspaceId: true },
      });
      return { workspaceId: project.workspaceId, count: pairs.length };
    });
    await this.audit(workspaceId, projectId, actorId, {
      op: 'transitions_set',
    });
    return this.describe(this.prisma, projectId);
  }

  async updateSettings(
    projectId: string,
    dto: UpdateWorkflowSettingsDto,
    actorId: string,
  ) {
    const { workspaceId } = await this.prisma.$transaction(async (tx) => {
      await this.lockExclusive(tx, projectId);
      const snap = await this.loadSnapshot(tx, projectId, {
        withTransitions: true,
      });
      if (dto.defaultStatusId !== undefined) {
        assertWorkflowValid(snap.statuses, dto.defaultStatusId);
      }
      if (dto.enforceTransitions === true && snap.transitions.length === 0) {
        throw new ConflictException(
          'Define at least one transition before enforcing them: with none, every task would be frozen',
        );
      }
      const project = await tx.project.update({
        where: { id: projectId },
        data: {
          ...(dto.enforceTransitions !== undefined
            ? { enforceTransitions: dto.enforceTransitions }
            : {}),
          ...(dto.defaultStatusId !== undefined
            ? { defaultWorkflowStatusId: dto.defaultStatusId }
            : {}),
        },
        select: { workspaceId: true },
      });
      return { workspaceId: project.workspaceId };
    });
    await this.audit(workspaceId, projectId, actorId, {
      op: 'settings_updated',
      ...(dto.enforceTransitions !== undefined
        ? { enforceTransitions: dto.enforceTransitions }
        : {}),
      ...(dto.defaultStatusId !== undefined
        ? { defaultStatusId: dto.defaultStatusId }
        : {}),
    });
    return this.describe(this.prisma, projectId);
  }

  // -------------------------------------------------------------- internals

  /**
   * Every status edit: exclusive lock, load, let `plan` compute the new list (and
   * touch tasks), validate the result, persist the difference. All one transaction.
   */
  private async edit(
    projectId: string,
    plan: (
      tx: Prisma.TransactionClient,
      snap: WorkflowSnapshot,
    ) => Promise<{
      after: StatusRow[];
      initialStatusId: string | null;
      meta: Record<string, unknown>;
    }>,
  ): Promise<{ workspaceId: string; meta: Record<string, unknown> }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockExclusive(tx, projectId);
        const snap = await this.loadSnapshot(tx, projectId, {
          withTransitions: false,
        });
        const { after, initialStatusId, meta } = await plan(tx, snap);
        assertWorkflowValid(after, initialStatusId);
        await this.persist(
          tx,
          projectId,
          snap.statuses,
          after,
          initialStatusId,
        );
        const project = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { workspaceId: true },
        });
        return { workspaceId: project.workspaceId, meta };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A status with that name already exists in this project (names are case-insensitive)',
        );
      }
      throw err;
    }
  }

  /** Makes `focusId` the default of its category when asked; otherwise repairs. */
  private settleDefaults(
    statuses: StatusRow[],
    focusId: string,
    makeDefault: boolean | undefined,
  ): StatusRow[] {
    if (makeDefault === true) {
      const focus = statuses.find((s) => s.id === focusId)!;
      return electDefaults(
        statuses.map((s) =>
          s.category === focus.category
            ? { ...s, isDefault: s.id === focusId }
            : s,
        ),
      );
    }
    return electDefaults(statuses);
  }

  /**
   * Writes `after` over `before`. Order matters for the unique indexes: deletes
   * first, then flags that are being CLEARED, then everything else.
   */
  private async persist(
    tx: Prisma.TransactionClient,
    projectId: string,
    before: StatusRow[],
    after: StatusRow[],
    initialStatusId: string | null,
  ) {
    const beforeById = new Map(before.map((s) => [s.id, s]));
    const afterIds = new Set(after.map((s) => s.id));
    const removed = before.filter((s) => !afterIds.has(s.id)).map((s) => s.id);

    // The project's pointer must leave a status before that status is deleted.
    await tx.project.update({
      where: { id: projectId },
      data: { defaultWorkflowStatusId: null },
    });
    if (removed.length > 0) {
      await tx.workflowStatus.deleteMany({ where: { id: { in: removed } } });
    }
    for (const s of after) {
      const old = beforeById.get(s.id);
      if (old && old.isDefault && !s.isDefault) {
        await tx.workflowStatus.update({
          where: { id: s.id },
          data: { isDefault: false },
        });
      }
    }
    for (const s of after) {
      const old = beforeById.get(s.id);
      if (!old) {
        await tx.workflowStatus.create({ data: { ...s, projectId } });
      } else if (changed(old, s)) {
        await tx.workflowStatus.update({
          where: { id: s.id },
          data: {
            name: s.name,
            nameKey: s.nameKey,
            color: s.color,
            position: s.position,
            category: s.category,
            excludeFromProgress: s.excludeFromProgress,
            isDefault: s.isDefault,
          },
        });
      }
    }
    await tx.project.update({
      where: { id: projectId },
      data: { defaultWorkflowStatusId: initialStatusId },
    });
  }

  private async audit(
    workspaceId: string,
    projectId: string,
    actorId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.activityService.record({
      actorId,
      action: ActivityAction.WORKFLOW_CHANGED,
      targetType: ActivityTargetType.PROJECT,
      targetId: projectId,
      workspaceId,
      metadata: metadata as Prisma.InputJsonValue,
    });
  }
}

const byOrder = (a: StatusRow, b: StatusRow) =>
  a.position - b.position || a.id.localeCompare(b.id);

function toRow(s: {
  id: string;
  name: string;
  nameKey: string;
  color: string;
  position: number;
  category: TaskStatus;
  isDefault: boolean;
  excludeFromProgress: boolean;
}): StatusRow {
  return {
    id: s.id,
    name: s.name,
    nameKey: s.nameKey,
    color: s.color,
    position: s.position,
    category: s.category,
    isDefault: s.isDefault,
    excludeFromProgress: s.excludeFromProgress,
  };
}

function changed(a: StatusRow, b: StatusRow): boolean {
  return (
    a.name !== b.name ||
    a.nameKey !== b.nameKey ||
    a.color !== b.color ||
    a.position !== b.position ||
    a.category !== b.category ||
    a.excludeFromProgress !== b.excludeFromProgress ||
    a.isDefault !== b.isDefault
  );
}
