import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, CollaboratorRole, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ACTION_CONFIG } from './config/action-config';
import {
  COLLABORATOR_ROLE_PERMISSIONS,
  mostPermissiveRole,
  ROLE_PERMISSIONS,
} from './config/role-permissions';
import { PlanLimitsService } from './plan-limits.service';
import {
  ActionName,
  ResolveResult,
  TargetType,
} from './interfaces/access-control.types';

interface ResolvedContext {
  accountId: string;
  accountType: AccountType;
  workspaceId?: string;
  projectId?: string;
}

type MatchedRole =
  | {
      vocab: 'ROLE';
      role: Role;
      tier: 1 | 2 | 3;
      overrides?: Record<string, boolean> | null;
    }
  | { vocab: 'COLLAB'; role: CollaboratorRole; tier: 2 };

/**
 * PermissionResolver.resolve(userId, action, targetType, targetId)
 *
 * ONE service. Used by BOTH AccessControlGuard (route-level) and the
 * /access-control/check self-check endpoint. This IS also the Foundations
 * account-session mechanism — step 1 below is the same resolution the
 * "stateless, no current-account concept" decision relies on.
 */
@Injectable()
export class PermissionResolver {
  private readonly logger = new Logger(PermissionResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planLimitsService: PlanLimitsService,
  ) {}

  async resolve(
    userId: string,
    action: ActionName,
    targetType: TargetType,
    targetId: string,
  ): Promise<ResolveResult> {
    const config = ACTION_CONFIG[action];
    if (!config) {
      throw new Error(
        `No ACTION_CONFIG entry for action "${action}" — every guarded action must have one`,
      );
    }

    // ---- Step 1: resolve targetId+targetType -> Workspace -> Account ----
    const { context, ownerId } = await this.resolveTargetAndOwner(
      action,
      targetType,
      targetId,
    );

    // ---- Steps 2-3: gather membership rows, first matching tier wins ----
    const matched = await this.findFirstMatchingTier(userId, context);

    // ---- Steps 4-6: baseline + additive overrides ----
    let step6Result = false;
    if (matched) {
      const baseline = this.getBaseline(matched, action);
      let granted = baseline ?? false;

      if (
        matched.vocab === 'ROLE' &&
        matched.overrides &&
        matched.overrides[action] === true
      ) {
        // Overrides are ADDITIVE ONLY — never a restriction below baseline.
        granted = true;
      }

      step6Result = granted;
    }

    // ---- Step 7: ownership grant, independent of steps 4-6 ----
    let step7Result = false;
    if (config.ownershipField && ownerId && ownerId === userId) {
      step7Result = true;
    }

    // ---- Step 8: planLimit check ----
    // Real implementation now — Billing module wired this up. Only runs
    // when step 6/7 already granted access; a denied action never needs
    // its plan limit checked at all. 'storage' is excluded here — see
    // PlanLimitsService's class doc for why it stays a separate check
    // inside AttachmentsService rather than fitting this generic shape.
    let step8Result = true;
    if ((step6Result || step7Result) && config.planLimit) {
      step8Result = await this.planLimitsService.checkLimit(
        config.planLimit,
        action,
        {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
        },
      );
    }

    const allowed = (step6Result || step7Result) && step8Result;

    if (!allowed) {
      this.logger.debug(
        `DENY user=${userId} action=${action} target=${targetType}:${targetId} matchedTier=${matched?.tier ?? 'none'}${step8Result ? '' : ' (plan limit exceeded)'}`,
      );
    }

    return {
      allowed,
      reason: allowed
        ? undefined
        : !step8Result
          ? "This action would exceed your plan's limits — upgrade to continue"
          : 'You do not have permission to perform this action',
      planLimitExceeded: !allowed && !step8Result,
    };
  }

  // ============================================================
  // Step 1 — target resolution (including multi-hop cases)
  // ============================================================

  private async resolveTargetAndOwner(
    action: ActionName,
    targetType: TargetType,
    targetId: string,
  ): Promise<{ context: ResolvedContext; ownerId: string | null }> {
    switch (targetType) {
      case 'ACCOUNT': {
        const account = await this.prisma.account.findUnique({
          where: { id: targetId },
          select: { id: true, type: true },
        });
        if (!account) throw new NotFoundException('Account not found');
        return {
          context: { accountId: account.id, accountType: account.type },
          ownerId: null,
        };
      }

      case 'WORKSPACE': {
        const workspace = await this.prisma.workspace.findUnique({
          where: { id: targetId },
          select: { id: true, account: { select: { id: true, type: true } } },
        });
        if (!workspace) throw new NotFoundException('Workspace not found');
        return {
          context: {
            accountId: workspace.account.id,
            accountType: workspace.account.type,
            workspaceId: workspace.id,
          },
          ownerId: null,
        };
      }

      case 'PROJECT': {
        const project = await this.prisma.project.findUnique({
          where: { id: targetId },
          select: {
            id: true,
            workspaceId: true,
            workspace: {
              select: { account: { select: { id: true, type: true } } },
            },
          },
        });
        if (!project) throw new NotFoundException('Project not found');
        return {
          context: {
            accountId: project.workspace.account.id,
            accountType: project.workspace.account.type,
            workspaceId: project.workspaceId,
            projectId: project.id,
          },
          ownerId: null,
        };
      }

      case 'TASK': {
        const task = await this.prisma.task.findUnique({
          where: { id: targetId },
          select: {
            id: true,
            workspaceId: true,
            projectId: true,
            workspace: {
              select: { account: { select: { id: true, type: true } } },
            },
          },
        });
        if (!task) throw new NotFoundException('Task not found');
        return {
          context: {
            accountId: task.workspace.account.id,
            accountType: task.workspace.account.type,
            workspaceId: task.workspaceId,
            projectId: task.projectId ?? undefined,
          },
          ownerId: null,
        };
      }

      case 'TEAM': {
        const team = await this.prisma.team.findUnique({
          where: { id: targetId },
          select: { id: true, account: { select: { id: true, type: true } } },
        });
        if (!team) throw new NotFoundException('Team not found');
        // Team has no workspaceId/projectId of its own — resolves straight
        // to its account (Tier1/2 never apply, only Tier3 AccountMember).
        return {
          context: {
            accountId: team.account.id,
            accountType: team.account.type,
          },
          ownerId: null,
        };
      }

      case 'ACTIVITY': {
        const activity = await this.prisma.activity.findUnique({
          where: { id: targetId },
          select: { id: true, workspaceId: true },
        });
        if (!activity) throw new NotFoundException('Activity not found');

        const workspace = await this.prisma.workspace.findUnique({
          where: { id: activity.workspaceId },
          select: { account: { select: { id: true, type: true } } },
        });
        if (!workspace)
          throw new NotFoundException('Workspace not found for this activity');

        // Resolved at workspace level only (Activity.workspaceId is
        // denormalized precisely for fast workspace-scoped lookups) —
        // not multi-hopped through the activity's OWN target (e.g. to the
        // underlying task/project), unlike Comment/Attachment/ShareLink.
        // Reasonable simplification: commenting/reacting on a feed item is
        // itself a workspace-level action, not scoped tighter than the
        // feed the user already had to have workspace-level access to see.
        return {
          context: {
            accountId: workspace.account.id,
            accountType: workspace.account.type,
            workspaceId: activity.workspaceId,
          },
          ownerId: null,
        };
      }

      case 'COMMENT': {
        const comment = await this.prisma.comment.findUnique({
          where: { id: targetId },
          select: {
            id: true,
            targetType: true,
            targetId: true,
            authorId: true,
          },
        });
        if (!comment) throw new NotFoundException('Comment not found');

        // MULTI-HOP CASE: resolve the Comment's OWN target first. Scope
        // rule: only comments whose own target is TASK or PROJECT support
        // this 2-hop resolution.
        if (comment.targetType === 'TASK' || comment.targetType === 'PROJECT') {
          const { context } = await this.resolveTargetAndOwner(
            action,
            comment.targetType,
            comment.targetId,
          );
          return { context, ownerId: comment.authorId };
        }

        // comment.targetType === 'ACTIVITY' — not supported for actions
        // needing workspace resolution.
        if (
          ACTION_CONFIG[action].ownershipField &&
          !this.actionNeedsWorkspaceResolution(action)
        ) {
          // e.g. editComment/deleteComment only need ownerId, not a
          // workspace-resolving tier lookup — still allow ownership path.
          return {
            context: {
              accountId: '',
              accountType: 'PERSONAL' as AccountType,
              workspaceId: undefined,
            },
            ownerId: comment.authorId,
          };
        }

        throw new ForbiddenException(
          'This action is not supported for comments on activity-feed entries',
        );
      }

      case 'ATTACHMENT': {
        const attachment = await this.prisma.attachment.findUnique({
          where: { id: targetId },
          select: {
            id: true,
            targetType: true,
            targetId: true,
            uploadedById: true,
          },
        });
        if (!attachment) throw new NotFoundException('Attachment not found');

        // EXTENSION beyond the graph: the algorithm only spells out the
        // multi-hop case for COMMENT, but deleteFile{scope:attachment}
        // equally needs a workspace to run Tier1/2 against. Attachment is
        // polymorphic the same way (targetType TASK|PROJECT|COMMENT), so
        // it gets the same treatment.
        if (
          attachment.targetType === 'TASK' ||
          attachment.targetType === 'PROJECT'
        ) {
          const { context } = await this.resolveTargetAndOwner(
            action,
            attachment.targetType,
            attachment.targetId,
          );
          return { context, ownerId: attachment.uploadedById };
        }
        if (attachment.targetType === 'COMMENT') {
          const { context } = await this.resolveTargetAndOwner(
            action,
            'COMMENT',
            attachment.targetId,
          );
          return { context, ownerId: attachment.uploadedById };
        }
        throw new NotFoundException('Unable to resolve attachment target');
      }

      case 'SHARE_LINK': {
        const shareLink = await this.prisma.shareLink.findUnique({
          where: { id: targetId },
          select: {
            id: true,
            targetType: true,
            targetId: true,
            createdById: true,
          },
        });
        if (!shareLink) throw new NotFoundException('Share link not found');
        const { context } = await this.resolveTargetAndOwner(
          action,
          shareLink.targetType,
          shareLink.targetId,
        );
        return { context, ownerId: shareLink.createdById };
      }

      case 'TEMPLATE': {
        // Step 3.5 (was a stub since 0.10). The account is the template's OWNER account;
        // `ownerId` is its creator, which is what makes editTemplate / deleteTemplate's
        // ownershipField ("the creator may, even as a MEMBER") work.
        const template = await this.prisma.template.findUnique({
          where: { id: targetId },
          select: {
            createdById: true,
            ownerAccount: { select: { id: true, type: true } },
          },
        });
        if (!template) throw new NotFoundException('Template not found');
        return {
          context: {
            accountId: template.ownerAccount.id,
            accountType: template.ownerAccount.type,
          },
          ownerId: template.createdById,
        };
      }

      default:
        throw new Error(`Unhandled targetType: ${targetType satisfies never}`);
    }
  }

  private actionNeedsWorkspaceResolution(action: ActionName): boolean {
    // Actions whose baseline role check needs Tier1/2/3 membership rows
    // (i.e. everything except pure ownership-only checks that could, in
    // principle, be satisfied by ownership alone). Conservative default:
    // true unless explicitly excluded.
    const ownershipOnly: ActionName[] = [];
    return !ownershipOnly.includes(action);
  }

  // ============================================================
  // Steps 2-3 — gather membership rows, first matching tier wins
  // ============================================================

  private async findFirstMatchingTier(
    userId: string,
    ctx: ResolvedContext,
  ): Promise<MatchedRole | null> {
    // Comment-on-ACTIVITY ownership-only fallback produces an empty
    // accountId — nothing to resolve tiers against.
    if (!ctx.accountId) return null;

    // ---- Tier 1: ProjectMember (only if target touches a project) ----
    if (ctx.projectId) {
      const projectMember = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: ctx.projectId, userId } },
        select: { role: true },
      });
      if (projectMember) {
        return { vocab: 'ROLE', role: projectMember.role, tier: 1 };
      }
    }

    return this.findTier2Or3(userId, ctx);
  }

  /**
   * Tier2 (WorkspaceCollaborator/WorkspaceGuest/team access) + Tier3
   * (AccountMember/personal owner) ONLY — Tier1 (ProjectMember) excluded.
   * Extracted for reuse by hasWorkspaceLevelAccess/hasProjectLevelAccess,
   * which need to answer "does this user have genuine workspace/account-
   * level access" WITHOUT a Tier1 ProjectMember row counting as one —
   * per explicit product decision: a user whose ONLY access is a
   * ProjectMember row (any role, not just CLIENT) is scoped to that one
   * project, never implicitly granted workspace-wide visibility.
   */
  private async findTier2Or3(
    userId: string,
    ctx: ResolvedContext,
  ): Promise<MatchedRole | null> {
    if (!ctx.accountId) return null;

    // ---- Tier 2: WorkspaceCollaborator (personal) OR team access (org) ----
    if (ctx.workspaceId) {
      if (ctx.accountType === 'PERSONAL') {
        const collaborator = await this.prisma.workspaceCollaborator.findUnique(
          {
            where: {
              workspaceId_invitedUserId: {
                workspaceId: ctx.workspaceId,
                invitedUserId: userId,
              },
            },
            select: { role: true },
          },
        );
        if (collaborator) {
          return { vocab: 'COLLAB', role: collaborator.role, tier: 2 };
        }
      } else {
        // ORGANIZATION: team-based WorkspaceTeamAccess, most-permissive
        // among ties, via the user's TeamMember rows.
        const teamMemberships = await this.prisma.teamMember.findMany({
          where: { userId, team: { accountId: ctx.accountId } },
          select: { teamId: true },
        });

        let teamRoles: Role[] = [];
        if (teamMemberships.length > 0) {
          const teamAccessRows = await this.prisma.workspaceTeamAccess.findMany(
            {
              where: {
                workspaceId: ctx.workspaceId,
                teamId: { in: teamMemberships.map((m) => m.teamId) },
              },
              select: { role: true },
            },
          );
          teamRoles = teamAccessRows.map((r) => r.role);
        }

        if (teamRoles.length > 0) {
          return {
            vocab: 'ROLE',
            role: mostPermissiveRole(teamRoles),
            tier: 2,
          };
        }

        // EXTENSION beyond the graph's explicit Tier2 text (which names
        // only WorkspaceCollaborator + WorkspaceTeamAccess): WorkspaceGuest
        // is the org-side individual analogue of WorkspaceCollaborator
        // (per its own schema comment — added specifically to give org
        // workspaces a non-billable, workspace-wide individual access
        // tier). Treated as Tier2 for consistency; flagged here since the
        // algorithm text doesn't name it.
        const guest = await this.prisma.workspaceGuest.findUnique({
          where: {
            workspaceId_invitedUserId: {
              workspaceId: ctx.workspaceId,
              invitedUserId: userId,
            },
          },
          select: { role: true },
        });
        if (guest) {
          return { vocab: 'COLLAB', role: guest.role, tier: 2 };
        }
      }
    }

    // ---- Tier 3: AccountMember, OR Account.personalOwnerId === userId ----
    const accountMember = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId: ctx.accountId, userId } },
      select: { role: true, permissions: true },
    });
    if (accountMember) {
      return {
        vocab: 'ROLE',
        role: accountMember.role,
        tier: 3,
        overrides:
          (accountMember.permissions as Record<string, boolean> | null) ??
          undefined,
      };
    }

    const account = await this.prisma.account.findUnique({
      where: { id: ctx.accountId },
      select: { personalOwnerId: true },
    });
    if (account?.personalOwnerId === userId) {
      return { vocab: 'ROLE', role: Role.OWNER, tier: 3 };
    }

    return null;
  }

  // ============================================================
  // Visibility helpers — used by TaskVisibilityService/ProjectsService
  // for reads that must include CLIENT/Tier1-only users, who fail every
  // named-action boolean check by design (CLIENT is false almost
  // everywhere in ROLE_PERMISSIONS) but still need to see their own
  // project's tasks. These answer "CAN you see into this workspace/
  // project at all" — a DIFFERENT question from "CAN you do <action>".
  // ============================================================

  /**
   * True iff the user has genuine Tier2 (WorkspaceCollaborator/Guest/team
   * access) or Tier3 (AccountMember/personal owner) access to this
   * workspace. Deliberately EXCLUDES Tier1 — a ProjectMember row on some
   * project inside this workspace does NOT imply workspace-wide access
   * (explicit product decision, Tenancy/Projects-Tasks review).
   */
  async hasWorkspaceLevelAccess(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { account: { select: { id: true, type: true } } },
    });
    if (!workspace) return false;

    const matched = await this.findTier2Or3(userId, {
      accountId: workspace.account.id,
      accountType: workspace.account.type,
      workspaceId,
    });
    return matched !== null;
  }

  /**
   * True iff the user can see INTO this specific project: either genuine
   * workspace-level access (see above), OR a ProjectMember row on this
   * exact project (Tier1 — the CLIENT/contractor case, scoped to just
   * this one project).
   */
  async hasProjectLevelAccess(
    userId: string,
    projectId: string,
  ): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) return false;

    if (await this.hasWorkspaceLevelAccess(userId, project.workspaceId)) {
      return true;
    }

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    return membership !== null;
  }

  // ============================================================
  // Steps 4-5 — baseline lookup
  // ============================================================

  private getBaseline(matched: MatchedRole, action: ActionName): boolean {
    if (matched.vocab === 'ROLE') {
      return ROLE_PERMISSIONS[matched.role][action] ?? false;
    }
    return COLLABORATOR_ROLE_PERMISSIONS[matched.role][action] ?? false;
  }
}
