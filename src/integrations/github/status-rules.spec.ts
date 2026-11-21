import { TaskStatus } from '@prisma/client';
import { mergeState } from './github-link.service';
import { DEFAULT_STATUS_RULES, decideStatus, rulesFromConfig } from './status-rules';

const { TODO, IN_PROGRESS, BLOCKED, DONE } = TaskStatus;

describe('decideStatus', () => {
  const d = DEFAULT_STATUS_RULES;

  it('defaults: opened -> IN_PROGRESS, merged -> DONE, closed unmerged -> nothing', () => {
    expect(decideStatus(d, 'opened', TODO)).toBe(IN_PROGRESS);
    expect(decideStatus(d, 'merged', IN_PROGRESS)).toBe(DONE);
    expect(decideStatus(d, 'merged', TODO)).toBe(DONE);
    expect(decideStatus(d, 'closed', IN_PROGRESS)).toBeNull();
  });

  it('opened/merged only move FORWARD: never drag a Done task back, never unblock a Blocked one', () => {
    expect(decideStatus(d, 'opened', DONE)).toBeNull();
    expect(decideStatus(d, 'opened', IN_PROGRESS)).toBeNull();
    expect(decideStatus(d, 'opened', BLOCKED)).toBeNull();
    expect(decideStatus(d, 'merged', DONE)).toBeNull();
    expect(decideStatus(d, 'merged', BLOCKED)).toBe(DONE);
  });

  it('a configured closed rule may move backwards, but never out of DONE', () => {
    const r = { ...d, prClosed: TODO };
    expect(decideStatus(r, 'closed', IN_PROGRESS)).toBe(TODO);
    expect(decideStatus(r, 'closed', BLOCKED)).toBe(TODO);
    expect(decideStatus(r, 'closed', DONE)).toBeNull();
    expect(decideStatus(r, 'closed', TODO)).toBeNull();
  });

  it('a cleared / missing rule does nothing', () => {
    expect(decideStatus({ prMerged: null }, 'merged', TODO)).toBeNull();
    expect(decideStatus({}, 'opened', TODO)).toBeNull();
    expect(decideStatus(null, 'opened', TODO)).toBeNull();
    expect(decideStatus(undefined, 'merged', TODO)).toBeNull();
  });
});

describe('rulesFromConfig', () => {
  it('reads valid statuses and drops anything else (the column is hand-editable JSON)', () => {
    expect(rulesFromConfig({ statusRules: { prOpened: 'IN_PROGRESS', prMerged: 'NOPE', prClosed: 5 } })).toEqual({ prOpened: 'IN_PROGRESS', prMerged: null, prClosed: null });
    expect(rulesFromConfig(null)).toEqual({ prOpened: null, prMerged: null, prClosed: null });
    expect(rulesFromConfig('garbage')).toEqual({ prOpened: null, prMerged: null, prClosed: null });
    expect(rulesFromConfig({ statusRules: 'x' })).toEqual({ prOpened: null, prMerged: null, prClosed: null });
  });
});

describe('mergeState (out-of-order deliveries)', () => {
  it('merged is final', () => {
    expect(mergeState('merged', 'open')).toBe('merged');
    expect(mergeState('merged', 'closed')).toBe('merged');
  });
  it('closed only reopens through a reopened action', () => {
    expect(mergeState('closed', 'open', 'opened')).toBe('closed'); // a late "opened" arrives after "closed"
    expect(mergeState('closed', 'open', 'edited')).toBe('closed');
    expect(mergeState('closed', 'open', 'reopened')).toBe('open');
    expect(mergeState('closed', 'merged')).toBe('merged');
  });
  it('normal progress and kinds without a state', () => {
    expect(mergeState('draft', 'open', 'ready_for_review')).toBe('open');
    expect(mergeState('open', 'merged', 'closed')).toBe('merged');
    expect(mergeState(null, 'open')).toBe('open');
    expect(mergeState(null, null)).toBeNull();
    expect(mergeState('open', null)).toBe('open');
  });
});
