import { FieldType, TemplateInstallMode } from '@prisma/client';
import { ResolvedTask } from '../resolve';

/**
 * Step 3.6. The apply plan: what applying a template to a workspace WOULD do. Built without
 * writing anything (the preview), then executed by the same plan (so preview and result cannot
 * disagree). Nothing in a plan or a report contains task text, only counts and names the
 * exporter/applier already sees.
 */
export type PlanAction = 'CREATE' | 'REUSE' | 'SKIP';

export interface PlanTag {
  name: string;
  action: Exclude<PlanAction, 'SKIP'>;
  existingId?: string;
}
export interface PlanIssueType {
  name: string;
  action: Exclude<PlanAction, 'SKIP'>;
  existingId?: string;
}
export interface PlanField {
  key: string;
  name: string;
  dataType: FieldType;
  options?: string[];
  order?: number;
  action: PlanAction;
  existingId?: string;
  /** For REUSE: options of the EXISTING field (values outside them are dropped). */
  existingOptions?: string[];
}
/**
 * Step 5.5. What happens to each automation the template carries. CREATE = a real rule, always created
 * OFF; RAW = an item that is not in the portable form, kept as an inert imported rule (its JSON
 * preserved for a later upgrade); SKIP = it cannot be bound in THIS workspace (the reason says why).
 */
export interface PlanAutomation {
  /** nodeKey of the project it belongs to */
  project: string;
  name: string;
  /** after making the name unique in the workspace */
  finalName: string;
  action: 'CREATE' | 'RAW' | 'SKIP';
  /** constructs it uses that this build cannot run yet (it is created off either way) */
  unsupported: number;
  reason?: string;
}
export interface PlanView {
  project: string;
  name: string;
  action: 'CREATE' | 'SKIP';
  /** final: the template's wish AND the person applying being allowed to share */
  shared: boolean;
  reason?: string;
}

export interface PlanProject {
  nodeKey: string;
  name: string;
  renamedFrom?: string;
  tasks: number;
}

export type PlanIssueCode =
  // blockers
  | 'KIND_MODE_MISMATCH'
  | 'WORKSPACE_NOT_EMPTY'
  | 'PROJECT_LIMIT'
  | 'TASK_LIMIT'
  | 'ISSUE_TYPE_LIMIT'
  | 'ITERATION_LIMIT'
  | 'STORAGE_LIMIT'
  | 'FILE_TOO_LARGE'
  | 'ASSET_MISSING'
  | 'AUTOMATION_LIMIT'
  | 'VIEW_LIMIT'
  // warnings
  | 'FIELD_TYPE_CONFLICT'
  | 'FIELD_OPTIONS_DIFFER'
  | 'VALUES_DROPPED'
  | 'PROJECT_RENAMED'
  | 'INVITES_NOT_SENT'
  | 'AUTOMATIONS_CREATED_OFF'
  | 'AUTOMATION_SKIPPED'
  | 'AUTOMATION_RENAMED'
  | 'VIEW_SKIPPED'
  | 'VIEW_NOT_SHARED'
  | 'WORKSPACE_IDENTITY_KEPT';

export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
  /** What the person can do about it (blockers). */
  suggestions?: string[];
}

export interface ApplyPlan {
  mode: TemplateInstallMode;
  tags: PlanTag[];
  customFields: PlanField[];
  issueTypes: PlanIssueType[];
  iterations: number;
  projects: PlanProject[];
  automations: PlanAutomation[];
  views: PlanView[];
  counts: {
    tasks: number;
    comments: number;
    dependencies: number;
    tags: { create: number; reuse: number };
    customFields: { create: number; reuse: number; skip: number };
    issueTypes: { create: number; reuse: number };
    droppedCustomValues: number;
    automations: { create: number; raw: number; skip: number };
    savedViews: { personal: number; shared: number; skip: number };
    /** Files the apply will COPY (one per task attachment) and their total size = the storage it reserves. */
    assets: { copies: number; bytes: number };
  };
  warnings: PlanIssue[];
  blockers: PlanIssue[];
}

export interface WorkspaceState {
  tags: Array<{ id: string; name: string }>;
  customFields: Array<{
    id: string;
    key: string;
    dataType: FieldType;
    options: unknown;
  }>;
  issueTypes: Array<{ id: string; name: string }>;
  projectNames: string[];
  projectCount: number;
  iterationCount: number;
  taskCount: number;
  /** step 5.5; absent = none (older callers) */
  automations?: { count: number; nameKeys: string[] };
  savedViews?: { personalOfUser: number; shared: number; canShare: boolean };
}

export interface LimitState {
  /** How many MORE projects the plan allows in this workspace/account; null = unlimited. */
  projectsRemaining: number | null;
  /** Per-project task cap (personal plans); null = none. */
  tasksPerProject: number | null;
  /** Step 3.7. Bytes the account may still store (plan limit minus live use incl. reservations); null = unlimited. */
  storageRemainingBytes?: number | null;
  /** Plan's per-file cap in bytes; null = none. */
  maxFileBytes?: number | null;
  /** sha256 of blueprint assets whose bytes are not in the template store (damaged template). */
  missingAssetShas?: string[];
}

export type ApplyTarget = {
  mode: TemplateInstallMode;
  /** The extracted template's kind. */
  kind: 'WORKSPACE' | 'PROJECT';
};

export const flattenTasks = (tasks: ResolvedTask[]): ResolvedTask[] =>
  tasks.flatMap((t) => [t, ...flattenTasks(t.children)]);
