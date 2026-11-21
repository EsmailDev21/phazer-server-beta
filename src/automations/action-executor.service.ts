import { HttpException, Injectable, Logger } from '@nestjs/common';
import { CreationMode, Prisma } from '@prisma/client';
import { DomainWriter } from '../domain-writer/domain-writer.service';
import { WriteContext } from '../domain-writer/write-context';
import { PrismaService } from '../prisma/prisma.service';
import { CommentsService } from '../collaboration/comments/comments.service';
import { CustomFieldsService } from '../projects-tasks/custom-fields/custom-fields.service';
import { TagsService } from '../projects-tasks/tags/tags.service';
import { TasksService } from '../projects-tasks/tasks/tasks.service';
import { Action, Conditions } from './dsl/rule.types';
import { treeLimits } from './dsl/rule.settings';
import { evaluateConditions } from './engine/conditions-eval';
import {
  ActionOutput,
  ActionRun,
  ActionServices,
  countActions,
  getAction,
  ifDepth,
} from './registry';
import { AutomationNotifier } from './automation-notifier.service';
import { loadTaskSnapshot } from './task-snapshot';
import {
  TaskQueryItem,
  TaskQueryService,
} from '../views/run/task-query.service';

export type { ActionRun };

export interface ExecutionResult {
  /** how many actions completed (an IF is a decision, not an action: only what ran inside it counts) */
  done: number;
  /** index of the TOP-LEVEL action that failed (for an action inside an IF: the index of that IF) */
  failedAt?: number;
  /** where exactly, as a JSON pointer: `/actions/2/then/0` (set whenever failedAt is) */
  failedPath?: string;
  /** set when the failure was inside a FOR_EACH: which task (0-based position) it was working on */
  failedItem?: { index: number; taskId: string };
  /** set when the run reached a WAIT: what is left of it, to be saved and carried on later */
  waiting?: WaitRequest;
  /** set when the failure was inside a rule another rule called (RUN_RULE) */
  failedRule?: { id: string; name: string };
  /** the same for every enclosing loop, outermost first */
  failedItems?: Array<{ path: string; index: number; taskId: string }>;
  error?: string;
}

/** An action failed; carries where, so a failure inside an IF branch is reported at its real position. */
class ActionFailure extends Error {
  /** the INNERMOST task being processed when it failed */
  item?: { index: number; taskId: string };
  /** every loop it was inside, outermost first (a loop inside a loop has two) */
  items?: Array<{ path: string; index: number; taskId: string }>;
  /** the INNERMOST rule that was running (a RUN_RULE) when it failed */
  rule?: { id: string; name: string };
  constructor(
    readonly pointer: string,
    readonly cause: unknown,
  ) {
    super('action failed');
  }
}

/**
 * Where to carry on, for ONE list of actions a WAIT was inside of: the list (a JSON pointer into the rule's
 * actions), the index to carry on FROM, and the run context that list had (the current task, captured
 * variables). A wait inside an IF inside a WITH has three, innermost first.
 */
export interface WaitFrame {
  listPointer: string;
  from: number;
  run: ActionRun;
}
export interface WaitRequest {
  until: Date;
  frames: WaitFrame[];
  /** where the WAIT itself is */
  pointer: string;
}

/** thrown by a WAIT to unwind the run; it is not a failure */
class WaitSignal extends Error {
  constructor(readonly request: WaitRequest) {
    super('waiting');
  }
}

/** a list being run, as the stack of what a WAIT must save */
interface StackFrame {
  listPointer: string;
  /** the index of the action being run (the wait carries on AFTER it) */
  index: number;
  run: ActionRun;
}

/** where an execution stands: successes so far, and the most it may execute (the limit at the START) */
interface RunState {
  done: number;
  max: number;
  /** loops started + tasks processed so far, and the most a run may do (loops inside loops multiply) */
  loopSteps: number;
  maxLoopSteps: number;
  /** RUN_RULE calls currently inside one another */
  callDepth: number;
  maxCallDepth: number;
  /** the lists being run, outermost first */
  stack: StackFrame[];
}

const MAX_ERROR = 300;

/** A person-readable reason, never a stack: the run log is shown to workspace admins. */
export function describeError(err: unknown): string {
  let text = 'Unexpected error';
  if (err instanceof HttpException) {
    const r = err.getResponse();
    const m = typeof r === 'string' ? r : (r as { message?: unknown })?.message;
    text = Array.isArray(m)
      ? m.join('; ')
      : typeof m === 'string'
        ? m
        : err.message;
  }
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
}

/**
 * Step 5.2. Carries out a rule's actions with the SAME services a person's request goes through, so
 * every existing rule (workflow transitions, visibility, plan limits, activity rows, notifications)
 * applies exactly as it would for a human; the only difference is the WriteContext, which stamps each
 * change with the rule and its depth so a rule cannot re-trigger itself.
 *
 * WHAT each action does lives in its descriptor (src/automations/registry, step 5.8); this class owns the
 * order, the stamp and the failure report.
 *
 * Actions run in order and stop at the first failure. There is no transaction across them (they are
 * different services); what completed stays done and the run log says where it stopped.
 */
@Injectable()
export class ActionExecutor {
  private readonly logger = new Logger(ActionExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly comments: CommentsService,
    private readonly domainWriter: DomainWriter,
    private readonly taskQuery: TaskQueryService,
    private readonly notifier: AutomationNotifier,
  ) {}

  async execute(actions: Action[], run: ActionRun): Promise<ExecutionResult> {
    // The CURRENT limits, every time: a rule saved under bigger ones must not run once they are lowered.
    const limits = treeLimits();
    if (countActions(actions) > limits.maxTotalActions)
      return {
        done: 0,
        failedAt: 0,
        failedPath: '/actions',
        error: `This rule has more actions than the current limit of ${limits.maxTotalActions}; shorten it to run it`,
      };
    if (ifDepth(actions) > limits.maxIfDepth)
      return {
        done: 0,
        failedAt: 0,
        failedPath: '/actions',
        error: `This rule nests IFs deeper than the current limit of ${limits.maxIfDepth}; flatten it to run it`,
      };
    const state = this.newState(limits);
    return this.guarded(state, () =>
      this.runList(actions, run, '/actions', state),
    );
  }

  private newState(limits: ReturnType<typeof treeLimits>): RunState {
    return {
      done: 0,
      max: limits.maxActionsPerRun,
      loopSteps: 0,
      maxLoopSteps: limits.maxLoopSteps,
      callDepth: 0,
      maxCallDepth: limits.maxCallDepth,
      stack: [],
    };
  }

  /** Runs `body` and turns how it ended into an ExecutionResult: finished, waiting, or failed (and where). */
  private async guarded(
    state: RunState,
    body: () => Promise<void>,
  ): Promise<ExecutionResult> {
    try {
      await body();
    } catch (err) {
      if (err instanceof WaitSignal)
        return { done: state.done, waiting: err.request };
      const failure =
        err instanceof ActionFailure
          ? err
          : new ActionFailure('/actions/0', err);
      const top = /^\/actions\/(\d+)/.exec(failure.pointer);
      return {
        done: state.done,
        ...(failure.item ? { failedItem: failure.item } : {}),
        ...(failure.items ? { failedItems: failure.items } : {}),
        ...(failure.rule ? { failedRule: failure.rule } : {}),
        failedAt: top ? Number(top[1]) : 0,
        failedPath: failure.pointer,
        error: describeError(failure.cause),
      };
    }
    return { done: state.done };
  }

  /**
   * Carries on a run that stopped at a WAIT: `actions` is the snapshot taken then, `frames` where to
   * carry on (innermost list first). Each list finishes, then the list around it carries on after the
   * action that held it. May WAIT again; the pointers in a failure refer to the snapshot.
   */
  async resume(
    actions: Action[],
    frames: WaitFrame[],
  ): Promise<ExecutionResult> {
    const state = this.newState(treeLimits());
    return this.guarded(state, async () => {
      for (let k = 0; k < frames.length; k++) {
        const f = frames[k];
        // the lists around this one are still to run: a second WAIT must save them too
        state.stack = frames
          .slice(k + 1)
          .reverse()
          .map((o) => ({
            listPointer: o.listPointer,
            index: o.from - 1,
            run: o.run,
          }));
        await this.runList(
          this.listAt(actions, f.listPointer),
          f.run,
          f.listPointer,
          state,
          f.from,
        );
      }
    });
  }

  /** the list a pointer such as `/actions/2/then` or `/actions/1/elseIf/0/then` names, in a snapshot */
  private listAt(actions: Action[], pointer: string): Action[] {
    let cur: unknown = actions;
    for (const seg of pointer.split('/').slice(2))
      cur = (cur as Record<string, unknown> | undefined)?.[seg];
    if (!Array.isArray(cur))
      throw new HttpException(
        `The saved rule has no list at ${pointer} to carry on in`,
        422,
      );
    return cur as Action[];
  }

  /** In order, stopping at the first failure; a branch of an IF is run by the same loop. */
  private async runList(
    actions: Action[],
    run: ActionRun,
    base: string,
    state: RunState,
    from = 0,
  ): Promise<void> {
    // what an action captures (`as`) is visible to the actions AFTER it in this list, and to what they
    // contain; it does not leave the list (a capture inside a branch may never have happened)
    let current = run;
    // a WAIT inside saves every list that is being run, where it is up to, and the run it had
    const frame: StackFrame = { listPointer: base, index: from - 1, run };
    state.stack.push(frame);
    try {
      for (let i = from; i < actions.length; i++) {
        const pointer = `${base}/${i}`;
        frame.index = i;
        frame.run = current;
        try {
          const captured = await this.executeOne(
            actions[i],
            current,
            pointer,
            state,
          );
          if (captured)
            current = { ...current, vars: { ...current.vars, ...captured } };
        } catch (err) {
          if (err instanceof ActionFailure || err instanceof WaitSignal)
            throw err; // already placed inside a branch / not a failure
          if (!(err instanceof HttpException))
            this.logger.error(
              `automation ${run.ruleId} action ${pointer} failed: ${err instanceof Error ? err.stack : err}`,
            );
          throw new ActionFailure(pointer, err);
        }
      }
    } finally {
      state.stack.pop();
    }
  }

  private ctx(run: ActionRun): WriteContext {
    return {
      origin: CreationMode.AUTOMATION,
      actorId: run.actorId,
      automation: { id: run.ruleId, depth: run.writeDepth },
    };
  }

  /**
   * FOR_EACH. The tasks are chosen FIRST and once (a body that adds subtasks does not grow its own loop),
   * then each runs the body with THAT task as the current one. Too many tasks = the loop does nothing and
   * fails: a bulk change is all-or-nothing in what it is allowed to TOUCH, never silently partial.
   * `onError: CONTINUE` finishes every item and then fails the action; the default stops at the first.
   */
  private async runLoop(
    a: Extract<Action, { type: 'FOR_EACH' }>,
    run: ActionRun,
    pointer: string,
    state: RunState,
  ): Promise<void> {
    this.spendLoopStep(state);
    const items = await this.selectItems(a, run);
    const failures: ActionFailure[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this.spendLoopStep(state);
      const itemRun = this.itemRun(run, item, i, items.length, true);
      try {
        await this.runList(a.do, itemRun, `${pointer}/do`, state);
      } catch (err) {
        if (!(err instanceof ActionFailure)) throw err;
        err.item ??= { index: i, taskId: item.id }; // the innermost stays
        err.items = [
          { path: pointer, index: i, taskId: item.id },
          ...(err.items ?? []),
        ];
        if (a.onError !== 'CONTINUE') throw err;
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      const first = failures[0];
      const failure = new ActionFailure(
        first.pointer,
        new HttpException(
          `${failures.length} of ${items.length} tasks failed; the first (task ${first.item?.index !== undefined ? first.item.index + 1 : '?'}): ${describeError(first.cause)}`,
          422,
        ),
      );
      failure.item = first.item;
      failure.items = first.items;
      throw failure;
    }
  }

  /**
   * RUN_RULE: the called rule's actions run on the CURRENT task inside this run: same budgets, same
   * stamp, same current limits. Its trigger is ignored; ITS conditions are checked against the task as
   * it is now and, if they do not hold, it does nothing (that is not a failure). A rule must be in the
   * current format and have nothing that cannot run; a rule that is switched off CAN still be called
   * (the switch is about events).
   */
  private async runRule(
    a: Extract<Action, { type: 'RUN_RULE' }>,
    run: ActionRun,
    pointer: string,
    state: RunState,
  ): Promise<void> {
    if (state.callDepth >= state.maxCallDepth)
      throw new HttpException(
        `Rules call each other more than ${state.maxCallDepth} deep (AUTOMATION_MAX_CALL_DEPTH)`,
        422,
      );
    const target = await this.prisma.automation.findFirst({
      where: { id: a.rule, workspaceId: run.workspaceId },
      select: {
        name: true,
        ruleVersion: true,
        unsupported: true,
        conditions: true,
        actions: true,
      },
    });
    if (!target)
      throw new HttpException('The rule to run no longer exists', 422);
    if (
      target.ruleVersion !== 1 ||
      (Array.isArray(target.unsupported) && target.unsupported.length > 0)
    )
      throw new HttpException(
        `The rule "${target.name}" cannot be run: it is not in the current format or holds something that cannot run yet`,
        422,
      );
    const task = run.taskId
      ? await loadTaskSnapshot(this.prisma, run.taskId)
      : null;
    if (!task) throw new HttpException('The task no longer exists', 422);
    if (
      !evaluateConditions(target.conditions as Conditions, task, {
        now: new Date(),
        actorId: run.triggererId,
      })
    )
      return; // its own conditions do not hold: nothing to do, and that is fine
    state.callDepth++;
    try {
      await this.runList(
        target.actions as unknown as Action[],
        run,
        `${pointer}/call`,
        state,
      );
    } catch (err) {
      if (err instanceof ActionFailure)
        err.rule ??= { id: a.rule, name: target.name }; // the innermost rule stays
      throw err;
    } finally {
      state.callDepth--;
    }
  }

  /**
   * WAIT: stop here and hand back what is left of the run. Refused (a failure) where what is left cannot
   * be saved: inside a loop, or inside a rule another rule called; both are also refused when the rule is
   * saved, this is for rules that changed since.
   */
  private suspend(
    ms: number,
    run: ActionRun,
    pointer: string,
    state: RunState,
  ): Promise<never> {
    if (state.callDepth > 0)
      throw new HttpException(
        'A Wait cannot run inside a rule that another rule called',
        422,
      );
    if (state.stack.some((f) => f.run.inLoop) || run.inLoop)
      throw new HttpException('A Wait cannot run inside a loop', 422);
    const max = treeLimits().maxWaitDays;
    if (ms > max * 86_400_000)
      throw new HttpException(
        `A wait can last at most ${max} days (AUTOMATION_MAX_WAIT_DAYS)`,
        422,
      );
    // innermost list first, each carrying on AFTER the action that was running in it
    const frames: WaitFrame[] = [...state.stack].reverse().map((f) => ({
      listPointer: f.listPointer,
      from: f.index + 1,
      run: f.run,
    }));
    throw new WaitSignal({
      until: new Date(Date.now() + ms),
      frames,
      pointer,
    });
  }

  /** a loop starting, and each task a loop processes, spend from one budget: it bounds loops in loops */
  private spendLoopStep(state: RunState): void {
    if (state.loopSteps >= state.maxLoopSteps)
      throw new HttpException(
        `This run reached the limit of ${state.maxLoopSteps} loop steps (AUTOMATION_MAX_LOOP_STEPS_PER_RUN)`,
        422,
      );
    state.loopSteps++;
  }

  /** the run as seen while a task is being processed: it is the CURRENT task, with its own placeholders */
  private itemRun(
    run: ActionRun,
    item: TaskQueryItem,
    index: number,
    of: number,
    inLoop = false,
  ): ActionRun {
    return {
      ...run,
      taskId: item.id,
      projectId: item.projectId ?? run.projectId,
      createdById: item.createdById,
      vars: {
        ...run.vars,
        'task.title': item.title,
        'task.key': item.key,
        'task.status': item.statusName,
        'task.priority': item.priority ?? '',
      },
      item: { index, of },
      ...(inLoop || run.inLoop ? { inLoop: true } : {}),
    };
  }

  /**
   * WITH: a task an earlier action captured becomes the current one for `do`. It counts as one loop step
   * and, like a loop, a failure inside it is reported against that task.
   */
  private async runWith(
    a: Extract<Action, { type: 'WITH' }>,
    run: ActionRun,
    pointer: string,
    state: RunState,
  ): Promise<void> {
    this.spendLoopStep(state);
    const id = run.vars[`${a.task}.id`];
    if (!id)
      throw new HttpException(
        `"${a.task}" was not captured: the action that creates it did not run`,
        422,
      );
    const page = await this.taskQuery.run({
      workspaceId: run.workspaceId,
      userId: null,
      actorId: run.triggererId,
      structural: { id },
      limit: 1,
      pageCap: 1,
    });
    const item = page.items[0];
    if (!item)
      throw new HttpException(`The task "${a.task}" no longer exists`, 422);
    try {
      await this.runList(
        a.do,
        this.itemRun(run, item, 0, 1),
        `${pointer}/do`,
        state,
      );
    } catch (err) {
      if (err instanceof ActionFailure) {
        err.item ??= { index: 0, taskId: item.id };
        err.items = [
          { path: pointer, index: 0, taskId: item.id },
          ...(err.items ?? []),
        ];
      }
      throw err;
    }
  }

  private async selectItems(
    a: Extract<Action, { type: 'FOR_EACH' }>,
    run: ActionRun,
  ) {
    const max = treeLimits().maxForEachItems;
    let structural: Prisma.TaskWhereInput = {};
    let projectId: string | null = null;
    if (a.over === 'QUERY') {
      if ((a.scope ?? 'PROJECT') === 'PROJECT') {
        if (!run.projectId)
          throw new HttpException(
            'There is no project to look for tasks in',
            422,
          );
        projectId = run.projectId;
      }
    } else {
      if (!run.taskId)
        throw new HttpException('There is no task to start from', 422);
      if (a.over === 'SUBTASKS') structural = { parentId: run.taskId };
      else {
        const parentId =
          (
            await this.prisma.task.findUnique({
              where: { id: run.taskId },
              select: { parentId: true },
            })
          )?.parentId ?? null;
        // no parent: no siblings and no parent, which is an empty loop, not an error
        structural =
          parentId === null
            ? { id: { in: [] } }
            : a.over === 'PARENT'
              ? { id: parentId }
              : { parentId, id: { not: run.taskId } };
      }
    }
    const page = await this.taskQuery.run({
      workspaceId: run.workspaceId,
      userId: null,
      actorId: run.triggererId,
      projectId,
      structural,
      filters: a.where,
      limit: max + 1,
      pageCap: max + 1,
    });
    if (page.items.length > max)
      throw new HttpException(
        `This selects more than ${max} tasks (AUTOMATION_MAX_FOR_EACH_ITEMS); narrow it with \`where\``,
        422,
      );
    if (page.capped)
      throw new HttpException(
        'Looking for these tasks would scan too many; narrow it with `where`',
        422,
      );
    return page.items;
  }

  /** what an action may call: the services, and the stamp every write carries */
  private services(
    run: ActionRun,
    pointer: string,
    state: RunState,
  ): ActionServices {
    return {
      prisma: this.prisma,
      tasks: this.tasks,
      tags: this.tags,
      customFields: this.customFields,
      comments: this.comments,
      domainWriter: this.domainWriter,
      ctx: this.ctx(run),
      snapshot: () =>
        run.taskId
          ? loadTaskSnapshot(this.prisma, run.taskId)
          : Promise.resolve(null),
      runBranch: (actions, key) =>
        this.runList(actions, run, `${pointer}/${key}`, state),
      runLoop: (a) => this.runLoop(a, run, pointer, state),
      runWith: (a) => this.runWith(a, run, pointer, state),
      runRule: (a) => this.runRule(a, run, pointer, state),
      wait: (ms) => this.suspend(ms, run, pointer, state),
      notify: async (userIds, message) => {
        await this.notifier.notify({
          workspaceId: run.workspaceId,
          automationId: run.ruleId,
          taskId: run.taskId,
          userIds,
          message,
        });
      },
    };
  }

  private async executeOne(
    a: Action,
    run: ActionRun,
    pointer: string,
    state: RunState,
  ): Promise<Record<string, string> | undefined> {
    const descriptor = getAction(a.type);
    if (!descriptor)
      throw new HttpException(`Unknown action "${String(a.type)}"`, 422);
    // a loop multiplies what a rule lists: count what is actually EXECUTED
    if (!descriptor.nested && state.done >= state.max)
      throw new HttpException(
        `This run reached the limit of ${state.max} actions (AUTOMATION_MAX_ACTIONS_PER_RUN)`,
        422,
      );
    const out = (await descriptor.execute(
      a,
      run,
      this.services(run, pointer, state),
    )) as ActionOutput | undefined;
    if (!descriptor.nested) state.done++;
    const name = (a as { as?: string }).as;
    if (name && out?.createdTaskId)
      return this.captureTask(name, out.createdTaskId);
    return undefined;
  }

  /** What `{{name.title}}` and friends will say about a task an action just created. */
  private async captureTask(
    name: string,
    taskId: string,
  ): Promise<Record<string, string>> {
    const t = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        number: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        workspace: { select: { key: true } },
        workflowStatus: { select: { name: true } },
        project: { select: { name: true } },
        assignees: { select: { name: true } },
      },
    });
    if (!t) return { [`${name}.id`]: taskId };
    return {
      [`${name}.id`]: taskId,
      [`${name}.key`]: `${t.workspace.key}-${t.number}`,
      [`${name}.title`]: t.title,
      [`${name}.status`]: t.workflowStatus?.name ?? t.status,
      [`${name}.priority`]: t.priority ?? '',
      [`${name}.project`]: t.project?.name ?? '',
      [`${name}.assignees`]: t.assignees.map((u) => u.name).join(', '),
      [`${name}.dueDate`]: t.dueDate
        ? t.dueDate.toISOString().slice(0, 10)
        : '',
    };
  }
}
