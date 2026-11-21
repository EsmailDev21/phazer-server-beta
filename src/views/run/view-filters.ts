import type { Condition, Conditions } from '../../automations/dsl/rule.types';
import type { ViewConfigV1 } from '../dsl/view.types';

/**
 * What a view shows, as ONE conditions block: its filters, plus the two switches that hide tasks
 * (`hideCompleted`, and `showSubtasks: false`). Only an explicit `showSubtasks: false` hides subtasks.
 */
export function viewFilters(config: ViewConfigV1): Conditions {
  const extra: Condition[] = [];
  if (config.hideCompleted === true)
    extra.push({ field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] });
  if (config.showSubtasks === false)
    extra.push({ field: 'IS_SUBTASK', op: 'IS_FALSE' });
  const base = config.filters ?? {};
  return {
    ...(base.all || extra.length
      ? { all: [...(base.all ?? []), ...extra] }
      : {}),
    ...(base.any ? { any: base.any } : {}),
  };
}
