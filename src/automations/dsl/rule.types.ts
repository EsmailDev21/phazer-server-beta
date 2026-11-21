import { FieldType, Priority, TaskStatus } from '@prisma/client';

/** DSL v1 (step 5.1). The shapes the validator lets through. Ids are database ids. */
export type StatusRef = { category: TaskStatus } | { statusId: string };
export type Duration = { amount: number; unit: 'HOURS' | 'DAYS' };
/** 'TRIGGERER' = whoever caused the event; 'CREATOR' = the task's creator; otherwise a user id */
export type UserRef = string;

export const BUILTIN_FIELDS = [
  'PRIORITY',
  'ASSIGNEES',
  'DUE_DATE',
  'START_DATE',
  'ESTIMATE',
  'ITERATION',
  'ISSUE_TYPE',
  'TAGS',
  'TITLE',
  'DESCRIPTION',
] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number];

export type Trigger =
  | { type: 'TASK_CREATED' }
  | { type: 'STATUS_CHANGED'; from?: StatusRef[]; to?: StatusRef[] }
  | { type: 'FIELD_CHANGED'; field?: BuiltinField; customFieldId?: string }
  | { type: 'DUE_APPROACHING'; offset: Duration }
  | {
      type: 'EXTERNAL_LINK_STATE_CHANGED';
      provider?: string;
      kind?: string;
      state?: string;
    }
  // ---- step 5.6
  | { type: 'COMMENT_ADDED'; contains?: string; by?: 'PEOPLE' | 'ANYONE' }
  | { type: 'TASK_ARCHIVED' }
  | { type: 'TASK_RESTORED' }
  | { type: 'ALL_SUBTASKS_DONE' }
  | { type: 'TASK_OVERDUE'; afterHours?: number }
  | {
      type: 'SCHEDULE';
      frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
      hour: number;
      weekdays?: number[];
      dayOfMonth?: number;
    }
  /** never fires from an event: the rule exists to be run by another rule's RUN_RULE (step 5.14) */
  | { type: 'CALLED' };

export const TRIGGER_TYPES = [
  'TASK_CREATED',
  'STATUS_CHANGED',
  'FIELD_CHANGED',
  'DUE_APPROACHING',
  'EXTERNAL_LINK_STATE_CHANGED',
  'COMMENT_ADDED',
  'TASK_ARCHIVED',
  'TASK_RESTORED',
  'ALL_SUBTASKS_DONE',
  'TASK_OVERDUE',
  'SCHEDULE',
  'CALLED',
] as const;

export interface Condition {
  field: string;
  op: string;
  value?: unknown;
  customFieldId?: string;
}
export interface Conditions {
  all?: Condition[];
  any?: Condition[];
}

export type Action =
  /**
   * If/else (step 5.10). `conditions` are checked WHEN THE ACTION RUNS, against the task as it is then
   * (earlier actions of the same rule are visible). Nothing runs from the branch not taken.
   */
  /**
   * Acts on a task an earlier action CAPTURED (`as`): runs `do` with that task as the current one, so every
   * task action (and IF, and FOR_EACH) inside works on it. For example create a task, then WITH it:
   * assign, tag, add subtasks.
   */
  | { type: 'WITH'; task: string; do: Action[] }
  /**
   * Runs ANOTHER rule's actions on the current task, as part of this run (its trigger is ignored; its own
   * conditions are checked and, if they do not hold, it does nothing). The rule is found by id; templates
   * carry its NAME. A rule with the CALLED trigger exists only to be called.
   */
  | { type: 'RUN_RULE'; rule: string }
  /**
   * Pauses the rule for a while (a durable delay): the actions after it run when the time is up, if the
   * rule is still on and the task still exists. Not allowed inside a loop or a called rule (step 5.15).
   */
  | {
      type: 'WAIT';
      for: { amount: number; unit: 'MINUTES' | 'HOURS' | 'DAYS' };
    }
  | {
      type: 'IF';
      conditions: Conditions;
      then: Action[];
      /** "else if": checked in order when the first conditions do not hold; the first that holds runs */
      elseIf?: Array<{ conditions: Conditions; then: Action[] }>;
      else?: Action[];
    }
  /**
   * Loop (step 5.12): runs `do` once for each task selected by `over`, with THAT task as the current one
   * (every task action in `do` acts on the item). SUBTASKS / SIBLINGS / PARENT are relative to the task
   * the rule fired on; QUERY is every task in `scope` (the rule's project by default). `where` narrows.
   */
  | {
      type: 'FOR_EACH';
      over: 'SUBTASKS' | 'SIBLINGS' | 'PARENT' | 'QUERY';
      scope?: 'PROJECT' | 'WORKSPACE';
      where?: Conditions;
      onError?: 'STOP' | 'CONTINUE';
      do: Action[];
    }
  | { type: 'SET_STATUS'; status: StatusRef }
  | { type: 'SET_PRIORITY'; priority: Priority | null }
  | { type: 'ASSIGN'; mode: 'SET' | 'ADD' | 'REMOVE'; users: UserRef[] }
  | { type: 'SET_DUE_DATE'; inDays: number | null; from?: 'NOW' | 'DUE_DATE' }
  | { type: 'SET_CUSTOM_FIELD'; customFieldId: string; value: unknown }
  | { type: 'ADD_TAG'; tagId: string }
  | { type: 'REMOVE_TAG'; tagId: string }
  | { type: 'COMMENT'; body: string }
  | {
      type: 'CREATE_SUBTASK';
      title: string;
      priority?: Priority;
      assignees?: UserRef[];
      /** capture the new subtask under this name: `{{name.title}}`, and `WITH` can act on it (step 5.13) */
      as?: string;
    }
  | { type: 'NOTIFY_CHANNEL'; channelLinkId: string; message: string }
  // ---- step 5.6
  | {
      type: 'CREATE_TASK';
      title: string;
      description?: string;
      priority?: Priority;
      dueInDays?: number;
      tags?: string[];
      assignees?: UserRef[];
      status?: StatusRef;
      /** capture the new task under this name: `{{name.title}}`, and `WITH` can act on it (step 5.13) */
      as?: string;
    }
  /**
   * Sends an in-app notification with your own text to people: ids, TRIGGERER, CREATOR, or the task's
   * ASSIGNEES / WATCHERS. Only people who can see the task get it.
   */
  | { type: 'NOTIFY'; users: UserRef[]; message: string }
  | { type: 'RENAME_TASK'; title: string }
  | { type: 'SET_DESCRIPTION'; text: string; mode: 'REPLACE' | 'APPEND' }
  | { type: 'SET_ESTIMATE'; estimate: number | null }
  | { type: 'SET_ISSUE_TYPE'; issueTypeId: string | null }
  | { type: 'SET_ITERATION'; iterationId: string | null }
  | { type: 'CHANGE_PRIORITY'; direction: 'UP' | 'DOWN' }
  | { type: 'SET_START_DATE'; inDays: number; from?: 'NOW' | 'DUE_DATE' }
  | { type: 'ARCHIVE_TASK' }
  | { type: 'RESTORE_TASK' };

export interface RuleV1 {
  trigger: Trigger;
  conditions: Conditions;
  actions: Action[];
}

/** What the semantic check needs to know about the workspace a rule lives in. */
export interface WorkspaceRuleContext {
  projectIds: ReadonlySet<string>;
  /** every workflow status of the workspace's projects */
  statuses: ReadonlyMap<string, { projectId: string; category: TaskStatus }>;
  tagIds: ReadonlySet<string>;
  issueTypeIds: ReadonlySet<string>;
  /** iterations of the workspace (saved views filter and group by them; rules do not) */
  iterationIds: ReadonlySet<string>;
  customFields: ReadonlyMap<
    string,
    { dataType: FieldType; options: readonly string[] | null }
  >;
  /** user ids that were looked up AND may work in this workspace */
  validUserIds: ReadonlySet<string>;
  /** the rules a RUN_RULE names (and, transitively, what they call). Absent = none were loaded. */
  rules?: ReadonlyMap<string, CallableRule>;
  /** the saved views a loop names. Absent = none were loaded. */
  views?: ReadonlyMap<string, ViewInfo>;
  /** the rule being checked, when it already exists (so a call back to it is a cycle) */
  selfRuleId?: string;
}

/** What a rule needs to know about ANOTHER rule it calls (RUN_RULE), loaded with its own calls so cycles can be found. */
export interface CallableRule {
  projectId: string | null;
  triggerType: string;
  ruleVersion: number;
  /** it holds constructs this build cannot run, so it cannot be called */
  hasUnsupported: boolean;
  /** the rule ids ITS RUN_RULE actions call */
  calls: string[];
  /** it holds a WAIT, which cannot run inside a called rule */
  hasWait?: boolean;
}

/** What a rule needs to know about a saved view it loops over. */
export interface ViewInfo {
  projectId: string | null;
  isShared: boolean;
  ownerId: string | null;
}

export interface RuleReferences {
  ruleIds: Set<string>;
  viewIds: Set<string>;
  statusIds: Set<string>;
  tagIds: Set<string>;
  issueTypeIds: Set<string>;
  projectIds: Set<string>;
  customFieldIds: Set<string>;
  userIds: Set<string>;
  iterationIds: Set<string>;
}
