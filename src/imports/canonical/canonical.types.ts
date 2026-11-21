import {
  DependencyType,
  FieldType,
  ImportIssueSeverity,
  IssueTypeLevel,
  IterationKind,
} from '@prisma/client';

/**
 * Step 4.2. CanonicalBundle v1: ONE PAGE of a source's data, in our vocabulary (diagram 05: "Adapter.fetchBundle(cursor)
 * -> Normalize -> CanonicalBundle page"). Every provider adapter emits this and nothing else; the mapping engine (4.3) and
 * the executor (4.4) read only this. Provider quirks end HERE.
 *
 * It is NOT a Blueprint (templates, 3.1). A Blueprint is a self-contained document with local keys, relative dates,
 * roles and placeholders. A bundle page is a slice of a live system: absolute dates, real people, the provider's own ids,
 * and references that may point at something on ANOTHER page (resolved through ExternalRef at write time). They share
 * the machinery that does not care (canonical JSON + checksum, name folding, text limits); see canonical.limits.ts.
 *
 * Conventions
 *  - `externalId` is the provider's id, verbatim, as a string, stable across runs. If the provider scopes ids (a Linear
 *    state id is only unique in its team) the ADAPTER composes a globally unique one ("<teamId>:<stateId>").
 *  - A `...ExternalId` field is a reference to another entity by that id.
 *  - Text is markdown (normalizers turn ADF / HTML into it). Instants are ISO-8601 UTC with milliseconds.
 *  - Absent optional field = "the source has no value".
 */
export const CANONICAL_SCHEMA_VERSION = 1 as const;

/** Neutral rollup of a source status; step 4.3 maps it to our TaskStatus. Never BLOCKED (nobody's source means that). */
export type SourceStatusCategory = 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELED' | 'UNKNOWN';

export interface CanonicalSource {
  /** Lower-case provider slug, e.g. "linear", "jira". Used in attribution ("Name (via Jira)"). */
  system: string;
  displayName: string;
}

export interface CanonicalUser {
  externalId: string;
  name: string;
  /** What 4.3 matches on (case-folded). Absent for providers that hide it. */
  email?: string;
  avatarUrl?: string;
  isBot?: boolean;
}

export interface CanonicalStatus {
  externalId: string;
  name: string;
  category: SourceStatusCategory;
  color?: string;
  /** Source display order; array order is the fallback. */
  position?: number;
}

export interface CanonicalProject {
  externalId: string;
  /** Short human key (ENG), display only. */
  key?: string;
  name: string;
  description?: string;
  url?: string;
  archived?: boolean;
  createdAt?: string;
  statuses?: CanonicalStatus[];
}

export interface CanonicalTag {
  /** Identity is the (folded) name; labels are merged by it. */
  name: string;
  color?: string;
}

export interface CanonicalCustomFieldOption {
  externalId?: string;
  label: string;
}

export interface CanonicalCustomField {
  externalId: string;
  name: string;
  dataType: FieldType;
  /** SELECT / MULTI_SELECT. A value is one of these labels. */
  options?: CanonicalCustomFieldOption[];
}

export interface CanonicalIssueType {
  externalId: string;
  name: string;
  level?: IssueTypeLevel;
  color?: string;
}

export interface CanonicalIteration {
  externalId: string;
  kind: IterationKind;
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  /** Absent = whole-workspace. */
  projectExternalId?: string;
}

/** string | number | boolean | string[]; a DATE value is an ISO date or instant, a USER value a user externalId. */
export type CanonicalCustomScalar = string | number | boolean | string[];

export interface CanonicalCustomValue {
  fieldExternalId: string;
  value: CanonicalCustomScalar;
}

export interface CanonicalComment {
  externalId: string;
  authorExternalId?: string;
  /** Shown when the author has no account to map to ("Name (via Jira)"). */
  authorName?: string;
  body: string;
  createdAt?: string;
  editedAt?: string;
  /** One level of replies only; a reply to a reply is re-attached to the thread's root. */
  parentExternalId?: string;
}

export interface CanonicalAttachment {
  externalId: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Opaque to everything but the adapter's `fetchAttachment` (4.6). NOT a URL we fetch. */
  providerRef: string;
  uploaderExternalId?: string;
  createdAt?: string;
}

/** One change in the source's history, as a generic field diff (step 4.6 writes it as silent activity). */
export interface CanonicalHistoryEntry {
  externalId: string;
  actorExternalId?: string;
  at: string;
  field: string;
  from?: string | null;
  to?: string | null;
}

export interface CanonicalTask {
  externalId: string;
  /** Human key (ENG-42), display only. */
  key?: string;
  url?: string;
  projectExternalId?: string;
  parentExternalId?: string;
  title: string;
  description?: string;
  statusExternalId?: string;
  /** The source's raw priority label ("High", "P1", "3"). Step 4.3 maps it to our enum. */
  priority?: string;
  issueTypeExternalId?: string;
  tags?: string[];
  customValues?: CanonicalCustomValue[];
  assigneeExternalIds?: string[];
  creatorExternalId?: string;
  createdAt?: string;
  updatedAt?: string;
  startDate?: string;
  dueDate?: string;
  /** Story points, 0..1000. */
  estimate?: number;
  iterationExternalId?: string;
  archived?: boolean;
  comments?: CanonicalComment[];
  attachments?: CanonicalAttachment[];
  history?: CanonicalHistoryEntry[];
}

export interface CanonicalDependency {
  externalId: string;
  /** The blocking task. */
  fromExternalId: string;
  /** The blocked task. */
  toExternalId: string;
  type: DependencyType;
}

export interface CanonicalBundle {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  source: CanonicalSource;
  users?: CanonicalUser[];
  projects?: CanonicalProject[];
  tags?: CanonicalTag[];
  customFields?: CanonicalCustomField[];
  issueTypes?: CanonicalIssueType[];
  iterations?: CanonicalIteration[];
  tasks?: CanonicalTask[];
  dependencies?: CanonicalDependency[];
}

// ---------------------------------------------------------------------------------------------- results

/**
 * What validation reports. Same shape as NewImportIssue (step 4.1) on purpose: the executor passes these straight to
 * ImportIssueService.record. `code` is stable; `externalRef` is "<kind>:<externalId>" (null = about the page).
 */
export type BundleIssueCode =
  // the item could not be used and was skipped
  | 'ITEM_INVALID'
  | 'DUPLICATE_ID'
  // the item was kept but a value was repaired or dropped
  | 'TEXT_SANITIZED'
  | 'TITLE_EMPTY'
  | 'TITLE_TRUNCATED'
  | 'NAME_TRUNCATED'
  | 'DESCRIPTION_TRUNCATED'
  | 'COMMENT_TRUNCATED'
  | 'COMMENT_EMPTY'
  | 'COMMENTS_LIMIT'
  | 'COMMENT_PARENT_INVALID'
  | 'ATTACHMENTS_LIMIT'
  | 'HISTORY_LIMIT'
  | 'DATE_INVALID'
  | 'DATE_ORDER'
  | 'URL_INVALID'
  | 'ESTIMATE_INVALID'
  | 'TAG_INVALID'
  | 'TAGS_LIMIT'
  | 'ASSIGNEES_LIMIT'
  | 'CUSTOM_VALUE_INVALID'
  | 'STATUS_NAME_DUPLICATE'
  | 'STATUSES_LIMIT'
  | 'SELF_PARENT'
  | 'PARENT_CYCLE'
  | 'DEPENDENCY_SELF'
  | 'DEPENDENCY_CYCLE'
  | 'MIME_INVALID'
  | 'FIELD_INVALID'
  | 'ISSUES_TRUNCATED';

export interface BundleIssue {
  severity: ImportIssueSeverity;
  code: BundleIssueCode;
  externalRef: string | null;
  message: string;
}

export type BundleFatalCode =
  | 'NOT_JSON'
  | 'TOO_DEEP'
  | 'TOO_LARGE'
  | 'VERSION_INVALID'
  | 'BAD_SHAPE'
  | 'PAGE_TOO_LARGE'
  /** The page still violates the schema AFTER repair: a bug in the adapter (it emitted a field the format does not have). */
  | 'ADAPTER_BUG';

export interface BundleStats {
  users: number;
  projects: number;
  tags: number;
  customFields: number;
  issueTypes: number;
  iterations: number;
  tasks: number;
  comments: number;
  attachments: number;
  history: number;
  dependencies: number;
  /** Items removed from the page (they are in `issues` as ITEM_INVALID / DUPLICATE_ID / ...). */
  skipped: number;
}

export type BundleValidation =
  | { ok: true; bundle: CanonicalBundle; issues: BundleIssue[]; stats: BundleStats }
  | { ok: false; fatal: { code: BundleFatalCode; message: string; details?: string[] }; issues: BundleIssue[] };
