import { CONDITION_TABLE, ConditionTable } from '../../automations/dsl';

/** The user token a view may use in place of an id: whoever is looking at it. */
export const VIEW_SPECIAL_USERS: ReadonlySet<string> = new Set(['ME']);

const pick = (names: string[]): ConditionTable =>
  Object.fromEntries(names.map((n) => [n, CONDITION_TABLE[n]]));

/**
 * What a view can filter on: field -> operator -> kind of value. The shared fields come from the
 * automation condition table (so a view and a rule mean the same thing by "priority is high");
 * the rest only make sense when LOOKING at tasks.
 */
export const VIEW_FILTER_TABLE: ConditionTable = {
  ...pick([
    'STATUS_CATEGORY',
    'STATUS',
    'PRIORITY',
    'ASSIGNEES',
    'TAGS',
    'ISSUE_TYPE',
    'PROJECT',
    'ESTIMATE',
    'IS_SUBTASK',
    'CUSTOM',
  ]),
  ITERATION: { IN: 'ids', NOT_IN: 'ids', IS_SET: 'none', IS_NOT_SET: 'none' },
  TITLE: { CONTAINS: 'text' },
  START_DATE: { IS_SET: 'none', IS_NOT_SET: 'none' },
  DUE_DATE: {
    IS_SET: 'none',
    IS_NOT_SET: 'none',
    IS_OVERDUE: 'none',
    IS_NOT_OVERDUE: 'none',
    DUE_WITHIN_DAYS: 'days',
  },
  CREATED_BY: { IN: 'userRefs', NOT_IN: 'userRefs' },
};

export const GROUP_FIELDS = [
  'STATUS',
  'PRIORITY',
  'ASSIGNEE',
  'ISSUE_TYPE',
  'ITERATION',
  'PROJECT',
  'DUE_DATE',
  'CREATED_BY',
] as const;
/** A board has columns, so it can only group by something with a small, known set of values. */
export const BOARD_GROUP_FIELDS: readonly string[] = [
  'STATUS',
  'PRIORITY',
  'ASSIGNEE',
  'ISSUE_TYPE',
  'ITERATION',
];
export const SORT_FIELDS = [
  'KEY',
  'TITLE',
  'STATUS',
  'PRIORITY',
  'DUE_DATE',
  'START_DATE',
  'ESTIMATE',
  'CREATED_AT',
  'UPDATED_AT',
] as const;
export const COLUMN_FIELDS = [
  'KEY',
  'TITLE',
  'STATUS',
  'PRIORITY',
  'ASSIGNEES',
  'DUE_DATE',
  'START_DATE',
  'ESTIMATE',
  'ISSUE_TYPE',
  'ITERATION',
  'TAGS',
  'PROJECT',
  'PARENT',
  'CREATED_AT',
  'UPDATED_AT',
  'CREATED_BY',
] as const;
export const DATE_FIELDS = ['START_DATE', 'DUE_DATE', 'CREATED_AT'] as const;

export const LAYOUTS = [
  'LIST',
  'BOARD',
  'TABLE',
  'CALENDAR',
  'TIMELINE',
] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Which top-level config keys each layout accepts, and which it requires. */
export const LAYOUT_RULES: Record<
  Layout,
  { allowed: readonly string[]; required: readonly string[] }
> = {
  LIST: {
    allowed: [
      'filters',
      'group',
      'sort',
      'columns',
      'showSubtasks',
      'hideCompleted',
    ],
    required: [],
  },
  TABLE: {
    allowed: [
      'filters',
      'group',
      'sort',
      'columns',
      'showSubtasks',
      'hideCompleted',
    ],
    required: [],
  },
  BOARD: {
    allowed: [
      'filters',
      'group',
      'sort',
      'columns',
      'showSubtasks',
      'hideCompleted',
    ],
    required: [],
  },
  CALENDAR: {
    allowed: [
      'filters',
      'columns',
      'showSubtasks',
      'hideCompleted',
      'calendar',
    ],
    required: ['calendar'],
  },
  TIMELINE: {
    allowed: [
      'filters',
      'group',
      'sort',
      'columns',
      'showSubtasks',
      'hideCompleted',
      'timeline',
    ],
    required: ['timeline'],
  },
};
