import { Role } from '@prisma/client';
import {
  ActionConfigEntry,
  ActionName,
} from '../interfaces/access-control.types';

/**
 * ACTION_CONFIG — representative entries by domain, per the Permission
 * Resolution graph. Extend per module as new actions are added; every
 * action a route guards with @RequireAccess() MUST have an entry here.
 */
export const ACTION_CONFIG: Record<ActionName, ActionConfigEntry> = {
  // ---- Tenancy ----
  viewAccount: { scopes: ['ACCOUNT'] },
  editAccount: { scopes: ['ACCOUNT'] },
  deleteAccount: { scopes: ['ACCOUNT'] },
  inviteToAccount: { scopes: ['ACCOUNT'], planLimit: 'member' },
  removeAccountMember: { scopes: ['ACCOUNT'] },
  changeAccountMemberRole: { scopes: ['ACCOUNT'] },
  createWorkspace: { scopes: ['ACCOUNT'], planLimit: 'workspace' },
  editWorkspace: { scopes: ['WORKSPACE'] },
  deleteWorkspace: { scopes: ['WORKSPACE'] },
  createTeam: { scopes: ['ACCOUNT'] },
  // EXTENSION beyond the original 34 (Tenancy module gap, explicitly
  // approved): editTeam/deleteTeam/manageTeamMembers weren't in the
  // Permission Resolution graph's action list. Same OWNER/ADMIN-only
  // profile as createTeam.
  editTeam: { scopes: ['TEAM'] },
  deleteTeam: { scopes: ['TEAM'] },
  manageTeamMembers: { scopes: ['TEAM'] },
  grantTeamWorkspaceAccess: { scopes: ['WORKSPACE'] },
  manageWorkspaceCollaborators: { scopes: ['WORKSPACE'] },
  manageWorkspaceGuests: { scopes: ['WORKSPACE'] },

  // ---- Project / Task ----
  createProject: { scopes: ['WORKSPACE'], planLimit: 'project' },
  editProject: { scopes: ['PROJECT'] },
  archiveProject: { scopes: ['PROJECT'] },
  deleteProject: { scopes: ['PROJECT'] },
  createTask: { scopes: ['WORKSPACE'], planLimit: 'task' },
  editTask: { scopes: ['TASK'] },
  deleteTask: { scopes: ['TASK'] },
  assignTask: { scopes: ['TASK'] },
  archiveTask: { scopes: ['TASK'] },
  uploadFile: { scopes: ['TASK', 'PROJECT', 'COMMENT'], planLimit: 'storage' },
  deleteFile: { scopes: ['ATTACHMENT'], ownershipField: 'uploadedById' },
  // EXTENSION: Tag definitions are workspace-scoped, same pattern as
  // Custom Fields. Attaching/detaching an EXISTING tag on a task reuses
  // editTask (already TASK-scoped) rather than a separate action —
  // that's just editing a task's metadata.
  manageTags: { scopes: ['WORKSPACE'] },

  // ---- Collaboration ----
  // COLLAB__COMMENT__UNIFY: comments can target TASK|PROJECT|ACTIVITY —
  // widened from the original TASK|PROJECT (ACTIVITY added for the
  // "comment on a feed item" terminal case).
  createComment: { scopes: ['TASK', 'PROJECT', 'ACTIVITY'] },
  editComment: { scopes: ['COMMENT'], ownershipField: 'authorId' },
  deleteComment: { scopes: ['COMMENT'], ownershipField: 'authorId' },
  // DEPRECATED — superseded by reactToTarget (below), which covers both
  // COMMENT and ACTIVITY. Left in place rather than removed since nothing
  // currently references it, and removing an already-approved action
  // isn't necessary just because it's unused.
  reactToComment: { scopes: ['COMMENT'] },
  // COLLAB__REACTION__UNIFY: reactions can target COMMENT|ACTIVITY.
  reactToTarget: { scopes: ['COMMENT', 'ACTIVITY'] },

  // ---- Meta ----
  manageCustomFields: { scopes: ['WORKSPACE'] },
  viewActivity: { scopes: ['WORKSPACE'] },
  viewAuditLog: { scopes: ['ACCOUNT'], minRole: Role.ADMIN },
  viewBilling: { scopes: ['ACCOUNT'], minRole: Role.ADMIN },
  manageBilling: { scopes: ['ACCOUNT'], minRole: Role.OWNER },
  createShareLink: { scopes: ['TASK', 'PROJECT'], minRole: Role.MEMBER },
  revokeShareLink: {
    scopes: ['TASK', 'PROJECT'],
    ownershipField: 'createdById',
  },

  // ---- Integrations / templates / workflow (step 0.10, diagram 18) ----
  //
  // NOT in this table, deliberately (they have no account/workspace to
  // resolve a tier against, so PermissionResolver cannot host them):
  //  - getListing / reviewListing / reportListing: any authenticated user;
  //    JwtAuthGuard alone, no @RequireAccess ("review needs a successful
  //    apply" is a service rule).
  //  - moderateMarketplace: platform staff; PlatformGuard + @RequirePlatformRole
  //    (step 0.6), outside account RBAC by design.
  //  - chat commands: run as the linked User through the normal guarded
  //    services, so they inherit whatever that user can do.
  //  - applying a template into a NEW workspace: that is `createWorkspace`
  //    (ACCOUNT, >= ADMIN, workspace plan limit) followed by `applyTemplate`
  //    into the new workspace - not a separate action.
  //  - shared (vs personal) saved views: manageSavedViews is the MEMBER-level
  //    personal-view right; creating/editing a SHARED view is additionally
  //    gated in the service by resolving `editWorkspace` (ADMIN+).
  //
  // NO `planLimit` on manageIntegrations / manageAutomations, unlike the
  // diagram: step 8 runs on EVERY check of the action, and these verbs also
  // cover disconnecting / disabling / deleting. With the limit attached, a
  // workspace sitting at its cap could not disconnect an integration or switch
  // an automation off - the one thing it needs to do to get back under the
  // cap. The CREATE paths call PlanLimitsService.checkLimit('integration' |
  // 'automation', ...) explicitly instead (as storage and bulk task writes do).
  manageIntegrations: { scopes: ['ACCOUNT'], minRole: Role.ADMIN },
  // Metered import items and the project/task preflight are checked by the
  // importer (dry-run), not as a step-8 limit on this action.
  runImport: { scopes: ['WORKSPACE'], minRole: Role.ADMIN },
  exportWorkspaceTemplate: { scopes: ['WORKSPACE'], minRole: Role.ADMIN },
  createTemplate: {
    scopes: ['ACCOUNT'],
    minRole: Role.MEMBER,
    planLimit: 'template',
  },
  // "creator or >= ADMIN": the matrix grants ADMIN+, ownership grants the
  // creator (the resolver loads the Template since step 3.5).
  editTemplate: {
    scopes: ['TEMPLATE'],
    ownershipField: 'createdById',
    minRole: Role.ADMIN,
  },
  deleteTemplate: {
    scopes: ['TEMPLATE'],
    ownershipField: 'createdById',
    minRole: Role.ADMIN,
  },
  // Merge into an existing workspace. Workspace/project/task/storage limits
  // are enforced by the apply engine's preflight and DomainWriter, not here.
  applyTemplate: { scopes: ['WORKSPACE'], minRole: Role.MEMBER },
  publishTemplate: { scopes: ['ACCOUNT'], minRole: Role.ADMIN },
  manageWorkflow: { scopes: ['PROJECT', 'WORKSPACE'], minRole: Role.ADMIN },
  manageAutomations: { scopes: ['WORKSPACE'], minRole: Role.ADMIN },
  manageSavedViews: { scopes: ['WORKSPACE'], minRole: Role.MEMBER },
  linkChannel: { scopes: ['ACCOUNT', 'WORKSPACE'], minRole: Role.ADMIN },
};
