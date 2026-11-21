// Step 3.9. First-party template content. Edit here, never in a stored version: a changed seed is
// published by the seeder as a NEW version. `assets` is not written by hand (see seed.prepare.ts).
export const sprintBoardBlueprint: Record<string, unknown> = {
  schemaVersion: 1,
  meta: {
    name: 'Scrum sprint board',
    description:
      'Epics, stories and bugs on a board with a review step; three two-week sprints.',
    kind: 'PROJECT',
    category: 'software',
    locale: 'en',
  },
  variables: [
    {
      key: 'team',
      label: 'Team name',
      type: 'TEXT',
      default: 'Platform',
    },
  ],
  roles: [
    {
      key: 'developer',
      label: 'Developer',
      suggestedAccess: 'MEMBER',
    },
    {
      key: 'product-owner',
      label: 'Product owner',
      suggestedAccess: 'ADMIN',
    },
  ],
  workspace: {
    tags: [
      {
        name: 'backend',
      },
      {
        name: 'frontend',
      },
      {
        name: 'tech-debt',
      },
    ],
    issueTypes: [
      {
        name: 'Epic',
        color: '#8B5CF6',
        level: 'EPIC',
      },
      {
        name: 'Story',
        color: '#22C55E',
        level: 'STANDARD',
      },
      {
        name: 'Bug',
        color: '#EF4444',
        level: 'STANDARD',
      },
      {
        name: 'Sub-task',
        level: 'SUBTASK',
      },
    ],
    iterations: [
      {
        nodeKey: 'sprint-1',
        kind: 'SPRINT',
        name: 'Sprint 1',
        goal: 'Walking skeleton',
        startOffsetDays: 0,
        endOffsetDays: 13,
        project: 'board',
      },
      {
        nodeKey: 'sprint-2',
        kind: 'SPRINT',
        name: 'Sprint 2',
        startOffsetDays: 14,
        endOffsetDays: 27,
        project: 'board',
      },
      {
        nodeKey: 'sprint-3',
        kind: 'SPRINT',
        name: 'Sprint 3',
        startOffsetDays: 28,
        endOffsetDays: 41,
        project: 'board',
      },
    ],
  },
  projects: [
    {
      nodeKey: 'board',
      name: '{{team}} sprint board',
      workflow: {
        statuses: [
          {
            key: 'backlog',
            name: 'Backlog',
            category: 'TODO',
            isDefault: true,
          },
          {
            key: 'ready',
            name: 'Ready',
            category: 'TODO',
          },
          {
            key: 'in-progress',
            name: 'In progress',
            category: 'IN_PROGRESS',
            isDefault: true,
          },
          {
            key: 'code-review',
            name: 'Code review',
            category: 'IN_PROGRESS',
          },
          {
            key: 'blocked',
            name: 'Blocked',
            category: 'BLOCKED',
            color: '#EF4444',
          },
          {
            key: 'done',
            name: 'Done',
            category: 'DONE',
            isDefault: true,
          },
          {
            key: 'wont-do',
            name: "Won't do",
            category: 'DONE',
            excludeFromProgress: true,
          },
        ],
        transitions: [
          {
            from: 'backlog',
            to: 'ready',
          },
          {
            from: 'ready',
            to: 'in-progress',
          },
          {
            from: 'in-progress',
            to: 'code-review',
          },
          {
            from: 'in-progress',
            to: 'blocked',
          },
          {
            from: 'blocked',
            to: 'in-progress',
          },
          {
            from: 'code-review',
            to: 'in-progress',
          },
          {
            from: 'code-review',
            to: 'done',
          },
          {
            from: 'backlog',
            to: 'wont-do',
          },
        ],
        enforceTransitions: true,
      },
      tasks: [
        {
          nodeKey: 'epic-auth',
          title: 'Sign-in and accounts',
          issueType: 'Epic',
          status: 'in-progress',
          priority: 'HIGH',
          children: [
            {
              nodeKey: 'story-login',
              title: 'As a user I can sign in with email',
              issueType: 'Story',
              status: 'ready',
              tags: ['backend', 'frontend'],
              assigneeRoles: ['developer'],
              estimate: 5,
              iteration: 'sprint-1',
              children: [
                {
                  nodeKey: 'login-api',
                  title: 'Login endpoint',
                  issueType: 'Sub-task',
                  tags: ['backend'],
                  estimate: 3,
                },
                {
                  nodeKey: 'login-form',
                  title: 'Login form',
                  issueType: 'Sub-task',
                  tags: ['frontend'],
                  estimate: 2,
                },
              ],
            },
            {
              nodeKey: 'story-reset',
              title: 'As a user I can reset my password',
              issueType: 'Story',
              status: 'backlog',
              estimate: 3,
              iteration: 'sprint-2',
            },
          ],
        },
        {
          nodeKey: 'bug-timeout',
          title: 'Session times out too early',
          description: 'Steps:\n1. sign in\n2. wait\n\nExpected: 30 minutes.',
          issueType: 'Bug',
          priority: 'URGENT',
          tags: ['backend'],
          assigneeRoles: ['developer', 'product-owner'],
          estimate: 2,
          iteration: 'sprint-1',
        },
        {
          nodeKey: 'debt-lint',
          title: 'Turn on the linter in CI',
          issueType: 'Story',
          tags: ['tech-debt'],
          estimate: 1,
          iteration: 'sprint-3',
        },
      ],
      dependencies: [
        {
          from: 'story-login',
          to: 'story-reset',
        },
        {
          from: 'login-api',
          to: 'login-form',
        },
      ],
      automations: [
        {
          kind: 'rule.v1',
          name: 'Flag blocked work',
          trigger: {
            type: 'STATUS_CHANGED',
            to: [
              {
                statusId: 'blocked',
              },
            ],
          },
          actions: [
            {
              type: 'CHANGE_PRIORITY',
              direction: 'UP',
            },
            {
              type: 'COMMENT',
              body: 'Blocked on {{date}}: say what is needed to unblock {{task.key}}.',
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Someone owns work that goes to review',
          trigger: {
            type: 'STATUS_CHANGED',
            to: [
              {
                statusId: 'code-review',
              },
            ],
          },
          conditions: {
            all: [
              {
                field: 'ASSIGNEES',
                op: 'IS_EMPTY',
              },
            ],
          },
          actions: [
            {
              type: 'ASSIGN',
              mode: 'ADD',
              users: ['TRIGGERER'],
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Close a story in review when all its sub-tasks are done',
          trigger: {
            type: 'ALL_SUBTASKS_DONE',
          },
          conditions: {
            all: [
              {
                field: 'STATUS',
                op: 'IN',
                value: ['code-review'],
              },
            ],
          },
          actions: [
            {
              type: 'SET_STATUS',
              status: {
                statusId: 'done',
              },
            },
            {
              type: 'COMMENT',
              body: 'All sub-tasks of {{task.key}} are done.',
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Late bugs become urgent',
          trigger: {
            type: 'TASK_OVERDUE',
          },
          conditions: {
            all: [
              {
                field: 'ISSUE_TYPE',
                op: 'IN',
                value: ['Bug'],
              },
            ],
          },
          actions: [
            {
              type: 'SET_PRIORITY',
              priority: 'URGENT',
            },
            {
              type: 'COMMENT',
              body: 'This bug is overdue since {{date}}.',
            },
          ],
        },
        {
          kind: 'rule.v1',
          name: 'Archive what will not be done',
          trigger: {
            type: 'STATUS_CHANGED',
            to: [
              {
                statusId: 'wont-do',
              },
            ],
          },
          actions: [
            {
              type: 'ARCHIVE_TASK',
            },
          ],
        },
      ],
      views: [
        {
          kind: 'view.v1',
          name: 'Sprint 1',
          layout: 'BOARD',
          shared: true,
          config: {
            group: {
              by: 'STATUS',
            },
            filters: {
              all: [
                {
                  field: 'ITERATION',
                  op: 'IN',
                  value: ['sprint-1'],
                },
              ],
            },
            columns: ['KEY', 'TITLE', 'ASSIGNEES', 'PRIORITY'],
          },
        },
        {
          kind: 'view.v1',
          name: 'Backlog',
          layout: 'LIST',
          shared: true,
          config: {
            filters: {
              all: [
                {
                  field: 'ITERATION',
                  op: 'IS_NOT_SET',
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
                field: 'PRIORITY',
                dir: 'DESC',
              },
            ],
            columns: ['KEY', 'TITLE', 'ISSUE_TYPE', 'PRIORITY', 'ESTIMATE'],
          },
        },
        {
          kind: 'view.v1',
          name: 'Open bugs',
          layout: 'LIST',
          shared: true,
          config: {
            filters: {
              all: [
                {
                  field: 'ISSUE_TYPE',
                  op: 'IN',
                  value: ['Bug'],
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
                field: 'PRIORITY',
                dir: 'DESC',
              },
            ],
          },
        },
        {
          kind: 'view.v1',
          name: 'Timeline',
          layout: 'TIMELINE',
          shared: true,
          config: {
            timeline: {
              startField: 'START_DATE',
              endField: 'DUE_DATE',
            },
            group: {
              by: 'ISSUE_TYPE',
            },
          },
        },
        {
          kind: 'view.v1',
          name: 'My work',
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
                field: 'PRIORITY',
                dir: 'DESC',
              },
            ],
          },
        },
      ],
    },
  ],
};
