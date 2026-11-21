import { ImportProgressPublisher, ProgressTracker } from './import-progress';

describe('ProgressTracker (step 4.4)', () => {
  it('starts empty and counts per type and outcome', () => {
    const t = new ProgressTracker();
    t.add('task', 'created', 3);
    t.add('task', 'skipped');
    t.add('project', 'created');
    t.add('task', 'failed', 2);
    expect(t.get('task', 'created')).toBe(3);
    expect(t.get('task', 'updated')).toBe(0);
    expect(t.totals()).toEqual({ created: 4, updated: 0, skipped: 1, failed: 2 });
  });
  it('ignores zero / negative additions', () => {
    const t = new ProgressTracker();
    t.add('task', 'created', 0);
    t.add('task', 'created', -5);
    t.charge('2026-01', 0);
    t.charge('2026-01', -1);
    expect(t.snapshot().counts).toEqual({});
    expect(t.chargedByPeriod()).toEqual({});
  });
  it('charges by period (what a rollback refunds)', () => {
    const t = new ProgressTracker();
    t.charge('2026-01', 5);
    t.charge('2026-01', 2);
    t.charge('2026-02', 1);
    expect(t.chargedByPeriod()).toEqual({ '2026-01': 7, '2026-02': 1 });
  });
  it('round-trips through its snapshot (JSON), which is how it survives in the job row', () => {
    const a = new ProgressTracker();
    a.phase = 'writing';
    a.add('task', 'created', 4);
    a.charge('2026-03', 4);
    const b = new ProgressTracker(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.snapshot(new Date(0))).toEqual({ ...a.snapshot(new Date(0)) });
    expect(b.phase).toBe('writing');
  });
  it('snapshots are copies: later changes do not leak into an earlier snapshot', () => {
    const t = new ProgressTracker();
    t.add('task', 'created');
    const s = t.snapshot();
    t.add('task', 'created', 9);
    t.charge('2026-01', 9);
    expect(s.counts.task.created).toBe(1);
    expect(s.chargedByPeriod).toEqual({});
  });
  it.each([null, undefined, 'x', 5, [], { counts: 'x' }, { counts: { task: 5 } }, { counts: { task: { created: -3, skipped: 'a', failed: 2.9, updated: Infinity } } }, { chargedByPeriod: { a: -1, b: 'z', c: 3.7 } }])(
    'a damaged stored value %j never throws and yields only sane numbers',
    (raw) => {
      const t = new ProgressTracker(raw);
      for (const o of Object.values(t.totals())) expect(Number.isInteger(o) && o >= 0).toBe(true);
      for (const n of Object.values(t.chargedByPeriod())) expect(Number.isInteger(n) && n > 0).toBe(true);
    },
  );
  it('does not let a stored type name reach the prototype', () => {
    const t = new ProgressTracker(JSON.parse('{"counts":{"__proto__":{"created":5},"task":{"created":1}}}'));
    expect(({} as Record<string, unknown>).created).toBeUndefined();
    expect(t.get('task', 'created')).toBe(1);
  });
});

describe('ImportProgressPublisher (step 4.4)', () => {
  const msg = { importJobId: 'j1', status: 'RUNNING', progress: null, pauseReason: null };
  it('publishes on the person\'s own SSE channel with a typed, self-describing payload', async () => {
    const calls: Array<[string, string]> = [];
    await new ImportProgressPublisher({ publish: async (c: string, m: string) => void calls.push([c, m]) } as never).publish('user-1', msg);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('sse:user:user-1');
    expect(JSON.parse(calls[0][1])).toMatchObject({ id: 'import:j1', type: 'IMPORT_PROGRESS', sourceType: 'IMPORT', sourceId: 'j1', data: msg });
  });
  it('never throws, whatever the bus does (progress is best effort; the job row is the truth)', async () => {
    const p = new ImportProgressPublisher({ publish: async () => { throw new Error('redis down'); } } as never);
    await expect(p.publish('u', msg)).resolves.toBeUndefined();
  });
});
