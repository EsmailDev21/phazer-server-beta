import { FieldType, TaskStatus } from '@prisma/client';
import { WorkspaceRuleContext } from '../../automations/dsl';
import {
  checkViewSemantics,
  collectViewCustomUserIds,
  collectViewReferences,
} from './view.semantic';
import { validateViewConfig } from './view.validator';
import { Layout } from './view.fields';

const ctx = (): WorkspaceRuleContext => ({
  projectIds: new Set(['p1', 'p2']),
  statuses: new Map([
    ['s_todo', { projectId: 'p1', category: TaskStatus.TODO }],
    ['s_other', { projectId: 'p2', category: TaskStatus.DONE }],
  ]),
  tagIds: new Set(['t1']),
  issueTypeIds: new Set(['it1']),
  iterationIds: new Set(['i1']),
  customFields: new Map<
    string,
    { dataType: FieldType; options: string[] | null }
  >([
    ['f_sel', { dataType: FieldType.SELECT, options: ['red', 'blue'] }],
    ['f_multi', { dataType: FieldType.MULTI_SELECT, options: ['a'] }],
    ['f_num', { dataType: FieldType.NUMBER, options: null }],
    ['f_user', { dataType: FieldType.USER, options: null }],
    ['f_check', { dataType: FieldType.CHECKBOX, options: null }],
    ['f_text', { dataType: FieldType.TEXT, options: null }],
    ['f_date', { dataType: FieldType.DATE, options: null }],
  ]),
  validUserIds: new Set(['u1']),
});
const check = (
  layout: Layout,
  config: unknown,
  scope: string | null = null,
) => {
  const v = validateViewConfig(layout, config);
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return checkViewSemantics(layout, v.config, scope, ctx()).map(
    (i) => `${i.code}@${i.path}`,
  );
};

describe('saved view config against a workspace', () => {
  it('a config whose ids all exist has no issues', () => {
    expect(
      check('LIST', {
        filters: {
          all: [
            { field: 'ITERATION', op: 'IN', value: ['i1'] },
            { field: 'TAGS', op: 'HAS_ANY', value: ['t1'] },
            { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME', 'u1'] },
          ],
        },
        group: { customFieldId: 'f_sel' },
        sort: [{ customFieldId: 'f_num', dir: 'ASC' }],
        columns: ['KEY', 'custom:f_text'],
      }),
    ).toEqual([]);
  });

  it('flags every unknown reference with its path', () => {
    expect(
      check('LIST', {
        filters: {
          all: [
            { field: 'ITERATION', op: 'IN', value: ['i1', 'gone'] },
            { field: 'CREATED_BY', op: 'IN', value: ['ghost'] },
            { field: 'TAGS', op: 'HAS_ANY', value: ['nope'] },
            { field: 'ISSUE_TYPE', op: 'IN', value: ['x'] },
            { field: 'PROJECT', op: 'IN', value: ['p9'] },
          ],
        },
        group: { customFieldId: 'missing' },
        sort: [{ customFieldId: 'missing2', dir: 'ASC' }],
        columns: ['custom:missing3'],
      }),
    ).toEqual([
      'UNKNOWN_ITERATION@/filters/all/0/value/1',
      'UNKNOWN_USER@/filters/all/1/value/0',
      'UNKNOWN_TAG@/filters/all/2/value/0',
      'UNKNOWN_ISSUE_TYPE@/filters/all/3/value/0',
      'UNKNOWN_PROJECT@/filters/all/4/value/0',
      'UNKNOWN_CUSTOM_FIELD@/group/customFieldId',
      'UNKNOWN_CUSTOM_FIELD@/sort/0/customFieldId',
      'UNKNOWN_CUSTOM_FIELD@/columns/0',
    ]);
  });

  it('ME is a view token, not a rule token: TRIGGERER and CREATOR are not users here', () => {
    expect(
      check('LIST', {
        filters: {
          all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
        },
      }),
    ).toEqual([]);
    expect(
      check('LIST', {
        filters: {
          all: [
            { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['TRIGGERER'] },
          ],
        },
      }),
    ).toEqual(['UNKNOWN_USER@/filters/all/0/value/0']);
    expect(
      check('LIST', {
        filters: {
          all: [
            {
              field: 'CUSTOM',
              customFieldId: 'f_user',
              op: 'INCLUDES_ANY',
              value: ['ME'],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("a specific status only in a project view, and only that project's", () => {
    const f = {
      filters: { all: [{ field: 'STATUS', op: 'IN', value: ['s_todo'] }] },
    };
    expect(check('LIST', f, null)).toEqual([
      'STATUS_NEEDS_PROJECT@/filters/all/0/value/0',
    ]);
    expect(check('LIST', f, 'p1')).toEqual([]);
    expect(check('LIST', f, 'p2')).toEqual([
      'UNKNOWN_STATUS@/filters/all/0/value/0',
    ]);
    expect(
      check(
        'LIST',
        {
          filters: {
            all: [{ field: 'STATUS_CATEGORY', op: 'IN', value: ['DONE'] }],
          },
        },
        null,
      ),
    ).toEqual([]);
  });

  describe('custom fields in group / sort', () => {
    it.each([
      ['LIST', 'f_sel', []],
      ['LIST', 'f_user', []],
      ['LIST', 'f_check', []],
      ['LIST', 'f_num', ['GROUP_TYPE_MISMATCH@/group/customFieldId']],
      ['LIST', 'f_multi', ['GROUP_TYPE_MISMATCH@/group/customFieldId']],
      ['LIST', 'f_text', ['GROUP_TYPE_MISMATCH@/group/customFieldId']],
      ['BOARD', 'f_sel', []],
      ['BOARD', 'f_user', ['GROUP_TYPE_MISMATCH@/group/customFieldId']],
      ['BOARD', 'f_check', ['GROUP_TYPE_MISMATCH@/group/customFieldId']],
    ] as const)('%s grouped by %s', (layout, field, expected) => {
      expect(check(layout, { group: { customFieldId: field } })).toEqual(
        expected,
      );
    });
    it.each([
      ['f_num', []],
      ['f_date', []],
      ['f_text', []],
      ['f_sel', []],
      ['f_check', []],
      ['f_multi', ['SORT_TYPE_MISMATCH@/sort/0/customFieldId']],
      ['f_user', ['SORT_TYPE_MISMATCH@/sort/0/customFieldId']],
    ] as const)('sorted by %s', (field, expected) => {
      expect(
        check('LIST', { sort: [{ customFieldId: field, dir: 'ASC' }] }),
      ).toEqual(expected);
    });
  });

  it("filters on custom fields are typed like a rule's", () => {
    expect(
      check('LIST', {
        filters: {
          all: [
            { field: 'CUSTOM', customFieldId: 'f_num', op: 'GT', value: 'ten' },
          ],
        },
      }),
    ).toEqual(['VALUE_MISMATCH@/filters/all/0/value']);
    expect(
      check('LIST', {
        filters: {
          all: [
            {
              field: 'CUSTOM',
              customFieldId: 'f_sel',
              op: 'EQ',
              value: 'green',
            },
          ],
        },
      }),
    ).toEqual(['VALUE_MISMATCH@/filters/all/0/value']);
    expect(
      check('LIST', {
        filters: {
          all: [
            { field: 'CUSTOM', customFieldId: 'f_text', op: 'GT', value: 'x' },
          ],
        },
      }),
    ).toEqual(['OPERATOR_MISMATCH@/filters/all/0/op']);
  });

  it('collects exactly what a config mentions', () => {
    const v = validateViewConfig('LIST', {
      filters: {
        all: [
          { field: 'STATUS', op: 'IN', value: ['s1'] },
          { field: 'ITERATION', op: 'IN', value: ['i1'] },
          { field: 'CREATED_BY', op: 'IN', value: ['u1', 'ME'] },
          {
            field: 'CUSTOM',
            customFieldId: 'f_user',
            op: 'INCLUDES_ANY',
            value: ['u2', 'ME'],
          },
        ],
      },
      group: { customFieldId: 'f_sel' },
      sort: [{ customFieldId: 'f_num', dir: 'ASC' }],
      columns: ['custom:f_text', 'KEY'],
    });
    if (v.ok === false) throw new Error('invalid');
    const refs = collectViewReferences(v.config, 'p1');
    expect([...refs.statusIds]).toEqual(['s1']);
    expect([...refs.iterationIds]).toEqual(['i1']);
    expect([...refs.userIds]).toEqual(['u1']);
    expect([...refs.customFieldIds].sort()).toEqual([
      'f_num',
      'f_sel',
      'f_text',
      'f_user',
    ]);
    expect([...refs.projectIds]).toEqual(['p1']);
    expect(
      collectViewCustomUserIds(
        v.config,
        (id) => ctx().customFields.get(id)?.dataType,
      ),
    ).toEqual(['u2']);
  });
});
