import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AttachmentableType,
  AttachmentStatus,
  CommentableType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BLUEPRINT_LIMITS as L } from '../blueprint';
import { buildRawBlueprint } from './extract.builder';
import {
  ExtractError,
  ExtractionReport,
  ExtractOptions,
  RawBlueprint,
  WorkspaceSnapshot,
} from './extract.types';

/**
 * Step 3.3. Loads one workspace (or one project of it) and hands it to the pure builder.
 * READ-ONLY: it never writes, so it needs no DomainWriter and emits no activity.
 *
 * Authorization is the CALLER'S job (the export endpoint resolves `exportWorkspaceTemplate`
 * before calling). The output is RAW - it contains user ids and real dates - and must go through
 * the sanitizer (3.4) before it is stored or shown to anyone.
 */
@Injectable()
export class TemplateExtractionService {
  constructor(private readonly prisma: PrismaService) {}

  async extract(
    workspaceId: string,
    options: ExtractOptions = {},
  ): Promise<{ raw: RawBlueprint; report: ExtractionReport }> {
    const db = this.prisma;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        key: true,
        icon: true,
        description: true,
      },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    if (options.projectId !== undefined) {
      const owns = await db.project.count({
        where: { id: options.projectId, workspaceId },
      });
      if (owns === 0)
        throw new ExtractError(
          'PROJECT_NOT_FOUND',
          'The project is not in this workspace',
        );
    }

    // Refuse BEFORE loading: a 400k-task workspace must not be pulled into memory to be told
    // no. (+projects: the node limit counts them too; the exact check is the validator's.)
    const taskWhere = {
      workspaceId,
      projectId: options.projectId ?? { not: null },
      ...(options.includeArchived ? {} : { isArchived: false }),
    };
    const taskCount = await db.task.count({ where: taskWhere });
    if (taskCount > L.maxNodes) {
      throw new ExtractError(
        'TOO_LARGE',
        `${taskCount} tasks; a template holds at most ${L.maxNodes} projects, tasks and iterations`,
      );
    }

    const projectFilter =
      options.projectId !== undefined ? { id: options.projectId } : {};
    const [tags, customFields, issueTypes, iterations, projects, tasks] =
      await Promise.all([
        db.tag.findMany({
          where: { workspaceId },
          select: { id: true, name: true },
        }),
        db.customField.findMany({
          where: { workspaceId },
          select: {
            id: true,
            key: true,
            name: true,
            dataType: true,
            options: true,
            order: true,
          },
        }),
        db.issueType.findMany({
          where: { workspaceId },
          select: {
            id: true,
            name: true,
            icon: true,
            color: true,
            level: true,
          },
        }),
        db.iteration.findMany({
          where: { workspaceId },
          select: {
            id: true,
            projectId: true,
            kind: true,
            name: true,
            goal: true,
            startDate: true,
            endDate: true,
            createdAt: true,
          },
        }),
        db.project.findMany({
          where: { workspaceId, ...projectFilter },
          select: {
            id: true,
            name: true,
            description: true,
            enforceTransitions: true,
            createdAt: true,
          },
        }),
        db.task.findMany({
          where: taskWhere,
          select: {
            id: true,
            number: true,
            projectId: true,
            parentId: true,
            title: true,
            description: true,
            workflowStatusId: true,
            issueTypeId: true,
            iterationId: true,
            priority: true,
            estimate: true,
            startDate: true,
            dueDate: true,
            isArchived: true,
            createdAt: true,
            assignees: { select: { id: true } },
            tags: { select: { tagId: true } },
            customValues: { select: { fieldId: true, value: true } },
          },
        }),
      ]);
    const projectIds = projects.map((p) => p.id);
    const taskIds = tasks.map((t) => t.id);

    const [
      statuses,
      transitions,
      dependencies,
      comments,
      attachments,
      automations,
      views,
    ] = await Promise.all([
      db.workflowStatus.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          id: true,
          projectId: true,
          name: true,
          color: true,
          position: true,
          category: true,
          excludeFromProgress: true,
          isDefault: true,
        },
      }),
      db.workflowTransition.findMany({
        where: { projectId: { in: projectIds } },
        select: { projectId: true, fromStatusId: true, toStatusId: true },
      }),
      db.taskDependency.findMany({
        where: {
          OR: [
            { blockingTaskId: { in: taskIds } },
            { blockedTaskId: { in: taskIds } },
          ],
        },
        select: { blockingTaskId: true, blockedTaskId: true, type: true },
      }),
      options.includeComments
        ? db.comment.findMany({
            where: {
              targetType: CommentableType.TASK,
              targetId: { in: taskIds },
            },
            select: {
              id: true,
              targetId: true,
              authorId: true,
              content: true,
              parentCommentId: true,
              createdAt: true,
            },
          })
        : Promise.resolve(undefined),
      options.includeAttachments
        ? db.attachment.findMany({
            where: {
              targetType: AttachmentableType.TASK,
              targetId: { in: taskIds },
            },
            select: {
              id: true,
              targetId: true,
              filename: true,
              mimeType: true,
              sizeBytes: true,
              status: true,
              createdAt: true,
            },
          })
        : Promise.resolve(undefined),
      // step 5.5: the project-scoped automations, and only the SHARED views (a personal view belongs to one person)
      db.automation.findMany({
        where: { workspaceId, projectId: { in: projectIds } },
        select: {
          id: true,
          projectId: true,
          name: true,
          ruleVersion: true,
          trigger: true,
          conditions: true,
          actions: true,
          sourceDefinition: true,
        },
      }),
      db.savedView.findMany({
        where: { workspaceId, isShared: true, projectId: { in: projectIds } },
        select: {
          id: true,
          projectId: true,
          name: true,
          layout: true,
          config: true,
        },
      }),
    ]);

    const snapshot: WorkspaceSnapshot = {
      automations,
      views,
      workspace,
      tags,
      customFields,
      issueTypes,
      iterations,
      projects,
      statuses,
      transitions,
      tasks: tasks.map(({ assignees, tags: taskTags, customValues, ...t }) => ({
        ...t,
        assigneeIds: assignees.map((a) => a.id),
        tagIds: taskTags.map((x) => x.tagId),
        customValues,
      })),
      dependencies,
      comments: comments?.map(({ targetId, ...c }) => ({
        ...c,
        taskId: targetId,
      })),
      attachments: attachments?.map(({ targetId, status, ...a }) => ({
        ...a,
        taskId: targetId,
        confirmed: status === AttachmentStatus.CONFIRMED,
      })),
    };
    const built = buildRawBlueprint(snapshot, options);

    // The query already left these out (so they never reach memory); count them separately so
    // the report still tells the person what the template does not contain.
    if (options.projectId === undefined) {
      built.report.tasks.inboxSkipped = await db.task.count({
        where: { workspaceId, projectId: null },
      });
    }
    if (!options.includeArchived) {
      built.report.tasks.archivedSkipped = await db.task.count({
        where: {
          workspaceId,
          projectId: options.projectId ?? { not: null },
          isArchived: true,
        },
      });
    }
    return built;
  }
}
