import {
  DependencyType,
  FieldType,
  IssueTypeLevel,
  IterationKind,
  Priority,
  TaskStatus,
} from '@prisma/client';
import {
  BlueprintCustomField,
  BlueprintIssueType,
  BlueprintMeta,
  BlueprintTag,
  BlueprintWorkflow,
} from '../blueprint';

/**
 * Step 3.3. What the extractor reads (a plain-data snapshot of one workspace, so the builder is
 * pure and testable without a database) and what it produces (a RAW blueprint).
 *
 * RAW = blueprint-shaped but still carrying what a real workspace has and a template must not:
 * user ids, absolute dates, comment authors and timestamps, source ids. Step 3.4 (sanitizer)
 * turns users into role placeholders, dates into offsets, strips ids, scans text, and only
 * then is the result a valid BlueprintV1. Nothing here is safe to store or share.
 */
export interface WorkspaceSnapshot {
  /** step 5.5; absent = none */
  automations?: SnapAutomation[];
  views?: SnapView[];
  workspace: {
    id: string;
    name: string;
    key: string;
    icon: string | null;
    description: string | null;
  };
  tags: Array<{ id: string; name: string }>;
  customFields: Array<{
    id: string;
    key: string;
    name: string;
    dataType: FieldType;
    options: unknown;
    order: number;
  }>;
  issueTypes: Array<{
    id: string;
    name: string;
    icon: string | null;
    color: string;
    level: IssueTypeLevel;
  }>;
  iterations: Array<{
    id: string;
    projectId: string | null;
    kind: IterationKind;
    name: string;
    goal: string | null;
    startDate: Date | null;
    endDate: Date | null;
    createdAt: Date;
  }>;
  projects: Array<{
    id: string;
    name: string;
    description: string | null;
    enforceTransitions: boolean;
    createdAt: Date;
  }>;
  statuses: Array<{
    id: string;
    projectId: string;
    name: string;
    color: string;
    position: number;
    category: TaskStatus;
    excludeFromProgress: boolean;
    isDefault: boolean;
  }>;
  transitions: Array<{
    projectId: string;
    fromStatusId: string;
    toStatusId: string;
  }>;
  tasks: Array<{
    id: string;
    number: number;
    projectId: string | null;
    parentId: string | null;
    title: string;
    description: string | null;
    workflowStatusId: string | null;
    issueTypeId: string | null;
    iterationId: string | null;
    priority: Priority | null;
    estimate: number | null;
    startDate: Date | null;
    dueDate: Date | null;
    isArchived: boolean;
    createdAt: Date;
    assigneeIds: string[];
    tagIds: string[];
    customValues: Array<{ fieldId: string; value: unknown }>;
  }>;
  dependencies: Array<{
    blockingTaskId: string;
    blockedTaskId: string;
    type: DependencyType;
  }>;
  /** Only when the caller opted in. */
  comments?: Array<{
    id: string;
    taskId: string;
    authorId: string;
    content: string;
    parentCommentId: string | null;
    createdAt: Date;
  }>;
  attachments?: Array<{
    id: string;
    taskId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    confirmed: boolean;
    createdAt: Date;
  }>;
}

export interface ExtractOptions {
  /** Extract ONE project as a PROJECT template. Absent = the whole workspace. */
  projectId?: string;
  includeComments?: boolean;
  includeAttachments?: boolean;
  includeArchived?: boolean;
  /** Template name; defaults to the workspace / project name. */
  name?: string;
  description?: string;
  category?: string;
  locale?: string;
}

export interface RawComment {
  body: string;
  authorUserId: string;
  /** ISO date-time. */
  createdAt: string;
}

export interface RawAsset {
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceAttachmentId: string;
}

export interface RawTask {
  nodeKey: string;
  title: string;
  description?: string;
  issueType?: string;
  status?: string;
  priority?: Priority;
  tags: string[];
  /** Keyed by the (normalised) custom field key; values exactly as stored. */
  customValues: Record<string, unknown>;
  assigneeUserIds: string[];
  /** "YYYY-MM-DD", UTC date part of the stored timestamp. */
  startDate?: string;
  dueDate?: string;
  estimate?: number;
  iteration?: string;
  children: RawTask[];
  comments: RawComment[];
  attachments: string[];
}

export interface RawIteration {
  nodeKey: string;
  kind: IterationKind;
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  project?: string;
}

/** Step 5.5. An automation of the workspace, as the extractor reads it (ids; it turns them into names). */
export interface SnapAutomation {
  id: string;
  projectId: string | null;
  name: string;
  /** 1 = the rule DSL, 0 = a raw definition kept as received */
  ruleVersion: number;
  trigger: unknown;
  conditions: unknown;
  actions: unknown;
  sourceDefinition: unknown;
}

/** Step 5.5. A SHARED saved view (personal views are never read: they belong to one person). */
export interface SnapView {
  id: string;
  projectId: string | null;
  name: string;
  layout: string;
  config: unknown;
}

export interface RawProject {
  nodeKey: string;
  name: string;
  description?: string;
  workflow?: BlueprintWorkflow;
  tasks: RawTask[];
  dependencies: Array<{ from: string; to: string; type: DependencyType }>;
  /** step 5.5: portable (kind rule.v1) and raw items */
  automations?: Array<Record<string, unknown>>;
  /** step 5.5: portable saved views (kind view.v1) */
  views?: Array<Record<string, unknown>>;
}

export interface RawBlueprint {
  schemaVersion: 1;
  meta: BlueprintMeta;
  workspace: {
    name?: string;
    key?: string;
    icon?: string;
    description?: string;
    tags: BlueprintTag[];
    customFields: BlueprintCustomField[];
    issueTypes: BlueprintIssueType[];
    iterations: RawIteration[];
  };
  projects: RawProject[];
  assets: RawAsset[];
  /** For the sanitizer to strip; never part of a stored template. */
  source: { workspaceId: string; projectId?: string };
}

export interface ExtractionReport {
  tasks: {
    included: number;
    archivedSkipped: number;
    inboxSkipped: number;
    orphanedSkipped: number;
    tooDeepSkipped: number;
  };
  dependencies: {
    included: number;
    droppedOutsideProject: number;
    droppedMissingEnd: number;
  };
  comments: { included: number; repliesFlattened: number };
  attachments: { included: number; unconfirmedSkipped: number };
  /** Custom field keys that had to change to fit the blueprint's key format. */
  customFieldKeyChanges: Array<{ from: string; to: string }>;
  iterationsOutOfScope: number;
  /** Step 5.5: what happened to the project-scoped automations and shared views (workspace-wide ones are not carried). */
  automations: {
    included: number;
    raw: number;
    skipped: Array<{ name: string; reason: string }>;
  };
  views: { included: number; skipped: Array<{ name: string; reason: string }> };
  /** The extracted task count exceeds what one blueprint may hold; validation would refuse it. */
  exceedsNodeLimit: boolean;
}

export class ExtractError extends Error {
  constructor(
    readonly code: 'PROJECT_NOT_FOUND' | 'TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}
