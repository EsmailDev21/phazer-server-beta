import { BlueprintIssue, BlueprintStats, BlueprintV1 } from '../blueprint';

/**
 * Step 3.4. What the sanitizer reports. HARD RULE for every string in a report: it never
 * contains the text that was matched (no token, no email, no number). Only the KIND, a human
 * label of the pattern, the path and a count. A report is shown to the exporter and logged;
 * it must not become the leak the sanitizer exists to prevent.
 */
export type FindingKind =
  | 'secret' //            high-confidence credential pattern
  | 'entropy-secret' //    long random-looking token
  | 'email'
  | 'phone'
  | 'card-number'
  | 'national-id'
  | 'internal-ip'
  | 'public-ip'
  | 'unsafe-url' //        javascript:, data:, file:, plain http, ...
  | 'internal-url' //      localhost, private ranges, intranet-looking hosts
  | 'external-ref-url' //  links to someone's Jira / GitHub issue / Slack / Notion ...
  | 'url-kept' //          an ordinary https link that stays; listed so the exporter can look
  | 'internal-id' //       a database id pasted into text
  | 'task-reference' //    "ENG-123": will not resolve in the new workspace
  | 'handle' //            "@someone"
  | 'control-chars'
  | 'braces' //            "{{" in the source text was neutralised
  | 'user-dropped' //      a person reference removed (assignee overflow, USER field value)
  | 'date-dropped'
  | 'value-dropped' //     a custom value that did not fit its field
  | 'asset-dropped'
  | 'comment-dropped';

/** blocked: stops the export. redacted: removed from the text. review: left in, look at it. info: FYI. */
export type FindingSeverity = 'blocked' | 'redacted' | 'review' | 'info';

export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** JSON pointer into the produced blueprint (or the raw one for removed items). */
  path: string;
  /** Label of the rule that fired. Never the matched text. */
  detail: string;
  count: number;
}

export interface SanitizeReport {
  blocked: boolean;
  findings: Finding[];
  /** Findings beyond the cap were counted in `summary` but not listed. */
  truncated: boolean;
  summary: Partial<Record<FindingKind, number>>;
  anchor: {
    date: string;
    source: 'earliest' | 'override';
    weekday: string;
  } | null;
  datesConverted: number;
  roles: { created: number };
  assets: { kept: number; dropped: number };
}

export interface SanitizeOptions {
  /** Day 0 for date offsets. Default: the earliest date found. */
  anchorDate?: string;
  /**
   * 'block' (default): a credential-shaped string stops the export and no blueprint is
   * produced. 'redact': it is removed from the text and the export continues (the exporter
   * chose to). Entropy-only hits are never blocking: they are redacted and flagged for review.
   */
  onSecret?: 'block' | 'redact';
  /**
   * sha256 per source attachment id, supplied by the asset step (3.7) once the bytes are
   * hashed. Assets without one cannot be part of a stored template yet and are dropped.
   */
  assetHashes?: ReadonlyMap<string, string>;
}

export type SanitizeResult =
  | {
      ok: true;
      blueprint: BlueprintV1;
      stats: BlueprintStats;
      report: SanitizeReport;
      warnings: BlueprintIssue[];
    }
  | { ok: false; reason: 'SECRETS_FOUND'; report: SanitizeReport }
  | {
      ok: false;
      reason: 'INVALID';
      issues: BlueprintIssue[];
      report: SanitizeReport;
    };

export const MAX_LISTED_FINDINGS = 500;
