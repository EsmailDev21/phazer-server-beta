import { FieldType, IssueTypeLevel } from '@prisma/client';
import { MappingContext, MappingInventory } from '../mapping.types';

/**
 * Step 4.3 fixtures. SYNTHETIC: modelled on each provider's documented shapes (status categories / types, priority
 * schemes, user fields), not recorded from live accounts. They are the "recorded fixtures" slot of the step's test plan:
 * when the Linear / ClickUp / Jira adapters land (4.5, 4.7, 4.8) their real recorded structure responses replace or join
 * these, and the same table-driven specs run against them unchanged.
 */

export const ANA = { userId: 'local-ana', name: 'Ana Lima', email: 'ana@example.com', emailVerified: true };
export const BEN = { userId: 'local-ben', name: 'Ben Ortiz', email: 'ben@example.com', emailVerified: false }; // NOT verified
export const CLEO = { userId: 'local-cleo', name: 'Cleo Park', email: 'cleo@example.com', emailVerified: true };
export const IMPORTER = 'local-importer';

export const CONTEXT: MappingContext = {
  importerUserId: IMPORTER,
  members: [ANA, BEN, CLEO, { userId: IMPORTER, name: 'Importer', email: 'importer@example.com', emailVerified: true }],
  identityLinks: [],
  issueTypes: [{ id: 'it-bug', name: 'Bug', level: IssueTypeLevel.STANDARD }],
  customFields: [
    { id: 'cf-points', name: 'Story points', dataType: FieldType.NUMBER },
    { id: 'cf-severity', name: 'Severity', dataType: FieldType.TEXT },
  ],
};

export const JIRA: MappingInventory = {
  system: 'jira',
  displayName: 'Jira',
  projects: [
    {
      externalId: 'ENG',
      name: 'Engineering',
      statuses: [
        { externalId: '10000', name: 'Backlog', category: 'BACKLOG' },
        { externalId: '10001', name: 'To Do', category: 'TODO' },
        { externalId: '10002', name: 'In Progress', category: 'IN_PROGRESS' },
        { externalId: '10003', name: 'In Review', category: 'IN_PROGRESS' },
        { externalId: '10004', name: 'Blocked', category: 'IN_PROGRESS' },
        { externalId: '10005', name: 'Done', category: 'DONE' },
        { externalId: '10006', name: "Won't Do", category: 'CANCELED' },
      ],
    },
  ],
  priorities: ['Highest', 'High', 'Medium', 'Low', 'Lowest', 'Showstopper'],
  users: [
    { externalId: 'j-1', name: 'Ana Lima', email: 'ANA@example.com' },
    { externalId: 'j-2', name: 'Ben Ortiz', email: 'ben@example.com' }, // local address not verified
    { externalId: 'j-3', name: 'Dana NoEmail' },
    { externalId: 'j-4', name: 'Automation for Jira', isBot: true },
    { externalId: 'j-5', name: 'Eve Outsider', email: 'eve@elsewhere.com' },
  ],
  issueTypes: [
    { externalId: 'epic', name: 'Epic', level: 'EPIC' },
    { externalId: 'story', name: 'Story' },
    { externalId: 'bug', name: 'bug' }, // case differs from the workspace's "Bug"
    { externalId: 'sub', name: 'Sub-task' },
  ],
  customFields: [
    { externalId: 'cf1', name: 'Story Points', dataType: 'NUMBER' },
    { externalId: 'cf2', name: 'Severity', dataType: 'SELECT', options: [{ label: 'S1' }, { label: 'S2' }] },
    { externalId: 'cf3', name: 'Reviewer', dataType: 'USER' },
  ],
};

export const CLICKUP: MappingInventory = {
  system: 'clickup',
  displayName: 'ClickUp',
  projects: [
    {
      externalId: 'list-1',
      name: 'Sprint list',
      statuses: [
        { externalId: 'open', name: 'Open', category: 'TODO' }, // type: open
        { externalId: 'backlog', name: 'backlog', category: 'UNKNOWN' }, // type: custom
        { externalId: 'prog', name: 'in progress', category: 'UNKNOWN' },
        { externalId: 'rev', name: 'Review', category: 'UNKNOWN' },
        { externalId: 'wait', name: 'Waiting on client', category: 'UNKNOWN' },
        { externalId: 'done', name: 'complete', category: 'DONE' }, // type: done
        { externalId: 'closed', name: 'Closed', category: 'DONE' }, // type: closed
        { externalId: 'wont', name: "Won't fix", category: 'UNKNOWN' },
      ],
    },
  ],
  priorities: ['Urgent', 'High', 'Normal', 'Low', '1', '4'],
  users: [{ externalId: '1001', name: 'Cleo Park', email: 'cleo@example.com' }],
  issueTypes: [],
  customFields: [{ externalId: 'cu1', name: 'Customer', dataType: 'TEXT' }],
};

export const LINEAR: MappingInventory = {
  system: 'linear',
  displayName: 'Linear',
  projects: [
    {
      externalId: 'team-eng', // a Linear TEAM is one project (ADR-0034); its states are 'team:state'
      name: 'Engineering',
      statuses: [
        { externalId: 'team-eng:triage', name: 'Triage', category: 'BACKLOG' },
        { externalId: 'team-eng:backlog', name: 'Backlog', category: 'BACKLOG' },
        { externalId: 'team-eng:todo', name: 'Todo', category: 'TODO' },
        { externalId: 'team-eng:started', name: 'In Progress', category: 'IN_PROGRESS' },
        { externalId: 'team-eng:review', name: 'In Review', category: 'IN_PROGRESS' },
        { externalId: 'team-eng:done', name: 'Done', category: 'DONE' },
        { externalId: 'team-eng:canceled', name: 'Canceled', category: 'CANCELED' },
        { externalId: 'team-eng:dup', name: 'Duplicate', category: 'CANCELED' },
      ],
    },
  ],
  priorities: ['0', '1', '2', '3', '4', 'No priority', 'Urgent'],
  users: [{ externalId: 'lin-1', name: 'Ana Lima', email: 'ana@example.com' }],
  issueTypes: [],
  customFields: [],
};

export const GITHUB: MappingInventory = {
  system: 'github',
  displayName: 'GitHub',
  projects: [
    {
      externalId: 'acme/web',
      name: 'acme/web',
      statuses: [
        { externalId: 'open', name: 'Open', category: 'TODO' },
        { externalId: 'closed', name: 'Closed', category: 'DONE' },
      ],
    },
  ],
  // label heuristics: the adapter hands over the label's value
  priorities: ['priority:high', 'Priority: Low', 'P0', 'p2', 'critical', 'nice to have'],
  users: [
    { externalId: 'gh-octocat', name: 'octocat' }, // GitHub hides e-mails
    { externalId: 'gh-bot', name: 'dependabot[bot]', isBot: true },
  ],
  issueTypes: [],
  customFields: [],
};
