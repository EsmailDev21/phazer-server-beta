import {
  AUTOMATION_LIMITS as L,
  CONDITION_TABLE,
  TEMPLATE_VARIABLES,
} from './dsl';
import { treeLimits } from './dsl/rule.settings';
import { TASK_CAPTURE_PROPS } from './registry/checks';
import { SPECIAL_USERS, ACTIONS, TRIGGER_DESCRIPTORS } from './registry';

/**
 * Step 5.8. What a rule editor needs to know to offer the right choices, generated from the registry:
 * every trigger and action (with a valid example, whether it can run today, who may author it, whether
 * it may travel in a template), the condition fields and their operators, the placeholders and user
 * tokens, and the limits. It is NOT a JSON Schema: the contract is the validator, and `POST .../validate`
 * is how an editor checks a draft. Pure and static (it does not depend on the workspace).
 */
export interface Catalogue {
  version: 1;
  triggers: Array<{
    type: string;
    label: string;
    summary: string;
    /** false = fires with no task (SCHEDULE) */
    needsTask: boolean;
    /** can a rule using it be switched on today? */
    available: boolean;
    unavailableReason: string | null;
    example: Record<string, unknown>;
  }>;
  actions: Array<{
    type: string;
    label: string;
    summary: string;
    needsTask: boolean;
    needsProject: boolean;
    /** the lowest role the rule's author needs (declared in 5.8; enforced from 5.9) */
    ceiling: string;
    portable: boolean;
    /** actions the example needs before it (a WITH needs the Create action that captures its task) */
    exampleBefore: Array<Record<string, unknown>> | null;
    available: boolean;
    unavailableReason: string | null;
    example: Record<string, unknown>;
  }>;
  conditions: {
    /** field -> operator -> the kind of value it takes */
    fields: Record<string, Record<string, string>>;
    maxConditions: number;
  };
  placeholders: string[];
  /** what a Create action's `as` captures, and what `{{name.prop}}` can ask for */
  captures: { task: string[] };
  userTokens: string[];
  limits: {
    maxActions: number;
    /** how many IFs / FOR_EACHs may sit inside one another, combined (configurable: AUTOMATION_MAX_IF_DEPTH) */
    maxIfDepth: number;
    /** every action in a rule, branches included (configurable: AUTOMATION_MAX_TOTAL_ACTIONS) */
    maxTotalActions: number;
    /** tasks one FOR_EACH may select (configurable: AUTOMATION_MAX_FOR_EACH_ITEMS) */
    maxForEachItems: number;
    /** actions one run may execute, loops included (configurable: AUTOMATION_MAX_ACTIONS_PER_RUN) */
    maxActionsPerRun: number;
    maxCommentLength: number;
    maxSubtaskTitleLength: number;
    maxDescriptionLength: number;
    maxMessageLength: number;
    maxAutomationsPerWorkspace: number;
    maxEnabledPerWorkspace: number;
    maxChainDepth: number;
    /** rules calling rules (RUN_RULE): how deep (configurable: AUTOMATION_MAX_CALL_DEPTH) */
    maxCallDepth: number;
    /** the longest a WAIT may last, in days (configurable: AUTOMATION_MAX_WAIT_DAYS) */
    maxWaitDays: number;
    /** waits one workspace may have pending (configurable: AUTOMATION_MAX_PENDING_WAITS) */
    maxPendingWaits: number;
    /** people one NOTIFY may reach (configurable: AUTOMATION_MAX_NOTIFY_RECIPIENTS) */
    maxNotifyRecipients: number;
    /** loops started + tasks processed in one run (configurable: AUTOMATION_MAX_LOOP_STEPS_PER_RUN) */
    maxLoopSteps: number;
    maxRunsPerRulePerMinute: number;
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function buildCatalogue(): Catalogue {
  return {
    version: 1,
    triggers: TRIGGER_DESCRIPTORS.map((d) => ({
      type: d.type,
      label: d.label,
      summary: d.summary,
      needsTask: d.needs.task,
      available: d.unavailable === undefined,
      unavailableReason: d.unavailable ?? null,
      example: clone(d.example),
    })),
    actions: ACTIONS.map((d) => ({
      type: d.type,
      label: d.label,
      summary: d.summary,
      needsTask: d.needs.task,
      needsProject: d.needs.project,
      ceiling: d.ceiling,
      portable: d.portable,
      exampleBefore: d.exampleBefore ? clone(d.exampleBefore) : null,
      available: d.unavailable === undefined,
      unavailableReason: d.unavailable ?? null,
      example: clone(d.example),
    })),
    conditions: {
      fields: clone(CONDITION_TABLE),
      maxConditions: L.maxConditions,
    },
    placeholders: [...TEMPLATE_VARIABLES],
    captures: { task: [...TASK_CAPTURE_PROPS] },
    userTokens: [...SPECIAL_USERS],
    limits: {
      maxActions: L.maxActions,
      ...treeLimits(),
      maxCommentLength: L.maxCommentLength,
      maxSubtaskTitleLength: L.maxSubtaskTitleLength,
      maxDescriptionLength: L.maxDescriptionLength,
      maxMessageLength: L.maxMessageLength,
      maxAutomationsPerWorkspace: L.maxAutomationsPerWorkspace,
      maxEnabledPerWorkspace: L.maxEnabledPerWorkspace,
      maxChainDepth: L.maxChainDepth,
      maxRunsPerRulePerMinute: L.maxRunsPerRulePerMinute,
    },
  };
}

/**
 * The catalogue as a markdown reference (docs/design/automation-catalogue.md). GENERATED: a test fails
 * when the checked-in file differs, so every trigger and action has a docs line and the doc cannot drift.
 */
export function renderCatalogueMarkdown(c: Catalogue): string {
  const cell = (t: string) => t.replace(/\|/g, '\\|');
  const out: string[] = [
    '# Automation catalogue (generated)',
    '',
    '> GENERATED from the registry (`src/automations/registry`). Do not edit by hand: change a descriptor,',
    '> then regenerate with `UPDATE_GOLDEN=1 npx jest src/automations/registry/registry.spec.ts`.',
    '> The same data is served by `GET workspaces/:id/automations/catalogue`.',
    '',
    `## Triggers (${c.triggers.length})`,
    '',
    '| Type | Label | What it does | Runs today |',
    '|---|---|---|---|',
  ];
  for (const t of c.triggers)
    out.push(
      `| \`${t.type}\` | ${cell(t.label)} | ${cell(t.summary)}${t.needsTask ? '' : ' *(no task)*'} | ${t.available ? 'yes' : `no: ${cell(t.unavailableReason ?? '')}`} |`,
    );
  out.push(
    '',
    `## Actions (${c.actions.length})`,
    '',
    '| Type | Label | What it does | Needs | Author role | Template | Runs today |',
    '|---|---|---|---|---|---|---|',
  );
  for (const a of c.actions)
    out.push(
      `| \`${a.type}\` | ${cell(a.label)} | ${cell(a.summary)} | ${a.needsTask ? 'task' : 'no task'}${a.needsProject ? ' + project' : ''} | ${a.ceiling} | ${a.portable ? 'yes' : 'no'} | ${a.available ? 'yes' : `no: ${cell(a.unavailableReason ?? '')}`} |`,
    );
  out.push(
    '',
    '## Examples',
    '',
    'One valid instance of each, as the validator accepts it (ids are placeholders).',
    '',
  );
  for (const t of c.triggers)
    out.push(`- trigger \`${t.type}\`: \`${JSON.stringify(t.example)}\``);
  for (const a of c.actions)
    out.push(
      `- action \`${a.type}\`: \`${JSON.stringify(a.example)}\`${a.exampleBefore ? ` (after \`${JSON.stringify(a.exampleBefore)}\`)` : ''}`,
    );
  out.push(
    '',
    '## Placeholders and tokens',
    '',
    `Placeholders: ${c.placeholders.map((p) => `\`{{${p}}}\``).join(', ')}.`,
    `A Create action's \`as: "name"\` captures the task it made: ${c.captures.task.map((p) => `\`{{name.${p}}}\``).join(', ')}.`,
    `User tokens: ${c.userTokens.map((u) => `\`${u}\``).join(', ')}.`,
    '',
    '## Condition fields',
    '',
  );
  for (const [field, ops] of Object.entries(c.conditions.fields))
    out.push(
      `- \`${field}\`: ${Object.entries(ops)
        .map(([op, kind]) => `${op}${kind === 'none' ? '' : ` (${kind})`}`)
        .join(', ')}`,
    );
  out.push(
    '',
    `At most ${c.conditions.maxConditions} conditions per rule.`,
    '',
  );
  return out.join('\n');
}
