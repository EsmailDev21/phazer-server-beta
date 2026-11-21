import { Priority } from '@prisma/client';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { Confidence } from './mapping.types';

/**
 * Step 4.3. The lookup tables. DATA, not logic: each is a small map a reviewer can read against the provider's own
 * documentation (diagram 07). Keys are `priorityKey()`-normalised. `null` means "this provider says: no priority".
 */

/** "Priority: High", "High (2)", "  HIGH " -> "high". "P1" stays "p1". */
export function priorityKey(raw: string): string {
  return foldName(raw)
    .replace(/^priority\s*[:/=-]\s*/, '')
    .replace(/\s*\(\s*\d+\s*\)\s*$/, '')
    .trim();
}

type Table = Readonly<Record<string, Priority | null>>;
const P = Priority;

/** Atlassian's default priority scheme, plus the older Jira Server names; numeric ids are the default scheme's order. */
const JIRA: Table = {
  highest: P.URGENT, blocker: P.URGENT, critical: P.URGENT,
  high: P.HIGH, major: P.HIGH,
  medium: P.MEDIUM,
  low: P.LOW, minor: P.LOW, lowest: P.LOW, trivial: P.LOW,
  '1': P.URGENT, '2': P.HIGH, '3': P.MEDIUM, '4': P.LOW, '5': P.LOW,
  none: null,
};

/** ClickUp: Urgent / High / Normal / Low, API numbers 1-4. */
const CLICKUP: Table = {
  urgent: P.URGENT, high: P.HIGH, normal: P.MEDIUM, low: P.LOW,
  '1': P.URGENT, '2': P.HIGH, '3': P.MEDIUM, '4': P.LOW,
  none: null,
};

/** Linear: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
const LINEAR: Table = {
  urgent: P.URGENT, high: P.HIGH, medium: P.MEDIUM, low: P.LOW,
  '1': P.URGENT, '2': P.HIGH, '3': P.MEDIUM, '4': P.LOW,
  '0': null, 'no priority': null, none: null,
};

const BY_SYSTEM: Readonly<Record<string, Table>> = { jira: JIRA, clickup: CLICKUP, linear: LINEAR };

/** Words and conventions that mean the same thing nearly everywhere; used when a provider's own table has no answer. */
const GENERIC: Table = {
  urgent: P.URGENT, critical: P.URGENT, highest: P.URGENT, blocker: P.URGENT, immediate: P.URGENT, asap: P.URGENT, p0: P.URGENT,
  high: P.HIGH, important: P.HIGH, major: P.HIGH, p1: P.HIGH,
  medium: P.MEDIUM, normal: P.MEDIUM, moderate: P.MEDIUM, mid: P.MEDIUM, default: P.MEDIUM, p2: P.MEDIUM,
  low: P.LOW, minor: P.LOW, lowest: P.LOW, trivial: P.LOW, p3: P.LOW, p4: P.LOW,
  none: null, 'no priority': null, unset: null, 'not set': null, '': null,
};

export interface PriorityLookup {
  priority: Priority | null;
  confidence: Confidence;
  reason: 'SOURCE_TABLE' | 'GENERIC_TABLE' | 'NONE';
}

export function lookupPriority(system: string, raw: string): PriorityLookup {
  const key = priorityKey(raw);
  const own = BY_SYSTEM[system.toLowerCase()];
  if (own && Object.prototype.hasOwnProperty.call(own, key)) return { priority: own[key], confidence: 'HIGH', reason: 'SOURCE_TABLE' };
  if (Object.prototype.hasOwnProperty.call(GENERIC, key)) return { priority: GENERIC[key], confidence: 'MEDIUM', reason: 'GENERIC_TABLE' };
  return { priority: null, confidence: 'LOW', reason: 'NONE' };
}

// ------------------------------------------------------------------------------------------------ status names

/**
 * Name heuristics, used ONLY where the source gives no usable category (or none that can say "blocked": no tracker has
 * one). Anchored on word boundaries so "Unblocked" and "Reviewed" do not match "block" / "review" by accident.
 */
export const NAME_BLOCKED = /\b(blocked|blocker|on[\s-]?hold|impediment|stuck|waiting(?:\s+(?:for|on))?|pending\s+(?:info|input|customer|answer))\b/i;
export const NAME_DONE = /^(?:done|closed|complete|completed|resolved|shipped|released|finished|fixed|deployed|live)$/i;
export const NAME_CANCELED = /\b(?:cancell?ed|won['’]?t\s+(?:do|fix)|wont\s+(?:do|fix)|rejected|obsolete|abandoned|duplicate|invalid|declined|not\s+planned|rejected)\b/i;
/**
 * `working on it` is monday.com's DEFAULT label; `wip` / `underway` / `ongoing` are common everywhere. `started` must not match "Not started" /
 * "Not yet started" (the lookbehind): that is the opposite state.
 */
export const NAME_IN_PROGRESS = /\b(?:in[\s-]?progress|working\s+on\s+it|wip|underway|ongoing|doing|(?<!\bnot\s+(?:yet\s+)?)started|active|developing|development|in[\s-]?review|review|testing|in[\s-]?test|qa|verify|verifying|code\s+review)\b/i;

/** Colours for a created workflow status when the source gave none (the app's own palette). */
export const CATEGORY_COLOR = {
  TODO: '#94A3B8',
  IN_PROGRESS: '#3B82F6',
  BLOCKED: '#EF4444',
  DONE: '#22C55E',
} as const;
