import { WorkspaceRuleContext } from '../../automations/dsl';
import { foldName } from '../blueprint/blueprint.names';
import { RefMapper } from './portable.refs';
import { EntityModel } from './portable.types';

/** The user tokens a template may use in place of a person. */
export const RULE_TOKENS: ReadonlySet<string> = new Set([
  'TRIGGERER',
  'CREATOR',
  // the groups of the task an action is about (step 5.14)
  'ASSIGNEES',
  'WATCHERS',
]);
export const VIEW_TOKENS: ReadonlySet<string> = new Set(['ME']);

const statusKey = (projectKey: string, key: string) =>
  `${projectKey}\u0000${key}`;

/** name -> id lookups over a model (names compared the way the blueprint compares them). */
export function indexOf(model: EntityModel) {
  return {
    tag: new Map(model.tags.map((t) => [foldName(t.name), t.id])),
    issueType: new Map(model.issueTypes.map((t) => [foldName(t.name), t.id])),
    customField: new Map(
      model.customFields.map((f) => [f.key.toLowerCase(), f.id]),
    ),
    iteration: new Map(model.iterations.map((i) => [i.nodeKey, i.id])),
    project: new Map(model.projects.map((p) => [p.nodeKey, p.id])),
    status: new Map(
      model.statuses.map((s) => [statusKey(s.projectKey, s.key), s.id]),
    ),
  };
}

/** name -> id: how a template's names become the ids of a workspace (or of a check). */
export function forwardMapper(
  model: EntityModel,
  projectKey: string,
  tokens: ReadonlySet<string>,
): RefMapper {
  const ix = indexOf(model);
  return (kind, value) => {
    switch (kind) {
      case 'status':
        return ix.status.get(statusKey(projectKey, value));
      case 'tag':
        return ix.tag.get(foldName(value));
      case 'issueType':
        return ix.issueType.get(foldName(value));
      case 'customField':
        return ix.customField.get(value.toLowerCase());
      case 'iteration':
        return ix.iteration.get(value);
      case 'project':
        return ix.project.get(value);
      case 'user':
        return tokens.has(value) ? value : undefined;
      // another rule / a saved view: not carried by name yet, so a rule that points at one is kept apart
      // from the template with a clear reason (never translated wrongly)
      case 'channel':
      case 'rule':
      case 'view':
        return undefined;
    }
  };
}

/** id -> name: how a workspace's rule or view becomes a template's. Anything it cannot name is not portable. */
export function reverseMapper(
  model: EntityModel,
  projectKey: string,
  tokens: ReadonlySet<string>,
): RefMapper {
  const tag = new Map(model.tags.map((t) => [t.id, t.name]));
  const issueType = new Map(model.issueTypes.map((t) => [t.id, t.name]));
  const customField = new Map(model.customFields.map((f) => [f.id, f.key]));
  const iteration = new Map(model.iterations.map((i) => [i.id, i.nodeKey]));
  const project = new Map(model.projects.map((p) => [p.id, p.nodeKey]));
  const status = new Map(
    model.statuses
      .filter((s) => s.projectKey === projectKey)
      .map((s) => [s.id, s.key]),
  );
  return (kind, value) => {
    switch (kind) {
      case 'status':
        return status.get(value);
      case 'tag':
        return tag.get(value);
      case 'issueType':
        return issueType.get(value);
      case 'customField':
        return customField.get(value);
      case 'iteration':
        return iteration.get(value);
      case 'project':
        return project.get(value);
      case 'user':
        return tokens.has(value) ? value : undefined;
      // another rule / a saved view: not carried by name yet, so a rule that points at one is kept apart
      // from the template with a clear reason (never translated wrongly)
      case 'channel':
      case 'rule':
      case 'view':
        return undefined;
    }
  };
}

/** What the semantic checks need to know, derived from the same model (no people: a template names none). */
export function contextOf(model: EntityModel): WorkspaceRuleContext {
  const projectId = new Map(model.projects.map((p) => [p.nodeKey, p.id]));
  return {
    projectIds: new Set(model.projects.map((p) => p.id)),
    statuses: new Map(
      model.statuses.map((s) => [
        s.id,
        { projectId: projectId.get(s.projectKey) ?? '', category: s.category },
      ]),
    ),
    tagIds: new Set(model.tags.map((t) => t.id)),
    issueTypeIds: new Set(model.issueTypes.map((t) => t.id)),
    iterationIds: new Set(model.iterations.map((i) => i.id)),
    customFields: new Map(
      model.customFields.map((f) => [
        f.id,
        { dataType: f.dataType, options: f.options },
      ]),
    ),
    validUserIds: new Set(),
  };
}
