import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SnapActionType,
  SnapReviewStatus,
  SnapSessionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolver } from '../access-control/access-control.service';
import { CreateSnapSessionDto } from './dto/create-snap-session.dto';
import { ReviewClauseDto } from './dto/review-clause.dto';
import { ExecutionResultDto } from './dto/execution-result.dto';
import { QuerySnapSessionsDto } from './dto/query-sessions.dto';
import { fuzzyMatch } from './fuzzy-match.util';

const DEFAULT_RETENTION_DAYS = 30;
const SESSION_REVIEW_TIMEOUT_HOURS = 24;

// Actions that reference an EXISTING task by free-text — these get the
// DB-dependent fuzzy-match resolution step this backend is positioned to
// do (the external pipeline can't see live app data).
const TASK_REFERENCE_ACTIONS: SnapActionType[] = [
  SnapActionType.UPDATE_TASK,
  SnapActionType.ASSIGN_TASK,
  SnapActionType.ADD_TAG,
  SnapActionType.SET_DUE_DATE,
];

// Only these actions can plausibly resolve to a real Task id for
// createdTaskId — CREATE_PROJECT/CREATE_WORKSPACE have no schema column
// to link to (see confirmExecution below).
const TASK_LINKABLE_ACTIONS: SnapActionType[] = [
  SnapActionType.CREATE_TASK,
  ...TASK_REFERENCE_ACTIONS,
];

@Injectable()
export class SnapSessionsService {
  private readonly logger = new Logger(SnapSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  /**
   * Accepts ALREADY-COMPUTED M1/M2/M3 output from the frontend (which ran
   * the real pipeline in a separate, real-time-facing project this
   * backend does not call into). This service's job: validate, persist,
   * and do the fuzzy-matching resolution step that genuinely needs live
   * app-database access.
   *
   * Sessions start at REVIEWING directly, not PARSING — parsing already
   * happened before this request arrived. PARSING remains in the enum
   * for whatever transient state the external pipeline project itself
   * models; it's never set by this backend.
   */
  async create(dto: CreateSnapSessionDto, userId: string) {
    if (!dto.consentGiven) {
      throw new BadRequestException(
        'consentGiven must be true — this is a privacy gate, not optional',
      );
    }

    if (dto.workspaceId) {
      if (
        !(await this.permissionResolver.hasWorkspaceLevelAccess(
          userId,
          dto.workspaceId,
        ))
      ) {
        throw new ForbiddenException(
          'You do not have access to this workspace',
        );
      }
    }

    const derived = this.deriveInputMetadata(dto.rawInput);

    const session = await this.prisma.snapSession.create({
      data: {
        userId,
        workspaceId: dto.workspaceId,
        rawInput: dto.rawInput,
        anonymizedInput: derived.anonymizedInput,
        inputLength: derived.inputLength,
        wordCount: derived.wordCount,
        hasMentions: derived.hasMentions,
        hasTags: derived.hasTags,
        hasSymbols: derived.hasSymbols,
        hasEmails: derived.hasEmails,
        consentGiven: dto.consentGiven,
        dataRetentionDays: dto.dataRetentionDays ?? DEFAULT_RETENTION_DAYS,
        status: SnapSessionStatus.REVIEWING,
      },
    });

    const clausesData = await Promise.all(
      dto.clauses.map(async (clauseInput, index) => {
        const fuzzyMatchesUsed = await this.resolveFuzzyMatches(
          clauseInput.predictedAction,
          clauseInput.extractedEntities,
          dto.workspaceId,
        );

        return {
          sessionId: session.id,
          clauseIndex: index,
          text: clauseInput.text,
          charStart: clauseInput.charStart,
          charEnd: clauseInput.charEnd,
          m1Confidence: clauseInput.m1Confidence,
          m1TimeMs: clauseInput.m1TimeMs,
          predictedAction: clauseInput.predictedAction,
          actionConfidence: clauseInput.actionConfidence,
          m2TimeMs: clauseInput.m2TimeMs,
          extractedEntities: clauseInput.extractedEntities as
            Prisma.InputJsonValue | undefined,
          entityConfidence: clauseInput.entityConfidence,
          m3TimeMs: clauseInput.m3TimeMs,
          fuzzyMatchesUsed: fuzzyMatchesUsed as
            Prisma.InputJsonValue | undefined,
        };
      }),
    );

    if (clausesData.length > 0) {
      await this.prisma.snapClause.createMany({ data: clausesData });
    }

    return this.getByIdOrThrow(session.id, userId);
  }

  async list(userId: string, pagination: QuerySnapSessionsDto) {
    const where = { userId };
    const [data, total] = await Promise.all([
      this.prisma.snapSession.findMany({
        where,
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.snapSession.count({ where }),
    ]);
    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  async getById(sessionId: string, userId: string) {
    return this.getByIdOrThrow(sessionId, userId);
  }

  /**
   * PATCH .../clauses/:clauseId — the HITL review action. Recomputes the
   * parent session's rolled-up status after every review per
   * SNAP__HITL__SESSION_STATUS. Blocks re-review of an already-executed
   * clause (executedAt set) — that's a historical record of a real
   * action, not something to silently revise.
   */
  async reviewClause(
    sessionId: string,
    clauseId: string,
    dto: ReviewClauseDto,
    userId: string,
  ) {
    const session = await this.getOwnedSessionOrThrow(sessionId, userId);
    const clause = session.clauses.find((c) => c.id === clauseId);
    if (!clause)
      throw new NotFoundException('Clause not found on this session');

    if (clause.executedAt) {
      throw new BadRequestException(
        'This clause has already been executed and cannot be re-reviewed',
      );
    }

    await this.prisma.snapClause.update({
      where: { id: clauseId },
      data: {
        reviewStatus: dto.reviewStatus,
        correctedAction: dto.correctedAction,
        correctedEntities: dto.correctedEntities as
          Prisma.InputJsonValue | undefined,
        correctionType: dto.correctionType,
        rejectionReason: dto.rejectionReason,
        userRating: dto.userRating,
      },
    });

    await this.recomputeSessionStatus(sessionId);
    return this.getByIdOrThrow(sessionId, userId);
  }

  /**
   * PATCH .../clauses/:clauseId/execution-result — THIN, records only.
   * Guarded by session ownership alone, per SNAP__EXEC__RESULT_RECORDING
   * — the actual privileged action already happened via the frontend
   * calling the real POST /tasks|/projects|/workspaces endpoint directly
   * (which already went through its own @RequireAccess and already
   * emitted its own real Activity row). This call never touches Task/
   * Project/Workspace tables itself.
   */
  async recordExecutionResult(
    sessionId: string,
    clauseId: string,
    dto: ExecutionResultDto,
    userId: string,
  ) {
    const session = await this.getOwnedSessionOrThrow(sessionId, userId);
    const clause = session.clauses.find((c) => c.id === clauseId);
    if (!clause)
      throw new NotFoundException('Clause not found on this session');

    if (
      clause.reviewStatus !== SnapReviewStatus.APPROVED &&
      clause.reviewStatus !== SnapReviewStatus.CORRECTED
    ) {
      throw new BadRequestException(
        'Only APPROVED or CORRECTED clauses can record an execution result',
      );
    }

    const executedAction = clause.correctedAction ?? clause.predictedAction;

    // createdTaskId only makes sense when the action is actually
    // Task-linkable — schema has no equivalent column for a created
    // Project/Workspace, so those are simply not linked (see README).
    const canLinkTask =
      executedAction && TASK_LINKABLE_ACTIONS.includes(executedAction);

    await this.prisma.snapClause.update({
      where: { id: clauseId },
      data: {
        executedAction,
        executedAt: new Date(),
        executionError: dto.success ? null : (dto.error ?? 'Execution failed'),
        executionTimeMs: dto.executionTimeMs,
        createdTaskId:
          dto.success && canLinkTask ? dto.createdEntityId : undefined,
      },
    });

    await this.recomputeSessionStatus(sessionId);
    return this.getByIdOrThrow(sessionId, userId);
  }

  /**
   * SNAP__CLEANUP__EXPIRY — not wired to an actual scheduler, same
   * constraint as every other cleanup job in this codebase (Attachments,
   * due-date reminders, account soft-delete purge). Complete, callable
   * implementation.
   */
  async expireStaleSessions(): Promise<{ expiredCount: number }> {
    const cutoff = new Date(
      Date.now() - SESSION_REVIEW_TIMEOUT_HOURS * 60 * 60 * 1000,
    );
    const result = await this.prisma.snapSession.updateMany({
      where: { status: SnapSessionStatus.REVIEWING, createdAt: { lt: cutoff } },
      data: { status: SnapSessionStatus.EXPIRED },
    });
    this.logger.log(
      `Snap session expiry sweep: ${result.count} session(s) expired`,
    );
    return { expiredCount: result.count };
  }

  // ---- internals ----

  private async getByIdOrThrow(sessionId: string, userId: string) {
    return this.getOwnedSessionOrThrow(sessionId, userId);
  }

  private async getOwnedSessionOrThrow(sessionId: string, userId: string) {
    const session = await this.prisma.snapSession.findUnique({
      where: { id: sessionId },
      include: { clauses: { orderBy: { clauseIndex: 'asc' } } },
    });
    if (!session || session.userId !== userId) {
      // 404, not 403 — a Snap session is a personal draft; its existence
      // shouldn't be revealed to anyone but its owner.
      throw new NotFoundException('Snap session not found');
    }
    return session;
  }

  /**
   * SNAP__HITL__SESSION_STATUS rollup:
   *   any PENDING remaining          -> stays REVIEWING
   *   none PENDING, all APPROVED/CORRECTED -> APPROVED
   *   none PENDING, mixed (some REJECTED/SKIPPED) -> PARTIAL
   *   once every APPROVED/CORRECTED clause has executedAt set -> EXECUTED
   */
  private async recomputeSessionStatus(sessionId: string): Promise<void> {
    const clauses = await this.prisma.snapClause.findMany({
      where: { sessionId },
    });
    if (clauses.length === 0) return;

    const anyPending = clauses.some(
      (c) => c.reviewStatus === SnapReviewStatus.PENDING,
    );
    if (anyPending) {
      await this.prisma.snapSession.update({
        where: { id: sessionId },
        data: { status: SnapSessionStatus.REVIEWING },
      });
      return;
    }

    const executable = clauses.filter(
      (c) =>
        c.reviewStatus === SnapReviewStatus.APPROVED ||
        c.reviewStatus === SnapReviewStatus.CORRECTED,
    );
    const allExecuted =
      executable.length > 0 && executable.every((c) => c.executedAt !== null);

    let status: SnapSessionStatus;
    if (allExecuted) {
      status = SnapSessionStatus.EXECUTED;
    } else if (executable.length === clauses.length) {
      status = SnapSessionStatus.APPROVED;
    } else {
      status = SnapSessionStatus.PARTIAL;
    }

    await this.prisma.snapSession.update({
      where: { id: sessionId },
      data: { status },
    });
  }

  /**
   * Basic PII scrub for the pipeline-facing copy — emails and phone-
   * looking sequences replaced with a placeholder token. rawInput is
   * preserved untouched for the user's own review; anonymizedInput is
   * what would be sent to any external pipeline (not done by this
   * backend anymore per the "pipeline lives elsewhere" clarification,
   * but the field still exists on the schema and is still computed here
   * since it may be useful for the frontend's own real-time pipeline call
   * to reuse, or for this backend's own future needs).
   */
  private deriveInputMetadata(rawInput: string) {
    const emailRegex = /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/g;
    const phoneRegex = /\+?\d[\d\s().-]{7,}\d/g;

    const anonymizedInput = rawInput
      .replace(emailRegex, '[EMAIL]')
      .replace(phoneRegex, '[PHONE]');

    return {
      anonymizedInput,
      inputLength: rawInput.length,
      wordCount: rawInput.trim().split(/\s+/).filter(Boolean).length,
      hasMentions: /@\w+/.test(rawInput),
      hasTags: /#\w+/.test(rawInput),
      hasSymbols: /[^\w\s@#]/.test(rawInput),
      hasEmails: emailRegex.test(rawInput),
    };
  }

  /**
   * DB-dependent resolution step this backend is positioned to do that
   * the external pipeline likely can't: fuzzy-match a free-text task
   * reference against REAL tasks in the resolved workspace. Only runs
   * for the four actions that reference an existing task
   * (TASK_REFERENCE_ACTIONS). Looks for a `taskRef` key in
   * extractedEntities — the expected shape this backend assumes the
   * external pipeline produces for these action types (no spec exists
   * to confirm the exact key name; documented assumption, easy to adjust
   * if the real pipeline uses a different field name).
   */
  private async resolveFuzzyMatches(
    predictedAction: SnapActionType | undefined,
    extractedEntities: Record<string, unknown> | undefined,
    workspaceId: string | undefined,
  ): Promise<Array<{ id: string; title: string; score: number }> | undefined> {
    if (!predictedAction || !TASK_REFERENCE_ACTIONS.includes(predictedAction))
      return undefined;
    if (!workspaceId) return undefined;

    const taskRef = extractedEntities?.taskRef;
    if (typeof taskRef !== 'string' || taskRef.trim().length === 0)
      return undefined;

    const candidates = await this.prisma.task.findMany({
      where: { workspaceId, isArchived: false },
      select: { id: true, title: true },
      take: 200, // bounded — this is a heuristic convenience match, not an exhaustive search
    });

    const matches = fuzzyMatch(taskRef, candidates, (t) => t.title);
    if (matches.length === 0) return undefined;

    return matches.slice(0, 5).map((m) => ({
      id: m.candidate.id,
      title: m.candidate.title,
      score: Math.round(m.score * 100) / 100,
    }));
  }
}
