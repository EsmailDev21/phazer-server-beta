import { canonicalJson, contentHash, taskContentHash } from './canonical.hash';

describe('content hash (step 4.2)', () => {
  const task = { externalId: '1', title: 'T', description: 'D', updatedAt: '2026-01-01T00:00:00.000Z', comments: [{ externalId: 'c', body: 'x' }], attachments: [], history: [] };

  it('has the "sha256:<64 hex>" shape', () => {
    expect(contentHash({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('does not depend on key order', () => {
    expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('depends on array order and on every value', () => {
    expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: '1' }));
  });
  it('a task hash ignores comments, attachments, history and updatedAt (a new comment must not re-write the task)...', () => {
    const base = taskContentHash(task);
    expect(taskContentHash({ ...task, comments: [...task.comments, { externalId: 'c2', body: 'y' }] })).toBe(base);
    expect(taskContentHash({ ...task, attachments: [{ externalId: 'a' }], history: [{ externalId: 'h' }] })).toBe(base);
    expect(taskContentHash({ ...task, updatedAt: '2030-01-01T00:00:00.000Z' })).toBe(base);
  });
  it('...but notices a change to the task itself', () => {
    const base = taskContentHash(task);
    expect(taskContentHash({ ...task, title: 'T2' })).not.toBe(base);
    expect(taskContentHash({ ...task, description: 'D2' })).not.toBe(base);
    expect(taskContentHash({ ...task, dueDate: '2026-02-01T00:00:00.000Z' })).not.toBe(base);
  });
  it('omit does not mutate its input and tolerates non-objects', () => {
    const copy = JSON.parse(JSON.stringify(task));
    taskContentHash(task);
    expect(task).toEqual(copy);
    expect(contentHash('x', ['a'])).toMatch(/^sha256:/);
    expect(contentHash([1], ['a'])).toBe(contentHash([1]));
  });
});
