import {
  BLOCKED_EXTENSIONS,
  BLOCKED_MIME,
  MIME_SHAPE,
} from '../assets/asset.policy';
import {
  BlueprintAsset,
  BlueprintComment,
  BlueprintCustomValue,
  BlueprintRole,
  BlueprintTask,
  BlueprintV1,
  BLUEPRINT_LIMITS as L,
  isCalendarDate,
  validateBlueprint,
} from '../blueprint';
import { RawBlueprint, RawTask } from '../extract/extract.types';
import { TEMPLATE_VARIABLES } from '../../automations/dsl';
import { scanText, ScanOptions, urlValueProblem } from './sanitize.scanners';
import {
  Finding,
  FindingKind,
  FindingSeverity,
  MAX_LISTED_FINDINGS,
  SanitizeOptions,
  SanitizeReport,
  SanitizeResult,
} from './sanitize.types';

const DAY = 86_400_000;
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Step 3.4. RAW blueprint -> a valid BlueprintV1 that is safe to store, or a refusal.
 *
 *  - users            -> role placeholders ("Person 1"...), in order of first appearance
 *  - dates            -> whole-day offsets from an anchor (earliest date, or the exporter's pick),
 *                        plus a required DATE variable `startDate` the person fills at apply time
 *  - comment authors  -> dropped (comments become anonymous)
 *  - source ids, USER custom values, attachments without a hash, risky files -> removed
 *  - every string     -> scanned (secrets, PII, URLs, high-entropy tokens), see sanitize.scanners
 *  - the result       -> validated with validateBlueprint; anything invalid is refused, never "fixed"
 *
 * Pure and deterministic. The report NEVER contains matched text.
 */
export function sanitize(
  raw: RawBlueprint,
  options: SanitizeOptions = {},
): SanitizeResult {
  const onSecret = options.onSecret ?? 'block';
  const findings: Finding[] = [];
  const summary: SanitizeReport['summary'] = {};
  let blocked = false;
  let truncated = false;

  const record = (
    kind: FindingKind,
    severity: FindingSeverity,
    path: string,
    detail: string,
    count = 1,
  ) => {
    summary[kind] = (summary[kind] ?? 0) + count;
    if (severity === 'blocked') blocked = true;
    const existing = findings.find(
      (f) => f.kind === kind && f.path === path && f.detail === detail,
    );
    if (existing) {
      existing.count += count;
      return;
    }
    if (findings.length >= MAX_LISTED_FINDINGS) {
      truncated = true;
      return;
    }
    findings.push({ kind, severity, path, detail, count });
  };

  const text = (
    path: string,
    value: string,
    o: Pick<ScanOptions, 'templated' | 'singleLine'>,
  ): string => {
    const r = scanText(value, { onSecret, ...o });
    for (const f of r.findings)
      record(f.kind, f.severity, path, f.detail, f.count);
    return r.text;
  };
  const plain = (path: string, value: string, singleLine = true) =>
    text(path, value, { templated: false, singleLine });
  const templated = (path: string, value: string, singleLine = false) =>
    text(path, value, { templated: true, singleLine });
  const maybe = <T>(
    v: T | undefined,
    f: (x: T) => string,
  ): string | undefined => (v === undefined ? undefined : f(v));
  /**
   * Step 5.5: every string inside an automation or view (comment text, subtask titles, filter values, an
   * imported rule's own text) gets the same scan as any other text. A rule's OWN placeholders
   * ({{task.title}}...) are protected while the rest is scanned, then put back: they are part of the rule,
   * not template syntax, and the plain scan would rewrite every "{{".
   */
  const deepScan = <T>(path: string, value: T, ours: boolean): T => {
    if (typeof value === 'string') {
      if (!ours) return plain(path, value, false) as unknown as T;
      const held: string[] = [];
      const shielded = value.replace(
        /\{\{\s*([^{}]*?)\s*\}\}/g,
        (m, name: string) => {
          if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name))
            return m;
          held.push(m);
          return `\uE000${held.length - 1}\uE001`;
        },
      );
      return plain(path, shielded, false).replace(
        /\uE000(\d+)\uE001/g,
        (_m, i: string) => held[Number(i)] ?? '',
      ) as unknown as T;
    }
    if (Array.isArray(value))
      return value.map((v, i) =>
        deepScan(`${path}/${i}`, v, ours),
      ) as unknown as T;
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          deepScan(
            `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`,
            v,
            ours,
          ),
        ]),
      ) as T;
    }
    return value;
  };
  const portableKind = (item: unknown): boolean =>
    typeof item === 'object' &&
    item !== null &&
    ['rule.v1', 'view.v1'].includes(
      (item as { kind?: unknown }).kind as string,
    );

  // ------------------------------------------------------------------ anchor ---------
  const dates: string[] = [];
  const noteDate = (d?: string) => {
    if (d && isCalendarDate(d)) dates.push(d);
  };
  const customFieldType = new Map(
    raw.workspace.customFields.map((f) => [f.key, f.dataType]),
  );
  const dateOfValue = (v: unknown): string | undefined =>
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(v) &&
    isCalendarDate(v.slice(0, 10))
      ? v.slice(0, 10)
      : undefined;
  const walkTasks = (tasks: RawTask[], f: (t: RawTask) => void) =>
    tasks.forEach((t) => {
      f(t);
      walkTasks(t.children, f);
    });
  for (const p of raw.projects) {
    walkTasks(p.tasks, (t) => {
      noteDate(t.startDate);
      noteDate(t.dueDate);
      for (const [k, v] of Object.entries(t.customValues))
        if (customFieldType.get(k) === 'DATE') noteDate(dateOfValue(v));
    });
  }
  raw.workspace.iterations.forEach((i) => {
    noteDate(i.startDate);
    noteDate(i.endDate);
  });

  let anchor: string | null = null;
  let anchorSource: 'earliest' | 'override' = 'earliest';
  if (options.anchorDate !== undefined && isCalendarDate(options.anchorDate)) {
    anchor = options.anchorDate;
    anchorSource = 'override';
  } else if (dates.length > 0) {
    anchor = [...dates].sort()[0];
  }
  const anchorMs = anchor ? Date.parse(anchor) : 0;
  let datesConverted = 0;
  const offset = (path: string, iso?: string): number | undefined => {
    if (iso === undefined || anchor === null) return undefined;
    const d = Math.round((Date.parse(iso) - anchorMs) / DAY);
    if (!Number.isFinite(d) || Math.abs(d) > L.maxOffsetDays) {
      record(
        'date-dropped',
        'review',
        path,
        'more than 10 years from the anchor',
      );
      return undefined;
    }
    datesConverted += 1;
    return d;
  };

  // ------------------------------------------------------------------ roles ----------
  const roleByUser = new Map<string, string>();
  const roles: BlueprintRole[] = [];
  const roleFor = (userId: string, path: string): string | undefined => {
    const existing = roleByUser.get(userId);
    if (existing) return existing;
    if (roles.length >= L.maxRoles) {
      record(
        'user-dropped',
        'review',
        path,
        `more than ${L.maxRoles} distinct people; the rest are left unassigned`,
      );
      return undefined;
    }
    const key = `person-${roles.length + 1}`;
    roleByUser.set(userId, key);
    roles.push({
      key,
      label: `Person ${roles.length + 1}`,
      suggestedAccess: 'MEMBER',
    });
    return key;
  };

  // ------------------------------------------------------------------ definitions ----
  const tagName = new Map<string, string>();
  const tags = raw.workspace.tags.map((t, i) => {
    const n = plain(`/workspace/tags/${i}/name`, t.name);
    tagName.set(t.name, n);
    return { name: n };
  });
  const typeName = new Map<string, string>();
  const issueTypes = raw.workspace.issueTypes.map((t, i) => {
    const n = plain(`/workspace/issueTypes/${i}/name`, t.name);
    typeName.set(t.name, n);
    return {
      name: n,
      ...(t.icon
        ? { icon: plain(`/workspace/issueTypes/${i}/icon`, t.icon) }
        : {}),
      ...(t.color ? { color: t.color } : {}),
      ...(t.level ? { level: t.level } : {}),
    };
  });
  const customFields = raw.workspace.customFields.map((f, i) => ({
    key: f.key,
    name: plain(`/workspace/customFields/${i}/name`, f.name),
    dataType: f.dataType,
    ...(f.options
      ? {
          options: f.options.map((o, oi) =>
            plain(`/workspace/customFields/${i}/options/${oi}`, o),
          ),
        }
      : {}),
    ...(f.order !== undefined ? { order: f.order } : {}),
  }));
  const fieldByKey = new Map(customFields.map((f) => [f.key, f]));
  const rawOptions = new Map(
    raw.workspace.customFields.map((f) => [f.key, f.options ?? []]),
  );

  const iterations = raw.workspace.iterations.map((it, i) => {
    const p = `/workspace/iterations/${i}`;
    const startOffsetDays = offset(`${p}/startOffsetDays`, it.startDate);
    const endOffsetDays = offset(`${p}/endOffsetDays`, it.endDate);
    return {
      nodeKey: it.nodeKey,
      kind: it.kind,
      name: templated(`${p}/name`, it.name, true),
      ...(it.goal ? { goal: templated(`${p}/goal`, it.goal) } : {}),
      ...(startOffsetDays !== undefined ? { startOffsetDays } : {}),
      ...(endOffsetDays !== undefined ? { endOffsetDays } : {}),
      ...(it.project ? { project: it.project } : {}),
    };
  });

  // ------------------------------------------------------------------ assets ---------
  const assetKeep = new Map<string, string>(); // raw key -> kept key
  const assets: BlueprintAsset[] = [];
  let assetBytes = 0;
  let assetsDropped = 0;
  raw.assets.forEach((a, i) => {
    const p = `/assets/${i}`;
    const drop = (why: string) => {
      assetsDropped += 1;
      record('asset-dropped', 'review', p, why);
    };
    const sha = options.assetHashes?.get(a.sourceAttachmentId);
    if (!sha || !/^[0-9a-f]{64}$/.test(sha))
      return drop('the file has not been copied into the template store yet');
    if (BLOCKED_MIME.test(a.mimeType) || BLOCKED_EXTENSIONS.test(a.fileName))
      return drop('executable / installer file type');
    if (a.sizeBytes > L.maxAssetBytes)
      return drop('over the per-file size cap');
    if (
      assets.length >= L.maxAssets ||
      assetBytes + a.sizeBytes > L.maxTotalAssetBytes
    )
      return drop('over the template asset cap');
    if (!MIME_SHAPE.test(a.mimeType.toLowerCase()))
      return drop('unrecognised file type');
    const base = a.fileName
      .split(/[\\/]/)
      .pop()!
      .replace(/^\.+/, '')
      .slice(0, L.fileName);
    const fileName = plain(`${p}/fileName`, base === '' ? 'file' : base);
    assetBytes += a.sizeBytes;
    const key = `a${assets.length + 1}`;
    assetKeep.set(a.key, key);
    assets.push({
      key,
      fileName,
      mimeType: a.mimeType.toLowerCase(),
      sizeBytes: a.sizeBytes,
      sha256: sha,
    });
  });

  // ------------------------------------------------------------------ tasks ----------
  const convertTask = (t: RawTask, path: string): BlueprintTask => {
    const roleKeys: string[] = [];
    for (const u of t.assigneeUserIds) {
      if (roleKeys.length >= L.maxAssigneeRolesPerTask) {
        record(
          'user-dropped',
          'review',
          `${path}/assigneeRoles`,
          `more than ${L.maxAssigneeRolesPerTask} assignees on one task`,
        );
        break;
      }
      const k = roleFor(u, `${path}/assigneeRoles`);
      if (k && !roleKeys.includes(k)) roleKeys.push(k);
    }
    const customValues: Record<string, BlueprintCustomValue> = {};
    for (const [key, value] of Object.entries(t.customValues)) {
      const vp = `${path}/customValues/${key}`;
      const field = fieldByKey.get(key);
      const drop = (why: string) => record('value-dropped', 'review', vp, why);
      if (!field) {
        drop('field is not part of the template');
        continue;
      }
      switch (field.dataType) {
        case 'USER':
          record(
            'user-dropped',
            'redacted',
            vp,
            'a person cannot be stored in a template',
          );
          break;
        case 'DATE': {
          const d = dateOfValue(value);
          const off = d ? offset(vp, d) : undefined;
          if (off === undefined) {
            if (!d) drop('not a date');
          } else customValues[key] = { offsetDays: off };
          break;
        }
        case 'TEXT':
          if (typeof value === 'string')
            customValues[key] = plain(vp, value, false).slice(
              0,
              L.customTextValue,
            );
          else drop('not text');
          break;
        case 'NUMBER':
          if (typeof value === 'number' && Number.isFinite(value))
            customValues[key] = value;
          else drop('not a number');
          break;
        case 'CHECKBOX':
          if (typeof value === 'boolean') customValues[key] = value;
          else drop('not true/false');
          break;
        case 'SELECT':
          if (typeof value === 'string' && rawOptions.get(key)!.includes(value))
            customValues[key] =
              field.options![rawOptions.get(key)!.indexOf(value)];
          else drop('not one of the options');
          break;
        case 'MULTI_SELECT': {
          const opts = rawOptions.get(key)!;
          if (
            Array.isArray(value) &&
            value.every((v) => typeof v === 'string' && opts.includes(v))
          ) {
            customValues[key] = [...new Set(value as string[])].map(
              (v) => field.options![opts.indexOf(v)],
            );
          } else drop('not a list of the options');
          break;
        }
        case 'URL': {
          const why =
            typeof value === 'string' ? urlValueProblem(value) : 'not a URL';
          if (why)
            record(
              'external-ref-url',
              'redacted',
              vp,
              `URL value removed: ${why}`,
            );
          else customValues[key] = value as string;
          break;
        }
      }
    }
    const comments: BlueprintComment[] = [];
    t.comments.forEach((c, i) => {
      if (comments.length >= L.maxCommentsPerTask) {
        record(
          'comment-dropped',
          'info',
          `${path}/comments`,
          `more than ${L.maxCommentsPerTask} comments on one task`,
        );
        return;
      }
      const body = templated(`${path}/comments/${i}/body`, c.body);
      if (body.trim() === '') {
        record(
          'comment-dropped',
          'info',
          `${path}/comments/${i}`,
          'empty comment',
        );
        return;
      }
      comments.push({ body });
    });
    const attachments = [
      ...new Set(
        t.attachments
          .map((k) => assetKeep.get(k))
          .filter((k): k is string => !!k),
      ),
    ].slice(0, L.maxAttachmentsPerTask);

    const startOffsetDays = offset(`${path}/startOffsetDays`, t.startDate);
    const dueOffsetDays = offset(`${path}/dueOffsetDays`, t.dueDate);
    const children = t.children.map((c, i) =>
      convertTask(c, `${path}/children/${i}`),
    );
    return {
      nodeKey: t.nodeKey,
      title: templated(`${path}/title`, t.title, true),
      ...(t.description
        ? { description: templated(`${path}/description`, t.description) }
        : {}),
      ...(t.issueType
        ? { issueType: typeName.get(t.issueType) ?? t.issueType }
        : {}),
      ...(t.status ? { status: t.status } : {}),
      ...(t.priority ? { priority: t.priority } : {}),
      ...(t.tags.length
        ? { tags: t.tags.map((n) => tagName.get(n) ?? n) }
        : {}),
      ...(Object.keys(customValues).length ? { customValues } : {}),
      ...(roleKeys.length ? { assigneeRoles: roleKeys } : {}),
      ...(startOffsetDays !== undefined ? { startOffsetDays } : {}),
      ...(dueOffsetDays !== undefined ? { dueOffsetDays } : {}),
      ...(t.estimate !== undefined ? { estimate: t.estimate } : {}),
      ...(t.iteration ? { iteration: t.iteration } : {}),
      ...(children.length ? { children } : {}),
      ...(comments.length ? { comments } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  };

  const projects = raw.projects.map((p, pi) => {
    const pp = `/projects/${pi}`;
    return {
      nodeKey: p.nodeKey,
      name: templated(`${pp}/name`, p.name, true),
      ...(p.description
        ? { description: templated(`${pp}/description`, p.description) }
        : {}),
      ...(p.workflow
        ? {
            workflow: {
              ...p.workflow,
              statuses: p.workflow.statuses.map((s, si) => ({
                ...s,
                name: plain(`${pp}/workflow/statuses/${si}/name`, s.name),
              })),
            },
          }
        : {}),
      tasks: p.tasks.map((t, ti) => convertTask(t, `${pp}/tasks/${ti}`)),
      ...(p.dependencies.length ? { dependencies: p.dependencies } : {}),
      ...(p.automations?.length
        ? {
            automations: p.automations.map((a, i) =>
              deepScan(`${pp}/automations/${i}`, a, portableKind(a)),
            ),
          }
        : {}),
      ...(p.views?.length
        ? {
            views: p.views.map((v, i) =>
              deepScan(`${pp}/views/${i}`, v, portableKind(v)),
            ),
          }
        : {}),
    };
  });

  // ------------------------------------------------------------------ assemble -------
  const isWorkspace = raw.meta.kind === 'WORKSPACE';
  const blueprint: BlueprintV1 = {
    schemaVersion: 1,
    meta: {
      name: plain('/meta/name', raw.meta.name),
      ...(raw.meta.description
        ? {
            description: plain(
              '/meta/description',
              raw.meta.description,
              false,
            ),
          }
        : {}),
      kind: raw.meta.kind,
      ...(raw.meta.category ? { category: raw.meta.category } : {}),
      ...(raw.meta.locale ? { locale: raw.meta.locale } : {}),
    },
    ...(anchor !== null
      ? {
          dateAnchor: { variable: 'startDate' },
          variables: [
            {
              key: 'startDate',
              label: 'Start date',
              type: 'DATE' as const,
              required: true,
            },
          ],
        }
      : {}),
    ...(roles.length ? { roles } : {}),
    workspace: {
      ...(isWorkspace && raw.workspace.name
        ? { name: templated('/workspace/name', raw.workspace.name, true) }
        : {}),
      ...(isWorkspace && raw.workspace.key ? { key: raw.workspace.key } : {}),
      ...(isWorkspace && raw.workspace.icon
        ? { icon: plain('/workspace/icon', raw.workspace.icon) }
        : {}),
      ...(isWorkspace && raw.workspace.description
        ? {
            description: templated(
              '/workspace/description',
              raw.workspace.description,
            ),
          }
        : {}),
      ...(tags.length ? { tags } : {}),
      ...(customFields.length ? { customFields } : {}),
      ...(issueTypes.length ? { issueTypes } : {}),
      ...(iterations.length ? { iterations } : {}),
    },
    projects,
    ...(assets.length ? { assets } : {}),
  };

  const report = (): SanitizeReport => ({
    blocked,
    findings,
    truncated,
    summary,
    anchor: anchor
      ? {
          date: anchor,
          source: anchorSource,
          weekday: WEEKDAYS[new Date(anchorMs).getUTCDay()],
        }
      : null,
    datesConverted,
    roles: { created: roles.length },
    assets: { kept: assets.length, dropped: assetsDropped },
  });

  if (blocked) return { ok: false, reason: 'SECRETS_FOUND', report: report() };

  const checked = validateBlueprint(blueprint);
  if (checked.ok === false)
    return {
      ok: false,
      reason: 'INVALID',
      issues: checked.issues,
      report: report(),
    };
  return {
    ok: true,
    blueprint: checked.blueprint,
    stats: checked.stats,
    warnings: checked.warnings,
    report: report(),
  };
}
