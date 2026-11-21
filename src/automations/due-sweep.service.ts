import { Injectable, Logger } from '@nestjs/common';
import { Automation, Prisma } from '@prisma/client';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationRunnerService } from './automation-runner.service';
import { AUTOMATION_LIMITS as L } from './dsl';
import { Trigger } from './dsl/rule.types';
import {
  RuleEvent,
  dueEventId,
  dueWindow,
  latestScheduleSlot,
  overdueEventId,
  overdueWindow,
  scheduleEventId,
} from './engine';

export interface SweepResult {
  rules: number;
  fired: number;
}

/**
 * Step 5.2. The DUE_APPROACHING trigger. Nothing happens to a task when time passes, so this looks:
 * for each enabled rule, the not-done, not-archived tasks of its scope whose due date is inside
 * [now, now + offset] and which this rule has not already fired for (the key includes the due date, so
 * moving the date re-arms it), oldest due date first, at most `maxDueFiresPerTick` per rule per sweep.
 * What it finds goes through the same runner as any event: conditions, rate breaker, claim, actions.
 */
@Injectable()
export class DueSweepService {
  private readonly logger = new Logger(DueSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly runner: AutomationRunnerService,
  ) {}

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    if (!this.flags.isEnabled('WORKFLOW')) return { rules: 0, fired: 0 };
    const rules = await this.prisma.automation.findMany({
      where: {
        enabled: true,
        ruleVersion: 1,
        triggerType: { in: ['DUE_APPROACHING', 'TASK_OVERDUE', 'SCHEDULE'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let fired = 0;
    for (const rule of rules) {
      try {
        fired +=
          rule.triggerType === 'SCHEDULE'
            ? await this.sweepSchedule(rule, now)
            : await this.sweepTasks(rule, now);
      } catch (err) {
        this.logger.error(
          `time sweep failed for automation ${rule.id}: ${err instanceof Error ? err.stack : err}`,
        );
      }
    }
    if (rules.length > 0)
      this.logger.log(`Time sweep: ${rules.length} rule(s), ${fired} run(s)`);
    return { rules: rules.length, fired };
  }

  /** SCHEDULE: the latest due slot (if any) is one run, keyed by the slot, so any number of sweeps or workers run it once. */
  private async sweepSchedule(rule: Automation, now: Date): Promise<number> {
    const slot = latestScheduleSlot(
      rule.trigger as unknown as Extract<Trigger, { type: 'SCHEDULE' }>,
      now,
    );
    if (!slot) return 0;
    const event: RuleEvent = {
      eventId: scheduleEventId(slot),
      kind: 'SCHEDULE',
      workspaceId: rule.workspaceId,
      taskId: null,
      actorId: null,
      depth: 0,
      causedBy: null,
      slot,
      at: now,
    };
    const outcome = await this.runner.runRule(rule, event, now);
    return outcome === 'RAN' || outcome === 'FAILED' ? 1 : 0;
  }

  /**
   * DUE_APPROACHING and TASK_OVERDUE: nothing happens to a task when time passes, so this looks. For each
   * rule, the not-done, not-archived tasks of its scope whose due date is in the rule's window and which this
   * rule has not already fired for (the key includes the due date, so moving the date re-arms it), soonest
   * first, at most `maxDueFiresPerTick` per rule per sweep.
   */
  private async sweepTasks(rule: Automation, now: Date): Promise<number> {
    const overdue = rule.triggerType === 'TASK_OVERDUE';
    const trigger = rule.trigger as unknown as Extract<
      Trigger,
      { type: 'DUE_APPROACHING' | 'TASK_OVERDUE' }
    >;
    const { from, to } = overdue
      ? overdueWindow(
          now,
          (trigger as Extract<Trigger, { type: 'TASK_OVERDUE' }>).afterHours ??
            0,
        )
      : dueWindow(
          now,
          (trigger as Extract<Trigger, { type: 'DUE_APPROACHING' }>).offset,
        );
    const prefix = overdue ? 'overdue:' : 'due:';
    // "not yet fired for THIS due date" has to be in the query, or the same first N tasks would be
    // returned every sweep and the rest would starve. The key format matches dueEventId / overdueEventId.
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; due_date: Date; workspace_id: string }>
    >(Prisma.sql`
      SELECT t.id, t.due_date, t.workspace_id
        FROM tasks t
       WHERE t.workspace_id = ${rule.workspaceId}
         ${rule.projectId ? Prisma.sql`AND t.project_id = ${rule.projectId}` : Prisma.empty}
         AND NOT t.is_archived AND t.status <> 'DONE'
         AND t.due_date >= ${from} AND t.due_date <= ${to}
         AND NOT EXISTS (
           SELECT 1 FROM automation_runs r
            WHERE r.automation_id = ${rule.id}
              AND r.event_id = ${prefix}::text || t.id || ':' || to_char(t.due_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       ORDER BY t.due_date ASC, t.id ASC
       LIMIT ${L.maxDueFiresPerTick}`);
    let fired = 0;
    for (const row of rows) {
      const event: RuleEvent = {
        eventId: overdue
          ? overdueEventId(row.id, row.due_date)
          : dueEventId(row.id, row.due_date),
        kind: overdue ? 'TASK_OVERDUE' : 'DUE_APPROACHING',
        workspaceId: row.workspace_id,
        taskId: row.id,
        actorId: null,
        depth: 0,
        causedBy: null,
        at: now,
      };
      const outcome = await this.runner.runRule(rule, event, now);
      if (outcome === 'RAN' || outcome === 'FAILED') fired++;
      if (
        outcome === 'SKIPPED' &&
        (
          await this.prisma.automation.findUnique({
            where: { id: rule.id },
            select: { enabled: true },
          })
        )?.enabled === false
      )
        break; // the rate breaker switched it off
    }
    return fired;
  }
}
