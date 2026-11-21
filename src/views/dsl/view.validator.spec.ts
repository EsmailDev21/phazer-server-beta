import { validateViewConfig } from './view.validator';

const codes = (layout: unknown, config: unknown) => {
  const r = validateViewConfig(layout, config);
  return r.ok === true ? [] : r.issues.map((i) => `${i.code}@${i.path}`);
};

describe('saved view config v1: structure', () => {
  it('accepts an empty config for the free-form layouts', () => {
    for (const layout of ['LIST', 'TABLE', 'BOARD'])
      expect(codes(layout, {})).toEqual([]);
  });

  it('accepts a rich list view', () => {
    const r = validateViewConfig('LIST', {
      filters: {
        all: [
          { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] },
          { field: 'DUE_DATE', op: 'DUE_WITHIN_DAYS', value: 7 },
        ],
        any: [
          { field: 'TITLE', op: 'CONTAINS', value: 'login' },
          { field: 'ITERATION', op: 'IS_SET' },
        ],
      },
      group: { by: 'STATUS' },
      sort: [
        { field: 'PRIORITY', dir: 'DESC' },
        { customFieldId: 'cf1', dir: 'ASC' },
      ],
      columns: ['KEY', 'TITLE', 'custom:cf1'],
      showSubtasks: false,
      hideCompleted: true,
    });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.layout).toBe('LIST');
  });

  it('every layout with what it needs', () => {
    expect(codes('CALENDAR', { calendar: { dateField: 'DUE_DATE' } })).toEqual(
      [],
    );
    expect(
      codes('TIMELINE', {
        timeline: { startField: 'START_DATE', endField: 'DUE_DATE' },
        group: { by: 'ISSUE_TYPE' },
      }),
    ).toEqual([]);
    expect(
      codes('BOARD', {
        group: { by: 'PRIORITY' },
        columns: ['TITLE', 'ASSIGNEES'],
      }),
    ).toEqual([]);
    expect(codes('BOARD', { group: { customFieldId: 'cf1' } })).toEqual([]);
  });

  describe('refuses', () => {
    it('an unknown layout, and a config that is not an object', () => {
      expect(codes('GANTT', {})).toEqual(['BAD_VALUE@/layout']);
      expect(codes(undefined, {})).toEqual(['BAD_VALUE@/layout']);
      expect(codes('LIST', null)).toEqual(['WRONG_TYPE@']);
      expect(codes('LIST', [])).toEqual(['WRONG_TYPE@']);
    });
    it('unknown keys (a typo must not silently do nothing)', () => {
      expect(codes('LIST', { filter: {} })).toEqual(['UNKNOWN_KEY@/filter']);
      expect(codes('LIST', { group: { by: 'STATUS', extra: 1 } })).toEqual([
        'UNKNOWN_KEY@/group/extra',
      ]);
    });
    it('keys that mean nothing for the layout', () => {
      expect(codes('LIST', { calendar: { dateField: 'DUE_DATE' } })).toEqual([
        'NOT_FOR_LAYOUT@/calendar',
      ]);
      expect(
        codes('TABLE', {
          timeline: { startField: 'START_DATE', endField: 'DUE_DATE' },
        }),
      ).toEqual(['NOT_FOR_LAYOUT@/timeline']);
      expect(
        codes('CALENDAR', {
          calendar: { dateField: 'DUE_DATE' },
          group: { by: 'STATUS' },
        }),
      ).toEqual(['NOT_FOR_LAYOUT@/group']);
      expect(
        codes('CALENDAR', {
          calendar: { dateField: 'DUE_DATE' },
          sort: [{ field: 'TITLE', dir: 'ASC' }],
        }),
      ).toEqual(['NOT_FOR_LAYOUT@/sort']);
      expect(
        codes('TIMELINE', {
          timeline: { startField: 'START_DATE', endField: 'DUE_DATE' },
          calendar: { dateField: 'DUE_DATE' },
        }),
      ).toEqual(['NOT_FOR_LAYOUT@/calendar']);
    });
    it('what a layout requires', () => {
      expect(codes('CALENDAR', {})).toEqual(['MISSING@/calendar']);
      expect(codes('TIMELINE', {})).toEqual(['MISSING@/timeline']);
      expect(
        codes('TIMELINE', {
          timeline: { startField: 'DUE_DATE', endField: 'DUE_DATE' },
        }),
      ).toEqual(['SAME_FIELD@/timeline/endField']);
      expect(codes('CALENDAR', { calendar: { dateField: 'TITLE' } })).toEqual([
        'BAD_VALUE@/calendar/dateField',
      ]);
    });
    it('a board grouped by something without a few known values', () => {
      expect(codes('BOARD', { group: { by: 'DUE_DATE' } })).toEqual([
        'BAD_BOARD_GROUP@/group/by',
      ]);
      expect(codes('BOARD', { group: { by: 'PROJECT' } })).toEqual([
        'BAD_BOARD_GROUP@/group/by',
      ]);
      expect(codes('LIST', { group: { by: 'DUE_DATE' } })).toEqual([]); // a list may
    });
    it('group, sort and column details', () => {
      expect(codes('LIST', { group: {} })).toEqual(['EXACTLY_ONE_OF@/group']);
      expect(
        codes('LIST', { group: { by: 'STATUS', customFieldId: 'x' } }),
      ).toEqual(['EXACTLY_ONE_OF@/group']);
      expect(codes('LIST', { group: { by: 'NOPE' } })).toEqual([
        'BAD_VALUE@/group/by',
      ]);
      expect(codes('LIST', { sort: [] })).toEqual(['TOO_FEW@/sort']);
      expect(
        codes('LIST', {
          sort: Array(4)
            .fill(0)
            .map((_, i) => ({
              field: ['TITLE', 'STATUS', 'PRIORITY', 'KEY'][i],
              dir: 'ASC',
            })),
        }),
      ).toEqual(['TOO_MANY@/sort']);
      expect(codes('LIST', { sort: [{ field: 'TITLE', dir: 'UP' }] })).toEqual([
        'BAD_VALUE@/sort/0/dir',
      ]);
      expect(codes('LIST', { sort: [{ dir: 'ASC' }] })).toEqual([
        'EXACTLY_ONE_OF@/sort/0',
      ]);
      expect(
        codes('LIST', {
          sort: [
            { field: 'TITLE', dir: 'ASC' },
            { field: 'TITLE', dir: 'DESC' },
          ],
        }),
      ).toEqual(['DUPLICATE@/sort']);
      expect(codes('LIST', { columns: ['KEY', 'KEY'] })).toEqual([
        'DUPLICATE@/columns',
      ]);
      expect(codes('LIST', { columns: ['NOPE'] })).toEqual([
        'BAD_VALUE@/columns/0',
      ]);
      expect(codes('LIST', { columns: ['custom:has space'] })).toEqual([
        'BAD_FORMAT@/columns/0',
      ]);
      expect(codes('LIST', { columns: [] })).toEqual(['TOO_FEW@/columns']);
      expect(codes('LIST', { columns: [5] })).toEqual([
        'WRONG_TYPE@/columns/0',
      ]);
      expect(codes('LIST', { showSubtasks: 'yes' })).toEqual([
        'WRONG_TYPE@/showSubtasks',
      ]);
    });
    it('cards and calendar entries show a few fields, not a table row', () => {
      const nine = [
        'KEY',
        'TITLE',
        'STATUS',
        'PRIORITY',
        'ASSIGNEES',
        'DUE_DATE',
        'START_DATE',
        'ESTIMATE',
        'TAGS',
      ];
      expect(codes('BOARD', { columns: nine })).toEqual(['TOO_MANY@/columns']);
      expect(codes('BOARD', { columns: nine.slice(0, 8) })).toEqual([]);
      expect(codes('TABLE', { columns: nine })).toEqual([]);
      expect(
        codes('CALENDAR', {
          calendar: { dateField: 'DUE_DATE' },
          columns: nine,
        }),
      ).toEqual(['TOO_MANY@/columns']);
    });
  });

  describe('filters', () => {
    const f = (c: unknown) => ({ filters: { all: [c] } });
    it('use the view field table: view-only fields work, automation-only ones do not', () => {
      expect(
        codes('LIST', f({ field: 'TITLE', op: 'CONTAINS', value: 'x' })),
      ).toEqual([]);
      expect(
        codes(
          'LIST',
          f({ field: 'DUE_DATE', op: 'DUE_WITHIN_DAYS', value: 0 }),
        ),
      ).toEqual([]);
      expect(
        codes('LIST', f({ field: 'CREATED_BY', op: 'IN', value: ['ME'] })),
      ).toEqual([]);
      expect(
        codes('LIST', f({ field: 'ITERATION', op: 'NOT_IN', value: ['i1'] })),
      ).toEqual([]);
      expect(codes('LIST', f({ field: 'START_DATE', op: 'IS_SET' }))).toEqual(
        [],
      );
      expect(
        codes('LIST', f({ field: 'TITLE', op: 'EQ', value: 'x' })),
      ).toEqual(['UNKNOWN_OPERATOR@/filters/all/0/op']);
      expect(codes('LIST', f({ field: 'TITLE', op: 'CONTAINS' }))).toEqual([
        'MISSING@/filters/all/0/value',
      ]);
      expect(
        codes(
          'LIST',
          f({ field: 'TITLE', op: 'CONTAINS', value: 'x'.repeat(201) }),
        ),
      ).toEqual(['TOO_LONG@/filters/all/0/value']);
      expect(
        codes(
          'LIST',
          f({ field: 'DUE_DATE', op: 'DUE_WITHIN_DAYS', value: 366 }),
        ),
      ).toEqual(['OUT_OF_RANGE@/filters/all/0/value']);
      expect(
        codes(
          'LIST',
          f({ field: 'DUE_DATE', op: 'DUE_WITHIN_DAYS', value: 1.5 }),
        ),
      ).toEqual(['WRONG_TYPE@/filters/all/0/value']);
      expect(
        codes('LIST', f({ field: 'DUE_DATE', op: 'DUE_WITHIN_DAYS' })),
      ).toEqual(['MISSING@/filters/all/0/value']);
      expect(codes('LIST', f({ field: 'NOPE', op: 'IN' }))).toEqual([
        'UNKNOWN_FIELD@/filters/all/0/field',
      ]);
    });
    it('and the automation tables are unchanged by this (no TITLE or CREATED_BY in rules)', async () => {
      const { validateRule } = await import('../../automations/dsl');
      for (const field of ['TITLE', 'CREATED_BY', 'ITERATION']) {
        const r = validateRule({
          trigger: { type: 'TASK_CREATED' },
          conditions: { all: [{ field, op: 'IN', value: ['x'] }] },
          actions: [{ type: 'ADD_TAG', tagId: 't' }],
        });
        expect(r.ok).toBe(false);
      }
    });
    it('are capped at 20 conditions in total', () => {
      const c = { field: 'IS_SUBTASK', op: 'IS_TRUE' };
      expect(codes('LIST', { filters: { all: Array(20).fill(c) } })).toEqual(
        [],
      );
      expect(codes('LIST', { filters: { all: Array(21).fill(c) } })).toEqual([
        'TOO_MANY@/filters/all',
      ]);
      expect(
        codes('LIST', {
          filters: { all: Array(11).fill(c), any: Array(10).fill(c) },
        }),
      ).toEqual(['TOO_MANY@/filters']);
    });
  });

  it('hostile input: too large, too deep, circular; does not mutate', () => {
    expect(
      codes('LIST', { columns: ['KEY'], junk: 'x'.repeat(20_000) }),
    ).toEqual(['TOO_LARGE@']);
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 30; i++) {
      deep.a = {};
      deep = deep.a;
    }
    expect(codes('LIST', { x: root })).toEqual(['TOO_DEEP@']);
    const circular: any = {};
    circular.self = circular;
    expect(codes('LIST', circular)).toEqual(['NOT_JSON@']);
    const input = { sort: [{ field: 'TITLE', dir: 'ASC' }] };
    const copy = JSON.parse(JSON.stringify(input));
    validateViewConfig('LIST', input);
    expect(input).toEqual(copy);
    const out = validateViewConfig('LIST', input);
    expect(out.ok === true && out.config).toEqual(input);
    expect(out.ok === true && out.config === (input as unknown)).toBe(false); // a copy, not the caller's object
  });
});
