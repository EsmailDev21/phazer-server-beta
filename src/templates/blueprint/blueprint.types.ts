import {
  DependencyType,
  FieldType,
  IssueTypeLevel,
  IterationKind,
  Priority,
  TaskStatus,
} from '@prisma/client';

/**
 * Step 3.1. Blueprint v1: the portable, UNTRUSTED document that templates are stored as
 * (diagram 15). Pure data - nothing here is executed. The JSON Schema in blueprint.schema.ts is
 * the contract; these types mirror it by hand, and a test keeps the two honest (a "kitchen
 * sink" value of this type that uses every optional field must pass the schema).
 *
 * Read docs/design/blueprint-v1.md for the rules the schema cannot express (references,
 * uniqueness, placeholders, cycles) and for where v1 deliberately differs from diagram 15.
 *
 * Conventions
 *  - A field marked "templated" may contain `{{...}}` placeholders (see blueprint.expressions.ts).
 *    Every other string is literal: placeholders there are an ERROR, never silently ignored.
 *  - "ref" fields point at something else in the same document and must resolve.
 *  - Absent optional arrays mean "none".
 */
export const BLUEPRINT_SCHEMA_VERSION = 1 as const;

export type BlueprintKind = 'WORKSPACE' | 'PROJECT';
export type VariableType = 'TEXT' | 'DATE' | 'NUMBER' | 'SELECT' | 'BOOLEAN';
/** Roles are placeholders for people; nobody is ever assigned an OWNER role by a template. */
export type RoleAccess = 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface BlueprintMeta {
  /** Templated: no. Shown in the library; the template's own name, not the workspace's. */
  name: string;
  description?: string;
  /** WORKSPACE templates may create/merge a workspace; PROJECT templates hold exactly one project. */
  kind: BlueprintKind;
  /** Marketplace category slug (free text in v1; the list is a Phase 6 decision). */
  category?: string;
  /** BCP-47-ish language tag, e.g. "en", "pt-BR". */
  locale?: string;
}

/** What the apply step asks the person for. Referenced as `{{key}}`. */
export interface BlueprintVariable {
  /** Identifier: letters, digits, underscore. */
  key: string;
  label: string;
  type: VariableType;
  /** Must match `type`. DATE: "YYYY-MM-DD". */
  default?: string | number | boolean;
  /** SELECT only. */
  options?: string[];
  required?: boolean;
}

/** A person-shaped hole, resolved at apply time to a member / an invite / unassigned. */
export interface BlueprintRole {
  key: string;
  label: string;
  suggestedAccess?: RoleAccess;
}

/** An optional group of nodes the person can switch off at apply time. */
export interface BlueprintModule {
  key: string;
  label: string;
  /** Default true. */
  defaultEnabled?: boolean;
  /** nodeKeys of projects and/or tasks (a task includes its subtree). */
  includes: string[];
}

/**
 * Where "day 0" is. `variable` is a DATE variable; absent = the day the template is applied.
 * Offsets everywhere in the document are whole days from this anchor.
 */
export interface BlueprintDateAnchor {
  variable?: string;
  /** Move computed dates that land on a weekend to the following Monday. */
  skipWeekends?: boolean;
}

export interface BlueprintTag {
  /** Merge key at apply time: an existing tag with the same normalised name is reused. */
  name: string;
}

export interface BlueprintCustomField {
  /** Merge key at apply time (a key clash with a different dataType is skipped with a warning). */
  key: string;
  name: string;
  dataType: FieldType;
  /** SELECT / MULTI_SELECT only; required for them. */
  options?: string[];
  order?: number;
}

export interface BlueprintIssueType {
  /** Referenced from tasks by name (compared normalised). */
  name: string;
  icon?: string;
  color?: string;
  level?: IssueTypeLevel;
}

export interface BlueprintIteration {
  nodeKey: string;
  kind: IterationKind;
  name: string;
  goal?: string;
  startOffsetDays?: number;
  endOffsetDays?: number;
  /** nodeKey of a project. Absent = whole-workspace iteration. */
  project?: string;
}

export interface BlueprintWorkspace {
  /** Not allowed when meta.kind is PROJECT. Never overwrites an existing workspace's identity. */
  name?: string;
  key?: string;
  icon?: string;
  /** Templated. */
  description?: string;
  tags?: BlueprintTag[];
  customFields?: BlueprintCustomField[];
  issueTypes?: BlueprintIssueType[];
  iterations?: BlueprintIteration[];
}

export interface BlueprintWorkflowStatus {
  /** Local reference key, unique in the project. Tasks refer to a status by this. */
  key: string;
  name: string;
  category: TaskStatus;
  color?: string;
  /** Done category only. */
  excludeFromProgress?: boolean;
  /** At most one per category; the To Do default is where new tasks start. */
  isDefault?: boolean;
}

export interface BlueprintWorkflowTransition {
  from: string;
  to: string;
}

export interface BlueprintWorkflow {
  /** Array order is the display order. */
  statuses: BlueprintWorkflowStatus[];
  transitions?: BlueprintWorkflowTransition[];
  enforceTransitions?: boolean;
}

export interface BlueprintComment {
  /** Templated. */
  body: string;
  /** Role key; absent = anonymous. A comment is never attributed to a real person. */
  authorRole?: string;
}

/** `{ offsetDays }` is the only way a DATE custom value is written. */
export type BlueprintCustomValue =
  string | number | boolean | string[] | { offsetDays: number };

export interface BlueprintTask {
  /** Unique across the WHOLE document (projects, tasks and iterations share one namespace). */
  nodeKey: string;
  /** Templated. */
  title: string;
  /** Templated. Markdown; sanitised at render. */
  description?: string;
  /** Ref: workspace.issueTypes[].name. */
  issueType?: string;
  /** Ref: the project's workflow.statuses[].key. Needs a `workflow`. Absent = initial status. */
  status?: string;
  priority?: Priority;
  /** Ref: workspace.tags[].name. */
  tags?: string[];
  /** Keyed by workspace.customFields[].key. Never for USER fields. */
  customValues?: Record<string, BlueprintCustomValue>;
  /** Ref: roles[].key. Never user ids. */
  assigneeRoles?: string[];
  startOffsetDays?: number;
  dueOffsetDays?: number;
  /** Story points, 0..1000. */
  estimate?: number;
  /** Ref: an iteration nodeKey that is whole-workspace or belongs to this task's project. */
  iteration?: string;
  children?: BlueprintTask[];
  comments?: BlueprintComment[];
  /** Ref: assets[].key. */
  attachments?: string[];
}

export interface BlueprintDependency {
  /** nodeKey of the blocking task. */
  from: string;
  /** nodeKey of the blocked task. Both tasks must be in the same project. */
  to: string;
  type?: DependencyType;
}

export interface BlueprintProject {
  nodeKey: string;
  /** Templated. */
  name: string;
  /** Templated. */
  description?: string;
  /** Absent = the product's default workflow at apply time. */
  workflow?: BlueprintWorkflow;
  tasks: BlueprintTask[];
  dependencies?: BlueprintDependency[];
  /**
   * RESERVED for Phase 5: opaque JSON, stored and carried, never interpreted or run until
   * step 5.5 defines the shape. The applier ignores them.
   */
  automations?: Array<Record<string, unknown>>;
  views?: Array<Record<string, unknown>>;
}

/** Metadata of a file the template carries; the bytes live in TemplateAsset (step 3.7). */
export interface BlueprintAsset {
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the bytes. */
  sha256: string;
}

export interface BlueprintV1 {
  schemaVersion: typeof BLUEPRINT_SCHEMA_VERSION;
  meta: BlueprintMeta;
  dateAnchor?: BlueprintDateAnchor;
  variables?: BlueprintVariable[];
  roles?: BlueprintRole[];
  modules?: BlueprintModule[];
  workspace?: BlueprintWorkspace;
  projects: BlueprintProject[];
  assets?: BlueprintAsset[];
  /**
   * Reserved. v1 readers ignore it, writers must carry it through unchanged. Keys are
   * lower-case dotted/dashed names (e.g. "acme.notes"); values are any JSON.
   */
  extensions?: Record<string, unknown>;
}

export type Blueprint = BlueprintV1;
