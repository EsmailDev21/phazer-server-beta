import { Priority } from '@prisma/client';
import { NAME_BLOCKED, NAME_CANCELED, NAME_DONE, NAME_IN_PROGRESS, lookupPriority, priorityKey } from './mapping.tables';

const U = Priority.URGENT, H = Priority.HIGH, M = Priority.MEDIUM, L = Priority.LOW;

describe('mapping tables (step 4.3)', () => {
  describe('priorityKey', () => {
    it.each([
      ['High', 'high'], ['  HIGH  ', 'high'], ['High (2)', 'high'], ['Urgent (1)', 'urgent'], ['Priority: High', 'high'], ['priority:high', 'high'],
      ['Priority - Low', 'low'], ['priority/medium', 'medium'], ['No   priority', 'no priority'], ['P1', 'p1'], ['３', '3'], ['', ''], ['Medium (3)', 'medium'],
    ])('%j -> %j', (raw, key) => expect(priorityKey(raw)).toBe(key));
  });

  describe('lookupPriority: each provider\'s own scheme first (diagram 07)', () => {
    it.each([
      // system, raw, expected, reason
      ['jira', 'Highest', U, 'SOURCE_TABLE'], ['jira', 'High', H, 'SOURCE_TABLE'], ['jira', 'Medium', M, 'SOURCE_TABLE'],
      ['jira', 'Low', L, 'SOURCE_TABLE'], ['jira', 'Lowest', L, 'SOURCE_TABLE'], ['jira', 'Blocker', U, 'SOURCE_TABLE'], ['jira', 'Critical', U, 'SOURCE_TABLE'],
      ['jira', 'Major', H, 'SOURCE_TABLE'], ['jira', 'Minor', L, 'SOURCE_TABLE'], ['jira', 'Trivial', L, 'SOURCE_TABLE'], ['jira', '1', U, 'SOURCE_TABLE'], ['jira', '5', L, 'SOURCE_TABLE'],
      ['clickup', 'Urgent', U, 'SOURCE_TABLE'], ['clickup', 'High', H, 'SOURCE_TABLE'], ['clickup', 'Normal', M, 'SOURCE_TABLE'], ['clickup', 'Low', L, 'SOURCE_TABLE'],
      ['clickup', '1', U, 'SOURCE_TABLE'], ['clickup', '3', M, 'SOURCE_TABLE'], ['clickup', '4', L, 'SOURCE_TABLE'],
      ['linear', 'Urgent (1)', U, 'SOURCE_TABLE'], ['linear', 'High (2)', H, 'SOURCE_TABLE'], ['linear', 'Medium (3)', M, 'SOURCE_TABLE'], ['linear', 'Low (4)', L, 'SOURCE_TABLE'],
      ['linear', '0', null, 'SOURCE_TABLE'], ['linear', 'No priority', null, 'SOURCE_TABLE'], ['linear', '1', U, 'SOURCE_TABLE'], ['linear', '4', L, 'SOURCE_TABLE'],
    ] as const)('%s %j -> %s', (system, raw, want, reason) => {
      const r = lookupPriority(system, raw);
      expect(r.priority).toBe(want);
      expect(r.reason).toBe(reason);
      expect(r.confidence).toBe('HIGH');
    });

    it('the system name is case-insensitive', () => {
      expect(lookupPriority('JIRA', 'Highest').reason).toBe('SOURCE_TABLE');
    });

    it.each([
      ['github', 'priority:high', H], ['github', 'Priority: Low', L], ['github', 'P0', U], ['github', 'p1', H], ['github', 'p2', M], ['github', 'p3', L], ['github', 'critical', U],
      ['asana', 'High', H], ['trello', 'urgent', U], ['jira', 'Important', H], ['linear', 'Normal', M], ['unknown-tool', 'LOW', L], ['jira', 'none', null], ['x', 'Not set', null],
    ] as const)('generic words / conventions: %s %j -> %s (MEDIUM confidence)', (system, raw, want) => {
      const r = lookupPriority(system, raw);
      expect(r.priority).toBe(want);
      expect(['SOURCE_TABLE', 'GENERIC_TABLE']).toContain(r.reason);
      if (r.reason === 'GENERIC_TABLE') expect(r.confidence).toBe('MEDIUM');
    });

    it.each([['jira', 'Showstopper'], ['github', 'nice to have'], ['clickup', 'ASAP-ish'], ['linear', '7'], ['jira', '99']])('unrecognised %s %j: no priority, LOW confidence, reason NONE', (system, raw) => {
      expect(lookupPriority(system, raw)).toEqual({ priority: null, confidence: 'LOW', reason: 'NONE' });
    });

    it('a provider\'s own meaning wins over the generic one (Jira "1" is Highest, generic has no "1")', () => {
      expect(lookupPriority('jira', '1').priority).toBe(U);
      expect(lookupPriority('github', '1')).toMatchObject({ reason: 'NONE' });
    });

    it('prototype keys are just unknown values, never table hits', () => {
      for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect(lookupPriority('jira', k)).toEqual({ priority: null, confidence: 'LOW', reason: 'NONE' });
      }
    });
  });

  describe('status name heuristics', () => {
    it.each(['Blocked', 'blocked', 'On Hold', 'on-hold', 'Waiting on client', 'Waiting for review', 'Waiting', 'Impediment', 'Stuck', 'Blocker found', 'Pending customer', 'pending info'])('NAME_BLOCKED matches %j', (n) => {
      expect(NAME_BLOCKED.test(n)).toBe(true);
    });
    it.each(['Unblocked', 'To Do', 'In Progress', 'Done', 'Holding pattern', 'Awaiting QA', 'Stuckey', 'Pending', 'Backlog'])('NAME_BLOCKED does not match %j', (n) => {
      expect(NAME_BLOCKED.test(n)).toBe(false);
    });
    it.each(['done', 'Done', 'Closed', 'COMPLETE', 'Completed', 'Resolved', 'Shipped', 'Released', 'Fixed', 'Deployed'])('NAME_DONE matches the whole name %j', (n) => {
      expect(NAME_DONE.test(n)).toBe(true);
    });
    it.each(['Done for now', 'Almost done', 'Undone', 'Not done', 'To do'])('NAME_DONE is anchored: %j is not done', (n) => {
      expect(NAME_DONE.test(n)).toBe(false);
    });
    it.each(["Won't do", "Won’t fix", 'Wont do', 'Canceled', 'Cancelled', 'Rejected', 'Obsolete', 'Abandoned', 'Duplicate', 'Invalid', 'Declined', 'Not planned'])('NAME_CANCELED matches %j', (n) => {
      expect(NAME_CANCELED.test(n)).toBe(true);
    });
    it.each(['Not started', 'not yet started', 'Not Started', 'Backlog', 'To do', 'Done'])('NAME_IN_PROGRESS does NOT match %j', (n) => {
      expect(NAME_IN_PROGRESS.test(n)).toBe(false);
    });

    it.each(['In Progress', 'Doing', 'In Review', 'Review', 'Testing', 'QA', 'In test', 'Code review', 'Active', 'Development', 'Started', 'Verifying', 'Working on it', 'WIP', 'Underway', 'Ongoing'])('NAME_IN_PROGRESS matches %j', (n) => {
      expect(NAME_IN_PROGRESS.test(n)).toBe(true);
    });
    it.each(['Backlog', 'Open', 'To do', 'Reviewed-later-maybe-never'.replace('Reviewed-later-maybe-never', 'Triage'), 'Inactive'])('NAME_IN_PROGRESS does not match %j', (n) => {
      expect(NAME_IN_PROGRESS.test(n)).toBe(false);
    });
  });
});
