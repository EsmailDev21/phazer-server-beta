// Step 3.9. First-party template content. Edit here, never in a stored version: a changed seed is
// published by the seeder as a NEW version. `assets` is not written by hand (see seed.prepare.ts).
export const contentCalendarBlueprint: Record<string, unknown> = {
  schemaVersion: 1,
  meta: {
    name: 'Content calendar',
    description:
      'A launch month of posts across channels, scheduled from a launch date, weekdays only.',
    kind: 'WORKSPACE',
    category: 'marketing',
  },
  dateAnchor: {
    variable: 'launchDate',
    skipWeekends: true,
  },
  variables: [
    {
      key: 'brand',
      label: 'Brand',
      type: 'TEXT',
      default: 'Acme',
    },
    {
      key: 'launchDate',
      label: 'Launch date',
      type: 'DATE',
      required: true,
    },
    {
      key: 'mainChannel',
      label: 'Main channel',
      type: 'SELECT',
      options: ['Blog', 'Newsletter', 'Social'],
      default: 'Blog',
    },
    {
      key: 'weeks',
      label: 'Weeks of content',
      type: 'NUMBER',
      default: 4,
    },
  ],
  roles: [
    {
      key: 'writer',
      label: 'Writer',
      suggestedAccess: 'MEMBER',
    },
    {
      key: 'editor',
      label: 'Editor',
      suggestedAccess: 'ADMIN',
    },
  ],
  modules: [
    {
      key: 'paid',
      label: 'Paid campaign',
      defaultEnabled: false,
      includes: ['ads'],
    },
  ],
  workspace: {
    tags: [
      {
        name: 'blog',
      },
      {
        name: 'newsletter',
      },
      {
        name: 'social',
      },
      {
        name: 'ads',
      },
    ],
    customFields: [
      {
        key: 'channel',
        name: 'Channel',
        dataType: 'SELECT',
        options: ['Blog', 'Newsletter', 'Social'],
      },
      {
        key: 'channels',
        name: 'Also on',
        dataType: 'MULTI_SELECT',
        options: ['Blog', 'Newsletter', 'Social'],
      },
      {
        key: 'word-count',
        name: 'Word count',
        dataType: 'NUMBER',
      },
      {
        key: 'approved',
        name: 'Approved',
        dataType: 'CHECKBOX',
      },
      {
        key: 'go-live',
        name: 'Go live',
        dataType: 'DATE',
      },
      {
        key: 'brief',
        name: 'Brief',
        dataType: 'URL',
      },
      {
        key: 'reviewer',
        name: 'Reviewer',
        dataType: 'USER',
      },
      {
        key: 'angle',
        name: 'Angle',
        dataType: 'TEXT',
      },
    ],
  },
  projects: [
    {
      nodeKey: 'calendar',
      name: '{{brand}} content calendar',
      tasks: [
        {
          nodeKey: 'post-1',
          title: '{{brand}} launch post ({{mainChannel}})',
          description:
            'Goes live {{format(launchDate, "EEEE d MMMM")}}. Slug: {{slug(brand)}}.',
          tags: ['blog'],
          priority: 'HIGH',
          customValues: {
            channel: 'Blog',
            channels: ['Newsletter', 'Social'],
            'word-count': 900,
            approved: false,
            'go-live': {
              offsetDays: 0,
            },
            brief: 'https://example.com/briefs/launch',
            angle: 'Why we built it',
          },
          assigneeRoles: ['writer'],
          startOffsetDays: -7,
          dueOffsetDays: 0,
          comments: [
            {
              body: 'Draft due {{addDays(launchDate, -3)}}',
            },
          ],
        },
        {
          nodeKey: 'post-2',
          title: 'Week 2 newsletter',
          tags: ['newsletter'],
          customValues: {
            channel: 'Newsletter',
            'go-live': {
              offsetDays: 7,
            },
          },
          assigneeRoles: ['writer', 'editor'],
          dueOffsetDays: 7,
        },
        {
          nodeKey: 'post-3',
          title: 'Week 3 social thread',
          tags: ['social'],
          customValues: {
            channel: 'Social',
            'go-live': {
              offsetDays: 14,
            },
          },
          dueOffsetDays: 14,
        },
        {
          nodeKey: 'ads',
          title: 'Paid ads flight',
          tags: ['ads'],
          startOffsetDays: 0,
          dueOffsetDays: 21,
        },
      ],
      dependencies: [
        {
          from: 'post-1',
          to: 'post-2',
        },
        {
          from: 'post-2',
          to: 'post-3',
        },
      ],
      description: 'A {{weeks}}-week plan for {{brand}}.',
      automations: [
        {
          kind: 'rule.v1',
          name: 'Warn the day before an unapproved piece is due',
          trigger: {
            type: 'DUE_APPROACHING',
            offset: {
              amount: 1,
              unit: 'DAYS',
            },
          },
          conditions: {
            all: [
              {
                field: 'CUSTOM',
                customFieldId: 'approved',
                op: 'IS_FALSE',
              },
            ],
          },
          actions: [
            {
              type: 'COMMENT',
              body: '{{task.key}} is due tomorrow and is not approved yet.',
            },
            {
              type: 'CHANGE_PRIORITY',
              direction: 'UP',
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Escalate late posts',
          trigger: {
            type: 'TASK_OVERDUE',
          },
          actions: [
            {
              type: 'CHANGE_PRIORITY',
              direction: 'UP',
            },
            {
              type: 'COMMENT',
              body: '{{task.key}} is overdue since {{date}}.',
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Close a piece when all its steps are done',
          trigger: {
            type: 'ALL_SUBTASKS_DONE',
          },
          actions: [
            {
              type: 'SET_STATUS',
              status: {
                category: 'DONE',
              },
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Weekly content planning',
          trigger: {
            type: 'SCHEDULE',
            frequency: 'WEEKLY',
            hour: 8,
            weekdays: [1],
          },
          actions: [
            {
              type: 'CREATE_TASK',
              title: "Plan next week's content ({{date}})",
              priority: 'MEDIUM',
              tags: ['social'],
            },
          ],
        },
      ],
      views: [
        {
          kind: 'view.v1',
          name: 'Calendar',
          layout: 'CALENDAR',
          shared: true,
          config: {
            calendar: {
              dateField: 'DUE_DATE',
            },
            columns: ['TITLE', 'custom:channel'],
          },
        },
        {
          kind: 'view.v1',
          name: 'Needs approval',
          layout: 'LIST',
          shared: true,
          config: {
            filters: {
              all: [
                {
                  field: 'CUSTOM',
                  customFieldId: 'approved',
                  op: 'IS_FALSE',
                },
                {
                  field: 'STATUS_CATEGORY',
                  op: 'NOT_IN',
                  value: ['DONE'],
                },
              ],
            },
            sort: [
              {
                field: 'DUE_DATE',
                dir: 'ASC',
              },
            ],
            columns: ['KEY', 'TITLE', 'DUE_DATE', 'custom:channel'],
          },
        },
        {
          kind: 'view.v1',
          name: 'By channel',
          layout: 'BOARD',
          shared: true,
          config: {
            group: {
              customFieldId: 'channel',
            },
            columns: ['TITLE', 'DUE_DATE'],
          },
        },
        {
          kind: 'view.v1',
          name: 'My content',
          layout: 'LIST',
          shared: false,
          config: {
            filters: {
              all: [
                {
                  field: 'ASSIGNEES',
                  op: 'INCLUDES_ANY',
                  value: ['ME'],
                },
                {
                  field: 'STATUS_CATEGORY',
                  op: 'NOT_IN',
                  value: ['DONE'],
                },
              ],
            },
            sort: [
              {
                field: 'DUE_DATE',
                dir: 'ASC',
              },
            ],
          },
        },
      ],
    },
  ],
  extensions: {
    'acme.notes': {
      owner: 'marketing',
      reviewed: true,
    },
  },
};
