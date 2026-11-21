import { ImportJobStatus as S } from '@prisma/client';

/**
 * Step 4.1 (diagram 04). The ONE place that says which import-job status may follow which.
 * Pure: no Nest, no DB. ImportsService makes every transition a compare-and-set
 * (`UPDATE ... WHERE status = <from>`), so two racing requests cannot both win; this table decides
 * whether the attempt is legal at all.
 *
 * Who moves a job:
 *  - the person: edit selection / mapping, preview, start, cancel, resume, rollback;
 *  - the executor (step 4.4): QUEUED -> RUNNING -> PAUSED / COMPLETED / FAILED / ..., ROLLING_BACK -> ROLLED_BACK.
 */
export const IMPORT_TRANSITIONS: Readonly<Record<S, readonly S[]>> = {
  // Setup. Editing the selection always drops back to SOURCES_SELECTED (mapping + preview are stale);
  // editing the mapping drops back to MAPPING (the preview is stale).
  [S.DRAFT]: [S.SOURCES_SELECTED],
  [S.SOURCES_SELECTED]: [S.SOURCES_SELECTED, S.MAPPING, S.PREVIEW_READY],
  [S.MAPPING]: [S.SOURCES_SELECTED, S.MAPPING, S.PREVIEW_READY],
  [S.PREVIEW_READY]: [S.SOURCES_SELECTED, S.MAPPING, S.PREVIEW_READY, S.QUEUED],

  // Run. QUEUED -> CANCELED lets a person cancel before a worker picked it up.
  [S.QUEUED]: [S.RUNNING, S.CANCELED],
  // RUNNING -> QUEUED is the executor handing the job back (chunk budget used up / graceful shutdown).
  [S.RUNNING]: [
    S.QUEUED,
    S.PAUSED,
    S.COMPLETED,
    S.COMPLETED_WITH_WARNINGS,
    S.FAILED,
    S.CANCELED,
  ],
  // PAUSED -> RUNNING: the executor retries by itself (429 backoff). PAUSED -> QUEUED: the person resumed.
  [S.PAUSED]: [S.RUNNING, S.QUEUED, S.CANCELED],

  // Finished. Anything that may have created rows can be rolled back; FAILED can also be resumed.
  [S.COMPLETED]: [S.ROLLING_BACK],
  [S.COMPLETED_WITH_WARNINGS]: [S.ROLLING_BACK],
  [S.FAILED]: [S.QUEUED, S.ROLLING_BACK],
  [S.CANCELED]: [S.ROLLING_BACK],

  // Rollback is idempotent and retried by the queue; it only ever ends in ROLLED_BACK. The self-edge is the
  // person re-requesting a rollback whose queue job was lost (the jobId is deterministic, so it cannot double up).
  [S.ROLLING_BACK]: [S.ROLLED_BACK, S.ROLLING_BACK],
  [S.ROLLED_BACK]: [],
};

export function canTransition(from: S, to: S): boolean {
  return IMPORT_TRANSITIONS[from].includes(to);
}

export class IllegalImportTransitionError extends Error {
  constructor(
    readonly from: S,
    readonly to: S,
  ) {
    super(`An import in ${from} cannot move to ${to}`);
    this.name = 'IllegalImportTransitionError';
  }
}

export function assertTransition(from: S, to: S): void {
  if (!canTransition(from, to)) throw new IllegalImportTransitionError(from, to);
}

/** Nothing is running or can start by itself: the job is at rest. */
export function isFinished(s: S): boolean {
  return (
    s === S.COMPLETED ||
    s === S.COMPLETED_WITH_WARNINGS ||
    s === S.FAILED ||
    s === S.CANCELED ||
    s === S.ROLLED_BACK
  );
}

/** Setup phase: nothing has been written to the workspace yet, so the job may simply be deleted. */
export function isSetup(s: S): boolean {
  return (
    s === S.DRAFT ||
    s === S.SOURCES_SELECTED ||
    s === S.MAPPING ||
    s === S.PREVIEW_READY
  );
}

/** Statuses in which the executor may be touching the workspace (selection / mapping are frozen). */
export function isActive(s: S): boolean {
  return s === S.QUEUED || s === S.RUNNING || s === S.PAUSED || s === S.ROLLING_BACK;
}

/** Statuses that may have created rows and therefore have something to roll back. */
export const ROLLBACKABLE: readonly S[] = [
  S.COMPLETED,
  S.COMPLETED_WITH_WARNINGS,
  S.FAILED,
  S.CANCELED,
];

export const SELECTION_EDITABLE: readonly S[] = [
  S.DRAFT,
  S.SOURCES_SELECTED,
  S.MAPPING,
  S.PREVIEW_READY,
];
export const MAPPING_EDITABLE: readonly S[] = [
  S.SOURCES_SELECTED,
  S.MAPPING,
  S.PREVIEW_READY,
];
export const PREVIEWABLE: readonly S[] = [
  S.SOURCES_SELECTED,
  S.MAPPING,
  S.PREVIEW_READY,
];
export const CANCELABLE: readonly S[] = [S.QUEUED, S.RUNNING, S.PAUSED];
export const RESUMABLE: readonly S[] = [S.PAUSED, S.FAILED];
