import { TaskStatus } from '@prisma/client';
import {
  MAX_WORKFLOW_STATUSES,
  StatusRow,
  WorkflowSnapshot,
  assertWorkflowValid,
  categoryDefault,
  electDefaults,
  initialStatus,
  remapForProject,
  resolveWrite,
} from './workflow-rules';

const st = (
  id: string,
  category: TaskStatus,
  position: number,
  over: Partial<StatusRow> = {},
): StatusRow => ({
  id,
  name: id,
  nameKey: id.toLowerCase(),
  color: '#000000',
  position,
  category,
  isDefault: false,
  excludeFromProgress: false,
  ...over,
});

const T = TaskStatus;
// Seeded shape plus a custom "Review" (IN_PROGRESS) and "Canceled" (DONE, excluded).
const statuses = (): StatusRow[] => [
  st('todo', T.TODO, 0, { isDefault: true }),
  st('prog', T.IN_PROGRESS, 1, { isDefault: true }),
  st('review', T.IN_PROGRESS, 2),
  st('blocked', T.BLOCKED, 3, { isDefault: true }),
  st('done', T.DONE, 4, { isDefault: true }),
  st('canceled', T.DONE, 5, { excludeFromProgress: true }),
];
const snap = (over: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({
  projectId: 'p',
  statuses: statuses(),
  initialStatusId: 'todo',
  enforceTransitions: false,
  transitions: [],
  ...over,
});
const on = { enforce: true };

describe('resolveWrite - ADR-0006 decision 5 table', () => {
  it('status only, same category as the current status: nothing changes', () => {
    const r = resolveWrite(
      snap(),
      { status: T.IN_PROGRESS, workflowStatusId: 'review' },
      { status: T.IN_PROGRESS },
      on,
    );
    expect(r).toEqual({
      status: T.IN_PROGRESS,
      workflowStatusId: 'review',
      changed: false,
    });
  });

  it('status only, different category: the category default', () => {
    const r = resolveWrite(
      snap(),
      { status: T.IN_PROGRESS, workflowStatusId: 'review' },
      { status: T.DONE },
      on,
    );
    expect(r).toMatchObject({
      status: T.DONE,
      workflowStatusId: 'done',
      changed: true,
    });
  });

  it('create without anything: the project initial status', () => {
    expect(resolveWrite(snap(), null, {}, on)).toMatchObject({
      workflowStatusId: 'todo',
      status: T.TODO,
    });
    expect(
      resolveWrite(snap({ initialStatusId: 'prog' }), null, {}, on)
        .workflowStatusId,
    ).toBe('prog');
  });

  it('create with status only: that category default', () => {
    expect(resolveWrite(snap(), null, { status: T.DONE }, on)).toMatchObject({
      workflowStatusId: 'done',
    });
  });

  it('workflowStatusId only: sets both, category derived', () => {
    expect(
      resolveWrite(snap(), null, { workflowStatusId: 'review' }, on),
    ).toMatchObject({ status: T.IN_PROGRESS, workflowStatusId: 'review' });
  });

  it('both, disagreeing: 400; both agreeing: fine', () => {
    expect(() =>
      resolveWrite(
        snap(),
        null,
        { status: T.DONE, workflowStatusId: 'review' },
        on,
      ),
    ).toThrow(/does not match/);
    expect(
      resolveWrite(
        snap(),
        null,
        { status: T.IN_PROGRESS, workflowStatusId: 'review' },
        on,
      ).workflowStatusId,
    ).toBe('review');
  });

  it('a status id from another project: 400', () => {
    expect(() =>
      resolveWrite(snap(), null, { workflowStatusId: 'nope' }, on),
    ).toThrow(/does not belong/);
  });

  it('a category with no status answers 409, not an invented status (decision 4)', () => {
    const noBlocked = snap({
      statuses: statuses().filter((s) => s.category !== T.BLOCKED),
    });
    expect(() =>
      resolveWrite(
        noBlocked,
        { status: T.TODO, workflowStatusId: 'todo' },
        { status: T.BLOCKED },
        on,
      ),
    ).toThrow(/no Blocked status/);
  });

  it('an unmapped task re-sending its own category is healed quietly (no change event)', () => {
    const r = resolveWrite(
      snap(),
      { status: T.DONE, workflowStatusId: null },
      { status: T.DONE },
      on,
    );
    expect(r).toEqual({
      status: T.DONE,
      workflowStatusId: 'done',
      changed: false,
    });
  });

  it('same specific status again is a no-op', () => {
    expect(
      resolveWrite(
        snap(),
        { status: T.IN_PROGRESS, workflowStatusId: 'review' },
        { workflowStatusId: 'review' },
        on,
      ).changed,
    ).toBe(false);
  });

  it('moving inside one category (a different specific status) IS a change', () => {
    expect(
      resolveWrite(
        snap(),
        { status: T.IN_PROGRESS, workflowStatusId: 'prog' },
        { workflowStatusId: 'review' },
        on,
      ),
    ).toMatchObject({ changed: true, workflowStatusId: 'review' });
  });
});

describe('resolveWrite - transitions (decision 7)', () => {
  const enforcing = (transitions: Array<[string, string]>) =>
    snap({
      enforceTransitions: true,
      transitions: transitions.map(([fromStatusId, toStatusId]) => ({
        fromStatusId,
        toStatusId,
      })),
    });
  const cur = { status: T.TODO, workflowStatusId: 'todo' };

  it('allowed pair passes, forbidden pair 409s with the allowed ids', () => {
    const s = enforcing([['todo', 'prog']]);
    expect(
      resolveWrite(s, cur, { workflowStatusId: 'prog' }, on).workflowStatusId,
    ).toBe('prog');
    try {
      resolveWrite(s, cur, { workflowStatusId: 'done' }, on);
      fail('should throw');
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({
        code: 'TRANSITION_NOT_ALLOWED',
        details: { allowedStatusIds: ['prog'] },
      });
    }
  });

  it('a legacy status-only request is checked against the category default', () => {
    expect(() =>
      resolveWrite(
        enforcing([['todo', 'review']]),
        cur,
        { status: T.IN_PROGRESS },
        on,
      ),
    ).toThrow(/does not allow/);
  });

  it('create is never restricted; a system writer (enforce: false) bypasses', () => {
    expect(
      resolveWrite(enforcing([]), null, { status: T.DONE }, on)
        .workflowStatusId,
    ).toBe('done');
    expect(
      resolveWrite(
        enforcing([]),
        cur,
        { workflowStatusId: 'done' },
        { enforce: false },
      ).workflowStatusId,
    ).toBe('done');
  });

  it('staying put is always allowed', () => {
    expect(
      resolveWrite(enforcing([]), cur, { workflowStatusId: 'todo' }, on)
        .changed,
    ).toBe(false);
  });

  it('not enforcing: transitions are ignored', () => {
    expect(
      resolveWrite(
        snap({ transitions: [] }),
        cur,
        { workflowStatusId: 'done' },
        on,
      ).workflowStatusId,
    ).toBe('done');
  });
});

describe('defaults and remapping', () => {
  it('categoryDefault: flagged one, else lowest position', () => {
    expect(categoryDefault(statuses(), T.IN_PROGRESS)?.id).toBe('prog');
    const unflagged = statuses().map((s) => ({ ...s, isDefault: false }));
    expect(categoryDefault(unflagged, T.DONE)?.id).toBe('done');
    expect(
      categoryDefault(
        unflagged.filter((s) => s.category !== T.BLOCKED),
        T.BLOCKED,
      ),
    ).toBeNull();
  });

  it('initialStatus falls back to the TODO default when the pointer is null', () => {
    expect(initialStatus(snap({ initialStatusId: null })).id).toBe('todo');
  });

  it('electDefaults: exactly one per non-empty category, deterministic', () => {
    const messy = [
      st('a', T.TODO, 0, { isDefault: true }),
      st('b', T.TODO, 1, { isDefault: true }),
      st('c', T.DONE, 2),
      st('d', T.DONE, 3),
    ];
    const r = electDefaults(messy);
    expect(
      r.filter((s) => s.category === T.TODO && s.isDefault).map((s) => s.id),
    ).toEqual(['a']);
    expect(
      r.filter((s) => s.category === T.DONE && s.isDefault).map((s) => s.id),
    ).toEqual(['c']);
  });

  it('remapForProject: name match inside the category, else the default, Inbox = null', () => {
    const target = [
      st('t-todo', T.TODO, 0, { isDefault: true }),
      st('t-prog', T.IN_PROGRESS, 1, { isDefault: true }),
      st('t-review', T.IN_PROGRESS, 2, { nameKey: 'review' }),
    ];
    expect(
      remapForProject(target, { category: T.IN_PROGRESS, nameKey: 'review' }),
    ).toBe('t-review');
    expect(
      remapForProject(target, { category: T.IN_PROGRESS, nameKey: 'qa' }),
    ).toBe('t-prog');
    // same name but another category must not match
    expect(
      remapForProject(target, { category: T.TODO, nameKey: 'review' }),
    ).toBe('t-todo');
    expect(
      remapForProject(null, { category: T.TODO, nameKey: 'x' }),
    ).toBeNull();
    expect(() =>
      remapForProject(target, { category: T.DONE, nameKey: 'x' }),
    ).toThrow(/no Done status/);
  });
});

describe('assertWorkflowValid (decisions 4, 10, 11)', () => {
  it('a healthy workflow passes (BLOCKED optional)', () => {
    expect(() => assertWorkflowValid(statuses(), 'todo')).not.toThrow();
    expect(() =>
      assertWorkflowValid(
        statuses().filter((s) => s.category !== T.BLOCKED),
        'todo',
      ),
    ).not.toThrow();
  });

  it.each([T.TODO, T.IN_PROGRESS, T.DONE])('%s is required', (cat) => {
    expect(() =>
      assertWorkflowValid(
        statuses().filter((s) => s.category !== cat),
        'todo',
      ),
    ).toThrow(/at least one/);
  });

  it('excludeFromProgress only on DONE', () => {
    const bad = statuses().map((s) =>
      s.id === 'review' ? { ...s, excludeFromProgress: true } : s,
    );
    expect(() => assertWorkflowValid(bad, 'todo')).toThrow(/Done category/);
  });

  it('initial status must exist and be TODO', () => {
    expect(() => assertWorkflowValid(statuses(), 'nope')).toThrow(
      /initial status/,
    );
    expect(() => assertWorkflowValid(statuses(), 'prog')).toThrow(
      /To Do category/,
    );
  });

  it(`caps a project at ${MAX_WORKFLOW_STATUSES} statuses`, () => {
    const many = [
      ...statuses(),
      ...Array.from({ length: MAX_WORKFLOW_STATUSES }, (_, i) =>
        st(`x${i}`, T.TODO, 10 + i),
      ),
    ];
    expect(() => assertWorkflowValid(many, 'todo')).toThrow(/at most/);
  });
});
