import { Injectable } from '@nestjs/common';
import { FieldType, Prisma, TaskStatus } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CallableRule,
  RuleReferences,
  ViewInfo,
  WorkspaceRuleContext,
} from './rule.types';
import { walkActions } from '../registry/tree';

/** how many rules the call graph of one rule may span before the loader stops following it */
const MAX_CALL_GRAPH = 200;

/**
 * What the semantic checks (automation rules, saved views) need to know about a workspace: loads ONLY
 * what a document mentions, always inside that workspace (an id from another workspace simply is not
 * found, which is what makes cross-workspace references fail), and which of the mentioned users can
 * actually work there.
 */
@Injectable()
export class WorkspaceContextLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  /** `customUserIdsOf` names the users a USER-typed custom value mentions: it needs the field types, so it runs after they are loaded. */
  async load(
    workspaceId: string,
    refs: RuleReferences,
    customUserIdsOf: (
      typeOf: (fieldId: string) => FieldType | undefined,
    ) => string[] = () => [],
  ): Promise<WorkspaceRuleContext> {
    const ids = (set: Set<string>) => ({ in: [...set] });
    const projects: Array<{ id: string }> = refs.projectIds.size
      ? await this.prisma.project.findMany({
          where: { workspaceId, id: ids(refs.projectIds) },
          select: { id: true },
        })
      : [];
    const statuses: Array<{
      id: string;
      projectId: string;
      category: TaskStatus;
    }> = refs.statusIds.size
      ? await this.prisma.workflowStatus.findMany({
          where: { id: ids(refs.statusIds), project: { workspaceId } },
          select: { id: true, projectId: true, category: true },
        })
      : [];
    const tags: Array<{ id: string }> = refs.tagIds.size
      ? await this.prisma.tag.findMany({
          where: { workspaceId, id: ids(refs.tagIds) },
          select: { id: true },
        })
      : [];
    const issueTypes: Array<{ id: string }> = refs.issueTypeIds.size
      ? await this.prisma.issueType.findMany({
          where: { workspaceId, id: ids(refs.issueTypeIds) },
          select: { id: true },
        })
      : [];
    const iterations: Array<{ id: string }> = refs.iterationIds.size
      ? await this.prisma.iteration.findMany({
          where: { workspaceId, id: ids(refs.iterationIds) },
          select: { id: true },
        })
      : [];
    const fields: Array<{
      id: string;
      dataType: FieldType;
      options: Prisma.JsonValue;
    }> = refs.customFieldIds.size
      ? await this.prisma.customField.findMany({
          where: { workspaceId, id: ids(refs.customFieldIds) },
          select: { id: true, dataType: true, options: true },
        })
      : [];
    const customFields = new Map<
      string,
      { dataType: FieldType; options: string[] | null }
    >(
      fields.map((f) => [
        f.id,
        {
          dataType: f.dataType,
          options: Array.isArray(f.options) ? (f.options as string[]) : null,
        },
      ]),
    );
    const userIds = new Set([
      ...refs.userIds,
      ...customUserIdsOf((fid) => customFields.get(fid)?.dataType),
    ]);
    const valid = new Set<string>();
    for (const uid of userIds)
      if (await this.resolver.hasWorkspaceLevelAccess(uid, workspaceId))
        valid.add(uid);
    return {
      projectIds: new Set(projects.map((p) => p.id)),
      statuses: new Map(
        statuses.map((s) => [
          s.id,
          { projectId: s.projectId, category: s.category },
        ]),
      ),
      tagIds: new Set(tags.map((t) => t.id)),
      issueTypeIds: new Set(issueTypes.map((t) => t.id)),
      iterationIds: new Set(iterations.map((i) => i.id)),
      customFields,
      validUserIds: valid,
      rules: await this.loadRules(workspaceId, refs.ruleIds),
      views: await this.loadViews(workspaceId, refs.viewIds),
    };
  }

  /**
   * The rules a document calls, AND what those call, and so on: a cycle or a chain that is too deep is
   * only visible with the whole graph. Rules of other workspaces are simply not found.
   */
  private async loadRules(
    workspaceId: string,
    wanted: Set<string>,
  ): Promise<Map<string, CallableRule>> {
    const out = new Map<string, CallableRule>();
    let next = [...wanted];
    while (next.length > 0 && out.size < MAX_CALL_GRAPH) {
      const rows = await this.prisma.automation.findMany({
        where: { workspaceId, id: { in: next } },
        select: {
          id: true,
          projectId: true,
          triggerType: true,
          ruleVersion: true,
          unsupported: true,
          actions: true,
        },
      });
      const found: string[] = [];
      for (const r of rows) {
        const calls: string[] = [];
        let hasWait = false;
        if (r.ruleVersion === 1)
          walkActions(r.actions, ({ action }) => {
            if (action.type === 'RUN_RULE' && typeof action.rule === 'string')
              calls.push(action.rule);
            if (action.type === 'WAIT') hasWait = true;
          });
        out.set(r.id, {
          projectId: r.projectId,
          triggerType: r.triggerType,
          ruleVersion: r.ruleVersion,
          hasUnsupported:
            Array.isArray(r.unsupported) && r.unsupported.length > 0,
          calls,
          hasWait,
        });
        found.push(...calls);
      }
      next = [...new Set(found)].filter((id) => !out.has(id));
    }
    return out;
  }

  private async loadViews(
    workspaceId: string,
    wanted: Set<string>,
  ): Promise<Map<string, ViewInfo>> {
    if (wanted.size === 0) return new Map();
    const rows = await this.prisma.savedView.findMany({
      where: { workspaceId, id: { in: [...wanted] } },
      select: { id: true, projectId: true, isShared: true, ownerId: true },
    });
    return new Map(
      rows.map((v) => [
        v.id,
        { projectId: v.projectId, isShared: v.isShared, ownerId: v.ownerId },
      ]),
    );
  }
}
