import { CollaboratorRole, Role } from '@prisma/client';

/**
 * Every resource type the AccessControlGuard/PermissionResolver can be
 * asked to check access against. ACCOUNT and WORKSPACE resolve directly;
 * PROJECT/TASK resolve up to a workspace; COMMENT and ATTACHMENT resolve
 * via their own polymorphic target (multi-hop, see PermissionResolver).
 */
/**
 * SHARE_LINK is an addition beyond the graph's explicit list (which only
 * narrates scopes inside ACTION_CONFIG text, e.g. "scope:task|project" for
 * revokeShareLink). ShareLink is polymorphic exactly like Comment/
 * Attachment (targets TASK|PROJECT) and its ownershipField (createdById)
 * lives on the ShareLink row itself, not on the task/project — so it needs
 * the same "resolve via its own target" treatment. Documented here rather
 * than guessed silently.
 */
export type TargetType =
  | 'ACCOUNT'
  | 'WORKSPACE'
  | 'PROJECT'
  | 'TASK'
  | 'TEAM'
  | 'COMMENT'
  | 'ATTACHMENT'
  | 'SHARE_LINK'
  | 'ACTIVITY'
  // step 0.10. STUB until step 3.1 adds the Template table: the resolver
  // answers NotFound for every id (see PermissionResolver, case 'TEMPLATE').
  | 'TEMPLATE';

/**
 * Single source of truth for "every valid TargetType value" — anything
 * needing a runtime list (e.g. CheckAccessDto's @IsEnum validator) MUST
 * import this instead of hand-maintaining a parallel array. A hand-copied
 * array here is exactly how CheckAccessDto silently drifted out of sync
 * with this type before (TEAM and ACTIVITY were added to the type above
 * but never to the DTO's validator, so /access-control/check rejected
 * both with a 400 despite them working everywhere else in the system).
 */
export const ALL_TARGET_TYPES: TargetType[] = [
  'ACCOUNT',
  'WORKSPACE',
  'PROJECT',
  'TASK',
  'TEAM',
  'COMMENT',
  'ATTACHMENT',
  'SHARE_LINK',
  'ACTIVITY',
  'TEMPLATE',
];

export type PlanLimitKey =
  | 'member'
  | 'workspace'
  | 'project'
  | 'task'
  | 'storage'
  // step 0.10 (diagram 18). All account-total. 'integration', 'template' and
  // 'automation' are COUNT limits whose tables arrive in later phases (they are
  // counted through PlanLimitsService.registerCounter); 'importItems' is a
  // MONTHLY METERED limit read from UsageMetric.
  | 'integration'
  | 'importItems'
  | 'template'
  | 'automation';

export type ActionName =
  // Tenancy
  | 'viewAccount'
  | 'editAccount'
  | 'deleteAccount'
  | 'inviteToAccount'
  | 'removeAccountMember'
  | 'changeAccountMemberRole'
  | 'createWorkspace'
  | 'editWorkspace'
  | 'deleteWorkspace'
  | 'createTeam'
  | 'editTeam'
  | 'deleteTeam'
  | 'manageTeamMembers'
  | 'grantTeamWorkspaceAccess'
  | 'manageWorkspaceCollaborators'
  | 'manageWorkspaceGuests'
  // Project / Task
  | 'createProject'
  | 'editProject'
  | 'archiveProject'
  | 'deleteProject'
  | 'createTask'
  | 'editTask'
  | 'deleteTask'
  | 'assignTask'
  | 'archiveTask'
  | 'uploadFile'
  | 'deleteFile'
  | 'manageTags'
  // Collaboration
  | 'createComment'
  | 'editComment'
  | 'deleteComment'
  | 'reactToComment'
  | 'reactToTarget'
  // Meta
  | 'manageCustomFields'
  | 'viewActivity'
  | 'viewAuditLog'
  | 'viewBilling'
  | 'manageBilling'
  | 'createShareLink'
  | 'revokeShareLink'
  // Integrations / templates / workflow (step 0.10, diagram 18)
  | 'manageIntegrations'
  | 'runImport'
  | 'exportWorkspaceTemplate'
  | 'createTemplate'
  | 'editTemplate'
  | 'deleteTemplate'
  | 'applyTemplate'
  | 'publishTemplate'
  | 'manageWorkflow'
  | 'manageAutomations'
  | 'manageSavedViews'
  | 'linkChannel';

export interface ActionConfigEntry {
  /** Valid targetType(s) this action may be checked against. */
  scopes: TargetType[];
  /**
   * If set, PermissionResolver step 7 ALSO grants access when
   * resource[ownershipField] === userId, regardless of role match.
   */
  ownershipField?: string;
  /**
   * If set, PermissionResolver step 8 additionally requires
   * BillingService.checkLimit(planLimit, accountId) === true.
   * TODO: BillingService does not exist yet (Billing is a future domain
   * module) — step 8 is currently a documented no-op. Revisit once
   * Billing is built; do not silently start enforcing this without
   * wiring BillingService in.
   */
  planLimit?: PlanLimitKey;
  /**
   * Documentation of the intended minimum role for this action — the
   * ROLE_PERMISSIONS matrix is authored to already reflect this threshold.
   * Not an independent runtime check (the algorithm's step 5 baseline
   * lookup is the single source of truth); kept here for reviewers.
   */
  minRole?: Role;
}

export type RoleName = Role;
export type CollaboratorRoleName = CollaboratorRole;

export interface ResolveResult {
  allowed: boolean;
  reason?: string;
  /**
   * True when denial was specifically a plan-limit failure (step 8), not
   * a role/ownership denial (steps 4-7). Callers that surface this over
   * HTTP should prefer 402 Payment Required over a generic 403 when this
   * is true — it's an actionable-by-upgrading condition, not an access
   * violation. Absent/false for every other denial reason.
   */
  planLimitExceeded?: boolean;
}
