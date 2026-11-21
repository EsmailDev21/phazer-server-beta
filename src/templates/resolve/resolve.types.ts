import {
  BlueprintAsset,
  BlueprintDependency,
  BlueprintMeta,
  BlueprintWorkflow,
  BlueprintCustomField,
  BlueprintIssueType,
  BlueprintTag,
} from '../blueprint';
import { DependencyType, IterationKind, Priority } from '@prisma/client';

/**
 * Step 3.2. Types of the apply-time resolution pipeline (diagram 15, steps 2-5). Everything in
 * this folder is PURE: no I/O, no clock (the caller passes `today`), no randomness.
 */
export type ResolveIssueCode =
  | 'BLUEPRINT_INVALID'
  | 'VARIABLE_UNKNOWN'
  | 'VARIABLE_MISSING'
  | 'VARIABLE_INVALID'
  | 'TEXT_BLANK'
  | 'TEXT_TOO_LONG'
  | 'RENDER_FAILED'
  | 'DATE_INVALID'
  | 'DATE_OUT_OF_RANGE'
  | 'MODULE_UNKNOWN'
  | 'MODULE_INVALID'
  | 'ROLE_UNKNOWN'
  | 'ROLE_INVALID'
  | 'TOO_MANY_INVITES';

export interface ResolveIssue {
  code: ResolveIssueCode;
  path: string;
  message: string;
}

export type VariableValue = string | number | boolean;
/** Only variables that HAVE a value (supplied or defaulted). */
export type VariableValues = ReadonlyMap<string, VariableValue>;

export type RoleAssignment =
  | { type: 'MEMBER'; userId: string }
  | { type: 'INVITE'; email: string }
  | { type: 'UNASSIGNED' };

export interface ResolvedRole {
  key: string;
  label: string;
  suggestedAccess?: 'ADMIN' | 'MEMBER' | 'VIEWER';
  assignment: RoleAssignment;
}

export type ResolvedCustomValue = string | number | boolean | string[];

export interface ResolvedTask {
  nodeKey: string;
  title: string;
  description?: string;
  issueType?: string;
  status?: string;
  priority?: Priority;
  tags: string[];
  customValues: Record<string, ResolvedCustomValue>;
  assigneeRoles: string[];
  /** Members only. Invited people cannot be assigned until they accept (applier's concern). */
  assigneeUserIds: string[];
  /** "YYYY-MM-DD" */
  startDate?: string;
  dueDate?: string;
  estimate?: number;
  iteration?: string;
  children: ResolvedTask[];
  comments: Array<{ body: string; authorRole?: string }>;
  attachments: string[];
}

export interface ResolvedIteration {
  nodeKey: string;
  kind: IterationKind;
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  project?: string;
}

export interface ResolvedProject {
  nodeKey: string;
  name: string;
  description?: string;
  workflow?: BlueprintWorkflow;
  tasks: ResolvedTask[];
  dependencies: Array<{ from: string; to: string; type: DependencyType }>;
  automations: Array<Record<string, unknown>>;
  views: Array<Record<string, unknown>>;
}

export interface DroppedByModules {
  projects: string[];
  tasks: string[];
  iterations: string[];
  assets: string[];
  dependencies: number;
}

export interface ResolvedBlueprint {
  meta: BlueprintMeta;
  /** The day offsets were counted from. */
  anchorDate: string;
  workspace: {
    name?: string;
    key?: string;
    icon?: string;
    description?: string;
    tags: BlueprintTag[];
    customFields: BlueprintCustomField[];
    issueTypes: BlueprintIssueType[];
    iterations: ResolvedIteration[];
  };
  projects: ResolvedProject[];
  assets: BlueprintAsset[];
  roles: ResolvedRole[];
  dropped: DroppedByModules;
}

export type { BlueprintDependency, BlueprintWorkflow };

export class Issues {
  readonly items: ResolveIssue[] = [];
  truncated = false;
  constructor(private readonly max = 100) {}
  get count(): number {
    return this.items.length;
  }
  add(code: ResolveIssueCode, path: string, message: string): void {
    if (this.items.length >= this.max) {
      this.truncated = true;
      return;
    }
    this.items.push({ code, path, message });
  }
}
