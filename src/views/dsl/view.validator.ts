import {
  Check,
  RuleIssue,
  Sink,
  arr,
  at,
  bool,
  depthOf,
  isObject,
  obj,
  objExactlyOne,
  oneOf,
  opt,
  req,
  str,
} from '../../common/dsl/schema';
import { makeConditionsCheck } from '../../automations/dsl';
import {
  BOARD_GROUP_FIELDS,
  COLUMN_FIELDS,
  DATE_FIELDS,
  GROUP_FIELDS,
  LAYOUTS,
  LAYOUT_RULES,
  Layout,
  SORT_FIELDS,
  VIEW_FILTER_TABLE,
} from './view.fields';
import { VIEW_LIMITS as L } from './view.limits';
import { ViewConfigV1 } from './view.types';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CUSTOM_COLUMN = /^custom:[A-Za-z0-9_-]{1,64}$/;

const column: Check = (v, path, sink) => {
  if (typeof v !== 'string')
    return sink.add('WRONG_TYPE', path, 'a column is a name');
  if (v.startsWith('custom:'))
    return str({ max: 80, pattern: CUSTOM_COLUMN, what: 'custom column' })(
      v,
      path,
      sink,
    );
  oneOf(COLUMN_FIELDS, 'column')(v, path, sink);
};

const columns: Check = (v, path, sink) => {
  arr(column, { min: 1, max: L.maxColumns })(v, path, sink);
  if (Array.isArray(v) && new Set(v).size !== v.length)
    sink.add('DUPLICATE', path, 'a column is listed twice');
};

const sortKeys: Check = (v, path, sink) => {
  arr(
    objExactlyOne(['field', 'customFieldId'], {
      field: opt(oneOf(SORT_FIELDS, 'sort field')),
      customFieldId: opt(
        str({ max: 64, pattern: ID, what: 'custom field id' }),
      ),
      dir: req(oneOf(['ASC', 'DESC'], 'direction')),
    }),
    { min: 1, max: L.maxSortKeys },
  )(v, path, sink);
  if (Array.isArray(v)) {
    const keys = v
      .filter(isObject)
      .map((k) =>
        k.field !== undefined
          ? `f:${String(k.field)}`
          : `c:${String(k.customFieldId)}`,
      );
    if (new Set(keys).size !== keys.length)
      sink.add('DUPLICATE', path, 'the same sort key is used twice');
  }
};

const timeline: Check = (v, path, sink) => {
  obj({
    startField: req(oneOf(DATE_FIELDS, 'start field')),
    endField: req(oneOf(DATE_FIELDS, 'end field')),
  })(v, path, sink);
  if (isObject(v) && v.startField !== undefined && v.startField === v.endField)
    sink.add(
      'SAME_FIELD',
      at(path, 'endField'),
      'the end must be a different date than the start',
    );
};

const configShape: Check = obj({
  filters: opt(makeConditionsCheck(VIEW_FILTER_TABLE)),
  group: opt(
    objExactlyOne(['by', 'customFieldId'], {
      by: opt(oneOf(GROUP_FIELDS, 'group field')),
      customFieldId: opt(
        str({ max: 64, pattern: ID, what: 'custom field id' }),
      ),
    }),
  ),
  sort: opt(sortKeys),
  columns: opt(columns),
  showSubtasks: opt(bool),
  hideCompleted: opt(bool),
  calendar: opt(obj({ dateField: req(oneOf(DATE_FIELDS, 'date field')) })),
  timeline: opt(timeline),
});

export type ViewConfigValidation =
  | { ok: true; layout: Layout; config: ViewConfigV1 }
  | { ok: false; issues: RuleIssue[] };

/**
 * Structure of a saved view's config for a layout: pure, no database. Strict (unknown keys are
 * errors), bounded (16 KB, shallow, short lists), and layout-aware: a calendar needs its date field,
 * a board can only be grouped by something with a few known values, and a key that means nothing for
 * the layout is refused rather than silently stored. What needs the workspace (do these ids exist?
 * can that custom field be grouped by?) is `checkViewSemantics`.
 */
export function validateViewConfig(
  layoutInput: unknown,
  input: unknown,
): ViewConfigValidation {
  if (
    typeof layoutInput !== 'string' ||
    !(LAYOUTS as readonly string[]).includes(layoutInput)
  ) {
    return {
      ok: false,
      issues: [
        {
          code: 'BAD_VALUE',
          path: '/layout',
          message: `layout must be one of ${LAYOUTS.join(', ')}`,
        },
      ],
    };
  }
  const layout = layoutInput as Layout;
  if (!isObject(input))
    return {
      ok: false,
      issues: [
        {
          code: 'WRONG_TYPE',
          path: '',
          message: 'A view config must be an object',
        },
      ],
    };
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: 'NOT_JSON',
          path: '',
          message: 'The config is not valid JSON data',
        },
      ],
    };
  }
  if (bytes > L.maxConfigBytes)
    return {
      ok: false,
      issues: [
        {
          code: 'TOO_LARGE',
          path: '',
          message: `A view config is at most ${L.maxConfigBytes / 1024} KB`,
        },
      ],
    };
  if (depthOf(input, L.maxJsonDepth + 1) > L.maxJsonDepth)
    return {
      ok: false,
      issues: [
        {
          code: 'TOO_DEEP',
          path: '',
          message: 'The config is nested too deeply',
        },
      ],
    };

  const sink = new Sink();
  configShape(input, '', sink);
  const rules = LAYOUT_RULES[layout];
  for (const key of Object.keys(input)) {
    if (
      !rules.allowed.includes(key) &&
      [
        'filters',
        'group',
        'sort',
        'columns',
        'showSubtasks',
        'hideCompleted',
        'calendar',
        'timeline',
      ].includes(key)
    ) {
      sink.add(
        'NOT_FOR_LAYOUT',
        at('', key),
        `"${key}" does not apply to a ${layout} view`,
      );
    }
  }
  for (const key of rules.required)
    if (input[key] === undefined)
      sink.add('MISSING', at('', key), `a ${layout} view needs "${key}"`);

  const group = isObject(input.group) ? input.group : null;
  if (
    layout === 'BOARD' &&
    group &&
    typeof group.by === 'string' &&
    !BOARD_GROUP_FIELDS.includes(group.by)
  ) {
    sink.add(
      'BAD_BOARD_GROUP',
      at(at('', 'group'), 'by'),
      `a board can be grouped by ${BOARD_GROUP_FIELDS.join(', ')} or a select field`,
    );
  }
  if (
    (layout === 'BOARD' || layout === 'CALENDAR') &&
    Array.isArray(input.columns) &&
    input.columns.length > L.maxCardFields
  ) {
    sink.add(
      'TOO_MANY',
      at('', 'columns'),
      `a ${layout === 'BOARD' ? 'card' : 'calendar entry'} shows at most ${L.maxCardFields} fields`,
    );
  }
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues };
  return {
    ok: true,
    layout,
    config: JSON.parse(JSON.stringify(input)) as ViewConfigV1,
  };
}
