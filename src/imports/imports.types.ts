import { ImportIssueSeverity } from '@prisma/client';
import type { AttentionItem, MappingInventory } from './mapping/mapping.types';

/**
 * Step 4.1. The JSON documents stored on ImportJob. Provider-neutral: an adapter fills them with its
 * own ids and `type` strings ('team', 'project', 'space', 'list', ...). Stored as JSON, so every one of
 * them is validated on the way IN (imports.validation.ts) and treated as untrusted on the way out.
 */

/**
 * Step 4.10. The jobs a field/column/property of a source can do for the import. Monday (several status columns) and Notion
 * (arbitrary properties) cannot say which one is THE status or THE due date, so the person chooses per source; Asana, ClickUp,
 * Jira and Linear never need it. Closed set: a new role is a deliberate change here, in the validation and in the picker.
 */
export const FIELD_ROLES = ['status', 'priority', 'assignee', 'due', 'start'] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];

/** role -> field id, as chosen by the person. A role that is absent = "use the suggestion"; `null` = "none: do not map this role". */
export type FieldRoleChoice = Partial<Record<FieldRole, string | null>>;

/** One choosable field (a Monday column, a Notion property) of a selectable source, as `discover()` reports it. */
export interface SourceField {
  id: string;
  name: string;
  /** The provider's word for its type ('status', 'people', 'date', 'select', ...); shown as a hint only. */
  type: string;
  /** The roles this field can sensibly play, decided by the adapter from its type. A field with no roles is not offered. */
  roles: FieldRole[];
  /** The roles the adapter would give it by default (see `suggestFieldRoles`). */
  suggested?: FieldRole[];
}

/** One thing in the provider's hierarchy, as `discover()` reports it. Flat list; `parentId` gives the tree. */
export interface SourceNode {
  id: string;
  /** Provider's word for it: 'team' | 'project' | 'space' | 'folder' | 'list' | 'repo' ... */
  type: string;
  name: string;
  parentId?: string | null;
  /** false = a grouping node the person cannot pick on its own (selecting its children is the way). */
  selectable: boolean;
  /** Cheap hint shown in the picker; the preview computes the real number. */
  taskCount?: number;
  /** Step 4.10: the fields the person may assign roles to (only for providers that need it, on selectable nodes). */
  fields?: SourceField[];
}

export interface SourceTree {
  nodes: SourceNode[];
  /** Step 4.12: what to tell the person when there is nothing to pick (Notion: "nothing is shared with this connection yet"). */
  hint?: string;
}

export interface ImportSelection {
  /** `fieldRoles` (step 4.10): which of the source's fields plays which role; absent = the adapter's suggestion. */
  sources: Array<{ id: string; type: string; fieldRoles?: FieldRoleChoice }>;
}

/** What to bring along besides the tasks themselves. */
export interface ImportOptions {
  comments: boolean;
  attachments: boolean;
  /** Activity history (silent, original timestamps, external actor in metadata) - step 4.6. */
  history: boolean;
  /** Keep the source's createdAt/updatedAt/completedAt instead of "now". */
  keepDates: boolean;
  /**
   * Step 4.9. INTERNAL: set by `startAsTemplate`, never accepted from a request body (parseOptions refuses unknown keys). 'TEMPLATE' =
   * nothing is written to the workspace: the import is read, mapped and stored as a PRIVATE template (see ImportTemplateRunner).
   */
  target?: 'TEMPLATE';
  template?: TemplateTarget;
}

export interface TemplateTarget {
  name: string;
  description?: string;
  category?: string;
  /** Carry the comments as role-attributed reference comments. Default false. */
  includeComments?: boolean;
  /** 'block' (default): a credential-shaped string stops the import. 'redact': it is removed from the text and the import continues. */
  onSecret?: 'block' | 'redact';
}

export const DEFAULT_IMPORT_OPTIONS: Readonly<ImportOptions> = {
  comments: true,
  attachments: true,
  history: true,
  keepDates: true,
};

/** What `adapter.estimate()` reports for a selection: the dry run. No writes anywhere. */
export interface ImportEstimate {
  projects: Array<{ sourceId: string; name: string; tasks: number }>;
  comments?: number;
  attachments?: number;
  attachmentBytes?: number;
  /** Distinct people seen on the selected items (assignees, authors). Step 4.3 maps them. */
  users?: number;
  warnings?: Array<{ code: string; message: string }>;
  /**
   * What exists in the selection, for the Map step (step 4.3): statuses per project, priorities seen, people, issue types,
   * custom fields. Built with `buildInventory` from the adapter's structure pages. Without it the person can still save
   * overrides, but nothing can be suggested or checked.
   */
  inventory?: MappingInventory;
}

export type PreflightBlockerCode =
  | 'PROJECT_LIMIT'
  | 'TASK_LIMIT'
  | 'IMPORT_ITEMS_LIMIT'
  | 'CONNECTION_NOT_ACTIVE'
  | 'NOTHING_TO_IMPORT';

export interface PreflightBlocker {
  code: PreflightBlockerCode;
  message: string;
  /** The source project the blocker is about (TASK_LIMIT), so the person can "import a subset". */
  sourceId?: string;
}

/** G1 of diagram 04, as stored on the job after a preview and recomputed at start. */
export interface ImportPreviewSummary {
  generatedAt: string;
  counts: {
    projects: number;
    tasks: number;
    comments: number;
    attachments: number;
    attachmentBytes: number;
    users: number;
  };
  projects: Array<{ sourceId: string; name: string; tasks: number }>;
  warnings: Array<{ code: string; message: string }>;
  /** Source people the mapping engine could not match to a member (step 4.3): external ids, at most 200. */
  unmappedUsers: string[];
  /** Things to look at before starting (step 4.3). Absent when the adapter gave no inventory. */
  mapping?: { attention: AttentionItem[] };
  plan: {
    /** Items the monthly import quota is charged for = tasks (ADR-0030). */
    importItems: number;
    blockers: PreflightBlocker[];
  };
}

/** The executor's counters (step 4.4). Shape fixed now so the report and SSE have something to read. */
export interface ImportProgress {
  phase: string | null;
  /** created / updated / skipped / failed per object type, e.g. { task: { created: 40, skipped: 2 } }. */
  counts: Record<string, Partial<Record<'created' | 'updated' | 'skipped' | 'failed', number>>>;
  /** Items charged to the monthly quota so far, by 'YYYY-MM' period (so rollback refunds the right month). */
  chargedByPeriod: Record<string, number>;
  updatedAt: string;
}

export interface ImportCheckpoint {
  phase: string;
  /** Opaque to everything but the adapter. */
  cursor: unknown;
}

export interface ImportJobIssueDto {
  id: string;
  severity: ImportIssueSeverity;
  code: string;
  externalRef: string | null;
  message: string;
  createdAt: Date;
}

/** Queue payloads (declared next to the handlers by declaration merging, see queue.definitions.ts). */
declare module '../queue/queue.definitions' {
  interface JobPayloads {
    'imports.run': { importJobId: string; attempt: number };
    'imports.rollback': { importJobId: string };
    /** Step 4.6. Acts only when `attempt` is the job's current attempt and the job is RUNNING. */
    'imports.copy-files': { importJobId: string; attempt: number };
  }
}
