interface AssigneeSummary {
  id: string;
  name: string;
  avatar: string | null;
}

/**
 * Matches the one place the old code already did this correctly, plus the
 * CORRECTED addition of commentCount/attachmentCount (both _count, cheap
 * even at list scale) found missing during the UI consolidation pass —
 * the Kanban/List card design assumed these badges existed and they
 * didn't. STILL NOT included: description, customValues, tags,
 * dependencies, full comment content — none of that renders in a
 * list/kanban card view.
 */
export interface TaskListItemDto {
  id: string;
  title: string;
  /** The CATEGORY (TODO | IN_PROGRESS | BLOCKED | DONE); authoritative for progress etc. */
  status: string;
  /** The specific workflow status (ADR-0006); null for Inbox tasks. */
  workflowStatusId: string | null;
  /** ADR-0007; null = untyped / not in an iteration. */
  issueTypeId: string | null;
  iterationId: string | null;
  /** ADR-0008: story points; null = not estimated. */
  estimate: number | null;
  priority: string | null;
  dueDate: Date | null;
  /** Gantt/timeline need the start as well as the due date. null = not set. */
  startDate: Date | null;
  projectId: string | null;
  /** The parent task, or null for a top-level task (ADR-0005). */
  parentId: string | null;
  assignees: AssigneeSummary[];
  commentCount: number;
  attachmentCount: number;
}

export interface TaskDependencySummary {
  id: string;
  type: string;
  task: { id: string; title: string; status: string };
}

export interface TaskCustomValueSummary {
  fieldId: string;
  field: {
    id: string;
    name: string;
    key: string;
    dataType: string;
    options: unknown;
  };
  value: unknown;
}

export interface ExternalLinkDto {
  id: string;
  provider: string;
  kind: string;
  externalId: string;
  url: string;
  title: string;
  /** The provider's own word (open / merged / closed ...); null when the kind has none. */
  state: string | null;
  lastSeenAt: Date;
}

/** At most this many links are returned in a task's detail (newest first); the total is separate. */
export const MAX_EXTERNAL_LINKS_IN_DETAIL = 50;

export interface TaskDetailDto extends TaskListItemDto {
  /** Step 1.6. Newest first, capped at MAX_EXTERNAL_LINKS_IN_DETAIL. */
  externalLinks: ExternalLinkDto[];
  /** All links of the task, including any beyond the cap. */
  externalLinkCount: number;
  /** The specific status with its display data (ADR-0006); null for Inbox tasks. */
  workflowStatus: {
    id: string;
    name: string;
    color: string;
    category: string;
  } | null;
  issueType: {
    id: string;
    name: string;
    icon: string | null;
    color: string;
    level: string;
  } | null;
  iteration: {
    id: string;
    name: string;
    kind: string;
    state: string;
    projectId: string | null;
  } | null;
  /** Permanent per-workspace number (ADR-0004). null only before the backfill. */
  number: number | null;
  /** "ENG-123": the workspace's CURRENT key plus the number. null until both exist. */
  key: string | null;
  /** Direct, non-archived subtasks. */
  subtaskCount: number;
  /**
   * Progress of this task's non-archived LEAF descendants (ADR-0005 decision 6);
   * null when it has no subtasks. Independent of this task's own status.
   */
  subtaskProgress: { done: number; total: number; percent: number } | null;
  description: string | null;
  customValues: TaskCustomValueSummary[];
  tags: { id: string; name: string }[];
  blockedBy: TaskDependencySummary[]; // dependencies where THIS task is blockedTask
  blocking: TaskDependencySummary[]; // dependencies where THIS task is blockingTask
}

/**
 * Dedicated Table-view shape — found missing during the UI consolidation
 * pass (Table view asserted customValues-as-columns with no contract ever
 * defined). Everything in TaskListItemDto PLUS customValues/tags, and a
 * simple `blocked: boolean` indicator (NOT the full dependency array
 * Detail has — Table shows an indicator, not connector lines like Gantt).
 */
export interface TaskTableItemDto extends TaskListItemDto {
  customValues: TaskCustomValueSummary[];
  tags: { id: string; name: string }[];
  blocked: boolean;
}
