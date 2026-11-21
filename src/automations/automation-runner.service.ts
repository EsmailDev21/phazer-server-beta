import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  Activity,
  Automation,
  AutomationRunStatus,
  Prisma,
} from '@prisma/client';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActionExecutor,
  ActionRun,
  describeError,
} from './action-executor.service';
import { AutomationWaitService } from './automation-wait.service';
import { AutomationActorService } from './automation-actor.service';
import { AUTOMATION_LIMITS as L } from './dsl';
import { Action, Conditions, RuleV1, Trigger } from './dsl/rule.types';
import {
  RuleEvent,
  TaskSnapshot,
  activityToRuleEvent,
  allSubtasksDoneEvent,
  evaluateConditions,
  loopGuard,
  matchesTrigger,
  rateExceeded,
} from './engine';

export type RuleOutcome =
  'RAN' | 'FAILED' | 'SKIPPED' | 'NO_MATCH' | 'DUPLICATE' | 'TASK_GONE';

interface LoadedTask extends TaskSnapshot {
  id: string;
  workspaceId: string;
  title: string;
  key: string;
  statusName: string;
  isArchived: boolean;
}

const ruleOf = (a: Automation): RuleV1 => ({
  trigger: a.trigger as unknown as Trigger,
  conditions: a.conditions as unknown as Conditions,
  actions: a.actions as unknown as Action[],
});

/**
 * Step 5.2. Reacts to what happens to tasks and runs the enabled rules that match.
 *
 *   event -> candidate rules (workspace + trigger type, enabled) -> scope -> trigger -> conditions
 *         -> loop guard -> rate breaker -> claim (one row per rule+event) -> actions -> result
 *
 * Properties worth knowing:
 *  - AT MOST ONCE per (rule, event): the run row is claimed BEFORE any action, so a redelivered event
 *    (or a second instance) finds it and does nothing; a crash mid-run leaves an honest "interrupted" row.
 *  - A rule never reacts to its own writes, and a chain of rule-made changes stops at the depth cap.
 *  - A rule that runs too often is switched off with a visible reason (`pausedReason`).
 *  - Nothing here ever throws into the event bus: a bug in a rule must not break the request that caused it.
 *  - Events are in-process (like notifications): one lost while the process dies between commit and run
 *    is not replayed. The due-date sweep is the durable path for time-based rules.
 */
@Injectable()
export class AutomationRunnerService {
  private readonly logger = new Logger(AutomationRunnerService.name);
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly actor: AutomationActorService,
    private readonly executor: ActionExecutor,
    private readonly waits: AutomationWaitService,
  ) {}

  @OnEvent('activity.created')
  onActivity(activity: Activity): void {
    const p: Promise<unknown> = this.process(activity)
      .catch((err) =>
        this.logger.error(
          `automation runner failed for activity ${activity?.id}: ${err instanceof Error ? err.stack : err}`,
        ),
      )
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  /** Resolves when every event handed to the runner so far has been dealt with (tests, graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async process(activity: Activity): Promise<void> {
    const event = activityToRuleEvent(activity);
    if (event) await this.handleEvent(event);
  }

  /** Runs every matching enabled rule for one event. Public so the sweep (and tests) can feed it directly. */
  async handleEvent(
    event: RuleEvent,
    now: Date = new Date(),
  ): Promise<Record<string, RuleOutcome>> {
    const outcomes: Record<string, RuleOutcome> = {};
    if (!this.flags.isEnabled('WORKFLOW')) return outcomes;
    const rules = await this.prisma.automation.findMany({
      where: {
        workspaceId: event.workspaceId,
        enabled: true,
        ruleVersion: 1,
        triggerType: event.kind,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ready = rules.length > 0 ? await this.enrich(event) : event;
    if (ready) {
      for (const rule of rules) {
        try {
          outcomes[rule.id] = await this.runRule(rule, ready, now);
        } catch (err) {
          this.logger.error(
            `automation ${rule.id} crashed on event ${event.eventId}: ${err instanceof Error ? err.stack : err}`,
          );
        }
      }
    }
    // a subtask reaching DONE may also be the moment its PARENT has all subtasks done: an event of its own
    if (event.kind === 'STATUS_CHANGED')
      await this.deriveAllSubtasksDone(event, now, outcomes);
    return outcomes;
  }

  /**
   * COMMENT_ADDED needs the comment itself (its text, who wrote it); read once per event, and only when a
   * rule is listening. A comment that has since been deleted is not an event any more.
   */
  private async enrich(event: RuleEvent): Promise<RuleEvent | null> {
    if (event.kind !== 'COMMENT_ADDED' || !event.commentId) return event;
    const c = await this.prisma.comment.findUnique({
      where: { id: event.commentId },
      select: { content: true, authorId: true },
    });
    if (!c) return null;
    const byAutomation =
      event.causedBy !== null || c.authorId === (await this.actor.userId());
    return { ...event, comment: { text: c.content, byAutomation } };
  }

  /** The last open subtask of a parent just reached DONE: tell the rules listening for ALL_SUBTASKS_DONE on the parent. */
  private async deriveAllSubtasksDone(
    event: RuleEvent,
    now: Date,
    outcomes: Record<string, RuleOutcome>,
  ): Promise<void> {
    if (event.statusChange?.toCategory !== 'DONE' || !event.taskId) return;
    const listening = await this.prisma.automation.count({
      where: {
        workspaceId: event.workspaceId,
        enabled: true,
        ruleVersion: 1,
        triggerType: 'ALL_SUBTASKS_DONE',
      },
    });
    if (listening === 0) return;
    const sub = await this.prisma.task.findUnique({
      where: { id: event.taskId },
      select: { parentId: true },
    });
    if (!sub?.parentId) return;
    const open = await this.prisma.task.count({
      where: {
        parentId: sub.parentId,
        isArchived: false,
        status: { not: 'DONE' },
        id: { not: event.taskId },
      },
    });
    const derived = allSubtasksDoneEvent(event, sub.parentId, open);
    if (derived) Object.assign(outcomes, await this.handleEvent(derived, now));
  }

  /** One rule, one event. Re-reads the task each time: an earlier rule may have changed it. */
  async runRule(
    rule: Automation,
    event: RuleEvent,
    now: Date,
  ): Promise<RuleOutcome> {
    const { trigger, conditions, actions } = ruleOf(rule);
    // a SCHEDULE run has no task: it only makes new work in the rule's own project
    const scheduled = event.kind === 'SCHEDULE';
    const task =
      scheduled || !event.taskId ? null : await this.loadTask(event.taskId);
    if (!scheduled) {
      // an archived task is still a subject for these: it was just archived / someone commented on it
      const archivedOk =
        event.kind === 'TASK_ARCHIVED' || event.kind === 'COMMENT_ADDED';
      if (
        !task ||
        (task.isArchived && !archivedOk) ||
        task.workspaceId !== rule.workspaceId
      )
        return 'TASK_GONE';
      if (rule.projectId !== null && rule.projectId !== task.projectId)
        return 'NO_MATCH';
    }
    if (!matchesTrigger(trigger, event)) return 'NO_MATCH';
    if (
      task &&
      !evaluateConditions(conditions, task, { now, actorId: event.actorId })
    )
      return 'NO_MATCH';
    const taskId = task?.id ?? null;

    const block = loopGuard(event, rule.id);
    if (block) {
      const text =
        block === 'SELF'
          ? 'LOOP_GUARD: this rule does not react to its own change'
          : `LOOP_GUARD: chain of rule-made changes reached ${L.maxChainDepth} steps`;
      return (await this.claim(
        rule,
        event,
        taskId,
        AutomationRunStatus.SKIPPED,
        text,
      ))
        ? 'SKIPPED'
        : 'DUPLICATE';
    }

    const recent = await this.prisma.automationRun.count({
      where: {
        automationId: rule.id,
        status: { not: AutomationRunStatus.SKIPPED },
        // carrying on a wait is not a new reaction to an event: a burst of waits that come due together
        // must not switch a healthy rule off
        eventId: { not: { startsWith: 'wait:' } },
        ranAt: { gte: new Date(now.getTime() - 60_000) },
      },
    });
    if (rateExceeded(recent)) {
      const reason = `RATE_LIMIT: ran ${recent} times in a minute; switched off`;
      await this.prisma.automation.updateMany({
        where: { id: rule.id, enabled: true },
        data: { enabled: false, pausedReason: reason },
      });
      this.logger.warn(`automation ${rule.id} paused: ${reason}`);
      return (await this.claim(
        rule,
        event,
        taskId,
        AutomationRunStatus.SKIPPED,
        reason,
      ))
        ? 'SKIPPED'
        : 'DUPLICATE';
    }

    // claim BEFORE acting: at most once per (rule, event). Left as FAILED/interrupted if we die mid-run.
    const runId = await this.claim(
      rule,
      event,
      taskId,
      AutomationRunStatus.FAILED,
      'INTERRUPTED: the run did not finish',
      event.depth,
    );
    if (!runId) return 'DUPLICATE';

    const actorId = await this.actor.userId();
    const run: ActionRun = {
      ruleId: rule.id,
      writeDepth: event.depth + 1,
      workspaceId: rule.workspaceId,
      projectId: task ? task.projectId : rule.projectId,
      taskId,
      createdById: task ? task.createdById : rule.createdById,
      triggererId: event.actorId,
      actorId,
      vars: await this.variables(task, event, now),
    };
    let result = await this.executor.execute(actions, run);
    if (result.waiting) {
      // the run reached a WAIT: save what is left of it, to be carried on later
      const problem = await this.waits.schedule({
        workspaceId: rule.workspaceId,
        automationId: rule.id,
        runId,
        taskId,
        actions: actions as unknown as Action[],
        waiting: result.waiting,
      });
      if (problem)
        result = {
          done: result.done,
          failedAt: Number(
            /^\/actions\/(\d+)/.exec(result.waiting.pointer)?.[1] ?? 0,
          ),
          failedPath: result.waiting.pointer,
          error: problem,
        };
    }
    const ok = result.error === undefined;
    await this.prisma.automationRun.update({
      where: { id: runId },
      data: {
        status: ok ? AutomationRunStatus.OK : AutomationRunStatus.FAILED,
        error: ok ? null : (result.error ?? null),
        actionsRun: result.done,
        ...(ok && result.waiting
          ? {
              details: {
                waiting: {
                  until: result.waiting.until.toISOString(),
                  pointer: result.waiting.pointer,
                },
              },
            }
          : {}),
        ...(ok
          ? {}
          : {
              details: {
                failedAt: result.failedAt ?? null,
                failedPath: result.failedPath ?? null,
                failedItem: result.failedItem ?? null,
                failedItems: result.failedItems ?? null,
                failedRule: result.failedRule ?? null,
                of: actions.length,
              },
            }),
      },
    });
    return ok ? 'RAN' : 'FAILED';
  }

  // ------------------------------------------------------------------ helpers -----------------
  private async claim(
    rule: Automation,
    event: RuleEvent,
    taskId: string | null,
    status: AutomationRunStatus,
    error: string,
    depth = event.depth,
  ): Promise<string | null> {
    try {
      const row = await this.prisma.automationRun.create({
        data: {
          automationId: rule.id,
          workspaceId: rule.workspaceId,
          taskId,
          eventId: event.eventId,
          status,
          error,
          depth: Math.min(depth, 10),
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      )
        return null; // this rule already handled this event
      throw err;
    }
  }

  private async loadTask(taskId: string): Promise<LoadedTask | null> {
    const t = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        parentId: true,
        number: true,
        title: true,
        status: true,
        workflowStatusId: true,
        workflowStatus: { select: { name: true } },
        priority: true,
        estimate: true,
        dueDate: true,
        createdById: true,
        isArchived: true,
        issueTypeId: true,
        assignees: { select: { id: true } },
        tags: { select: { tagId: true } },
        customValues: { select: { fieldId: true, value: true } },
        workspace: { select: { key: true } },
      },
    });
    if (!t) return null;
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      title: t.title,
      key: `${t.workspace.key}-${t.number}`,
      statusName: t.workflowStatus?.name ?? t.status,
      isArchived: t.isArchived,
      status: t.status,
      workflowStatusId: t.workflowStatusId,
      priority: t.priority,
      assigneeIds: t.assignees.map((u) => u.id),
      tagIds: t.tags.map((x) => x.tagId),
      issueTypeId: t.issueTypeId,
      projectId: t.projectId,
      estimate: t.estimate,
      dueDate: t.dueDate,
      parentId: t.parentId,
      createdById: t.createdById,
      customValues: Object.fromEntries(
        t.customValues.map((v) => [v.fieldId, v.value]),
      ),
    };
  }

  /** The {{placeholders}}. Shown as they were when the rule started: later actions do not rewrite them. */
  private async variables(
    task: LoadedTask | null,
    event: RuleEvent,
    now: Date,
  ): Promise<Record<string, string>> {
    const date = (event.slot ?? now).toISOString().slice(0, 10);
    if (!task) return { date }; // a scheduled run has no task, no status change, no triggerer
    const ids = [
      event.statusChange?.fromStatusId,
      event.statusChange?.toStatusId,
    ].filter((x): x is string => typeof x === 'string');
    const names = ids.length
      ? new Map(
          (
            await this.prisma.workflowStatus.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true },
            })
          ).map((s) => [s.id, s.name]),
        )
      : new Map<string, string>();
    const c = event.statusChange;
    const actorName = event.actorId
      ? ((
          await this.prisma.user.findUnique({
            where: { id: event.actorId },
            select: { name: true },
          })
        )?.name ?? '')
      : '';
    return {
      date,
      'task.title': task.title,
      'task.key': task.key,
      'task.status': task.statusName,
      'task.priority': task.priority ?? '',
      'trigger.from': c
        ? (c.fromStatusId && names.get(c.fromStatusId)) || c.fromCategory || ''
        : '',
      'trigger.to': c
        ? (c.toStatusId && names.get(c.toStatusId)) || c.toCategory || ''
        : '',
      'actor.name': actorName,
    };
  }
}

export { describeError };
