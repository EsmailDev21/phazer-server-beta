import { TaskStatus } from '@prisma/client';

/**
 * Per-repo status rules (ADR-0014 d.6), stored in `ChannelLink.config.statusRules` until Phase 5 turns them into Automations.
 * Values are the five-ish workflow CATEGORIES (`Task.status`), as in the chat commands; the project's workflow picks the
 * concrete status of that category. `null`/absent = do nothing for that event.
 */
export interface StatusRules {
  prOpened?: TaskStatus | null;
  prMerged?: TaskStatus | null;
  prClosed?: TaskStatus | null;
}

/** What a new repo link starts with (diagram 10): opened -> In progress, merged -> Done, closed unmerged -> no change. Stored EXPLICITLY, so changing these defaults later never alters an existing link. */
export const DEFAULT_STATUS_RULES: Readonly<Required<StatusRules>> = { prOpened: TaskStatus.IN_PROGRESS, prMerged: TaskStatus.DONE, prClosed: null };

export type PrTrigger = 'opened' | 'merged' | 'closed';

const RANK: Record<TaskStatus, number> = { TODO: 0, IN_PROGRESS: 1, BLOCKED: 1, DONE: 2 };

/**
 * Should the automation move a task that is in `current` according to the rule for `trigger`? Returns the target or null.
 *  - never when the target is where it already is;
 *  - opened / merged only move FORWARD (a reopened PR must not drag a Done task back; a new PR must not unblock a Blocked task: BLOCKED ranks with IN_PROGRESS, so IN_PROGRESS is not "forward" of it);
 *  - a closed-unmerged rule is an explicit admin choice and may move backwards (e.g. back to TODO), but NEVER out of DONE:
 *    another PR may already have finished the work.
 */
export function decideStatus(rules: StatusRules | null | undefined, trigger: PrTrigger, current: TaskStatus): TaskStatus | null {
  const target = trigger === 'opened' ? rules?.prOpened : trigger === 'merged' ? rules?.prMerged : rules?.prClosed;
  if (!target || target === current) return null;
  if (trigger === 'closed') return current === TaskStatus.DONE ? null : target;
  return RANK[target] > RANK[current] ? target : null;
}

const STATUSES = new Set<string>(Object.values(TaskStatus));

/** Reads whatever is in `config` defensively (it is JSON; an old or hand-edited row must never crash the webhook path). */
export function rulesFromConfig(config: unknown): StatusRules {
  const raw = (config as { statusRules?: Record<string, unknown> } | null)?.statusRules;
  const pick = (v: unknown): TaskStatus | null => (typeof v === 'string' && STATUSES.has(v) ? (v as TaskStatus) : null);
  return { prOpened: pick(raw?.prOpened), prMerged: pick(raw?.prMerged), prClosed: pick(raw?.prClosed) };
}
