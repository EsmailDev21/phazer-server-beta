import {
  FieldType,
  ImportIssueSeverity,
  IssueTypeLevel,
  IterationKind,
  Priority,
  TaskStatus,
} from '@prisma/client';
import {
  CanonicalAttachment,
  CanonicalCustomField,
  CanonicalCustomScalar,
  CanonicalDependency,
  CanonicalIssueType,
  CanonicalStatus,
  CanonicalUser,
} from '../canonical';

/**
 * Step 4.3. Types of the mapping engine: what a source looks like (inventory), what the workspace looks like (context),
 * what the person may override (config), what the engine recommends (suggestions), what it will really do (resolved),
 * and what it hands the executor (mapped page). Everything here is plain data: the engine is PURE (no database, no
 * clock, no randomness), so it can be exercised by tables of inputs and expected outputs.
 */

// ------------------------------------------------------------------------------------------------ targets

/** Who a source person becomes. */
export type UserTarget =
  /** A member of the target workspace: assigned to / credited with the source person's work. */
  | { kind: 'user'; userId: string }
  /**
   * Nobody local. They are NOT assigned tasks; what they authored (comments, history, creation) is credited to the
   * person running the import, labelled "Name (via <source>)".
   */
  | { kind: 'importer' };

/** What a source concept becomes in the workspace. */
export type EntityTarget =
  | { kind: 'existing'; id: string }
  | { kind: 'create' }
  /** Not imported (an issue type becomes "no type"; a custom field's values are dropped). */
  | { kind: 'skip' };

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

// ------------------------------------------------------------------------------------------------ inventory

/**
 * What exists in the source selection, de-duplicated. Built from the structure pages an adapter emits
 * (`buildInventory`) and stored on the job at preview time; the person maps against it. Bounded (INVENTORY_LIMITS).
 */
export interface MappingInventory {
  system: string;
  displayName: string;
  projects: Array<{ externalId: string; name: string; statuses: CanonicalStatus[] }>;
  /** Distinct raw priority values seen on tasks, first spelling kept. */
  priorities: string[];
  users: CanonicalUser[];
  issueTypes: CanonicalIssueType[];
  customFields: CanonicalCustomField[];
}

export const INVENTORY_LIMITS = {
  maxProjects: 500,
  maxStatusesPerProject: 30,
  maxPriorities: 200,
  maxUsers: 5000,
  maxIssueTypes: 200,
  maxCustomFields: 500,
} as const;

// ------------------------------------------------------------------------------------------------ context (the workspace side)

export interface LocalMember {
  userId: string;
  name: string;
  email: string | null;
  /** Only a VERIFIED address may be matched against a source's e-mail (an unverified one proves nothing about who owns it). */
  emailVerified: boolean;
}

export interface MappingContext {
  /** The person running the import: what "importer" means. */
  importerUserId: string;
  /** Who may be assigned / credited: members of the target workspace (account members + accepted collaborators). */
  members: LocalMember[];
  /** Earlier explicit links on this connection (IdentityLink). */
  identityLinks: Array<{ externalUserId: string; userId: string }>;
  issueTypes: Array<{ id: string; name: string; level: IssueTypeLevel }>;
  customFields: Array<{ id: string; name: string; dataType: FieldType }>;
}

// ------------------------------------------------------------------------------------------------ config (what the person saved)

/**
 * `ImportJob.mappingConfig` v1: ONLY what differs from the engine's suggestion. Arrays of rows (never objects keyed by
 * provider ids: no prototype-key games, stable order). Absent = "accept the suggestion".
 */
export interface MappingConfigV1 {
  version: 1;
  /** Match source people to members by verified e-mail. Default true. */
  matchByEmail?: boolean;
  projects?: Array<{ externalId: string; name: string }>;
  statuses?: Array<{
    statusExternalId: string;
    category?: TaskStatus;
    excludeFromProgress?: boolean;
    name?: string;
    /** Fold this source status into another status of the SAME project: one workflow status, both sets of tasks. */
    mergeInto?: string;
  }>;
  priorities?: Array<{ raw: string; priority: Priority | null }>;
  users?: Array<{ externalId: string; target: UserTarget }>;
  issueTypes?: Array<{ externalId: string; target: EntityTarget; level?: IssueTypeLevel }>;
  customFields?: Array<{ externalId: string; target: EntityTarget; name?: string }>;
}

export const EMPTY_CONFIG: Readonly<MappingConfigV1> = Object.freeze({ version: 1 });

// ------------------------------------------------------------------------------------------------ suggestions

export type StatusReason =
  | 'SOURCE_CATEGORY'
  | 'NAME_DONE'
  | 'NAME_CANCELED'
  | 'NAME_IN_PROGRESS'
  /** Heuristic on the name: confirmed in the Map step (diagram 07). */
  | 'NAME_BLOCKED'
  | 'DEFAULT';

export interface StatusSuggestion {
  projectExternalId: string;
  statusExternalId: string;
  name: string;
  category: TaskStatus;
  excludeFromProgress: boolean;
  confidence: Confidence;
  reason: StatusReason;
}

export type PriorityReason = 'SOURCE_TABLE' | 'GENERIC_TABLE' | 'NONE';

export interface PrioritySuggestion {
  raw: string;
  priority: Priority | null;
  confidence: Confidence;
  reason: PriorityReason;
}

export type UserReason = 'IDENTITY_LINK' | 'VERIFIED_EMAIL' | 'BOT' | 'NONE';

export interface UserSuggestion {
  externalId: string;
  name: string;
  email?: string;
  target: UserTarget;
  confidence: Confidence;
  reason: UserReason;
}

export interface IssueTypeSuggestion {
  externalId: string;
  name: string;
  target: EntityTarget;
  level: IssueTypeLevel;
  reason: 'NAME_MATCH' | 'NEW';
}

export interface CustomFieldSuggestion {
  externalId: string;
  name: string;
  dataType: FieldType;
  target: EntityTarget;
  /** Name shown for a created field (a conflicting name gets the source's name appended). */
  createName: string;
  reason: 'NAME_AND_TYPE_MATCH' | 'NEW' | 'NAME_CONFLICT';
}

export interface MappingSuggestions {
  statuses: StatusSuggestion[];
  priorities: PrioritySuggestion[];
  users: UserSuggestion[];
  issueTypes: IssueTypeSuggestion[];
  customFields: CustomFieldSuggestion[];
}

// ------------------------------------------------------------------------------------------------ resolved (suggestion + overrides)

export interface ResolvedStatus {
  projectExternalId: string;
  statusExternalId: string;
  /** The status this one is folded into (itself when not merged). Always a root: never a chain. */
  rootExternalId: string;
  name: string;
  category: TaskStatus;
  excludeFromProgress: boolean;
  color?: string;
  position?: number;
  overridden: boolean;
}

export interface ResolvedMapping {
  system: string;
  displayName: string;
  importerUserId: string;
  matchByEmail: boolean;
  projects: Map<string, { name: string }>;
  statuses: Map<string, ResolvedStatus>;
  /** key = foldName(raw) */
  priorities: Map<string, Priority | null>;
  /** `decided`: a person chose this target (an override row applied), so it is not "unmatched" even when it is the importer. */
  users: Map<string, { target: UserTarget; name: string; isBot: boolean; decided: boolean }>;
  issueTypes: Map<string, { target: EntityTarget; level: IssueTypeLevel; name: string }>;
  customFields: Map<string, { target: EntityTarget; name: string; dataType: FieldType }>;
}

export type AttentionKind = 'STATUS' | 'PRIORITY' | 'USER' | 'CUSTOM_FIELD' | 'CONFIG';

/** Something the person should look at before starting. None of these blocks the import. */
export interface AttentionItem {
  kind: AttentionKind;
  key: string;
  code:
    | 'STATUS_BLOCKED_GUESS'
    | 'STATUS_DEFAULTED'
    | 'PRIORITY_UNMATCHED'
    | 'USERS_UNMAPPED'
    | 'CUSTOM_FIELD_NAME_CONFLICT'
    | 'CONFIG_ROW_IGNORED';
  message: string;
}

export interface ConfigProblem {
  path: string;
  code:
    | 'INVALID_SHAPE'
    | 'DUPLICATE_KEY'
    | 'UNKNOWN_SOURCE_ENTITY'
    | 'MERGE_INVALID'
    | 'NAME_COLLISION'
    | 'NOT_A_MEMBER'
    | 'UNKNOWN_TARGET'
    | 'TYPE_MISMATCH'
    | 'CATEGORY_INVALID';
  message: string;
}

// ------------------------------------------------------------------------------------------------ mapped page (what the executor writes)

export type MappingIssueCode =
  | 'USER_UNMAPPED'
  | 'PRIORITY_UNMATCHED'
  | 'STATUS_UNKNOWN'
  | 'CUSTOM_VALUE_USER_UNMAPPED'
  | 'COMMENT_TRUNCATED';

/** Same shape as NewImportIssue (step 4.1): the executor passes these straight to ImportIssueService. */
export interface MappingIssue {
  severity: ImportIssueSeverity;
  code: MappingIssueCode;
  externalRef: string | null;
  message: string;
}

export type Author =
  | { kind: 'user'; userId: string }
  /** Credited to the importer; `label` ("Name (via Jira)") is also in the text, and kept for activity metadata. */
  | { kind: 'importer'; label: string };

export interface MappedStatus {
  externalId: string;
  /** Every source status folded into this one (including itself): tasks of all of them point here. */
  sourceExternalIds: string[];
  name: string;
  category: TaskStatus;
  excludeFromProgress: boolean;
  color: string;
  position: number;
}

export interface MappedProject {
  externalId: string;
  key?: string;
  name: string;
  description?: string;
  url?: string;
  archived?: boolean;
  createdAt?: string;
  statuses: MappedStatus[];
  /** First TODO-category status by position (else the first). Absent when the source has no statuses (executor seeds defaults). */
  initialStatusExternalId?: string;
}

export interface MappedComment {
  externalId: string;
  author: Author;
  body: string;
  createdAt?: string;
  editedAt?: string;
  parentExternalId?: string;
}

/** A file to copy (step 4.6). The uploader is resolved like any other author: a workspace member, or the importer. */
export type MappedAttachment = Omit<CanonicalAttachment, 'uploaderExternalId'> & { uploader: Author };

export interface MappedHistoryEntry {
  externalId: string;
  actor: Author | null;
  at: string;
  field: string;
  from?: string | null;
  to?: string | null;
}

export type MappedTarget = { kind: 'existing'; id: string } | { kind: 'create' };

export interface MappedCustomValue {
  fieldExternalId: string;
  target: MappedTarget;
  /** USER values are already local user ids. */
  value: CanonicalCustomScalar;
}

export interface MappedTask {
  externalId: string;
  key?: string;
  url?: string;
  projectExternalId?: string;
  parentExternalId?: string;
  title: string;
  description?: string;
  /** The category the task's `status` column takes. */
  status: TaskStatus;
  /** The (root) source status whose WorkflowStatus the task points at; absent = the project's initial status. */
  workflowStatusExternalId?: string;
  priority: Priority | null;
  issueType?: MappedTarget & { externalId: string };
  tags: string[];
  customValues: MappedCustomValue[];
  assigneeUserIds: string[];
  creator: Author;
  createdAt?: string;
  updatedAt?: string;
  startDate?: string;
  dueDate?: string;
  estimate?: number;
  iterationExternalId?: string;
  archived?: boolean;
  comments: MappedComment[];
  attachments: MappedAttachment[];
  history: MappedHistoryEntry[];
}

export interface MappedIssueType {
  externalId: string;
  name: string;
  level: IssueTypeLevel;
  color?: string;
}

export interface MappedCustomField {
  externalId: string;
  name: string;
  dataType: FieldType;
  options?: string[];
}

export interface MappedIteration {
  externalId: string;
  kind: IterationKind;
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  projectExternalId?: string;
}

/** One page, mapped. Entities with target `existing` are NOT listed (nothing to create); tasks reference them by id. */
export interface MappedPage {
  projects: MappedProject[];
  issueTypes: MappedIssueType[];
  customFields: MappedCustomField[];
  iterations: MappedIteration[];
  tags: Array<{ name: string; color?: string }>;
  tasks: MappedTask[];
  dependencies: CanonicalDependency[];
  issues: MappingIssue[];
}

export type { CanonicalUser };
