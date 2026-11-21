import { BlueprintTask, BlueprintV1 } from './blueprint.types';

export interface BlueprintStats {
  projects: number;
  /** Every level, subtasks included. These are what count against plan task caps. */
  tasks: number;
  rootTasks: number;
  /** Levels, root = 1. 0 when there are no tasks. */
  maxTaskLevels: number;
  iterations: number;
  tags: number;
  customFields: number;
  issueTypes: number;
  statuses: number;
  transitions: number;
  comments: number;
  dependencies: number;
  attachments: number;
  assets: number;
  assetBytes: number;
  variables: number;
  roles: number;
  modules: number;
  /** projects + tasks + iterations: the limit BLUEPRINT_LIMITS.maxNodes applies to. */
  nodes: number;
}

/** Pure and iterative. Used for the node-count limit, for plan-limit preflight (3.6) and for listings. */
export function computeBlueprintStats(bp: BlueprintV1): BlueprintStats {
  let tasks = 0;
  let comments = 0;
  let attachments = 0;
  let maxLevels = 0;

  for (const project of bp.projects) {
    const stack: Array<{ task: BlueprintTask; level: number }> =
      project.tasks.map((task) => ({ task, level: 1 }));
    while (stack.length > 0) {
      const { task, level } = stack.pop()!;
      tasks += 1;
      comments += task.comments?.length ?? 0;
      attachments += task.attachments?.length ?? 0;
      if (level > maxLevels) maxLevels = level;
      for (const child of task.children ?? [])
        stack.push({ task: child, level: level + 1 });
    }
  }

  const iterations = bp.workspace?.iterations?.length ?? 0;
  return {
    projects: bp.projects.length,
    tasks,
    rootTasks: bp.projects.reduce((n, p) => n + p.tasks.length, 0),
    maxTaskLevels: maxLevels,
    iterations,
    tags: bp.workspace?.tags?.length ?? 0,
    customFields: bp.workspace?.customFields?.length ?? 0,
    issueTypes: bp.workspace?.issueTypes?.length ?? 0,
    statuses: bp.projects.reduce(
      (n, p) => n + (p.workflow?.statuses.length ?? 0),
      0,
    ),
    transitions: bp.projects.reduce(
      (n, p) => n + (p.workflow?.transitions?.length ?? 0),
      0,
    ),
    comments,
    dependencies: bp.projects.reduce(
      (n, p) => n + (p.dependencies?.length ?? 0),
      0,
    ),
    attachments,
    assets: bp.assets?.length ?? 0,
    assetBytes: (bp.assets ?? []).reduce((n, a) => n + a.sizeBytes, 0),
    variables: bp.variables?.length ?? 0,
    roles: bp.roles?.length ?? 0,
    modules: bp.modules?.length ?? 0,
    nodes: bp.projects.length + tasks + iterations,
  };
}
