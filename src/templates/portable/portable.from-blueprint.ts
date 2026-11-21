import { BlueprintV1 } from '../blueprint/blueprint.types';
import { EntityModel } from './portable.types';

/**
 * The entity model of a blueprint ON ITS OWN: every tag, field, type, iteration, project and status
 * it defines, with placeholder ids (`tag0`, `field2`...). Used to check a template when it is
 * published: "does everything this automation names exist in the template?"
 */
export function modelFromBlueprint(
  bp: Pick<BlueprintV1, 'workspace' | 'projects'>,
): EntityModel {
  const ws = bp.workspace ?? {};
  return {
    tags: (ws.tags ?? []).map((t, i) => ({ name: t.name, id: `tag${i}` })),
    issueTypes: (ws.issueTypes ?? []).map((t, i) => ({
      name: t.name,
      id: `type${i}`,
    })),
    customFields: (ws.customFields ?? []).map((f, i) => ({
      key: f.key,
      id: `field${i}`,
      dataType: f.dataType,
      options: f.options ?? null,
    })),
    iterations: (ws.iterations ?? []).map((it, i) => ({
      nodeKey: it.nodeKey,
      id: `iter${i}`,
    })),
    projects: bp.projects.map((p, i) => ({
      nodeKey: p.nodeKey,
      id: `proj${i}`,
    })),
    statuses: bp.projects.flatMap((p, pi) =>
      (p.workflow?.statuses ?? []).map((s, si) => ({
        projectKey: p.nodeKey,
        key: s.key,
        id: `status${pi}x${si}`,
        category: s.category,
      })),
    ),
  };
}
