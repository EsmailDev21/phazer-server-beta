/**
 * Step 3.8. What changed between two versions of a blueprint, identified by nodeKey (never by
 * position), so a rename, a move or a reorder is reported as exactly that and not as a delete
 * plus an add.
 */
export type DiffEntity =
  | 'document' | 'meta' | 'dateAnchor' | 'variable' | 'role' | 'module' | 'workspace' | 'tag'
  | 'customField' | 'issueType' | 'iteration' | 'project' | 'workflow' | 'status' | 'transition'
  | 'dependency' | 'task' | 'comment' | 'automation' | 'view' | 'asset';

export type DiffKind = 'added' | 'removed' | 'modified' | 'moved' | 'reordered';

export interface DiffField {
  /** Dotted path inside the entity, e.g. `title`, `customValues.points`, `workflow.enforceTransitions`. */
  field: string;
  before?: unknown;
  after?: unknown;
  /** Arrays of scalars: what appeared / disappeared (by value). */
  added?: unknown[];
  removed?: unknown[];
  /** Arrays of scalars: same members, different order. */
  reordered?: true;
  /** A value was too large to carry: it is replaced by a short marker. */
  clipped?: true;
}

export interface DiffChange {
  entity: DiffEntity;
  /** The entity's stable key inside its scope (nodeKey, tag name folded, field key, ...). */
  id: string;
  /** Enclosing project / task nodeKey for statuses, transitions, dependencies, comments... */
  scope?: string;
  /** Human label (title / name), from the newer side when it exists. */
  label: string;
  kind: DiffKind;
  /**
   * added/removed: every field of the entity. modified/moved: only the fields that differ.
   * `moved` carries exactly `project` and `parent`.
   */
  fields?: DiffField[];
  /** reordered: the container and the keys in each order (only keys present on both sides). */
  container?: { entity: DiffEntity; id: string; field: string };
  before?: string[];
  after?: string[];
  /** reordered only: the order does not change what an apply does (tags, dependencies...). */
  minor?: true;
}

export interface DiffCounts { added: number; removed: number; modified: number; moved: number; reordered: number }

export interface BlueprintDiff {
  /** True exactly when the two documents are equal (canonical JSON). */
  identical: boolean;
  summary: DiffCounts & { total: number; byEntity: Partial<Record<DiffEntity, DiffCounts>> };
  changes: DiffChange[];
  /** `changes` was cut at `maxChanges`; the summary still counts everything. */
  truncated: boolean;
}

export interface DiffOptions { maxChanges?: number }
