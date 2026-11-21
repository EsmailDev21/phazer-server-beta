import { BlueprintV1, BlueprintTask } from './resolve.deps';
import { DroppedByModules, Issues } from './resolve.types';

/**
 * Step 3.2 / pipeline step 3. Drops the nodes of switched-off modules (diagram 15).
 *
 * Semantics (fixed here, documented in blueprint-v1.md):
 *  - A module INCLUDES projects and tasks; a task includes its whole subtree, a project its tasks.
 *  - A node is GOVERNED by every module that includes it or any ancestor of it.
 *  - A node with no governing module always stays. A governed node stays if AT LEAST ONE of its
 *    governing modules is enabled (union), and never if an ancestor was dropped.
 *  - Then: dependencies with a dropped end go, project-scoped iterations of a dropped project
 *    go, assets no kept task attaches go. The result has no `modules`.
 * A module with no explicit choice uses its `defaultEnabled` (default true).
 */
export interface ModuleResult {
  blueprint: BlueprintV1;
  dropped: DroppedByModules;
  enabled: Record<string, boolean>;
}

export function expandModules(
  bp: BlueprintV1,
  choices: unknown,
  issues: Issues,
): ModuleResult {
  const modules = bp.modules ?? [];
  const known = new Set(modules.map((m) => m.key));
  const given: Record<string, unknown> =
    choices !== null && typeof choices === 'object' && !Array.isArray(choices)
      ? (choices as Record<string, unknown>)
      : {};
  if (choices !== undefined && choices !== null && given !== choices) {
    issues.add('MODULE_INVALID', '/modules', 'Module choices must be an object');
  }
  for (const key of Object.keys(given)) {
    if (!known.has(key)) issues.add('MODULE_UNKNOWN', `/modules/${key}`, `"${key}" is not a module of this template`);
    else if (typeof given[key] !== 'boolean') issues.add('MODULE_INVALID', `/modules/${key}`, 'Expected true or false');
  }

  const enabled: Record<string, boolean> = {};
  for (const m of modules) {
    const g = Object.prototype.hasOwnProperty.call(given, m.key) ? given[m.key] : undefined;
    enabled[m.key] = typeof g === 'boolean' ? g : (m.defaultEnabled ?? true);
  }

  const direct = new Map<string, string[]>();
  for (const m of modules) {
    for (const k of m.includes) direct.set(k, [...(direct.get(k) ?? []), m.key]);
  }
  const decide = (nodeKey: string, inherited: ReadonlySet<string>) => {
    const governors = new Set(inherited);
    for (const m of direct.get(nodeKey) ?? []) governors.add(m);
    const keep = governors.size === 0 || [...governors].some((m) => enabled[m]);
    return { governors, keep };
  };

  const dropped: DroppedByModules = { projects: [], tasks: [], iterations: [], assets: [], dependencies: 0 };
  const keptTasks = new Set<string>();
  const droppedTasks = new Set<string>();
  const droppedProjects = new Set<string>();

  const filterTasks = (tasks: BlueprintTask[], inherited: ReadonlySet<string>): BlueprintTask[] => {
    const out: BlueprintTask[] = [];
    for (const t of tasks) {
      const { governors, keep } = decide(t.nodeKey, inherited);
      if (!keep) {
        markDropped(t, droppedTasks);
        continue;
      }
      keptTasks.add(t.nodeKey);
      out.push(t.children?.length ? { ...t, children: filterTasks(t.children, governors) } : t);
    }
    return out;
  };
  const markDropped = (t: BlueprintTask, into: Set<string>) => {
    into.add(t.nodeKey);
    dropped.tasks.push(t.nodeKey);
    for (const c of t.children ?? []) markDropped(c, into);
  };

  const projects = [];
  for (const p of bp.projects) {
    const { governors, keep } = decide(p.nodeKey, new Set());
    if (!keep) {
      droppedProjects.add(p.nodeKey);
      dropped.projects.push(p.nodeKey);
      const stack = [...p.tasks];
      while (stack.length) {
        const t = stack.pop()!;
        droppedTasks.add(t.nodeKey);
        dropped.tasks.push(t.nodeKey);
        stack.push(...(t.children ?? []));
      }
      continue;
    }
    const tasks = filterTasks(p.tasks, governors);
    const deps = (p.dependencies ?? []).filter(
      (d) => !droppedTasks.has(d.from) && !droppedTasks.has(d.to),
    );
    dropped.dependencies += (p.dependencies ?? []).length - deps.length;
    projects.push({ ...p, tasks, dependencies: deps });
  }

  const iterations = (bp.workspace?.iterations ?? []).filter((it) => {
    const gone = it.project !== undefined && droppedProjects.has(it.project);
    if (gone) dropped.iterations.push(it.nodeKey);
    return !gone;
  });

  const used = new Set<string>();
  const collect = (tasks: BlueprintTask[]) => {
    for (const t of tasks) {
      for (const a of t.attachments ?? []) used.add(a);
      collect(t.children ?? []);
    }
  };
  projects.forEach((p) => collect(p.tasks));
  const assets = (bp.assets ?? []).filter((a) => {
    const keep = used.has(a.key);
    if (!keep) dropped.assets.push(a.key);
    return keep;
  });
  // assets nobody ever attached are not "dropped by a module"; keep only those a module orphaned
  const everUsed = new Set<string>();
  const collectAll = (tasks: BlueprintTask[]) => {
    for (const t of tasks) {
      for (const a of t.attachments ?? []) everUsed.add(a);
      collectAll(t.children ?? []);
    }
  };
  bp.projects.forEach((p) => collectAll(p.tasks));
  dropped.assets = dropped.assets.filter((k) => everUsed.has(k));

  const { modules: _modules, ...rest } = bp;
  void _modules;
  return {
    blueprint: {
      ...rest,
      workspace: bp.workspace ? { ...bp.workspace, iterations } : undefined,
      projects,
      assets,
    },
    dropped,
    enabled,
  };
}
