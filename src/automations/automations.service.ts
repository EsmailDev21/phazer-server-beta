import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Automation,
  AutomationOrigin,
  AutomationWaitStatus,
  Prisma,
} from '@prisma/client';
import { PermissionResolver } from '../access-control/access-control.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeName } from '../projects-tasks/planning/normalize-name';
import { buildCatalogue, Catalogue } from './catalogue';
import { WorkspaceContextLoader } from './dsl/workspace-context.loader';
import {
  AUTOMATION_LIMITS as L,
  RuleIssue,
  RuleV1,
  UnsupportedConstruct,
  checkRuleSemantics,
  collectCustomUserIds,
  collectReferences,
  validateRule,
} from './dsl';
import {
  CreateAutomationDto,
  ListAutomationsQueryDto,
  ListRunsQueryDto,
  UpdateAutomationDto,
  ValidateAutomationDto,
} from './dto/automation.dto';

export interface AutomationDto {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  ruleVersion: number;
  triggerType: string;
  trigger: Prisma.JsonValue;
  conditions: Prisma.JsonValue;
  actions: Prisma.JsonValue;
  /** Constructs this build cannot run yet; while there are any the rule cannot be enabled. */
  unsupported: Prisma.JsonValue;
  /** Why the runner switched this rule off (e.g. it ran too often). Cleared when someone turns it back on. */
  pausedReason: string | null;
  /** A raw imported rule not yet translated: shown, never run. */
  isRaw: boolean;
  createdVia: AutomationOrigin;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  /** Only on `get`: what is wrong with the rule NOW (a tag or status it names may have been deleted since). */
  problems?: RuleIssue[];
}

export interface ValidationReport {
  valid: boolean;
  issues: RuleIssue[];
  unsupported: UnsupportedConstruct[];
  /** valid, nothing unsupported: it could be switched on */
  enableable: boolean;
  triggerType: string | null;
}

const toDto = (a: Automation): AutomationDto => ({
  id: a.id,
  workspaceId: a.workspaceId,
  projectId: a.projectId,
  name: a.name,
  enabled: a.enabled,
  ruleVersion: a.ruleVersion,
  triggerType: a.triggerType,
  trigger: a.trigger,
  conditions: a.conditions,
  actions: a.actions,
  unsupported: a.unsupported,
  pausedReason: a.pausedReason,
  isRaw: a.ruleVersion === 0,
  createdVia: a.createdVia,
  createdById: a.createdById,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

/**
 * Step 5.1. Rules as data: stored, validated, listed. Nothing here RUNS a rule (5.2 does).
 *
 *  - writes need `manageAutomations` on the workspace (admins and owners) (the controller guards it); reads need workspace access
 *  - a rule is checked twice: structure (pure DSL) and against the workspace (do its ids exist?)
 *  - to be enabled a rule must be valid AND free of unsupported constructs; the database enforces that too
 *  - `projectId` is fixed at creation: statuses are per project, so moving a rule would silently break it
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly contextLoader: WorkspaceContextLoader,
  ) {}

  // ------------------------------------------------------------------ reads -------------------
  async list(
    workspaceId: string,
    userId: string,
    query: ListAutomationsQueryDto,
  ): Promise<AutomationDto[]> {
    await this.assertCanRead(workspaceId, userId);
    const rows = await this.prisma.automation.findMany({
      where: {
        workspaceId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
        ...(query.triggerType ? { triggerType: query.triggerType } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: L.maxAutomationsPerWorkspace,
    });
    return rows.map(toDto);
  }

  async get(
    workspaceId: string,
    id: string,
    userId: string,
  ): Promise<AutomationDto> {
    await this.assertCanRead(workspaceId, userId);
    const row = await this.load(workspaceId, id);
    const dto = toDto(row);
    if (row.ruleVersion === 1) {
      const rule = this.asRule(row);
      dto.problems = await this.semanticIssues(
        workspaceId,
        row.projectId,
        rule,
        row.id,
      );
    } else {
      dto.problems = [];
    }
    return dto;
  }

  async listRuns(
    workspaceId: string,
    id: string,
    userId: string,
    query: ListRunsQueryDto,
  ) {
    await this.assertCanRead(workspaceId, userId);
    await this.load(workspaceId, id);
    return this.prisma.automationRun.findMany({
      where: {
        automationId: id,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ ranAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 50,
      select: {
        id: true,
        taskId: true,
        eventId: true,
        status: true,
        error: true,
        depth: true,
        actionsRun: true,
        ranAt: true,
      },
    });
  }

  // ------------------------------------------------------------------ waits ------------------
  /** The waits a rule has in flight (waiting, or being carried on right now), soonest first. */
  async listWaits(workspaceId: string, automationId: string) {
    await this.assertRule(workspaceId, automationId);
    const where = {
      workspaceId,
      automationId,
      status: {
        in: [AutomationWaitStatus.PENDING, AutomationWaitStatus.RESUMING],
      },
    };
    const [data, total] = await Promise.all([
      this.prisma.automationWait.findMany({
        where,
        orderBy: { resumeAt: 'asc' },
        take: 100,
        select: {
          id: true,
          status: true,
          taskId: true,
          resumeAt: true,
          createdAt: true,
          runId: true,
        },
      }),
      this.prisma.automationWait.count({ where }),
    ]);
    return { data, total };
  }

  /** Cancels a wait that is still waiting; the rest of that run never happens. */
  async cancelWait(
    workspaceId: string,
    automationId: string,
    waitId: string,
  ): Promise<void> {
    await this.assertRule(workspaceId, automationId);
    const r = await this.prisma.automationWait.updateMany({
      where: {
        id: waitId,
        workspaceId,
        automationId,
        status: AutomationWaitStatus.PENDING,
      },
      data: {
        status: AutomationWaitStatus.CANCELLED,
        error: 'Cancelled by a person',
        resumedAt: new Date(),
      },
    });
    if (r.count !== 1)
      throw new NotFoundException('No such wait, or it is no longer waiting');
  }

  private async assertRule(workspaceId: string, id: string): Promise<void> {
    const row = await this.prisma.automation.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Automation not found');
  }

  // ------------------------------------------------------------------ catalogue ---------------
  /** What a rule editor may offer (step 5.8). Static: built from the registry, the same for every workspace. */
  catalogue(): Catalogue {
    return buildCatalogue();
  }

  // ------------------------------------------------------------------ dry run -----------------
  async validate(
    workspaceId: string,
    dto: ValidateAutomationDto,
  ): Promise<ValidationReport> {
    if (dto.projectId)
      await this.assertProjectInWorkspace(workspaceId, dto.projectId);
    return this.report(workspaceId, dto.projectId ?? null, dto);
  }

  // ------------------------------------------------------------------ writes ------------------
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateAutomationDto,
  ): Promise<AutomationDto> {
    const { name, nameKey } = normalizeName(dto.name, 'Name', L.maxNameLength);
    if (dto.projectId)
      await this.assertProjectInWorkspace(workspaceId, dto.projectId);
    const report = await this.report(workspaceId, dto.projectId ?? null, dto);
    this.assertValid(report);
    const wantsOn = dto.enabled === true;
    if (wantsOn) this.assertEnableable(report);
    const rule = this.parsed(dto);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`; // serialises the two caps below
        await this.assertRoom(tx, workspaceId, wantsOn);
        const created = await tx.automation.create({
          data: {
            workspaceId,
            projectId: dto.projectId ?? null,
            name,
            nameKey,
            enabled: wantsOn,
            ruleVersion: 1,
            triggerType: rule.triggerType,
            trigger: rule.rule.trigger as unknown as Prisma.InputJsonValue,
            conditions: rule.rule
              .conditions as unknown as Prisma.InputJsonValue,
            actions: rule.rule.actions as unknown as Prisma.InputJsonValue,
            unsupported: rule.unsupported as unknown as Prisma.InputJsonValue,
            pausedReason: null,
            createdVia: AutomationOrigin.USER,
            createdById: userId,
          },
        });
        return toDto(created);
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async update(
    workspaceId: string,
    id: string,
    userId: string,
    dto: UpdateAutomationDto,
  ): Promise<AutomationDto> {
    void userId;
    const current = await this.load(workspaceId, id);
    const touchesRule =
      dto.trigger !== undefined ||
      dto.conditions !== undefined ||
      dto.actions !== undefined;
    if (
      current.ruleVersion === 0 &&
      touchesRule === false &&
      dto.enabled !== true &&
      dto.name === undefined
    )
      return toDto(current);

    const data: Prisma.AutomationUpdateInput = {};
    if (dto.name !== undefined) {
      const n = normalizeName(dto.name, 'Name', L.maxNameLength);
      data.name = n.name;
      data.nameKey = n.nameKey;
    }

    // A raw rule becomes a real one the moment someone gives it a v1 definition; until then it stays inert.
    let report: ValidationReport | null = null;
    if (touchesRule || current.ruleVersion === 0) {
      const base = current.ruleVersion === 1 ? this.asRule(current) : null;
      const merged = {
        trigger: dto.trigger ?? base?.trigger,
        conditions: dto.conditions ?? base?.conditions ?? {},
        actions: dto.actions ?? base?.actions,
      };
      if (current.ruleVersion === 0 && !touchesRule) {
        if (dto.enabled === true)
          throw new ConflictException({
            code: 'NOT_ENABLEABLE',
            message:
              'This imported rule has not been translated yet and cannot be enabled',
          });
      } else {
        report = await this.report(
          workspaceId,
          current.projectId,
          merged,
          current.id,
        );
        this.assertValid(report);
        const parsed = this.parsed(merged);
        data.ruleVersion = 1;
        data.triggerType = parsed.triggerType;
        data.trigger = parsed.rule.trigger as unknown as Prisma.InputJsonValue;
        data.conditions = parsed.rule
          .conditions as unknown as Prisma.InputJsonValue;
        data.actions = parsed.rule.actions as unknown as Prisma.InputJsonValue;
        data.unsupported =
          parsed.unsupported as unknown as Prisma.InputJsonValue;
        // editing a rule that was on keeps it on only if it is still runnable
        if (
          dto.enabled === undefined &&
          current.enabled &&
          parsed.unsupported.length > 0
        )
          data.enabled = false;
      }
    }

    if (dto.enabled !== undefined) {
      if (dto.enabled) {
        const effective =
          report ?? (await this.reportOfStored(workspaceId, current));
        this.assertEnableable(effective);
        data.enabled = true;
        data.pausedReason = null;
      } else {
        data.enabled = false;
      }
    }
    if (Object.keys(data).length === 0) return toDto(current);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        if (data.enabled === true && !current.enabled)
          await this.assertRoom(tx, workspaceId, true, true);
        const row = await tx.automation.update({ where: { id }, data });
        return toDto(row);
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.load(workspaceId, id);
    await this.prisma.automation.delete({ where: { id } });
  }

  // ------------------------------------------------------------------ internals ---------------
  private async load(workspaceId: string, id: string): Promise<Automation> {
    const row = await this.prisma.automation.findUnique({ where: { id } });
    if (!row || row.workspaceId !== workspaceId)
      throw new NotFoundException('Automation not found');
    return row;
  }

  /** The three rule parts only (never name / projectId / enabled), already known to be structurally valid. */
  private parsed(input: {
    trigger?: unknown;
    conditions?: unknown;
    actions?: unknown;
  }) {
    const r = validateRule({
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
    });
    if (r.ok === false)
      throw new UnprocessableEntityException({
        code: 'AUTOMATION_INVALID',
        message: 'This rule is not valid',
        issues: r.issues,
      });
    return r;
  }

  private asRule(row: Automation): RuleV1 {
    return {
      trigger: row.trigger as unknown as RuleV1['trigger'],
      conditions: row.conditions as unknown as RuleV1['conditions'],
      actions: row.actions as unknown as RuleV1['actions'],
    };
  }

  private async assertCanRead(workspaceId: string, userId: string) {
    if (!(await this.resolver.hasWorkspaceLevelAccess(userId, workspaceId)))
      throw new ForbiddenException('You do not have access to this workspace');
  }

  private async assertProjectInWorkspace(
    workspaceId: string,
    projectId: string,
  ) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });
    if (!p)
      throw new BadRequestException('Project not found in this workspace');
  }

  private assertValid(report: ValidationReport) {
    if (!report.valid)
      throw new UnprocessableEntityException({
        code: 'AUTOMATION_INVALID',
        message: 'This rule is not valid',
        issues: report.issues,
      });
  }

  private assertEnableable(report: ValidationReport) {
    if (report.valid && report.unsupported.length === 0) return;
    throw new ConflictException({
      code: 'NOT_ENABLEABLE',
      message: report.valid
        ? 'This rule uses something that cannot run yet, so it cannot be switched on'
        : 'This rule is not valid',
      unsupported: report.unsupported,
      issues: report.issues,
    });
  }

  private async assertRoom(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    enabling: boolean,
    onlyEnabled = false,
  ) {
    if (!onlyEnabled) {
      const total = await tx.automation.count({ where: { workspaceId } });
      if (total >= L.maxAutomationsPerWorkspace) {
        throw new ConflictException({
          code: 'AUTOMATION_LIMIT',
          message: `A workspace can have at most ${L.maxAutomationsPerWorkspace} automations`,
        });
      }
    }
    if (enabling) {
      const on = await tx.automation.count({
        where: { workspaceId, enabled: true },
      });
      if (on >= L.maxEnabledPerWorkspace) {
        throw new ConflictException({
          code: 'AUTOMATION_ENABLED_LIMIT',
          message: `At most ${L.maxEnabledPerWorkspace} automations can be on at once in a workspace`,
        });
      }
    }
  }

  private mapWriteError(err: unknown): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException({
        code: 'NAME_TAKEN',
        message:
          'An automation with that name already exists in this workspace',
      });
    }
    return err;
  }

  /** Structure first; only a structurally valid rule is checked against the workspace. */
  private async report(
    workspaceId: string,
    projectId: string | null,
    input: { trigger?: unknown; conditions?: unknown; actions?: unknown },
    selfRuleId?: string,
  ): Promise<ValidationReport> {
    const structural = validateRule({
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
    });
    if (structural.ok === false)
      return {
        valid: false,
        issues: structural.issues,
        unsupported: [],
        enableable: false,
        triggerType: null,
      };
    const issues = await this.semanticIssues(
      workspaceId,
      projectId,
      structural.rule,
      selfRuleId,
    );
    const valid = issues.length === 0;
    return {
      valid,
      issues,
      unsupported: structural.unsupported,
      enableable: valid && structural.unsupported.length === 0,
      triggerType: structural.triggerType,
    };
  }

  private async reportOfStored(
    workspaceId: string,
    row: Automation,
  ): Promise<ValidationReport> {
    if (row.ruleVersion === 0) {
      return {
        valid: false,
        issues: [
          {
            code: 'RAW_RULE',
            path: '',
            message: 'An imported rule has not been translated yet',
          },
        ],
        unsupported: [],
        enableable: false,
        triggerType: null,
      };
    }
    return this.report(workspaceId, row.projectId, this.asRule(row), row.id);
  }

  private async semanticIssues(
    workspaceId: string,
    projectId: string | null,
    rule: RuleV1,
    selfRuleId?: string,
  ): Promise<RuleIssue[]> {
    const ctx = await this.contextLoader.load(
      workspaceId,
      collectReferences(rule),
      (typeOf) => collectCustomUserIds(rule, typeOf),
    );
    return checkRuleSemantics(rule, projectId, { ...ctx, selfRuleId });
  }
}
