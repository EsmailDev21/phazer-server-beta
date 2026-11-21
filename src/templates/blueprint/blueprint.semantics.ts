import { DependencyType, FieldType, TaskStatus } from '@prisma/client';
import { REQUIRED_CATEGORIES } from '../../projects-tasks/workflow/workflow-rules';
import {
  checkExpr,
  parseTemplateText,
  VariableTypes,
  variablesRead,
} from './blueprint.expressions';
import { IssueList, pointer } from './blueprint.issues';
import { BLUEPRINT_LIMITS as L } from './blueprint.limits';
import { collapseName, foldName } from './blueprint.names';
import {
  EntityModel,
  classifyItem,
  evaluateRuleItem,
  evaluateViewItem,
} from '../portable';
import { modelFromBlueprint } from '../portable/portable.from-blueprint';
import {
  BlueprintCustomField,
  BlueprintTask,
  BlueprintV1,
  VariableType,
} from './blueprint.types';

/**
 * Step 3.1. Everything about a blueprint the JSON Schema cannot say: references resolve, names
 * and keys are unique the way the database will compare them, placeholders only where allowed
 * and only to declared variables, workflows satisfy ADR-0006, dependencies are acyclic,
 * dates/offsets are ordered, values match their field types.
 *
 * Runs ONLY on a document that already passed the schema, so shapes can be trusted here.
 * Pure: no I/O, no clock, no randomness.
 */

interface NodeInfo {
  kind: 'project' | 'task' | 'iteration';
  path: string;
  /** For tasks and project-scoped iterations: the owning project's nodeKey. */
  project?: string;
}

const REQUIRES_OPTIONS = new Set<FieldType>([
  FieldType.SELECT,
  FieldType.MULTI_SELECT,
]);

export function checkSemantics(
  bp: BlueprintV1,
  issues: IssueList,
  warnings: IssueList,
): void {
  const varTypes = new Map<string, VariableType>();
  const usedVars = new Set<string>();
  const usedRoles = new Set<string>();
  const usedAssets = new Set<string>();
  const nodes = new Map<string, NodeInfo>();
  // step 5.5: what the template itself defines, for checking the automations and views it carries
  let model: EntityModel | undefined;
  const portableModel = (): EntityModel => (model ??= modelFromBlueprint(bp));

  // ------------------------------------------------------------------ text -----------
  const checkText = (
    path: string,
    value: string,
    opts: { templated: boolean; singleLine?: boolean },
  ): void => {
    if (value.trim() === '') {
      issues.add('NAME_INVALID', path, 'Must not be blank');
      return;
    }
    if (opts.singleLine && /[\r\n\t]/.test(value)) {
      issues.add('NAME_INVALID', path, 'Must be a single line');
    }
    if (!value.includes('{{')) return;
    const parsed = parseTemplateText(value);
    if (!opts.templated) {
      // Plain leaves are never evaluated. A well-formed placeholder there means the author
      // expected substitution that will not happen - say so instead of shipping "{{x}}".
      if (
        parsed.ok === true &&
        parsed.segments.some((s) => s.type === 'expr')
      ) {
        issues.add(
          'PLACEHOLDER_NOT_ALLOWED',
          path,
          'Placeholders are not allowed in this field (it is used as an identifier or label)',
        );
      }
      return;
    }
    if (parsed.ok === false) {
      issues.add(
        'PLACEHOLDER_SYNTAX',
        path,
        `${parsed.message} (at character ${parsed.offset})`,
      );
      return;
    }
    for (const seg of parsed.segments) {
      if (seg.type !== 'expr') continue;
      const problem = checkExpr(seg.expr, varTypes as VariableTypes);
      if (problem) {
        issues.add('PLACEHOLDER_INVALID', path, `${seg.raw}: ${problem}`);
      }
      for (const name of variablesRead(seg.expr)) usedVars.add(name);
    }
  };
  const plain = (
    path: string,
    value: string | undefined,
    singleLine = true,
  ) => {
    if (value !== undefined)
      checkText(path, value, { templated: false, singleLine });
  };
  const templated = (
    path: string,
    value: string | undefined,
    singleLine = false,
  ) => {
    if (value !== undefined)
      checkText(path, value, { templated: true, singleLine });
  };

  // ------------------------------------------------------------------ kind -----------
  if (bp.meta.kind === 'PROJECT' && bp.projects.length !== 1) {
    issues.add(
      'KIND_MISMATCH',
      '/projects',
      `A PROJECT template holds exactly one project (found ${bp.projects.length})`,
    );
  }
  if (bp.meta.kind === 'PROJECT' && bp.workspace) {
    for (const f of ['name', 'key', 'icon', 'description'] as const) {
      if (bp.workspace[f] !== undefined) {
        issues.add(
          'KIND_MISMATCH',
          pointer('/workspace', f),
          'A PROJECT template cannot describe a workspace',
        );
      }
    }
  }
  plain('/meta/name', bp.meta.name);
  plain('/meta/description', bp.meta.description, false);

  // ------------------------------------------------------------- variables ----------
  const seenVars = new Set<string>();
  (bp.variables ?? []).forEach((v, i) => {
    const p = pointer('/variables', i);
    if (seenVars.has(v.key.toLowerCase())) {
      issues.add(
        'DUPLICATE',
        pointer(p, 'key'),
        `Variable "${v.key}" is declared twice (names are compared ignoring case)`,
      );
    } else {
      seenVars.add(v.key.toLowerCase());
      varTypes.set(v.key, v.type);
    }
    plain(pointer(p, 'label'), v.label);

    if (v.type === 'SELECT') {
      if (!v.options) {
        issues.add(
          'VARIABLE_INVALID',
          pointer(p, 'options'),
          'A SELECT variable needs options',
        );
      }
    } else if (v.options !== undefined) {
      issues.add(
        'VARIABLE_INVALID',
        pointer(p, 'options'),
        'Only SELECT variables have options',
      );
    }
    if (v.options) {
      const seen = new Set<string>();
      v.options.forEach((o, oi) => {
        const folded = foldName(o);
        if (folded === '') {
          issues.add(
            'VARIABLE_INVALID',
            pointer(p, 'options', oi),
            'An option must not be blank',
          );
        } else if (seen.has(folded)) {
          issues.add(
            'DUPLICATE',
            pointer(p, 'options', oi),
            `Option "${o}" is listed twice`,
          );
        }
        seen.add(folded);
      });
    }
    if (v.default !== undefined) {
      const bad = defaultProblem(v.type, v.default, v.options);
      if (bad) issues.add('VARIABLE_INVALID', pointer(p, 'default'), bad);
    }
  });

  if (bp.dateAnchor?.variable !== undefined) {
    const t = varTypes.get(bp.dateAnchor.variable);
    if (t === undefined) {
      issues.add(
        'ANCHOR_INVALID',
        '/dateAnchor/variable',
        `Unknown variable "${bp.dateAnchor.variable}"`,
      );
    } else if (t !== 'DATE') {
      issues.add(
        'ANCHOR_INVALID',
        '/dateAnchor/variable',
        `The anchor must be a DATE variable, "${bp.dateAnchor.variable}" is ${t}`,
      );
    }
    usedVars.add(bp.dateAnchor.variable);
  }

  // ----------------------------------------------------------------- roles ----------
  const roleKeys = new Set<string>();
  (bp.roles ?? []).forEach((r, i) => {
    const p = pointer('/roles', i);
    if (roleKeys.has(r.key))
      issues.add(
        'DUPLICATE',
        pointer(p, 'key'),
        `Role "${r.key}" is declared twice`,
      );
    roleKeys.add(r.key);
    plain(pointer(p, 'label'), r.label);
  });

  // ----------------------------------------------------------------- assets ---------
  const assetKeys = new Set<string>();
  let assetBytes = 0;
  (bp.assets ?? []).forEach((a, i) => {
    const p = pointer('/assets', i);
    if (assetKeys.has(a.key))
      issues.add(
        'DUPLICATE',
        pointer(p, 'key'),
        `Asset "${a.key}" is declared twice`,
      );
    assetKeys.add(a.key);
    assetBytes += a.sizeBytes;
    if (/[\\/]/.test(a.fileName) || a.fileName === '.' || a.fileName === '..') {
      issues.add(
        'ASSET_INVALID',
        pointer(p, 'fileName'),
        'A file name must not contain a path',
      );
    }
    plain(pointer(p, 'fileName'), a.fileName);
  });
  if (assetBytes > L.maxTotalAssetBytes) {
    issues.add(
      'ASSETS_TOO_LARGE',
      '/assets',
      `Assets total ${assetBytes} bytes; the limit is ${L.maxTotalAssetBytes}`,
    );
  }

  // ------------------------------------------------------------- workspace ----------
  const ws = bp.workspace ?? {};
  templated('/workspace/name', ws.name, true);
  templated('/workspace/description', ws.description);
  plain('/workspace/icon', ws.icon);

  const tagKeys = new Set<string>();
  (ws.tags ?? []).forEach((t, i) => {
    const p = pointer('/workspace/tags', i, 'name');
    plain(p, t.name);
    const folded = foldName(t.name);
    if (collapseName(t.name).length > L.tagName) {
      issues.add('NAME_INVALID', p, `At most ${L.tagName} characters`);
    }
    if (folded && tagKeys.has(folded))
      issues.add(
        'DUPLICATE',
        p,
        `Tag "${t.name}" is listed twice (names are compared ignoring case and spacing)`,
      );
    tagKeys.add(folded);
  });

  const fields = new Map<string, BlueprintCustomField>();
  (ws.customFields ?? []).forEach((f, i) => {
    const p = pointer('/workspace/customFields', i);
    const lk = f.key.toLowerCase();
    if (fields.has(lk)) {
      issues.add(
        'DUPLICATE',
        pointer(p, 'key'),
        `Custom field "${f.key}" is declared twice (keys are compared ignoring case)`,
      );
    } else {
      fields.set(lk, f);
    }
    plain(pointer(p, 'name'), f.name);
    if (REQUIRES_OPTIONS.has(f.dataType)) {
      if (!f.options)
        issues.add(
          'FIELD_INVALID',
          pointer(p, 'options'),
          `options is required for ${f.dataType} fields`,
        );
    } else if (f.options !== undefined) {
      issues.add(
        'FIELD_INVALID',
        pointer(p, 'options'),
        'options is only valid for SELECT / MULTI_SELECT fields',
      );
    }
    const seen = new Set<string>();
    (f.options ?? []).forEach((o, oi) => {
      if (o.trim() === '')
        issues.add(
          'FIELD_INVALID',
          pointer(p, 'options', oi),
          'An option must not be blank',
        );
      if (seen.has(o))
        issues.add(
          'DUPLICATE',
          pointer(p, 'options', oi),
          `Option "${o}" is listed twice`,
        );
      seen.add(o);
    });
  });

  const issueTypeKeys = new Set<string>();
  (ws.issueTypes ?? []).forEach((t, i) => {
    const p = pointer('/workspace/issueTypes', i, 'name');
    plain(p, t.name);
    plain(pointer('/workspace/issueTypes', i, 'icon'), t.icon);
    const folded = foldName(t.name);
    if (folded && issueTypeKeys.has(folded))
      issues.add('DUPLICATE', p, `Issue type "${t.name}" is listed twice`);
    issueTypeKeys.add(folded);
  });

  // ------------------------------------------------- node namespace: projects -------
  const register = (key: string, info: NodeInfo, at: string): void => {
    const first = nodes.get(key);
    if (first) {
      issues.add(
        'DUPLICATE',
        at,
        `nodeKey "${key}" is already used at ${first.path} (one namespace for projects, tasks and iterations)`,
      );
      return;
    }
    nodes.set(key, info);
  };
  bp.projects.forEach((proj, pi) => {
    const p = pointer('/projects', pi, 'nodeKey');
    register(proj.nodeKey, { kind: 'project', path: p }, p);
  });

  // ------------------------------------------------------------- iterations ---------
  (ws.iterations ?? []).forEach((it, i) => {
    const p = pointer('/workspace/iterations', i);
    let project: string | undefined;
    if (it.project !== undefined) {
      const target = nodes.get(it.project);
      if (!target || target.kind !== 'project') {
        issues.add(
          'UNKNOWN_REF',
          pointer(p, 'project'),
          `"${it.project}" is not a project nodeKey`,
        );
      } else {
        project = it.project;
      }
    }
    register(
      it.nodeKey,
      { kind: 'iteration', path: pointer(p, 'nodeKey'), project },
      pointer(p, 'nodeKey'),
    );
    templated(pointer(p, 'name'), it.name, true);
    templated(pointer(p, 'goal'), it.goal);
    if (
      it.startOffsetDays !== undefined &&
      it.endOffsetDays !== undefined &&
      it.startOffsetDays > it.endOffsetDays
    ) {
      issues.add(
        'DATE_RANGE',
        p,
        'startOffsetDays must not be after endOffsetDays',
      );
    }
  });

  // --------------------------------------------------------------- projects ---------
  const pendingDeps: Array<() => void> = [];
  bp.projects.forEach((proj, pi) => {
    const pp = pointer('/projects', pi);
    templated(pointer(pp, 'name'), proj.name, true);
    templated(pointer(pp, 'description'), proj.description);

    const statusKeys = proj.workflow
      ? checkWorkflow(proj.workflow, pointer(pp, 'workflow'), issues, plain)
      : null;

    const taskKeys = new Set<string>();
    const walk = (
      tasks: BlueprintTask[],
      base: string,
      level: number,
    ): void => {
      tasks.forEach((t, ti) => {
        const tp = pointer(base, ti);
        register(
          t.nodeKey,
          { kind: 'task', path: pointer(tp, 'nodeKey'), project: proj.nodeKey },
          pointer(tp, 'nodeKey'),
        );
        taskKeys.add(t.nodeKey);
        checkTask(t, tp, proj.nodeKey, statusKeys);
        if (t.children && t.children.length > 0) {
          if (level >= L.maxTaskLevels) {
            issues.add(
              'TASK_TOO_DEEP',
              pointer(tp, 'children'),
              `Subtasks can go ${L.maxTaskLevels} levels deep (a task, its subtasks, their subtasks)`,
            );
          } else {
            walk(t.children, pointer(tp, 'children'), level + 1);
          }
        }
      });
    };

    const checkTask = (
      t: BlueprintTask,
      tp: string,
      projectKey: string,
      statuses: Set<string> | null,
    ): void => {
      templated(pointer(tp, 'title'), t.title, true);
      templated(pointer(tp, 'description'), t.description);

      if (
        t.issueType !== undefined &&
        !issueTypeKeys.has(foldName(t.issueType))
      ) {
        issues.add(
          'UNKNOWN_REF',
          pointer(tp, 'issueType'),
          `Issue type "${t.issueType}" is not in workspace.issueTypes`,
        );
      }
      if (t.status !== undefined) {
        if (!statuses) {
          issues.add(
            'UNKNOWN_REF',
            pointer(tp, 'status'),
            'A task can only name a status when its project defines a workflow',
          );
        } else if (!statuses.has(t.status)) {
          issues.add(
            'UNKNOWN_REF',
            pointer(tp, 'status'),
            `Status "${t.status}" is not in this project's workflow`,
          );
        }
      }
      const seenTags = new Set<string>();
      (t.tags ?? []).forEach((name, i) => {
        const folded = foldName(name);
        if (!tagKeys.has(folded)) {
          issues.add(
            'UNKNOWN_REF',
            pointer(tp, 'tags', i),
            `Tag "${name}" is not in workspace.tags`,
          );
        }
        if (seenTags.has(folded))
          issues.add(
            'DUPLICATE',
            pointer(tp, 'tags', i),
            `Tag "${name}" is listed twice on this task`,
          );
        seenTags.add(folded);
      });
      const seenRoles = new Set<string>();
      (t.assigneeRoles ?? []).forEach((r, i) => {
        if (!roleKeys.has(r))
          issues.add(
            'UNKNOWN_REF',
            pointer(tp, 'assigneeRoles', i),
            `Role "${r}" is not declared in roles`,
          );
        if (seenRoles.has(r))
          issues.add(
            'DUPLICATE',
            pointer(tp, 'assigneeRoles', i),
            `Role "${r}" is listed twice on this task`,
          );
        seenRoles.add(r);
        usedRoles.add(r);
      });
      if (
        t.startOffsetDays !== undefined &&
        t.dueOffsetDays !== undefined &&
        t.startOffsetDays > t.dueOffsetDays
      ) {
        issues.add(
          'DATE_RANGE',
          tp,
          'startOffsetDays must not be after dueOffsetDays',
        );
      }
      if (t.iteration !== undefined) {
        const target = nodes.get(t.iteration);
        if (!target || target.kind !== 'iteration') {
          issues.add(
            'UNKNOWN_REF',
            pointer(tp, 'iteration'),
            `"${t.iteration}" is not an iteration nodeKey`,
          );
        } else if (
          target.project !== undefined &&
          target.project !== projectKey
        ) {
          issues.add(
            'ITERATION_SCOPE',
            pointer(tp, 'iteration'),
            `Iteration "${t.iteration}" belongs to another project`,
          );
        }
      }
      (t.comments ?? []).forEach((c, i) => {
        templated(pointer(tp, 'comments', i, 'body'), c.body);
        if (c.authorRole !== undefined) {
          if (!roleKeys.has(c.authorRole)) {
            issues.add(
              'UNKNOWN_REF',
              pointer(tp, 'comments', i, 'authorRole'),
              `Role "${c.authorRole}" is not declared in roles`,
            );
          }
          usedRoles.add(c.authorRole);
        }
      });
      const seenAssets = new Set<string>();
      (t.attachments ?? []).forEach((a, i) => {
        if (!assetKeys.has(a))
          issues.add(
            'UNKNOWN_REF',
            pointer(tp, 'attachments', i),
            `Asset "${a}" is not declared in assets`,
          );
        if (seenAssets.has(a))
          issues.add(
            'DUPLICATE',
            pointer(tp, 'attachments', i),
            `Asset "${a}" is attached twice to this task`,
          );
        seenAssets.add(a);
        usedAssets.add(a);
      });
      if (t.customValues) {
        for (const [key, value] of Object.entries(t.customValues)) {
          const vp = pointer(tp, 'customValues', key);
          const field = fields.get(key.toLowerCase());
          if (!field) {
            issues.add(
              'UNKNOWN_REF',
              vp,
              `Custom field "${key}" is not in workspace.customFields`,
            );
            continue;
          }
          const bad = customValueProblem(field, value);
          if (bad) issues.add('VALUE_INVALID', vp, bad);
          else if (field.dataType === FieldType.TEXT)
            plain(vp, value as string, false);
        }
      }
    };

    walk(proj.tasks, pointer(pp, 'tasks'), 1);
    // deferred: "a task of another project" is only knowable once every project is walked
    pendingDeps.push(() =>
      checkDependencies(
        proj.dependencies ?? [],
        pointer(pp, 'dependencies'),
        taskKeys,
        nodes,
        proj.nodeKey,
        issues,
      ),
    );

    for (const [kind, items, max] of [
      ['automations', proj.automations, L.maxOpaqueItemBytes],
      ['views', proj.views, L.maxOpaqueItemBytes],
    ] as const) {
      const names = new Set<string>();
      (items ?? []).forEach((item, i) => {
        const ip = pointer(pp, kind, i);
        if (Buffer.byteLength(JSON.stringify(item), 'utf8') > max) {
          issues.add('OPAQUE_TOO_LARGE', ip, `At most ${max} bytes each`);
          return;
        }
        // step 5.5: an item that says what it is (kind rule.v1 / view.v1) must hold up; anything else stays opaque
        const cls = classifyItem(item);
        if (cls === 'raw') return;
        const out =
          cls === 'rule'
            ? evaluateRuleItem(item, portableModel(), proj.nodeKey)
            : evaluateViewItem(item, portableModel(), proj.nodeKey);
        if (out.ok === false) {
          for (const issue of out.issues)
            issues.add(
              cls === 'rule' ? 'AUTOMATION_INVALID' : 'VIEW_INVALID',
              `${ip}${issue.path}`,
              `${issue.code}: ${issue.message}`,
            );
          return;
        }
        const folded = foldName(out.name);
        if (names.has(folded))
          issues.add(
            'DUPLICATE',
            pointer(ip, 'name'),
            `Two ${kind} in this project are named "${out.name}"`,
          );
        names.add(folded);
      });
    }
  });

  pendingDeps.forEach((run) => run());

  // ---------------------------------------------------------------- modules ---------
  const moduleKeys = new Set<string>();
  (bp.modules ?? []).forEach((m, i) => {
    const p = pointer('/modules', i);
    if (moduleKeys.has(m.key))
      issues.add(
        'DUPLICATE',
        pointer(p, 'key'),
        `Module "${m.key}" is declared twice`,
      );
    moduleKeys.add(m.key);
    plain(pointer(p, 'label'), m.label);
    const seen = new Set<string>();
    m.includes.forEach((k, ki) => {
      const info = nodes.get(k);
      if (!info) {
        issues.add(
          'UNKNOWN_REF',
          pointer(p, 'includes', ki),
          `"${k}" is not a nodeKey in this blueprint`,
        );
      } else if (info.kind === 'iteration') {
        issues.add(
          'MODULE_INVALID',
          pointer(p, 'includes', ki),
          'A module can include projects and tasks, not iterations',
        );
      }
      if (seen.has(k))
        issues.add(
          'DUPLICATE',
          pointer(p, 'includes', ki),
          `"${k}" is included twice`,
        );
      seen.add(k);
    });
  });

  // --------------------------------------------------------------- warnings ---------
  (bp.variables ?? []).forEach((v, i) => {
    if (!usedVars.has(v.key))
      warnings.add(
        'UNUSED_VARIABLE',
        pointer('/variables', i),
        `Variable "${v.key}" is never used`,
      );
  });
  (bp.roles ?? []).forEach((r, i) => {
    if (!usedRoles.has(r.key))
      warnings.add(
        'UNUSED_ROLE',
        pointer('/roles', i),
        `Role "${r.key}" is never used`,
      );
  });
  (bp.assets ?? []).forEach((a, i) => {
    if (!usedAssets.has(a.key))
      warnings.add(
        'UNUSED_ASSET',
        pointer('/assets', i),
        `Asset "${a.key}" is never attached`,
      );
  });
}

// =================================================================================================

function defaultProblem(
  type: VariableType,
  value: string | number | boolean,
  options?: string[],
): string | null {
  switch (type) {
    case 'TEXT':
      if (typeof value !== 'string') return 'A TEXT default must be text';
      if (value.length > L.variableTextDefault)
        return `At most ${L.variableTextDefault} characters`;
      return null;
    case 'DATE':
      if (typeof value !== 'string' || !isCalendarDate(value))
        return 'A DATE default must be a real date, "YYYY-MM-DD"';
      return null;
    case 'NUMBER':
      return typeof value === 'number'
        ? null
        : 'A NUMBER default must be a number';
    case 'BOOLEAN':
      return typeof value === 'boolean'
        ? null
        : 'A BOOLEAN default must be true or false';
    case 'SELECT':
      if (typeof value !== 'string' || !options?.includes(value))
        return 'A SELECT default must be one of its options';
      return null;
  }
}

export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function customValueProblem(
  field: BlueprintCustomField,
  value: unknown,
): string | null {
  switch (field.dataType) {
    case FieldType.TEXT:
      if (typeof value !== 'string') return 'Expected text';
      if (value.length > L.customTextValue)
        return `At most ${L.customTextValue} characters`;
      return null;
    case FieldType.NUMBER:
      return typeof value === 'number' ? null : 'Expected a number';
    case FieldType.CHECKBOX:
      return typeof value === 'boolean' ? null : 'Expected true or false';
    case FieldType.DATE: {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return 'A date value is written as { "offsetDays": n }';
      const keys = Object.keys(value);
      const n = (value as { offsetDays?: unknown }).offsetDays;
      if (keys.length !== 1 || keys[0] !== 'offsetDays')
        return 'A date value is written as { "offsetDays": n } and nothing else';
      if (
        typeof n !== 'number' ||
        !Number.isInteger(n) ||
        Math.abs(n) > L.maxOffsetDays
      ) {
        return `offsetDays must be a whole number within +-${L.maxOffsetDays}`;
      }
      return null;
    }
    case FieldType.SELECT:
      return typeof value === 'string' && field.options?.includes(value)
        ? null
        : "Expected one of the field's options";
    case FieldType.MULTI_SELECT: {
      if (!Array.isArray(value))
        return "Expected a list of the field's options";
      if (
        !value.every((v) => typeof v === 'string' && field.options?.includes(v))
      ) {
        return "Every entry must be one of the field's options";
      }
      return new Set(value).size === value.length
        ? null
        : 'An option is listed twice';
    }
    case FieldType.USER:
      return 'A person cannot be stored in a template; leave USER fields empty';
    case FieldType.URL: {
      if (typeof value !== 'string') return 'Expected a URL';
      if (value.length > L.customUrlValue)
        return `At most ${L.customUrlValue} characters`;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return 'Not a valid URL';
      }
      if (url.protocol !== 'https:') return 'Only https:// URLs are allowed';
      if (url.username !== '' || url.password !== '')
        return 'A URL must not contain credentials';
      return null;
    }
  }
}

function checkWorkflow(
  wf: NonNullable<BlueprintV1['projects'][number]['workflow']>,
  base: string,
  issues: IssueList,
  plain: (
    path: string,
    value: string | undefined,
    singleLine?: boolean,
  ) => void,
): Set<string> {
  const keys = new Set<string>();
  const names = new Set<string>();
  const defaults = new Map<TaskStatus, number>();
  wf.statuses.forEach((s, i) => {
    const p = pointer(base, 'statuses', i);
    if (keys.has(s.key))
      issues.add(
        'DUPLICATE',
        pointer(p, 'key'),
        `Status key "${s.key}" is used twice`,
      );
    keys.add(s.key);
    plain(pointer(p, 'name'), s.name);
    const folded = foldName(s.name);
    if (folded && names.has(folded))
      issues.add(
        'DUPLICATE',
        pointer(p, 'name'),
        `Status "${s.name}" is listed twice (names are compared ignoring case and spacing)`,
      );
    names.add(folded);
    if (s.excludeFromProgress && s.category !== TaskStatus.DONE) {
      issues.add(
        'WORKFLOW_INVALID',
        pointer(p, 'excludeFromProgress'),
        'Only a Done-category status can be left out of progress',
      );
    }
    if (s.isDefault) {
      const n = (defaults.get(s.category) ?? 0) + 1;
      defaults.set(s.category, n);
      if (n > 1)
        issues.add(
          'WORKFLOW_INVALID',
          pointer(p, 'isDefault'),
          `Only one ${s.category} status can be the default`,
        );
    }
  });
  for (const category of REQUIRED_CATEGORIES) {
    if (!wf.statuses.some((s) => s.category === category)) {
      issues.add(
        'WORKFLOW_INVALID',
        pointer(base, 'statuses'),
        `A workflow needs at least one ${category} status`,
      );
    }
  }
  const seen = new Set<string>();
  (wf.transitions ?? []).forEach((t, i) => {
    const p = pointer(base, 'transitions', i);
    for (const side of ['from', 'to'] as const) {
      if (!keys.has(t[side]))
        issues.add(
          'UNKNOWN_REF',
          pointer(p, side),
          `Status "${t[side]}" is not in this workflow`,
        );
    }
    if (t.from === t.to)
      issues.add(
        'WORKFLOW_INVALID',
        p,
        'A transition from a status to itself is meaningless',
      );
    const k = `${t.from}>${t.to}`;
    if (seen.has(k))
      issues.add(
        'DUPLICATE',
        p,
        `Transition ${t.from} -> ${t.to} is listed twice`,
      );
    seen.add(k);
  });
  if (wf.enforceTransitions && seen.size === 0) {
    issues.add(
      'WORKFLOW_INVALID',
      pointer(base, 'enforceTransitions'),
      'Enforcing transitions with none defined would freeze every task',
    );
  }
  return keys;
}

function checkDependencies(
  deps: NonNullable<BlueprintV1['projects'][number]['dependencies']>,
  base: string,
  taskKeys: Set<string>,
  nodes: Map<string, NodeInfo>,
  projectKey: string,
  issues: IssueList,
): void {
  const pairs = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  deps.forEach((d, i) => {
    const p = pointer(base, i);
    let ok = true;
    for (const side of ['from', 'to'] as const) {
      const k = d[side];
      if (taskKeys.has(k)) continue;
      ok = false;
      const info = nodes.get(k);
      if (info?.kind === 'task' && info.project !== projectKey) {
        issues.add(
          'DEPENDENCY_INVALID',
          pointer(p, side),
          `"${k}" is a task of another project; dependencies stay inside one project`,
        );
      } else {
        issues.add(
          'UNKNOWN_REF',
          pointer(p, side),
          `"${k}" is not a task of this project`,
        );
      }
    }
    if (d.from === d.to) {
      issues.add('DEPENDENCY_INVALID', p, 'A task cannot depend on itself');
      ok = false;
    }
    const type = d.type ?? DependencyType.BLOCKS;
    const forward = `${d.from}>${d.to}`;
    if (pairs.has(forward)) {
      issues.add('DUPLICATE', p, `${d.from} -> ${d.to} is listed twice`);
      ok = false;
    }
    pairs.add(forward);
    if (type === DependencyType.RELATES_TO && pairs.has(`${d.to}>${d.from}`)) {
      // the relation is symmetric in meaning; storing both directions would be one fact twice
      const reverse = deps.find((x) => x.from === d.to && x.to === d.from);
      if (
        reverse &&
        (reverse.type ?? DependencyType.BLOCKS) === DependencyType.RELATES_TO
      ) {
        issues.add(
          'DEPENDENCY_INVALID',
          p,
          `${d.to} and ${d.from} are already related; list the relation once`,
        );
        ok = false;
      }
    }
    if (ok && type === DependencyType.BLOCKS) {
      const out = adjacency.get(d.from) ?? [];
      out.push(d.to);
      adjacency.set(d.from, out);
      indegree.set(d.to, (indegree.get(d.to) ?? 0) + 1);
      if (!indegree.has(d.from)) indegree.set(d.from, 0);
    }
  });

  // Kahn: whatever cannot be removed is on or behind a cycle.
  const queue = [...indegree.entries()]
    .filter(([, n]) => n === 0)
    .map(([k]) => k);
  let removed = 0;
  while (queue.length > 0) {
    const k = queue.pop()!;
    removed += 1;
    for (const next of adjacency.get(k) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (removed < indegree.size) {
    const stuck = [...indegree.entries()]
      .filter(([, n]) => n > 0)
      .map(([k]) => k);
    issues.add(
      'DEPENDENCY_CYCLE',
      base,
      `These tasks block each other in a cycle: ${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? ', ...' : ''}`,
    );
  }
}
