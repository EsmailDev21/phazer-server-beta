import { Injectable } from '@nestjs/common';
import { ImportIssueSeverity as Sev } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitize } from '../../templates/sanitize';
import { TemplatesService } from '../../templates/templates.service';
import { validateBundle } from '../canonical';
import { ImportFailure } from '../executor/import-errors';
import { ImportIssueService, NewImportIssue } from '../import-issue.service';
import { ImportAdapterContext, ImportCapableAdapter } from '../import-adapter';
import { ImportOptions, ImportSelection } from '../imports.types';
import { MappingContext, MappingConfigV1, MappedPage, applyMapping, resolve } from '../mapping';
import { MappingService } from '../mapping/mapping.service';
import { ANONYMOUS_USER, ImportTemplateError, ImportTemplateReport, SRC_USER_PREFIX, buildRawFromImport } from './import-template.builder';

/** Pages one template build may read: far above what fits in a template (5,000 items), so only a runaway provider can reach it. */
const MAX_PAGES = 2000;

export interface TemplateRunInput {
  job: { id: string; accountId: string; createdById: string; inventory: unknown; mappingConfig: unknown };
  adapter: ImportCapableAdapter;
  selection: ImportSelection;
  options: ImportOptions;
  ctx: (accessToken: string) => ImportAdapterContext;
  accessToken: () => Promise<string>;
  shouldStop: () => Promise<boolean>;
}

export interface TemplateRunResult {
  result: Record<string, unknown>;
  /** True when something was left out or needs a look: the job then ends COMPLETED_WITH_WARNINGS. */
  warnings: boolean;
  tasks: number;
}

/**
 * Step 4.9 (import-as-template). Reads the provider exactly like an import, maps it with a TEMPLATE resolution (every entity is
 * created, every source person is a placeholder), builds a RawBlueprint (`buildRawFromImport`), runs it through the ONE sanitizer
 * (3.4: secrets, personal data, dates -> offsets, people -> roles) and stores it through the ONE template service (3.5) as a
 * PRIVATE template. Nothing is written to the workspace.
 *
 * Not resumable by checkpoint (the pages live in memory): a transient failure restarts the read from the first page.
 * A template is capped at 5,000 items, so a build is at most a few dozen pages.
 */
@Injectable()
export class ImportTemplateRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mapping: MappingService,
    private readonly templates: TemplatesService,
    private readonly issues: ImportIssueService,
  ) {}

  /** Mapping for a template: nobody and nothing exists "in the destination", so everything is created and every person is a placeholder. */
  private resolution(inventoryRaw: unknown, importerUserId: string) {
    const inventory = this.mapping.inventoryOf({ inventory: inventoryRaw } as never);
    if (!inventory) throw new ImportFailure('The import was never previewed with a structure to map. Preview it again.');
    const members = inventory.users.filter((u) => !u.isBot).map((u) => ({ userId: `${SRC_USER_PREFIX}${u.externalId}`, name: u.name, email: null, emailVerified: false }));
    const ctx: MappingContext = { importerUserId, members, identityLinks: [], issueTypes: [], customFields: [] };
    const config: MappingConfigV1 = {
      version: 1,
      matchByEmail: false,
      users: inventory.users.filter((u) => !u.isBot).map((u) => ({ externalId: u.externalId, target: { kind: 'user' as const, userId: `${SRC_USER_PREFIX}${u.externalId}` } })),
    };
    return resolve(inventory, ctx, config).resolved;
  }

  async run(input: TemplateRunInput): Promise<TemplateRunResult | 'STOPPED'> {
    const { job, adapter, selection, options } = input;
    const target = options.template;
    if (!target?.name) throw new ImportFailure('The template has no name.');
    const resolved = this.resolution(job.inventory, job.createdById);

    const pages: MappedPage[] = [];
    let cursor: unknown = null;
    for (let n = 0; n < MAX_PAGES; n++) {
      if (await input.shouldStop()) return 'STOPPED';
      const accessToken = await input.accessToken();
      const fetched = await adapter.fetchBundle({ ctx: input.ctx(accessToken), selection, options, cursor });
      const v = validateBundle(fetched.bundle);
      if ('fatal' in v) {
        await this.issues.record(job.id, v.issues as NewImportIssue[]);
        throw new ImportFailure(`The provider's data could not be used (${v.fatal.code}): ${v.fatal.message}`);
      }
      const mapped = applyMapping(v.bundle, resolved);
      // the same reports an import gives, once per run (a restart reads from the start: its own, fresh job attempt)
      await this.issues.record(job.id, [...(v.issues as NewImportIssue[]), ...mapped.issues.map((i) => ({ severity: i.severity, code: i.code, externalRef: i.externalRef, message: i.message }))]);
      pages.push(mapped);
      if (fetched.next === null) break;
      cursor = fetched.next;
      if (n === MAX_PAGES - 1) throw new ImportFailure('The provider returned more pages than a template can hold.');
    }

    let built;
    try {
      built = buildRawFromImport(pages, { name: target.name, description: target.description, category: target.category, includeComments: target.includeComments === true, sourceId: job.id });
    } catch (e) {
      if (e instanceof ImportTemplateError) throw new ImportFailure(e.message);
      throw e;
    }
    const { raw, report } = built;
    await this.issues.record(job.id, this.reportIssues(report, target.includeComments === true));

    const s = sanitize(raw, { onSecret: target.onSecret ?? 'block' });
    if (s.ok === false) {
      throw new ImportFailure(
        s.reason === 'SECRETS_FOUND'
          ? 'The import contains what looks like a credential, so no template was made. Start again choosing to redact it, or remove it at the source.'
          : `The import cannot be turned into a valid template: ${s.issues.slice(0, 3).map((i) => i.message).join('; ')}`,
      );
    }

    const template = await this.templates.createFromBlueprint(job.accountId, job.createdById, {
      blueprint: s.blueprint as unknown as Record<string, unknown>,
      name: target.name,
      description: target.description,
      category: target.category,
      visibility: 'PRIVATE',
    } as never);

    const findings = Object.values(s.report.summary).reduce((a, b) => a + (b ?? 0), 0);
    const left = report.tasks.archivedSkipped + report.tasks.orphanedParent + report.tasks.parentCycle + report.dependencies.droppedOutsideProject + report.dependencies.droppedMissingEnd;
    return {
      tasks: report.tasks.included,
      warnings: left > 0 || findings > 0 || s.warnings.length > 0,
      result: {
        kind: 'TEMPLATE',
        templateId: (template as { id: string }).id,
        name: target.name,
        build: report,
        sanitize: { summary: s.report.summary, datesConverted: s.report.datesConverted, rolesCreated: s.report.roles.created, anchor: s.report.anchor },
      },
    };
  }

  private reportIssues(r: ImportTemplateReport, comments: boolean): NewImportIssue[] {
    const out: NewImportIssue[] = [];
    const add = (severity: Sev, code: string, message: string) => out.push({ severity, code, externalRef: null, message });
    if (r.attachmentsDropped) add(Sev.INFO, 'TEMPLATE_ATTACHMENTS_DROPPED', `${r.attachmentsDropped} file(s) are not part of a template (a template carries no files from an import).`);
    if (r.historyDropped) add(Sev.INFO, 'TEMPLATE_HISTORY_DROPPED', `${r.historyDropped} history entries are not part of a template.`);
    if (!comments) add(Sev.INFO, 'TEMPLATE_COMMENTS_OFF', 'Comments were not included in the template.');
    if (r.tasks.archivedSkipped) add(Sev.WARN, 'TEMPLATE_ARCHIVED_SKIPPED', `${r.tasks.archivedSkipped} archived task(s) were left out.`);
    if (r.tasks.orphanedParent) add(Sev.WARN, 'TEMPLATE_PARENT_MISSING', `${r.tasks.orphanedParent} task(s) have a parent that is not in the template (another project, or not imported); they became top-level tasks.`);
    if (r.tasks.parentCycle) add(Sev.WARN, 'TEMPLATE_PARENT_CYCLE', `${r.tasks.parentCycle} task(s) were part of a parent loop; the loop was broken.`);
    if (r.tasks.flattenedTooDeep) add(Sev.INFO, 'TEMPLATE_TOO_DEEP', `${r.tasks.flattenedTooDeep} task(s) were nested deeper than a template allows and were moved up a level.`);
    if (r.dependencies.droppedOutsideProject) add(Sev.WARN, 'TEMPLATE_DEPENDENCY_OUTSIDE', `${r.dependencies.droppedOutsideProject} dependency(ies) between different projects were left out (a template keeps dependencies inside one project).`);
    if (r.dependencies.droppedMissingEnd) add(Sev.WARN, 'TEMPLATE_DEPENDENCY_MISSING', `${r.dependencies.droppedMissingEnd} dependency(ies) point at a task that is not in the template.`);
    if (r.workflowCompleted.length) add(Sev.INFO, 'TEMPLATE_WORKFLOW_COMPLETED', `A template workflow needs a To Do, an In Progress and a Done status; added: ${r.workflowCompleted.join(', ')}.`);
    if (r.comments.droppedByLimit) add(Sev.INFO, 'TEMPLATE_COMMENTS_LIMIT', `${r.comments.droppedByLimit} comment(s) beyond the per-task limit were left out.`);
    return out;
  }
}

void ANONYMOUS_USER;
