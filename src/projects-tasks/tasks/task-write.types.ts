import { CreateTaskDto } from './dto/create-task.dto';

/**
 * Server-side-only additions to a task create. Deliberately NOT a DTO class:
 * nothing here is reachable from an HTTP body (ADR-0003 decision 3), and the
 * dates are only honoured under `WriteContext.keepOriginalDates` (origin IMPORT).
 */
export interface TaskWriteExtras {
  /** Original creation time of an imported task. Needs ctx.keepOriginalDates. */
  createdAt?: Date;
  /** Original last-modified time of an imported task. Needs ctx.keepOriginalDates. */
  updatedAt?: Date;
  /** Users to assign. Validated to exist, like setAssignees. */
  assigneeIds?: string[];
  /** Create the task already archived (isArchived + archivedAt). Honoured on an IMPORT context only (step 4.5: Linear auto-archives old issues). */
  archived?: boolean;
}

/** One task of a bulk chunk. The workspace is given once for the whole chunk. */
export type BulkTaskItem = Omit<CreateTaskDto, 'workspaceId'> &
  TaskWriteExtras & {
    /**
     * Parent is an EARLIER item of the list passed to createTasksBulk (a
     * 0-based index into that list, whichever chunk either lands in).
     * Mutually exclusive with `parentId` (an already-existing task). A bulk
     * child must carry the same `projectId` as its parent (no inheritance in
     * bulk: the cap preflight needs it up front).
     */
    parentIndex?: number;
  };
