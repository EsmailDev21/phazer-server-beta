import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  CreationMode,
  DependencyType,
  Prisma,
  Task,
  TaskStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityService } from '../../events/activity.service';
import {
  WriteContext,
  assertWriteContext,
} from '../../domain-writer/write-context';
import { newEntityId } from '../../domain-writer/entity-id';
import { BulkTaskItem, TaskWriteExtras } from './task-write.types';
import { TaskTreeService } from './task-tree.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  PlanningResult,
  TaskPlanningService,
} from '../planning/task-planning.service';
import { MAX_TASK_DEPTH, leafProgress } from './task-tree';
import { formatTaskKey } from '../../tenancy/workspaces/workspace-key';
import { TaskVisibilityService } from './task-visibility.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { SetAssigneesDto } from './dto/set-assignees.dto';
import { CreateDependencyDto } from './dto/create-dependency.dto';
import {
  TaskDetailDto,
  TaskListItemDto,
  TaskTableItemDto,
  MAX_EXTERNAL_LINKS_IN_DETAIL,
} from './dto/task-response.dto';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: TaskVisibilityService,
    private readonly activityService: ActivityService,
    private readonly tree: TaskTreeService,
    private readonly workflow: WorkflowService,
    private readonly planning: TaskPlanningService,
  ) {}

  /**
   * `ctx` omitted (every controller call) = exactly the behaviour pinned by
   * the -1.3 characterization suite: createdVia MANUAL, task insert then
   * activity insert, immediate emit, no transaction (ADR-0003 decisions 1, 5).
   *
   * With a `ctx` (DomainWriter only): `ctx.origin` becomes `createdVia`,
   * everything runs on `ctx.tx` when present, and `silent` suppresses the
   * emit. `extras` carries the server-only fields (original dates, assignees).
   */
  /** IMPORT / TEMPLATE writers reproduce history, which may include closed iterations. */
  private mayReplayHistory(ctx?: WriteContext): boolean {
    return ctx?.origin === 'IMPORT' || ctx?.origin === 'TEMPLATE';
  }

  async create(
    dto: CreateTaskDto,
    createdById: string,
    ctx?: WriteContext,
    extras?: TaskWriteExtras,
  ) {
    if (ctx) assertWriteContext(ctx);
    this.assertExtrasAllowed(extras, ctx);
    const db = ctx?.tx ?? this.prisma;

    const workspace = await db.workspace.findUnique({
      where: { id: dto.workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    if (dto.projectId) {
      const project = await db.project.findUnique({
        where: { id: dto.projectId },
      });
      if (!project || project.workspaceId !== dto.workspaceId) {
        throw new BadRequestException(
          'projectId does not belong to this workspace',
        );
      }
    }

    // App-layer rule (not DB-expressible): startDate must be <= dueDate when both are set.
    this.assertDateOrder(dto.startDate, dto.dueDate);

    const assigneeIds = this.dedupe(extras?.assigneeIds);
    await this.assertUsersExist(db, assigneeIds);

    // ADR-0004: take the next number and insert the task in ONE transaction.
    // The counter bump and the insert commit or roll back together, so a failed
    // create leaves no gap, and concurrent creates in a workspace serialize on
    // the workspace row. Inside a DomainWriter run the caller's transaction is
    // joined; otherwise a short one is opened here.
    // ADR-0005: a subtask must be visible-to-the-caller's parent in the same
    // project. The DomainWriter path authorises its own callers (ADR-0003).
    if (dto.parentId && !ctx) {
      if (!(await this.visibility.canViewTask(createdById, dto.parentId))) {
        throw new NotFoundException('Parent task not found');
      }
    }

    const insert = async (client: Prisma.TransactionClient) => {
      let projectId = dto.projectId;
      // Lock order is ALWAYS workflow-shared, then tree (see WorkflowService): a
      // status edit queued between the two could otherwise deadlock them.
      let lockProject = dto.projectId;
      if (!lockProject && dto.parentId) {
        lockProject =
          (
            await client.task.findUnique({
              where: { id: dto.parentId },
              select: { projectId: true },
            })
          )?.projectId ?? undefined;
      }
      if (lockProject) await this.workflow.lockShared(client, lockProject);
      if (dto.parentId) {
        // Every write that sets a parent takes the workspace tree lock first.
        await this.tree.lockTree(client, dto.workspaceId);
        const { parent } = await this.tree.assertCanBeParent(client, {
          parentId: dto.parentId,
          workspaceId: dto.workspaceId,
          childProjectId: dto.projectId, // undefined = inherit the parent's
          subtreeHeight: 0,
        });
        if (dto.projectId === undefined) {
          projectId = parent.projectId ?? undefined;
          // The route guard only sees the request body, so an INHERITED project
          // would slip past the task cap; count it here (ADR-0005 decision 7).
          await this.tree.assertCapacity(
            client,
            dto.workspaceId,
            parent.projectId,
            1,
          );
        }
      }
      // ADR-0006: the specific status is resolved against the FINAL project
      // (inherited from the parent when none was given). Takes the shared
      // workflow lock before any task row is written.
      const resolved = await this.workflow.resolveForCreate(client, projectId, {
        status: dto.status,
        workflowStatusId: dto.workflowStatusId,
      });
      // ADR-0007: type + iteration, validated against the final project. The iteration
      // row is locked FOR SHARE here, before any task row is written.
      const planned = await this.planning.resolveForCreate(
        client,
        { workspaceId: dto.workspaceId, projectId: projectId ?? null },
        { issueTypeId: dto.issueTypeId, iterationId: dto.iterationId },
        { allowClosed: this.mayReplayHistory(ctx) },
      );
      const number = await this.reserveTaskNumbers(client, dto.workspaceId, 1);
      return client.task.create({
        data: {
          workspaceId: dto.workspaceId,
          projectId,
          parentId: dto.parentId,
          issueTypeId: planned.issueTypeId,
          iterationId: planned.iterationId,
          estimate: dto.estimate ?? null,
          number,
          title: dto.title,
          description: dto.description,
          status: resolved.status,
          workflowStatusId: resolved.workflowStatusId,
          priority: dto.priority,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          createdById,
          createdVia: ctx ? ctx.origin : 'MANUAL',
          ...(ctx?.keepOriginalDates
            ? { createdAt: extras?.createdAt, updatedAt: extras?.updatedAt }
            : {}),
          ...(assigneeIds.length > 0
            ? { assignees: { connect: assigneeIds.map((id) => ({ id })) } }
            : {}),
        },
      });
    };
    const task = ctx?.tx
      ? await insert(ctx.tx)
      : await this.prisma.$transaction(insert);

    await this.activityService.record(
      {
        actorId: ctx ? ctx.actorId : createdById,
        action: ActivityAction.CREATED,
        targetType: ActivityTargetType.TASK,
        targetId: task.id,
        workspaceId: task.workspaceId,
        ...(dto.parentId ? { metadata: { parentId: dto.parentId } } : {}),
      },
      ctx,
    );

    // Same per-assignee ASSIGNED rows setAssignees writes, so a non-silent
    // create-with-assignees (chat) notifies exactly like create-then-assign.
    for (const assigneeId of assigneeIds) {
      await this.activityService.record(
        {
          actorId: ctx ? ctx.actorId : createdById,
          action: ActivityAction.ASSIGNED,
          targetType: ActivityTargetType.TASK,
          targetId: task.id,
          workspaceId: task.workspaceId,
          metadata: { assigneeId },
        },
        ctx,
      );
    }

    return task;
  }

  /**
   * ONE chunk of a bulk write (ADR-0003 decision 8). The caller
   * (DomainWriter.createTasksBulk) owns the transaction, the chunking and the
   * plan-limit check; this method owns validation and the inserts, so the
   * rules live in exactly one place with create() above.
   *
   * Requires `ctx.bulk` and `ctx.tx`. Never emits.
   */
  async createChunk(
    workspaceId: string,
    items: BulkTaskItem[],
    createdById: string,
    ctx: WriteContext,
  ) {
    assertWriteContext(ctx);
    if (!ctx.bulk || !ctx.tx) {
      throw new Error('TasksService.createChunk requires ctx.bulk and ctx.tx');
    }
    if (items.length === 0) return [];
    const db = ctx.tx;

    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // One query for every distinct project, not one per task.
    const projectIds = Array.from(
      new Set(items.map((i) => i.projectId).filter((p): p is string => !!p)),
    );
    if (projectIds.length > 0) {
      const projects = await db.project.findMany({
        where: { id: { in: projectIds }, workspaceId },
        select: { id: true },
      });
      const ok = new Set(projects.map((p) => p.id));
      const bad = projectIds.filter((id) => !ok.has(id));
      if (bad.length > 0) {
        throw new BadRequestException(
          `projectId does not belong to this workspace: ${bad.join(', ')}`,
        );
      }
    }

    // ADR-0006: one snapshot per distinct project, not one per task. Done BEFORE the
    // tree lock below: the lock order is always workflow-shared, then tree.
    const resolvedStatuses = await this.workflow.resolveForBulk(db, items);
    // ADR-0007: types/iterations (iteration rows locked FOR SHARE here, id-ordered).
    const resolvedPlanning = await this.planning.resolveForBulk(
      db,
      workspaceId,
      items,
      { allowClosed: this.mayReplayHistory(ctx) },
    );

    const allAssignees = this.dedupe(items.flatMap((i) => i.assigneeIds ?? []));
    await this.assertUsersExist(db, allAssignees);

    items.forEach((item) => {
      this.assertExtrasAllowed(item, ctx);
      this.assertDateOrder(item.startDate, item.dueDate);
    });

    // ADR-0005 decision 12: a chunk may contain trees. A parent is either an
    // EARLIER item of the same chunk (`parentIndex`) or an existing task
    // (`parentId`). Requiring parentIndex < own index makes a cycle inside a
    // chunk impossible and lets depth be computed in one pass.
    const depthByIndex: number[] = [];
    const existingParents = new Map<string, number>(); // parentId -> its depth
    if (items.some((i) => i.parentId || i.parentIndex !== undefined)) {
      await this.tree.lockTree(db, workspaceId);
      for (const [index, item] of items.entries()) {
        if (item.parentId && item.parentIndex !== undefined) {
          throw new BadRequestException(
            `item ${index}: give parentId OR parentIndex, not both`,
          );
        }
        if (item.parentIndex !== undefined) {
          const pi = item.parentIndex;
          if (!Number.isInteger(pi) || pi < 0 || pi >= index) {
            throw new BadRequestException(
              `item ${index}: parentIndex must refer to an EARLIER item of the same chunk`,
            );
          }
          if ((items[pi].projectId ?? null) !== (item.projectId ?? null)) {
            throw new BadRequestException(
              `item ${index}: a subtask must be in the same project as its parent`,
            );
          }
          depthByIndex[index] = depthByIndex[pi] + 1;
        } else if (item.parentId) {
          let parentDepth = existingParents.get(item.parentId);
          if (parentDepth === undefined) {
            ({ parentDepth } = await this.tree.assertCanBeParent(db, {
              parentId: item.parentId,
              workspaceId,
              childProjectId: item.projectId ?? null,
              subtreeHeight: 0,
            }));
            existingParents.set(item.parentId, parentDepth);
          } else {
            const parent = await db.task.findUnique({
              where: { id: item.parentId },
              select: { projectId: true },
            });
            if ((item.projectId ?? null) !== (parent?.projectId ?? null)) {
              throw new BadRequestException(
                `item ${index}: a subtask must be in the same project as its parent`,
              );
            }
          }
          depthByIndex[index] = parentDepth + 1;
        } else {
          depthByIndex[index] = 0;
        }
        if (depthByIndex[index] > MAX_TASK_DEPTH) {
          throw new BadRequestException(
            `item ${index}: subtasks can be nested at most ${MAX_TASK_DEPTH + 1} levels deep`,
          );
        }
      }
    }

    // ADR-0004: one atomic reservation for the whole chunk. The workspace row
    // stays locked until the chunk's transaction ends (the ADR's stated cost;
    // chunk size is tuned against measured lock time in step 1.7).
    const firstNumber = await this.reserveTaskNumbers(
      db,
      workspaceId,
      items.length,
    );
    const rows = items.map((item, index) => ({
      id: newEntityId(),
      number: firstNumber + index,
      item,
    }));

    const created = await db.task.createManyAndReturn({
      data: rows.map(({ id, number, item }, index) => ({
        id,
        number,
        workspaceId,
        projectId: item.projectId,
        parentId:
          item.parentIndex !== undefined
            ? rows[item.parentIndex].id
            : item.parentId,
        title: item.title,
        description: item.description,
        status: resolvedStatuses[index].status,
        workflowStatusId: resolvedStatuses[index].workflowStatusId,
        issueTypeId: resolvedPlanning[index].issueTypeId,
        iterationId: resolvedPlanning[index].iterationId,
        estimate: item.estimate ?? null,
        priority: item.priority,
        startDate: item.startDate ? new Date(item.startDate) : undefined,
        dueDate: item.dueDate ? new Date(item.dueDate) : undefined,
        createdById,
        createdVia: ctx.origin,
        ...(ctx.keepOriginalDates
          ? { createdAt: item.createdAt, updatedAt: item.updatedAt }
          : {}),
        ...(item.archived && ctx.origin === CreationMode.IMPORT
          ? { isArchived: true, archivedAt: item.updatedAt ?? new Date() }
          : {}),
      })),
    });

    // Implicit many-to-many cannot be written by createMany*. Per-row connect
    // is the engine-agnostic way; swapping this one block for a bulk insert
    // into "_TaskAssignees" is the optimisation ADR-0003 leaves to a benchmark.
    for (const { id, item } of rows) {
      const ids = this.dedupe(item.assigneeIds);
      if (ids.length === 0) continue;
      await db.task.update({
        where: { id },
        data: { assignees: { connect: ids.map((u) => ({ id: u })) } },
        select: { id: true },
      });
    }

    const activityRows: Parameters<ActivityService['recordMany']>[0] = [];
    for (const { id, item } of rows) {
      activityRows.push({
        actorId: ctx.actorId,
        action: ActivityAction.CREATED,
        targetType: ActivityTargetType.TASK,
        targetId: id,
        workspaceId,
      });
      for (const assigneeId of this.dedupe(item.assigneeIds)) {
        activityRows.push({
          actorId: ctx.actorId,
          action: ActivityAction.ASSIGNED,
          targetType: ActivityTargetType.TASK,
          targetId: id,
          workspaceId,
          metadata: { assigneeId },
        });
      }
    }
    await this.activityService.recordMany(activityRows, ctx);

    // createManyAndReturn does not promise input order; callers (bulk trees,
    // importers mapping source rows to ids) need it.
    const byId = new Map(created.map((t) => [t.id, t]));
    return rows.map(({ id }) => byId.get(id) as (typeof created)[number]);
  }

  /**
   * LIST_GUARD_FIX: ALWAYS routes through TaskVisibilityService, no
   * exceptions — this is the ONE query path every task-listing route uses
   * (replaces the old bug where GET /tasks and GET /project/:projectId had
   * ZERO guard). No @RequireAccess decorator here: there's no single named
   * action that both (a) has a real boolean per role and (b) returns true
   * for CLIENT, since CLIENT is false for nearly every named action by
   * design — visibility is answered entirely by TaskVisibilityService,
   * which itself calls PermissionResolver.hasWorkspaceLevelAccess.
   */
  async list(
    userId: string,
    query: QueryTasksDto,
  ): Promise<{
    data: TaskListItemDto[];
    total: number;
    take: number;
    skip: number;
  }> {
    const visible = await this.visibility.buildVisibleTasksWhere(userId, {
      workspaceId: query.workspaceId,
      projectId: query.projectId,
      status: query.status,
      assigneeId: query.assigneeId,
    });
    // ADR-0005 decision 11: with neither option set this is the unchanged
    // pre-subtask query (every task, subtasks included).
    const base: Prisma.TaskWhereInput = query.parentId
      ? { ...visible, parentId: query.parentId }
      : query.rootsOnly
        ? { ...visible, parentId: null }
        : visible;
    // ADR-0006 decision 5: `?status=` still filters by CATEGORY; this narrows to one
    // specific workflow status.
    const narrowing: Prisma.TaskWhereInput[] = [];
    if (query.workflowStatusId)
      narrowing.push({ workflowStatusId: query.workflowStatusId });
    if (query.issueTypeId) narrowing.push({ issueTypeId: query.issueTypeId });
    if (query.iterationId) narrowing.push({ iterationId: query.iterationId });
    const where: Prisma.TaskWhereInput =
      narrowing.length > 0 ? { AND: [base, ...narrowing] } : base;

    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        select: {
          id: true,
          title: true,
          status: true,
          workflowStatusId: true,
          issueTypeId: true,
          iterationId: true,
          estimate: true,
          priority: true,
          dueDate: true,
          startDate: true,
          projectId: true,
          parentId: true,
          assignees: { select: { id: true, name: true, avatar: true } },
        },
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.task.count({ where }),
    ]);

    const data = await this.attachCounts(rows);
    return { data, total, take: query.take, skip: query.skip };
  }

  async getDetail(taskId: string, userId: string): Promise<TaskDetailDto> {
    await this.visibility.assertCanView(userId, taskId);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        number: true,
        parentId: true,
        workspace: { select: { key: true } },
        title: true,
        description: true,
        status: true,
        workflowStatusId: true,
        workflowStatus: {
          select: { id: true, name: true, color: true, category: true },
        },
        issueTypeId: true,
        iterationId: true,
        estimate: true,
        issueType: {
          select: { id: true, name: true, icon: true, color: true, level: true },
        },
        iteration: {
          select: {
            id: true,
            name: true,
            kind: true,
            state: true,
            projectId: true,
          },
        },
        // Step 1.6: explicit field list - internal columns (taskId, createdAt, updatedAt)
        // never leave the API. Capped; the true total comes from _count.
        externalLinks: {
          orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
          take: MAX_EXTERNAL_LINKS_IN_DETAIL,
          select: {
            id: true,
            provider: true,
            kind: true,
            externalId: true,
            url: true,
            title: true,
            state: true,
            lastSeenAt: true,
          },
        },
        _count: { select: { externalLinks: true } },
        priority: true,
        dueDate: true,
        startDate: true,
        projectId: true,
        assignees: { select: { id: true, name: true, avatar: true } },
        tags: { select: { tag: { select: { id: true, name: true } } } },
        customValues: {
          select: {
            fieldId: true,
            value: true,
            field: {
              select: {
                id: true,
                name: true,
                key: true,
                dataType: true,
                options: true,
              },
            },
          },
        },
        dependenciesBlocked: {
          select: {
            id: true,
            type: true,
            blockingTask: { select: { id: true, title: true, status: true } },
          },
        },
        dependenciesBlocking: {
          select: {
            id: true,
            type: true,
            blockedTask: { select: { id: true, title: true, status: true } },
          },
        },
      },
    });
    if (!task) throw new NotFoundException('Task not found');

    const subtasks = await this.tree.descendants(this.prisma, taskId, {
      isArchived: false,
    });
    const [commentCount, attachmentCount] = await this.getCounts(taskId);

    return {
      id: task.id,
      number: task.number,
      parentId: task.parentId,
      subtaskCount: subtasks.filter((d) => d.depth === 1).length,
      subtaskProgress: leafProgress(subtasks),
      key:
        task.number !== null && task.workspace.key
          ? formatTaskKey(task.workspace.key, task.number)
          : null,
      title: task.title,
      status: task.status,
      workflowStatusId: task.workflowStatusId,
      workflowStatus: task.workflowStatus,
      issueTypeId: task.issueTypeId,
      iterationId: task.iterationId,
      estimate: task.estimate,
      issueType: task.issueType,
      iteration: task.iteration,
      externalLinks: task.externalLinks,
      externalLinkCount: task._count.externalLinks,
      priority: task.priority,
      dueDate: task.dueDate,
      startDate: task.startDate,
      projectId: task.projectId,
      assignees: task.assignees,
      description: task.description,
      commentCount,
      attachmentCount,
      customValues: task.customValues,
      tags: task.tags.map((t) => t.tag),
      blockedBy: task.dependenciesBlocked.map((d) => ({
        id: d.id,
        type: d.type,
        task: d.blockingTask,
      })),
      blocking: task.dependenciesBlocking.map((d) => ({
        id: d.id,
        type: d.type,
        task: d.blockedTask,
      })),
    };
  }

  /** Table view — customValues/tags flattened, `blocked` boolean instead of the full dependency arrays. */
  async getTableRow(taskId: string, userId: string): Promise<TaskTableItemDto> {
    await this.visibility.assertCanView(userId, taskId);
    return this.buildTableItem(taskId);
  }

  private async buildTableItem(taskId: string): Promise<TaskTableItemDto> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        status: true,
        workflowStatusId: true,
        issueTypeId: true,
        iterationId: true,
        estimate: true,
        priority: true,
        dueDate: true,
        startDate: true,
        projectId: true,
        parentId: true,
        assignees: { select: { id: true, name: true, avatar: true } },
        tags: { select: { tag: { select: { id: true, name: true } } } },
        customValues: {
          select: {
            fieldId: true,
            value: true,
            field: {
              select: {
                id: true,
                name: true,
                key: true,
                dataType: true,
                options: true,
              },
            },
          },
        },
        dependenciesBlocked: {
          where: { type: DependencyType.BLOCKS },
          select: { blockingTask: { select: { status: true } } },
        },
      },
    });
    if (!task) throw new NotFoundException('Task not found');

    const [commentCount, attachmentCount] = await this.getCounts(taskId);

    // `blocked`: true if any BLOCKS dependency's blocking task isn't DONE
    // yet — an indicator, not the full connector-line detail Gantt shows.
    const blocked = task.dependenciesBlocked.some(
      (d) => d.blockingTask.status !== 'DONE',
    );

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      workflowStatusId: task.workflowStatusId,
      issueTypeId: task.issueTypeId,
      iterationId: task.iterationId,
      estimate: task.estimate,
      priority: task.priority,
      dueDate: task.dueDate,
      startDate: task.startDate,
      projectId: task.projectId,
      parentId: task.parentId,
      assignees: task.assignees,
      commentCount,
      attachmentCount,
      customValues: task.customValues,
      tags: task.tags.map((t) => t.tag),
      blocked,
    };
  }

  /**
   * Step 4.4. Puts an already-created, parentless task under a parent that arrived on a LATER page of an import. The one
   * place besides `update` that writes `Task.parentId`, with the same rules (ADR-0005): same project, no cycle, depth bound
   * counting the child's own subtree, serialised by the tree lock. Needs `ctx.tx` (the importer's chunk transaction).
   *
   * Returns false (nothing written) when the child already has a parent. Throws 400 / 404 for a rule violation, which the
   * importer reports against that one task.
   */
  async attachImportedChild(
    workspaceId: string,
    taskId: string,
    parentId: string,
    ctx: WriteContext,
  ): Promise<boolean> {
    assertWriteContext(ctx);
    if (!ctx.tx) throw new Error('attachImportedChild requires ctx.tx');
    const tx = ctx.tx;
    await this.tree.lockTree(tx, workspaceId);
    const child = await tx.task.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true, projectId: true, parentId: true },
    });
    if (!child || child.workspaceId !== workspaceId) throw new NotFoundException('Task not found');
    if (child.parentId) return false;
    const below = await this.tree.descendants(tx, taskId);
    const subtreeHeight = below.reduce((h, d) => Math.max(h, d.depth), 0);
    await this.tree.assertCanBeParent(tx, {
      parentId,
      workspaceId,
      childId: taskId,
      childProjectId: child.projectId,
      subtreeHeight,
    });
    await tx.task.update({ where: { id: taskId }, data: { parentId } });
    return true;
  }

  /**
   * Step 4.7b: the importer re-points a link in an imported task's description once the file behind it has been copied
   * (`https://uploads.linear.app/...` -> our own stable file address). The ONLY text rewrite besides `update`: IMPORT origin only,
   * inside the importer's transaction, silent (no activity, no event). Returns false when the text does not contain `from`.
   */
  async rewriteImportedText(workspaceId: string, taskId: string, from: string, to: string, ctx: WriteContext): Promise<boolean> {
    assertWriteContext(ctx);
    if (!ctx.tx) throw new Error('rewriteImportedText requires ctx.tx');
    if (ctx.origin !== CreationMode.IMPORT) throw new Error('rewriteImportedText is for imports only');
    if (!from) return false;
    const t = await ctx.tx.task.findUnique({ where: { id: taskId }, select: { workspaceId: true, description: true, updatedAt: true } });
    if (!t || t.workspaceId !== workspaceId) throw new NotFoundException('Task not found');
    if (!t.description || !t.description.includes(from)) return false;
    // `updatedAt` is put back: this is a fix-up of the import, not an edit (the source's own time was kept on purpose)
    await ctx.tx.task.update({ where: { id: taskId }, data: { description: t.description.split(from).join(to), updatedAt: t.updatedAt } });
    return true;
  }

  /**
   * `actorId` null = an automation with no human behind it (GitHub status rules, step 2.6). `opts.ctx` only labels the
   * activity rows (origin INTEGRATION); `opts.metadata` is merged into every row written (e.g. which PR caused it).
   */
  async update(
    taskId: string,
    dto: UpdateTaskDto,
    actorId: string | null,
    opts?: { ctx?: WriteContext; metadata?: Prisma.InputJsonObject },
  ) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');

    const startDate =
      dto.startDate !== undefined
        ? dto.startDate
        : task.startDate?.toISOString();
    const dueDate =
      dto.dueDate !== undefined ? dto.dueDate : task.dueDate?.toISOString();
    this.assertDateOrder(startDate, dueDate);

    if (dto.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
      });
      if (!project || project.workspaceId !== task.workspaceId) {
        throw new BadRequestException(
          "projectId does not belong to this task's workspace",
        );
      }
    }

    // ADR-0005: `parentId` and `projectId` are pulled OUT of the DTO. This
    // method used to spread the whole DTO into Prisma; a parentId left in that
    // spread would bypass every tree rule (cycle, depth, same-project, lock).
    // ADR-0006: `status` / `workflowStatusId` are pulled out for the same reason -
    // they are only ever written together, by WorkflowService's resolution.
    const {
      parentId,
      projectId,
      status,
      workflowStatusId,
      issueTypeId,
      iterationId,
      ...fields
    } = dto;
    const fieldData = {
      ...fields,
      startDate:
        dto.startDate !== undefined ? new Date(dto.startDate) : undefined,
      dueDate: dto.dueDate !== undefined ? new Date(dto.dueDate) : undefined,
    };
    const parentChanges = parentId !== undefined && parentId !== task.parentId;
    const projectChanges =
      projectId !== undefined && projectId !== task.projectId;
    const statusRequested =
      status !== undefined || workflowStatusId !== undefined;
    // ADR-0007: type / iteration are validated in PlanningService, never spread into Prisma.
    const planningRequested =
      issueTypeId !== undefined || iterationId !== undefined;

    if (
      parentChanges &&
      parentId &&
      !(await this.visibility.canViewTask(actorId, parentId))
    ) {
      throw new NotFoundException('Parent task not found');
    }

    let updated: Task;
    let hierarchy: {
      plan: Awaited<ReturnType<TaskTreeService['planChange']>>;
      before: { parentId: string | null; projectId: string | null };
    } | null = null;
    let planningChange: PlanningResult | null = null;
    let movedIterationsCleared = 0;
    let statusChange: {
      fromStatusId: string | null;
      toStatusId: string | null;
      fromCategory: TaskStatus;
      toCategory: TaskStatus;
    } | null = null;

    if (
      !parentChanges &&
      !projectChanges &&
      !statusRequested &&
      !planningRequested
    ) {
      // The common case: nothing about the tree or the status changes. No transaction, no lock.
      updated = await this.prisma.task.update({
        where: { id: taskId },
        data: fieldData,
      });
    } else {
      const result = await this.prisma.$transaction(async (tx) => {
        // Lock order is ALWAYS workflow-shared, then tree. Taken before any task
        // row is written, so a status edit (exclusive) cannot deadlock with us.
        const workflowProject = projectChanges ? projectId : task.projectId;
        if (workflowProject && (statusRequested || projectChanges)) {
          await this.workflow.lockShared(tx, workflowProject);
        }
        // ADR-0007: the target iteration's row FOR SHARE, before any task row is written
        // (IterationsService.close locks it FOR UPDATE and then updates tasks).
        if (iterationId) await this.planning.lockIterations(tx, [iterationId]);
        if (parentChanges || projectChanges) {
          await this.tree.lockTree(tx, task.workspaceId);
        }
        // Re-read under the lock: the tree may have changed while we waited.
        const fresh = await tx.task.findUnique({ where: { id: taskId } });
        if (!fresh) throw new NotFoundException('Task not found');

        let plan: Awaited<ReturnType<TaskTreeService['planChange']>> | null =
          null;
        let iterationsCleared = 0;
        let saved: Task;
        if (parentChanges || projectChanges) {
          plan = await this.tree.planChange(tx, fresh, { parentId, projectId });
          saved = await tx.task.update({
            where: { id: taskId },
            data: {
              ...fieldData,
              parentId: plan.finalParentId,
              projectId: plan.finalProjectId,
            },
          });
          // A root moves WITH its subtree (ADR-0005 decision 9).
          if (plan.projectChanges && plan.descendantIds.length > 0) {
            await tx.task.updateMany({
              where: { id: { in: plan.descendantIds } },
              data: { projectId: plan.finalProjectId },
            });
          }
          // ADR-0006 decision 6: every moved task gets the matching status of the
          // target project (same category, so progress arithmetic is unaffected).
          if (plan.projectChanges) {
            await this.workflow.remapTasksToProject(
              tx,
              [taskId, ...plan.descendantIds],
              plan.finalProjectId,
            );
            iterationsCleared = await this.planning.clearForMove(
              tx,
              [taskId, ...plan.descendantIds],
              plan.finalProjectId,
            );
            saved = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
          }
        } else {
          saved = await tx.task.update({
            where: { id: taskId },
            data: fieldData,
          });
        }

        let change: typeof statusChange = null;
        if (statusRequested) {
          const resolved = await this.workflow.resolveForUpdate(
            tx,
            saved.projectId,
            { status: saved.status, workflowStatusId: saved.workflowStatusId },
            { status, workflowStatusId },
            { enforce: true },
          );
          saved = await tx.task.update({
            where: { id: taskId },
            data: {
              status: resolved.status,
              workflowStatusId: resolved.workflowStatusId,
            },
          });
          if (resolved.changed) {
            change = {
              fromStatusId: fresh.workflowStatusId,
              toStatusId: resolved.workflowStatusId,
              fromCategory: fresh.status,
              toCategory: resolved.status,
            };
          }
        }
        let planningResult: PlanningResult | null = null;
        if (planningRequested) {
          planningResult = await this.planning.resolveForUpdate(
            tx,
            {
              workspaceId: saved.workspaceId,
              projectId: saved.projectId,
              issueTypeId: saved.issueTypeId,
              iterationId: saved.iterationId,
            },
            { issueTypeId, iterationId },
            { allowClosed: false },
          );
          if (Object.keys(planningResult.data).length > 0) {
            saved = await tx.task.update({
              where: { id: taskId },
              data: planningResult.data,
            });
          }
        }
        return {
          saved,
          plan,
          change,
          planningResult,
          iterationsCleared,
          before: { parentId: fresh.parentId, projectId: fresh.projectId },
        };
      });
      updated = result.saved;
      statusChange = result.change;
      planningChange = result.planningResult;
      movedIterationsCleared = result.iterationsCleared;
      if (result.plan) {
        hierarchy = { plan: result.plan, before: result.before };
      }
    }

    // Diff old vs new — ONE Activity row per changed field, not one
    // "TASK_UPDATED" blob, so the fan-out can address each change to the
    // right NotificationType (STATUS_CHANGED/PRIORITY_CHANGED/etc.).
    const changes: {
      action: ActivityAction;
      metadata?: Prisma.InputJsonValue;
    }[] = [];
    // ADR-0006: fires when the SPECIFIC status changed (To Do -> Backlog is a real
    // change even inside one category), with both ends in the metadata.
    if (statusChange) {
      changes.push({
        action: ActivityAction.STATUS_CHANGED,
        metadata: statusChange,
      });
    }
    if (planningChange?.issueTypeChange) {
      changes.push({
        action: ActivityAction.ISSUE_TYPE_CHANGED,
        metadata: planningChange.issueTypeChange,
      });
    }
    if (planningChange?.iterationChange) {
      changes.push({
        action: ActivityAction.ITERATION_CHANGED,
        metadata: planningChange.iterationChange,
      });
    }
    if (dto.priority !== undefined && dto.priority !== task.priority)
      changes.push({ action: ActivityAction.PRIORITY_CHANGED });
    if (
      dto.dueDate !== undefined &&
      updated.dueDate?.getTime() !== task.dueDate?.getTime()
    ) {
      changes.push({ action: ActivityAction.DUE_DATE_CHANGED });
    }
    if (dto.description !== undefined && dto.description !== task.description) {
      changes.push({ action: ActivityAction.DESCRIPTION_UPDATED });
    }
    if (hierarchy?.plan.parentChanges) {
      changes.push({
        action: ActivityAction.PARENT_CHANGED,
        metadata: {
          from: hierarchy.before.parentId,
          to: hierarchy.plan.finalParentId,
        },
      });
    }
    if (hierarchy?.plan.projectChanges) {
      changes.push({
        action: ActivityAction.TASK_MOVED,
        metadata: {
          from: hierarchy.before.projectId,
          to: hierarchy.plan.finalProjectId,
          descendants: hierarchy.plan.descendantIds.length,
          ...(movedIterationsCleared > 0
            ? { iterationsCleared: movedIterationsCleared }
            : {}),
        },
      });
    }

    await Promise.all(
      changes.map((c) => {
        const base =
          c.metadata && typeof c.metadata === 'object' && !Array.isArray(c.metadata)
            ? (c.metadata as Prisma.InputJsonObject)
            : undefined;
        const metadata = opts?.metadata ? { ...(base ?? {}), ...opts.metadata } : c.metadata;
        return this.activityService.record(
          {
            actorId,
            action: c.action,
            targetType: ActivityTargetType.TASK,
            targetId: taskId,
            workspaceId: task.workspaceId,
            ...(metadata ? { metadata } : {}),
          },
          opts?.ctx,
        );
      }),
    );

    return updated;
  }

  /**
   * ADR-0005 decision 4: a task with subtasks is NOT deleted unless the caller
   * says `cascade`. The foreign key is NO ACTION, so even a code path that forgets
   * this check cannot orphan a child - the database refuses.
   */
  async delete(taskId: string, cascade = false): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    await this.prisma.$transaction(async (tx) => {
      await this.tree.lockTree(tx, task.workspaceId);
      const descendants = await this.tree.descendants(tx, taskId);
      if (descendants.length > 0 && !cascade) {
        throw new ConflictException(
          `This task has ${descendants.length} subtask(s). Delete them as well with ?cascade=true, or detach/move them first.`,
        );
      }
      // ONE statement for the whole subtree: the NO ACTION foreign key is
      // checked at the end of the statement, so parent and children go together.
      await tx.task.deleteMany({
        where: { id: { in: [taskId, ...descendants.map((d) => d.id)] } },
      });
    });
  }

  /**
   * ADR-0005 decision 5: archiving a parent archives its non-archived subtree
   * with the SAME `archivedAt`, which is what lets restore undo exactly this.
   * Archiving an already-archived task is a no-op: re-stamping it would break
   * that match for the children archived with it.
   */
  async archive(taskId: string, actorId: string, ctx?: WriteContext) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.isArchived) return task;

    const archivedAt = new Date();
    const { updated, descendantCount } = await this.prisma.$transaction(
      async (tx) => {
        await this.tree.lockTree(tx, task.workspaceId);
        const descendants = await this.tree.descendants(tx, taskId, {
          isArchived: false,
        });
        await tx.task.updateMany({
          where: {
            id: { in: [taskId, ...descendants.map((d) => d.id)] },
            isArchived: false,
          },
          data: { isArchived: true, archivedAt },
        });
        return {
          updated: await tx.task.findUniqueOrThrow({ where: { id: taskId } }),
          descendantCount: descendants.length,
        };
      },
    );
    const params = {
      actorId,
      action: ActivityAction.ARCHIVED,
      targetType: ActivityTargetType.TASK,
      targetId: taskId,
      workspaceId: task.workspaceId,
      ...(descendantCount > 0
        ? { metadata: { descendants: descendantCount } }
        : {}),
    };
    await (ctx
      ? this.activityService.record(params, ctx)
      : this.activityService.record(params));
    return updated;
  }

  /**
   * Restores the task and exactly the descendants archived together with it
   * (same `archivedAt`). Subtasks archived on their own earlier stay archived.
   * A subtask whose parent is still archived cannot be restored alone.
   */
  async restore(taskId: string, actorId: string, ctx?: WriteContext) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (!task.isArchived) return task;
    if (task.parentId) {
      const parent = await this.prisma.task.findUnique({
        where: { id: task.parentId },
        select: { isArchived: true },
      });
      if (parent?.isArchived) {
        throw new ConflictException('Restore the parent task first');
      }
    }

    const { updated, descendantCount } = await this.prisma.$transaction(
      async (tx) => {
        await this.tree.lockTree(tx, task.workspaceId);
        const descendants = await this.tree.descendants(tx, taskId, {
          isArchived: true,
          archivedAt: task.archivedAt,
        });
        await tx.task.updateMany({
          where: { id: { in: [taskId, ...descendants.map((d) => d.id)] } },
          data: { isArchived: false, archivedAt: null },
        });
        return {
          updated: await tx.task.findUniqueOrThrow({ where: { id: taskId } }),
          descendantCount: descendants.length,
        };
      },
    );
    const params = {
      actorId,
      action: ActivityAction.RESTORED,
      targetType: ActivityTargetType.TASK,
      targetId: taskId,
      workspaceId: task.workspaceId,
      ...(descendantCount > 0
        ? { metadata: { descendants: descendantCount } }
        : {}),
    };
    await (ctx
      ? this.activityService.record(params, ctx)
      : this.activityService.record(params));
    return updated;
  }

  /**
   * GET /tasks/:id/subtasks - the non-archived subtree as a flat list, each row
   * with its `depth` below this task (1 = direct child), ordered depth then
   * number. Bounded by MAX_TASK_DEPTH; clients build the tree from `parentId`.
   * Visibility of the root is visibility of the whole tree (same project).
   */
  async getSubtree(taskId: string, userId: string) {
    await this.visibility.assertCanView(userId, taskId);
    const tree = await this.tree.descendants(this.prisma, taskId, {
      isArchived: false,
    });
    if (tree.length === 0) return [];
    const depthById = new Map(tree.map((d) => [d.id, d.depth]));
    const rows = await this.prisma.task.findMany({
      where: { id: { in: tree.map((d) => d.id) } },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        workflowStatusId: true,
        issueTypeId: true,
        iterationId: true,
        estimate: true,
        priority: true,
        dueDate: true,
        startDate: true,
        parentId: true,
        projectId: true,
        assignees: { select: { id: true, name: true, avatar: true } },
      },
    });
    return rows
      .map((r) => ({ ...r, depth: depthById.get(r.id) as number }))
      .sort((a, b) => a.depth - b.depth || (a.number ?? 0) - (b.number ?? 0));
  }

  /**
   * FULL REPLACEMENT: assignees.set = userIds.map(id => ({id})) — NOT the
   * old '[...current, ...new]' union, which could only ever ADD, never
   * remove. Validates every userId exists (real query, 404 with which id
   * failed) BEFORE the write, matched by userId only, never username.
   * Throws on any failure — no silent swallow.
   */
  async setAssignees(
    taskId: string,
    dto: SetAssigneesDto,
    actorId: string,
    ctx?: WriteContext,
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        workspaceId: true,
        assignees: { select: { id: true } },
      },
    });
    if (!task) throw new NotFoundException('Task not found');

    if (dto.userIds.length > 0) {
      const existingUsers = await this.prisma.user.findMany({
        where: { id: { in: dto.userIds } },
        select: { id: true },
      });
      const existingIds = new Set(existingUsers.map((u) => u.id));
      const missing = dto.userIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(`User(s) not found: ${missing.join(', ')}`);
      }
    }

    const before = new Set(task.assignees.map((a) => a.id));
    const after = new Set(dto.userIds);
    const added = dto.userIds.filter((id) => !before.has(id));
    const removed = Array.from(before).filter((id) => !after.has(id));

    const result = await this.prisma.task.update({
      where: { id: taskId },
      data: { assignees: { set: dto.userIds.map((id) => ({ id })) } },
      select: {
        id: true,
        assignees: { select: { id: true, name: true, avatar: true } },
      },
    });

    // ONE Activity per newly-added/removed assignee, metadata:{assigneeId}
    // — FanoutService reads this to notify exactly that one user.
    await Promise.all([
      ...added.map((assigneeId) =>
        this.activityService.record(
          {
            actorId,
            action: ActivityAction.ASSIGNED,
            targetType: ActivityTargetType.TASK,
            targetId: taskId,
            workspaceId: task.workspaceId,
            metadata: { assigneeId },
          },
          ctx,
        ),
      ),
      ...removed.map((assigneeId) =>
        this.activityService.record(
          {
            actorId,
            action: ActivityAction.UNASSIGNED,
            targetType: ActivityTargetType.TASK,
            targetId: taskId,
            workspaceId: task.workspaceId,
            metadata: { assigneeId },
          },
          ctx,
        ),
      ),
    ]);

    return result;
  }

  /**
   * Cycle check BEFORE insert: walk the blockedTaskId's existing BLOCKS
   * chain, reject (400) if blockingTaskId would appear in it — app-layer,
   * not DB-expressible. Only meaningful for type BLOCKS; RELATES_TO isn't
   * a blocking relationship, so no cycle risk there.
   */
  async addDependency(
    blockingTaskId: string,
    dto: CreateDependencyDto,
    actorId: string,
  ) {
    const type = dto.type ?? DependencyType.BLOCKS;

    if (blockingTaskId === dto.blockedTaskId) {
      throw new BadRequestException('A task cannot depend on itself');
    }

    const [blockingTask, blockedTask] = await Promise.all([
      this.prisma.task.findUnique({ where: { id: blockingTaskId } }),
      this.prisma.task.findUnique({ where: { id: dto.blockedTaskId } }),
    ]);
    if (!blockingTask)
      throw new NotFoundException('blockingTaskId (route :id) not found');
    if (!blockedTask) throw new NotFoundException('blockedTaskId not found');

    if (
      type === DependencyType.BLOCKS &&
      (await this.wouldCreateCycle(blockingTaskId, dto.blockedTaskId))
    ) {
      throw new BadRequestException('This dependency would create a cycle');
    }

    const existing = await this.prisma.taskDependency.findUnique({
      where: {
        blockingTaskId_blockedTaskId: {
          blockingTaskId,
          blockedTaskId: dto.blockedTaskId,
        },
      },
    });
    if (existing) throw new ConflictException('This dependency already exists');

    const dependency = await this.prisma.taskDependency.create({
      data: { blockingTaskId, blockedTaskId: dto.blockedTaskId, type },
    });

    await this.activityService.record({
      actorId,
      action: ActivityAction.DEPENDENCY_ADDED,
      targetType: ActivityTargetType.TASK,
      targetId: blockingTaskId,
      workspaceId: blockingTask.workspaceId,
      metadata: { blockedTaskId: dto.blockedTaskId, dependencyType: type },
    });

    return dependency;
  }

  async removeDependency(
    taskId: string,
    dependencyId: string,
    actorId: string,
  ): Promise<void> {
    const dependency = await this.prisma.taskDependency.findUnique({
      where: { id: dependencyId },
    });
    if (
      !dependency ||
      (dependency.blockingTaskId !== taskId &&
        dependency.blockedTaskId !== taskId)
    ) {
      throw new NotFoundException('Dependency not found on this task');
    }
    await this.prisma.taskDependency.delete({ where: { id: dependencyId } });

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { workspaceId: true },
    });
    if (task) {
      await this.activityService.record({
        actorId,
        action: ActivityAction.DEPENDENCY_REMOVED,
        targetType: ActivityTargetType.TASK,
        targetId: taskId,
        workspaceId: task.workspaceId,
      });
    }
  }

  // ---- internals ----

  /**
   * Walk the blockedTaskId's existing BLOCKS chain (forward, following
   * blockedTask -> its own blockedTasks) — if blockingTaskId would appear
   * in it, inserting blockingTaskId -> blockedTaskId would close a cycle.
   */
  private async wouldCreateCycle(
    blockingTaskId: string,
    blockedTaskId: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    const queue: string[] = [blockedTaskId];

    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === blockingTaskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const next = await this.prisma.taskDependency.findMany({
        where: { blockingTaskId: current, type: DependencyType.BLOCKS },
        select: { blockedTaskId: true },
      });
      queue.push(...next.map((n) => n.blockedTaskId));
    }

    return false;
  }

  /**
   * Original dates are an IMPORT-only privilege. Handing them to a context
   * that did not opt in is a programming error, never silently ignored: an
   * importer that forgot `keepOriginalDates` would otherwise lose every
   * date without a trace.
   */
  private assertExtrasAllowed(
    extras: Pick<TaskWriteExtras, 'createdAt' | 'updatedAt'> | undefined,
    ctx: WriteContext | undefined,
  ): void {
    if (
      (extras?.createdAt || extras?.updatedAt) &&
      !(ctx?.keepOriginalDates && ctx.origin === CreationMode.IMPORT)
    ) {
      throw new BadRequestException(
        'createdAt/updatedAt may only be supplied with keepOriginalDates on an IMPORT context',
      );
    }
  }

  /**
   * Atomically advances the workspace's counter by `count` and returns the
   * FIRST number of the reserved range. One `UPDATE ... SET next_task_number =
   * next_task_number + n RETURNING` (what Prisma's `increment` compiles to),
   * so it takes the row lock and never reads-then-writes. MUST be called on
   * the transaction that inserts the tasks, or a rollback would leave a gap.
   */
  private async reserveTaskNumbers(
    client: Prisma.TransactionClient,
    workspaceId: string,
    count: number,
  ): Promise<number> {
    const { nextTaskNumber } = await client.workspace.update({
      where: { id: workspaceId },
      data: { nextTaskNumber: { increment: count } },
      select: { nextTaskNumber: true },
    });
    return nextTaskNumber - count;
  }

  private dedupe(ids: string[] | undefined): string[] {
    return Array.from(new Set(ids ?? []));
  }

  private async assertUsersExist(
    db: Prisma.TransactionClient | PrismaService,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    const existing = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true },
    });
    const have = new Set(existing.map((u) => u.id));
    const missing = userIds.filter((id) => !have.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`User(s) not found: ${missing.join(', ')}`);
    }
  }

  private assertDateOrder(startDate?: string, dueDate?: string): void {
    if (startDate && dueDate && new Date(startDate) > new Date(dueDate)) {
      throw new BadRequestException('startDate must be on or before dueDate');
    }
  }

  private async getCounts(taskId: string): Promise<[number, number]> {
    const [commentCount, attachmentCount] = await Promise.all([
      this.prisma.comment.count({
        where: { targetType: 'TASK', targetId: taskId },
      }),
      this.prisma.attachment.count({
        where: { targetType: 'TASK', targetId: taskId, status: 'CONFIRMED' },
      }),
    ]);
    return [commentCount, attachmentCount];
  }

  private async attachCounts(
    rows: Array<{
      id: string;
      title: string;
      status: string;
      workflowStatusId: string | null;
      issueTypeId: string | null;
      iterationId: string | null;
      estimate: number | null;
      priority: string | null;
      dueDate: Date | null;
      startDate: Date | null;
      projectId: string | null;
      parentId: string | null;
      assignees: { id: string; name: string; avatar: string | null }[];
    }>,
  ): Promise<TaskListItemDto[]> {
    return Promise.all(
      rows.map(async (row) => {
        const [commentCount, attachmentCount] = await this.getCounts(row.id);
        return { ...row, commentCount, attachmentCount };
      }),
    );
  }
}
