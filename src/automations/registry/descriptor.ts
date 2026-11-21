import type { Role } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DomainWriter } from '../../domain-writer/domain-writer.service';
import type { WriteContext } from '../../domain-writer/write-context';
import type { CommentsService } from '../../collaboration/comments/comments.service';
import type { CustomFieldsService } from '../../projects-tasks/custom-fields/custom-fields.service';
import type { TagsService } from '../../projects-tasks/tags/tags.service';
import type { TasksService } from '../../projects-tasks/tasks/tasks.service';
import type { Check } from '../dsl/rule.schema';
import type {
  Action,
  RuleV1,
  Trigger,
  WorkspaceRuleContext,
} from '../dsl/rule.types';
import type { RuleIssue } from '../dsl/rule.schema';
import type { TaskSnapshot } from '../engine/conditions-eval';
import type { RuleEvent } from '../engine/rule-event';

/** What a name refers to. Same set the template walker (step 5.5) translates. */
export type RuleRefKind =
  | 'status'
  | 'tag'
  | 'issueType'
  | 'customField'
  | 'iteration'
  | 'project'
  | 'user'
  | 'channel'
  | 'rule'
  | 'view';

/**
 * The SHAPE of one place a reference lives, on a trigger or an action:
 *   one            a string id                      (`tagId`)
 *   list           an array of ids                  (`tags`, `users`)
 *   statusRef      `{category} | {statusId}`         (`status`)
 *   statusRefList  an array of those                (`from`, `to`)
 * A `null` or missing value is skipped everywhere ("no tag", "clear the iteration").
 */
export type RefShape = 'one' | 'list' | 'statusRef' | 'statusRefList';
export interface RefSlot {
  key: string;
  kind: RuleRefKind;
  shape: RefShape;
}

/** What an action or trigger needs the event to have. Replaces the old TASKLESS_ACTIONS list. */
export interface Needs {
  /** false = works with no task (a SCHEDULE rule has none) */
  task: boolean;
  /** true = needs a project to put new work in (the event's task's, or the rule's own) */
  project: boolean;
}

/** What an action knows about the run it belongs to. */
export interface ActionRun {
  ruleId: string;
  /** hops deep the writes will be (the event's depth + 1) */
  writeDepth: number;
  workspaceId: string;
  projectId: string | null;
  /** null for a SCHEDULE run: there is no task, only a project to create work in */
  taskId: string | null;
  createdById: string;
  /** set while a FOR_EACH item is being processed: which one, of how many */
  item?: { index: number; of: number };
  /** set while a FOR_EACH item (or anything inside one) is processed: a WAIT is not allowed there */
  inLoop?: boolean;
  /** whoever caused the event; null for a system event (the due-date sweep) */
  triggererId: string | null;
  /** the system user the writes are attributed to */
  actorId: string;
  vars: Readonly<Record<string, string>>;
}

/** The services an action may call, and the write stamp, handed to `execute` by the executor. */
export interface ActionServices {
  prisma: PrismaService;
  tasks: TasksService;
  tags: TagsService;
  customFields: CustomFieldsService;
  comments: CommentsService;
  domainWriter: DomainWriter;
  /** the stamp every write carries: {origin: AUTOMATION, actorId, automation: {id, depth}} */
  ctx: WriteContext;
  /** the task as it is RIGHT NOW (an earlier action of the rule may have changed it); null if it is gone */
  snapshot(): Promise<TaskSnapshot | null>;
  /**
   * Runs one branch of a control-flow action (IF) through the same executor, in order, stopping at the
   * first failure. The failure carries the pointer of the action inside the branch.
   */
  runBranch(actions: Action[], key: string): Promise<void>;
  /**
   * Runs a FOR_EACH: selects its tasks, then runs its `do` once per task with THAT task as the current
   * one. Throws (so the run fails at this action) when the selection is over the limit.
   */
  runLoop(a: Extract<Action, { type: 'FOR_EACH' }>): Promise<void>;
  /** Runs a WITH: the task an earlier action captured becomes the current one for its `do`. */
  runWith(a: Extract<Action, { type: 'WITH' }>): Promise<void>;
  /**
   * Pauses the run for this long: what is left of it is saved and carried on later. Never returns (it
   * unwinds the run); throws when a wait is not allowed here (inside a loop, or in a called rule).
   */
  wait(durationMs: number): Promise<never>;
  /** Sends a notification with this text to these people (who can see the task); returns nothing. */
  notify(userIds: string[], message: string): Promise<void>;
  /** Runs a RUN_RULE: the called rule's actions on the current task, inside this run. */
  runRule(a: Extract<Action, { type: 'RUN_RULE' }>): Promise<void>;
}

/**
 * What an action hands back to the executor. `createdTaskId` is the task it made: if the action has an
 * `as`, the executor captures it so later actions can use `{{name.title}}` and `WITH name`.
 */
export interface ActionOutput {
  createdTaskId?: string;
}

/** Collects what a descriptor-level semantic check reports. */
export type AddIssue = (code: string, path: string, message: string) => void;

interface BaseDescriptor {
  /** shown in a rule editor */
  label: string;
  /** one sentence: what it does / when it fires */
  summary: string;
  /** a VALID instance: the fixture for the completeness test and the catalogue's "how to write one" */
  example: Record<string, unknown>;
  /** structural check of the whole node, `type` included */
  schema: Check;
  /** where ids live (one declaration drives reference collection, the workspace checks and the template walker) */
  refs: readonly RefSlot[];
  /** stored but cannot be switched on: why. Reported on every use of the construct. */
  unavailable?: string;
}

export interface ActionDescriptor<
  A extends Action = Action,
> extends BaseDescriptor {
  type: A['type'];
  needs: Needs;
  /**
   * The lowest role the rule's AUTHOR needs to include this action. DECLARED in 5.8, ENFORCED from 5.9:
   * today everything needs what `manageAutomations` needs (ADMIN).
   */
  ceiling: Role;
  /** may travel inside a template. DECLARED in 5.8 (an action that names a chat channel cannot); ENFORCED from 5.9. */
  portable: boolean;
  /** actions that must come BEFORE the example for it to be valid on its own (WITH needs a capture) */
  exampleBefore?: Array<Record<string, unknown>>;
  /** checks beyond "does this id exist" (a custom-field value must fit the field's type) */
  semantic?: (
    a: A,
    base: string,
    ctx: WorkspaceRuleContext,
    add: AddIssue,
    /** the rule it is in, and the project the rule belongs to (null = a workspace-wide rule) */
    env: { rule: RuleV1; scopeProjectId: string | null },
  ) => void;
  /**
   * An instance that works with NO task (a SCHEDULE rule has none) although the type needs one in general:
   * a FOR_EACH over a query selects its own tasks. Absent = decided by `needs.task`.
   */
  taskless?: (a: A) => boolean;
  /** a rule-wide check, run ONCE per rule that contains this action (at the first one): `pointer` is where it is */
  ruleCheck?: (
    rule: RuleV1,
    pointer: string,
    scopeProjectId: string | null,
  ) => RuleIssue[];
  /**
   * Control flow (IF): which keys hold a conditions block and which hold nested action lists. Everything
   * that walks a rule (reference collection, workspace checks, the template walker) follows these.
   */
  nested?: {
    conditions?: string;
    branches?: readonly string[];
    /** an array of `{conditions, then}` (an IF's `elseIf`) */
    cases?: string;
  };
  execute(
    a: A,
    run: ActionRun,
    x: ActionServices,
  ): Promise<void | ActionOutput>;
  /** a sentence for the run log and a dry run */
  describe(a: A): string;
}

export interface TriggerDescriptor<
  T extends Trigger = Trigger,
> extends BaseDescriptor {
  type: T['type'];
  /** false = fires with no task (SCHEDULE): no conditions, only task-less actions, no task placeholders */
  needs: Pick<Needs, 'task'>;
  /** pure: does this event fire this trigger? (scope and conditions are checked elsewhere) */
  match(t: T, event: RuleEvent): boolean;
  ruleCheck?: (rule: RuleV1, scopeProjectId: string | null) => RuleIssue[];
  describe(t: T): string;
}
