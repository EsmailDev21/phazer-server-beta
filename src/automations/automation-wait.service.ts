import { Injectable, Logger } from '@nestjs/common';
import {
  AutomationRunStatus,
  AutomationWaitStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActionExecutor,
  ExecutionResult,
  WaitFrame,
  WaitRequest,
} from './action-executor.service';
import { treeLimits } from './dsl/rule.settings';
import type { Action } from './dsl/rule.types';

export interface WaitResumeSummary {
  resumed: number;
  cancelled: number;
  failed: number;
}

/** how long a wait may stay RESUMING before it is taken to be dead (the worker that claimed it died) */
const STALE_RESUMING_MS = 60 * 60_000;
const BATCH = 100;

/**
 * Step 5.15. WAIT: saving what is left of a run, and carrying it on when the time is up.
 *
 * Carrying on happens at most once (a wait is claimed before it runs, like a run is), only if the rule is
 * still on and the task still exists (otherwise the wait is CANCELLED with the reason), and as its own
 * run row (`eventId: wait:<id>`) linked to the run that started it, so the history shows both halves.
 */
@Injectable()
export class AutomationWaitService {
  private readonly logger = new Logger(AutomationWaitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: ActionExecutor,
  ) {}

  /**
   * Saves a run's wait. Returns a message when it cannot be (too many waiting in this workspace): the
   * caller fails the run with it, at the WAIT.
   */
  async schedule(input: {
    workspaceId: string;
    automationId: string;
    runId: string | null;
    taskId: string | null;
    actions: Action[];
    waiting: WaitRequest;
  }): Promise<string | null> {
    const max = treeLimits().maxPendingWaits;
    const pending = await this.prisma.automationWait.count({
      where: {
        workspaceId: input.workspaceId,
        status: AutomationWaitStatus.PENDING,
      },
    });
    if (pending >= max)
      return `This workspace already has ${pending} waits pending; the limit is ${max} (AUTOMATION_MAX_PENDING_WAITS)`;
    await this.prisma.automationWait.create({
      data: {
        workspaceId: input.workspaceId,
        automationId: input.automationId,
        runId: input.runId,
        taskId: input.taskId,
        resumeAt: input.waiting.until,
        actions: input.actions as unknown as Prisma.InputJsonValue,
        frames: input.waiting.frames as unknown as Prisma.InputJsonValue,
      },
    });
    return null;
  }

  /** The waits whose time is up, oldest first. Safe to run on several workers at once. */
  async resumeDue(
    now: Date = new Date(),
    limit = BATCH,
  ): Promise<WaitResumeSummary> {
    const summary: WaitResumeSummary = { resumed: 0, cancelled: 0, failed: 0 };
    await this.prisma.automationWait.updateMany({
      where: {
        status: AutomationWaitStatus.RESUMING,
        resumedAt: { lt: new Date(now.getTime() - STALE_RESUMING_MS) },
      },
      data: {
        status: AutomationWaitStatus.FAILED,
        error:
          'INTERRUPTED: the wait was being carried on when its worker stopped',
      },
    });
    const due = await this.prisma.automationWait.findMany({
      where: {
        status: AutomationWaitStatus.PENDING,
        resumeAt: { lte: now },
      },
      orderBy: { resumeAt: 'asc' },
      take: limit,
      include: {
        automation: {
          select: { enabled: true, name: true, pausedReason: true },
        },
      },
    });
    for (const wait of due) {
      try {
        const outcome = await this.resumeOne(wait, now);
        summary[outcome]++;
      } catch (err) {
        summary.failed++;
        this.logger.error(
          `wait ${wait.id} could not be carried on: ${err instanceof Error ? err.stack : err}`,
        );
      }
    }
    return summary;
  }

  /** Cancels a wait that is still waiting. Returns false if it was not (already resumed, or cancelled). */
  async cancel(waitId: string, reason: string): Promise<boolean> {
    const r = await this.prisma.automationWait.updateMany({
      where: { id: waitId, status: AutomationWaitStatus.PENDING },
      data: {
        status: AutomationWaitStatus.CANCELLED,
        error: reason,
        resumedAt: new Date(),
      },
    });
    return r.count === 1;
  }

  private async resumeOne(
    wait: Prisma.AutomationWaitGetPayload<{
      include: {
        automation: {
          select: { enabled: true; name: true; pausedReason: true };
        };
      };
    }>,
    now: Date,
  ): Promise<keyof WaitResumeSummary> {
    const frames = wait.frames as unknown as WaitFrame[];
    // the TASK the whole rule was about is the outermost frame's (a wait inside a WITH is about that
    // task for the actions in it, but the rule's task must still exist for the rest)
    const rootTaskId = frames[frames.length - 1]?.run.taskId ?? null;

    if (!wait.automation.enabled) {
      await this.cancel(
        wait.id,
        wait.automation.pausedReason
          ? `The rule is switched off (${wait.automation.pausedReason})`
          : 'The rule is switched off',
      );
      return 'cancelled';
    }
    if (rootTaskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: rootTaskId },
        select: { id: true },
      });
      if (!task) {
        await this.cancel(wait.id, 'The task no longer exists');
        return 'cancelled';
      }
    }

    // claim BEFORE acting: at most once
    const claim = await this.prisma.automationWait.updateMany({
      where: { id: wait.id, status: AutomationWaitStatus.PENDING },
      data: { status: AutomationWaitStatus.RESUMING, resumedAt: now },
    });
    if (claim.count !== 1) return 'cancelled'; // another worker has it (or it was cancelled meanwhile)

    let runId: string;
    try {
      const row = await this.prisma.automationRun.create({
        data: {
          automationId: wait.automationId,
          workspaceId: wait.workspaceId,
          taskId: rootTaskId,
          eventId: `wait:${wait.id}`,
          status: AutomationRunStatus.FAILED,
          error: 'INTERRUPTED: the run did not finish',
          depth: Math.min(
            Math.max((frames[0]?.run.writeDepth ?? 1) - 1, 0),
            10,
          ),
        },
        select: { id: true },
      });
      runId = row.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        await this.finish(wait.id, AutomationWaitStatus.DONE, null);
        return 'cancelled'; // this wait was already carried on
      }
      throw err;
    }

    let result: ExecutionResult = await this.executor.resume(
      wait.actions as unknown as Action[],
      frames,
    );
    if (result.waiting) {
      // it reached another WAIT: save the new rest, and this half is done
      const problem = await this.schedule({
        workspaceId: wait.workspaceId,
        automationId: wait.automationId,
        runId,
        taskId: rootTaskId,
        actions: wait.actions as unknown as Action[],
        waiting: result.waiting,
      });
      if (problem)
        result = {
          done: result.done,
          failedPath: result.waiting.pointer,
          failedAt: 0,
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
        details: {
          resumedFromWait: wait.id,
          ...(result.waiting
            ? {
                waiting: {
                  until: result.waiting.until.toISOString(),
                  pointer: result.waiting.pointer,
                },
              }
            : {}),
          ...(ok
            ? {}
            : {
                failedAt: result.failedAt ?? null,
                failedPath: result.failedPath ?? null,
                failedItem: result.failedItem ?? null,
                failedItems: result.failedItems ?? null,
                failedRule: result.failedRule ?? null,
              }),
        } as Prisma.InputJsonValue,
      },
    });
    await this.finish(
      wait.id,
      ok ? AutomationWaitStatus.DONE : AutomationWaitStatus.FAILED,
      ok ? null : (result.error ?? null),
    );
    return ok ? 'resumed' : 'failed';
  }

  private finish(
    id: string,
    status: AutomationWaitStatus,
    error: string | null,
  ) {
    return this.prisma.automationWait.update({
      where: { id },
      data: { status, error, resumedAt: new Date() },
    });
  }
}
