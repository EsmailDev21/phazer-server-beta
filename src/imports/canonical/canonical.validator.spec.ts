import { CANONICAL_LIMITS as L } from './canonical.limits';
import { CANONICAL_ITEM_KEYS, MAX_BUNDLE_ISSUES, validateBundle } from './canonical.validator';
import { CANONICAL_V1_SCHEMA } from './canonical.schema';
import { BundleIssue, BundleValidation, CanonicalBundle, CanonicalTask } from './canonical.types';
import { TRUNCATION_MARKER } from './canonical.text';

const NOW = new Date('2026-06-15T12:00:00Z');
const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  source: { system: 'linear', displayName: 'Linear' },
  ...extra,
});
const task = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ externalId: 't1', title: 'A task', ...extra });
const v = (page: unknown): BundleValidation => validateBundle(page, { now: NOW });
function good(page: unknown): { bundle: CanonicalBundle; issues: BundleIssue[]; stats: Extract<BundleValidation, { ok: true }>['stats'] } {
  const r = v(page);
  if ('fatal' in r) throw new Error(`expected ok, got fatal ${r.fatal.code}: ${r.fatal.message} ${JSON.stringify(r.fatal.details)}`);
  return r;
}
const tasksOf = (page: unknown): CanonicalTask[] => good(page).bundle.tasks ?? [];
const codes = (r: { issues: BundleIssue[] }) => r.issues.map((i) => i.code);
const fatalOf = (page: unknown) => {
  const r = v(page);
  if (!('fatal' in r)) throw new Error('expected fatal');
  return r.fatal;
};

describe('validateBundle (step 4.2)', () => {
  // ------------------------------------------------------------------------------------------------------------
  describe('fatal: the page itself is unusable', () => {
    it.each([[null], [undefined], [[]], ['x'], [5], [true]])('%j is NOT_JSON', (x) => {
      expect(fatalOf(x).code).toBe('NOT_JSON');
    });

    it('values that are not JSON anywhere in the page are NOT_JSON', () => {
      class C { a = 1; }
      for (const bad of [NaN, Infinity, -Infinity, () => 1, Symbol('s'), BigInt(1), new Date(), new C(), new Map(), new Set()]) {
        expect(fatalOf(base({ tasks: [task({ title: bad })] })).code).toBe('NOT_JSON');
      }
      expect(fatalOf(base({ tasks: [undefined] })).code).toBe('NOT_JSON'); // undefined in an array
      const holes = new Array(2); holes[0] = task();
      expect(fatalOf(base({ tasks: holes })).code).toBe('NOT_JSON');
    });

    it('an undefined PROPERTY is simply absent (JSON.stringify semantics), not an error', () => {
      expect(tasksOf(base({ tasks: [task({ description: undefined })] }))[0]).not.toHaveProperty('description');
    });

    it('a __proto__ key (as JSON.parse can create) is refused', () => {
      expect(fatalOf(JSON.parse('{"schemaVersion":1,"source":{"system":"a","displayName":"A"},"__proto__":{"x":1}}')).code).toBe('NOT_JSON');
      expect(fatalOf(JSON.parse('{"schemaVersion":1,"source":{"system":"a","displayName":"A"},"tasks":[{"externalId":"1","title":"t","__proto__":{}}]}')).code).toBe('NOT_JSON');
    });

    it('nesting over the ceiling is TOO_DEEP; a cyclic object graph ends the same way instead of looping', () => {
      let deep: unknown = 'x';
      for (let i = 0; i < L.maxJsonDepth + 5; i++) deep = { a: deep };
      expect(fatalOf(base({ extra: deep })).code).toBe('TOO_DEEP');
      const cyc: Record<string, unknown> = { externalId: 't', title: 'x' };
      cyc.self = cyc;
      expect(fatalOf(base({ tasks: [cyc] })).code).toBe('TOO_DEEP');
    });

    it('a page over the byte ceiling is TOO_LARGE', () => {
      const f = fatalOf(base({ tasks: [task({ description: 'x'.repeat(L.maxPageBytes + 10) })] }));
      expect(f.code).toBe('TOO_LARGE');
    });

    it.each([[undefined], [0], [2], ['1'], [null]])('schemaVersion %j is VERSION_INVALID', (ver) => {
      expect(fatalOf({ ...base(), schemaVersion: ver }).code).toBe('VERSION_INVALID');
    });

    it('a collection that is not a list is BAD_SHAPE; over its page ceiling is PAGE_TOO_LARGE (the adapter picks the page size)', () => {
      expect(fatalOf(base({ tasks: {} })).code).toBe('BAD_SHAPE');
      expect(fatalOf(base({ users: 'x' })).code).toBe('BAD_SHAPE');
      const f = fatalOf(base({ tasks: Array.from({ length: L.maxTasks + 1 }, (_, i) => task({ externalId: `t${i}` })) }));
      expect(f.code).toBe('PAGE_TOO_LARGE');
      expect(f.message).toContain(String(L.maxTasks));
    });

    it('a field the format does not have is an ADAPTER_BUG, naming where (never silently ignored)', () => {
      const f = fatalOf(base({ tasks: [task({ descripton: 'typo' })] }));
      expect(f.code).toBe('ADAPTER_BUG');
      expect(f.details).toEqual(['tasks[0]: unknown field "descripton"']);
      expect(fatalOf(base({ extraCollection: [] })).details).toEqual(['page: unknown field "extraCollection"']);
      expect(fatalOf({ ...base(), source: { system: 'x', displayName: 'X', evil: 1 } }).details).toEqual(['source: unknown field "evil"']);
      expect(fatalOf(base({ tasks: [task({ comments: [{ externalId: 'c', body: 'b', mood: 1 }] })] })).details).toEqual(['task:t1.comments[0]: unknown field "mood"']);
    });

    it('a missing or malformed source is an ADAPTER_BUG from the schema gate', () => {
      expect(fatalOf({ schemaVersion: 1 }).code).toBe('ADAPTER_BUG');
      expect(fatalOf({ schemaVersion: 1, source: { system: 'Bad Slug!', displayName: 'x' } }).code).toBe('ADAPTER_BUG');
      expect(fatalOf({ schemaVersion: 1, source: { system: 'ok', displayName: '' } }).code).toBe('ADAPTER_BUG');
    });

    it('a fatal result still carries the issues found so far, and never a bundle', () => {
      const r = v(base({ tasks: [task({ title: 'bad\u0000' }), task({ externalId: 't2', typo: 1 })] }));
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty('bundle');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('a valid page', () => {
    it('minimal: source only', () => {
      const r = good(base());
      expect(r.bundle).toEqual(base());
      expect(r.issues).toEqual([]);
      expect(r.stats.tasks).toBe(0);
    });

    /** Every field of every entity, all valid: no issues, output equals input (types and schema agree). */
    const KITCHEN_SINK = base({
      users: [{ externalId: 'u1', name: 'Ana Lima', email: 'ana@example.com', avatarUrl: 'https://x.com/a.png', isBot: false }],
      projects: [{
        externalId: 'p1', key: 'ENG', name: 'Engineering', description: 'Desc', url: 'https://x.com/p', archived: false, createdAt: '2025-01-01T00:00:00.000Z',
        statuses: [
          { externalId: 's1', name: 'Todo', category: 'TODO', color: '#112233', position: 0 },
          { externalId: 's2', name: 'Done', category: 'DONE', position: 1 },
        ],
      }],
      tags: [{ name: 'bug', color: '#ff0000' }, { name: 'ui' }],
      customFields: [
        { externalId: 'f1', name: 'Severity', dataType: 'SELECT', options: [{ externalId: 'o1', label: 'High' }, { label: 'Low' }] },
        { externalId: 'f2', name: 'Cost', dataType: 'NUMBER' },
      ],
      issueTypes: [{ externalId: 'i1', name: 'Bug', level: 'STANDARD', color: '#aa0000' }],
      iterations: [{ externalId: 'it1', kind: 'SPRINT', name: 'Sprint 1', goal: 'Ship', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-14T00:00:00.000Z', projectExternalId: 'p1' }],
      tasks: [{
        externalId: 't1', key: 'ENG-1', url: 'https://x.com/t1', projectExternalId: 'p1', title: 'Fix', description: 'Body **md**', statusExternalId: 's1',
        priority: 'High', issueTypeExternalId: 'i1', tags: ['bug'], customValues: [{ fieldExternalId: 'f1', value: 'High' }, { fieldExternalId: 'f2', value: 3.5 }],
        assigneeExternalIds: ['u1'], creatorExternalId: 'u1', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
        startDate: '2026-01-04T00:00:00.000Z', dueDate: '2026-01-05T00:00:00.000Z', estimate: 5, iterationExternalId: 'it1', archived: false,
        comments: [
          { externalId: 'c1', authorExternalId: 'u1', authorName: 'Ana', body: 'Top', createdAt: '2026-01-02T01:00:00.000Z', editedAt: '2026-01-02T02:00:00.000Z' },
          { externalId: 'c2', body: 'Reply', parentExternalId: 'c1' },
        ],
        attachments: [{ externalId: 'a1', fileName: 'x.png', mimeType: 'image/png', sizeBytes: 10, providerRef: 'ref-1', uploaderExternalId: 'u1', createdAt: '2026-01-02T00:00:00.000Z' }],
        history: [{ externalId: 'h1', actorExternalId: 'u1', at: '2026-01-02T00:30:00.000Z', field: 'status', from: 'Todo', to: 'Done' }, { externalId: 'h2', at: '2026-01-02T00:40:00.000Z', field: 'assignee', from: null, to: 'Ana' }],
      }, { externalId: 't2', title: 'Child', parentExternalId: 't1' }],
      dependencies: [{ externalId: 'd1', fromExternalId: 't1', toExternalId: 't2', type: 'BLOCKS' }],
    });

    it('a page using every field passes with NO issues and comes back unchanged', () => {
      const r = good(KITCHEN_SINK);
      expect(r.issues).toEqual([]);
      expect(r.bundle).toEqual(KITCHEN_SINK);
      expect(r.stats).toEqual({ users: 1, projects: 1, tags: 2, customFields: 2, issueTypes: 1, iterations: 1, tasks: 2, comments: 2, attachments: 1, history: 2, dependencies: 1, skipped: 0 });
    });

    it('validation is idempotent: validating the output yields the same output and no issues', () => {
      const messy = base({ tasks: [task({ title: '  spaced \n title ', description: '  body \r\n line  ', createdAt: '2026-03-04', tags: ['A', 'a ', ' b'] })] });
      const once = good(messy);
      const twice = good(once.bundle);
      expect(twice.bundle).toEqual(once.bundle);
      expect(twice.issues).toEqual([]);
    });

    it('never mutates its input (deep-frozen input does not throw)', () => {
      const frozen = JSON.parse(JSON.stringify(KITCHEN_SINK));
      const freeze = (o: unknown): void => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(freeze); } };
      freeze(frozen);
      expect(() => v(frozen)).not.toThrow();
      expect(frozen).toEqual(KITCHEN_SINK);
    });

    it('is deterministic for a fixed `now`', () => {
      const page = base({ tasks: [task({ createdAt: '2099-01-01', title: '' })] });
      expect(v(page)).toEqual(v(page));
    });

    it('the output is a fresh object: changing it cannot reach the adapter\'s data', () => {
      const input = base({ tasks: [task()] });
      const r = good(input);
      (r.bundle.tasks as CanonicalTask[])[0].title = 'changed';
      expect((input.tasks as Array<Record<string, unknown>>)[0].title).toBe('A task');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('items: skipped with an issue, the rest of the page goes on', () => {
    it('non-object entries, missing / empty / non-string / too-long ids', () => {
      const r = good(base({ tasks: [null, 5, 'x', [], task({ externalId: '' }), task({ externalId: 5 }), task({ externalId: 'x'.repeat(L.externalId + 1) }), { title: 'no id' }, task({ externalId: 'ok' })] }));
      expect(r.bundle.tasks?.map((t) => t.externalId)).toEqual(['ok']);
      expect(r.stats.skipped).toBe(8);
      expect(r.issues.every((i) => i.severity === 'ERROR' && i.code === 'ITEM_INVALID')).toBe(true);
      expect(r.issues[0].externalRef).toBe('task[0]');
    });

    it('a duplicate id on one page: the FIRST wins, the second is skipped and reported against the id', () => {
      const r = good(base({ tasks: [task({ title: 'first' }), task({ title: 'second' })] }));
      expect(r.bundle.tasks).toHaveLength(1);
      expect(r.bundle.tasks?.[0].title).toBe('first');
      expect(r.issues).toEqual([expect.objectContaining({ code: 'DUPLICATE_ID', severity: 'ERROR', externalRef: 'task:t1' })]);
    });

    it('issues are shaped for ImportIssueService (severity, code, externalRef, message) and refs read "<kind>:<id>"', () => {
      const r = good(base({ tasks: [task({ title: '' })], users: [{ externalId: 'u', name: '' }] }));
      for (const i of r.issues) {
        expect(Object.keys(i).sort()).toEqual(['code', 'externalRef', 'message', 'severity']);
        expect(typeof i.message).toBe('string');
      }
      expect(r.issues.map((i) => i.externalRef)).toContain('task:t1');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('text repair', () => {
    it('control characters are removed and reported ONCE per item, attributed to the item', () => {
      const r = good(base({ tasks: [task({ title: 'bad\u0000title\u0007', description: 'a\u0001b', comments: [{ externalId: 'c', body: 'x\u0000' }] }), task({ externalId: 't2' })] }));
      expect(r.bundle.tasks?.[0].title).toBe('badtitle');
      expect(r.bundle.tasks?.[0].description).toBe('ab');
      expect(r.bundle.tasks?.[0].comments?.[0].body).toBe('x');
      expect(r.issues).toEqual([expect.objectContaining({ code: 'TEXT_SANITIZED', severity: 'INFO', externalRef: 'task:t1' })]);
    });
    it('control characters in a KEY are removed too, and a lone surrogate is dropped', () => {
      const r = good(base({ tasks: [{ externalId: 't1', title: 'ok\ud800', 'descr\u0000iption': 'd' }] }));
      expect(r.bundle.tasks?.[0]).toEqual({ externalId: 't1', title: 'ok', description: 'd' });
    });
    it('text sanitising on the page itself (not an item) is reported without a ref', () => {
      const r = good({ schemaVersion: 1, source: { system: 'linear', displayName: 'Lin\u0000ear' } });
      expect(r.bundle.source.displayName).toBe('Linear');
      expect(r.issues).toEqual([expect.objectContaining({ code: 'TEXT_SANITIZED', externalRef: null })]);
    });

    it('titles: collapsed to one line, empty -> "(untitled)", over-long cut with an ellipsis', () => {
      expect(tasksOf(base({ tasks: [task({ title: '  a \n b\t c  ' })] }))[0].title).toBe('a b c');
      for (const empty of ['', '   ', '\n\t', null, undefined]) {
        const r = good(base({ tasks: [task({ title: empty })] }));
        expect(r.bundle.tasks?.[0].title).toBe('(untitled)');
        expect(codes(r)).toEqual(['TITLE_EMPTY']);
      }
      const long = good(base({ tasks: [task({ title: 'x'.repeat(L.title + 50) })] }));
      expect(long.bundle.tasks?.[0].title).toHaveLength(L.title);
      expect(long.bundle.tasks?.[0].title.endsWith('…')).toBe(true);
      expect(codes(long)).toEqual(['TITLE_TRUNCATED']);
    });

    it('a title of the wrong type is dropped to "(untitled)" with a field warning', () => {
      const r = good(base({ tasks: [task({ title: 42 })] }));
      expect(r.bundle.tasks?.[0].title).toBe('(untitled)');
      expect(codes(r)).toEqual(['FIELD_INVALID', 'TITLE_EMPTY']);
    });

    it('descriptions: line endings normalised, trimmed, empty omitted, over-long cut with a visible marker', () => {
      expect(tasksOf(base({ tasks: [task({ description: '\r\n a\r\nb \n' })] }))[0].description).toBe('a\nb');
      expect(tasksOf(base({ tasks: [task({ description: '   ' })] }))[0]).not.toHaveProperty('description');
      const r = good(base({ tasks: [task({ description: 'word '.repeat(5000) })] }));
      const d = r.bundle.tasks?.[0].description as string;
      expect(d.length).toBeLessThanOrEqual(L.description);
      expect(d.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(codes(r)).toEqual(['DESCRIPTION_TRUNCATED']);
    });

    it('markdown structure is preserved (not collapsed like a title)', () => {
      const md = '# H\n\n- a\n- b\n\n```js\ncode\n```';
      expect(tasksOf(base({ tasks: [task({ description: md })] }))[0].description).toBe(md);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('dates', () => {
    const t = (x: Record<string, unknown>) => good(base({ tasks: [task(x)] }));

    it('are normalised to canonical UTC instants whatever the input offset', () => {
      const r = t({ createdAt: '2026-03-04T10:20:30+02:00', dueDate: '2026-04-01', startDate: '2026-03-01T00:00:00Z' });
      expect(r.bundle.tasks?.[0]).toMatchObject({ createdAt: '2026-03-04T08:20:30.000Z', dueDate: '2026-04-01T00:00:00.000Z', startDate: '2026-03-01T00:00:00.000Z' });
      expect(r.issues).toEqual([]);
    });
    it.each([['03/04/2026'], ['tomorrow'], ['2026-02-30'], ['0001-01-01'], [12345], [{}], [true]])('an unusable date %j is dropped and reported', (bad) => {
      const r = t({ dueDate: bad });
      expect(r.bundle.tasks?.[0]).not.toHaveProperty('dueDate');
      expect(codes(r)).toEqual(['DATE_INVALID']);
    });
    it('a due date before the start date: the START is dropped (the due date is the one people plan by)', () => {
      const r = t({ startDate: '2026-05-10', dueDate: '2026-05-01' });
      expect(r.bundle.tasks?.[0]).toMatchObject({ dueDate: '2026-05-01T00:00:00.000Z' });
      expect(r.bundle.tasks?.[0]).not.toHaveProperty('startDate');
      expect(codes(r)).toEqual(['DATE_ORDER']);
    });
    it('updatedAt before createdAt is set equal to createdAt', () => {
      const r = t({ createdAt: '2026-05-10', updatedAt: '2026-05-01' });
      expect(r.bundle.tasks?.[0].updatedAt).toBe('2026-05-10T00:00:00.000Z');
      expect(codes(r)).toEqual(['DATE_ORDER']);
    });
    it('created / updated times in the future are dropped (clock skew > 1 day is a bug at the source); due dates may be in the future', () => {
      const r = t({ createdAt: '2026-06-17T00:00:00Z', updatedAt: '2026-06-15T13:00:00Z', dueDate: '2030-01-01' });
      expect(r.bundle.tasks?.[0]).not.toHaveProperty('createdAt');
      expect(r.bundle.tasks?.[0].updatedAt).toBe('2026-06-15T13:00:00.000Z'); // within the 1-day tolerance
      expect(r.bundle.tasks?.[0].dueDate).toBe('2030-01-01T00:00:00.000Z');
      expect(codes(r)).toEqual(['DATE_INVALID']);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('task fields', () => {
    const t = (x: Record<string, unknown>) => good(base({ tasks: [task(x)] }));

    it('estimate: 0..1000 numbers only', () => {
      expect(t({ estimate: 0 }).bundle.tasks?.[0].estimate).toBe(0);
      expect(t({ estimate: 1000 }).bundle.tasks?.[0].estimate).toBe(1000);
      expect(t({ estimate: 2.5 }).bundle.tasks?.[0].estimate).toBe(2.5);
      for (const bad of [-1, 1001, '5', true, {}]) {
        const r = t({ estimate: bad });
        expect(r.bundle.tasks?.[0]).not.toHaveProperty('estimate');
        expect(codes(r)).toEqual(['ESTIMATE_INVALID']);
      }
    });

    it('tags: trimmed, de-duplicated by folded name, non-text dropped, capped', () => {
      const r = t({ tags: ['Bug', 'bug ', ' BUG', 'Ui', 5, '', 'Ünï', 'ünï'] });
      expect(r.bundle.tasks?.[0].tags).toEqual(['Bug', 'Ui', 'Ünï']);
      expect(codes(r)).toEqual(['TAG_INVALID', 'TAG_INVALID']);
      const many = t({ tags: Array.from({ length: L.maxTagsPerTask + 5 }, (_, i) => `tag${i}`) });
      expect(many.bundle.tasks?.[0].tags).toHaveLength(L.maxTagsPerTask);
      expect(codes(many)).toEqual(['TAGS_LIMIT']);
      expect(t({ tags: [] }).bundle.tasks?.[0]).not.toHaveProperty('tags');
    });

    it('assignees: de-duplicated, bad ids dropped, capped', () => {
      const r = t({ assigneeExternalIds: ['u1', 'u1', '', 5, 'u2'] });
      expect(r.bundle.tasks?.[0].assigneeExternalIds).toEqual(['u1', 'u2']);
      expect(codes(r)).toEqual(['FIELD_INVALID', 'FIELD_INVALID']);
      const many = t({ assigneeExternalIds: Array.from({ length: L.maxAssigneesPerTask + 3 }, (_, i) => `u${i}`) });
      expect(many.bundle.tasks?.[0].assigneeExternalIds).toHaveLength(L.maxAssigneesPerTask);
      expect(codes(many)).toEqual(['ASSIGNEES_LIMIT']);
    });

    it('urls: only http(s); anything else is dropped and reported', () => {
      expect(t({ url: 'https://x.com/t' }).bundle.tasks?.[0].url).toBe('https://x.com/t');
      for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/rel', 'ftp://x', 5]) {
        const r = t({ url: bad });
        expect(r.bundle.tasks?.[0]).not.toHaveProperty('url');
        expect(codes(r)).toEqual(['URL_INVALID']);
      }
    });

    it('references that are not usable ids are dropped with a warning; usable ones pass through', () => {
      const r = t({ projectExternalId: 5, statusExternalId: '', creatorExternalId: 'u1' });
      expect(r.bundle.tasks?.[0]).toEqual({ externalId: 't1', title: 'A task', creatorExternalId: 'u1' });
      expect(codes(r)).toEqual(['FIELD_INVALID', 'FIELD_INVALID']);
    });

    it('a priority is kept as the source wrote it (one line, bounded); mapping is step 4.3', () => {
      expect(t({ priority: '  P1 \n High ' }).bundle.tasks?.[0].priority).toBe('P1 High');
    });

    it('archived must be a boolean', () => {
      expect(t({ archived: true }).bundle.tasks?.[0].archived).toBe(true);
      const r = t({ archived: 'yes' });
      expect(r.bundle.tasks?.[0]).not.toHaveProperty('archived');
      expect(codes(r)).toEqual(['FIELD_INVALID']);
    });

    it('wrong-typed list fields are dropped, not crashed on', () => {
      const r = t({ tags: 'bug', comments: {}, attachments: 3, history: 'x', customValues: true, assigneeExternalIds: 'u' });
      expect(r.bundle.tasks?.[0]).toEqual({ externalId: 't1', title: 'A task' });
      expect(codes(r)).toEqual(Array(6).fill('FIELD_INVALID'));
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('task hierarchy', () => {
    const parentsOf = (page: unknown) => Object.fromEntries(tasksOf(page).map((x) => [x.externalId, x.parentExternalId ?? null]));

    it('a task that is its own parent loses the link', () => {
      const r = good(base({ tasks: [task({ parentExternalId: 't1' })] }));
      expect(r.bundle.tasks?.[0]).not.toHaveProperty('parentExternalId');
      expect(codes(r)).toEqual(['SELF_PARENT']);
    });

    it('a parent on another page is kept (cannot be judged here)', () => {
      expect(parentsOf(base({ tasks: [task({ parentExternalId: 'elsewhere' })] }))).toEqual({ t1: 'elsewhere' });
    });

    it('a normal chain is untouched, in any order', () => {
      const page = base({ tasks: [task({ externalId: 'c', parentExternalId: 'b' }), task({ externalId: 'a' }), task({ externalId: 'b', parentExternalId: 'a' })] });
      expect(parentsOf(page)).toEqual({ c: 'b', a: null, b: 'a' });
      expect(good(page).issues).toEqual([]);
    });

    it.each([
      ['2-cycle', [['a', 'b'], ['b', 'a']]],
      ['3-cycle', [['a', 'b'], ['b', 'c'], ['c', 'a']]],
      ['cycle with a tail', [['x', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'a']]],
    ] as const)('%s is broken by cutting exactly ONE link, reported as PARENT_CYCLE', (_n, edges) => {
      const ids = [...new Set(edges.flat())];
      const page = base({ tasks: ids.map((id) => task({ externalId: id, parentExternalId: edges.find(([c]) => c === id)?.[1] })) });
      const r = good(page);
      expect(r.issues.filter((i) => i.code === 'PARENT_CYCLE')).toHaveLength(1);
      const after = parentsOf(page);
      // no cycle remains: follow parents from everywhere
      for (const id of ids) {
        const seen = new Set<string>();
        for (let cur: string | null = id; cur; cur = after[cur] ?? null) { expect(seen.has(cur)).toBe(false); seen.add(cur); }
      }
      expect(Object.values(after).filter((p) => p !== null).length).toBe(edges.length - 1);
    });

    it('a long chain (500 deep) is handled without recursion problems', () => {
      const tasks = Array.from({ length: 500 }, (_, i) => task({ externalId: `t${i}`, ...(i > 0 ? { parentExternalId: `t${i - 1}` } : {}) }));
      expect(good(base({ tasks })).issues).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('comments', () => {
    const c = (list: unknown[]) => good(base({ tasks: [task({ comments: list })] }));
    const cm = (id: string, extra: Record<string, unknown> = {}) => ({ externalId: id, body: `body ${id}`, ...extra });

    it('empty bodies are left out (INFO), duplicates skipped, bodies cut at the limit', () => {
      const r = c([cm('a'), { externalId: 'b', body: '  \n ' }, cm('a'), cm('d', { body: 'x'.repeat(L.commentBody + 10) })]);
      expect(r.bundle.tasks?.[0].comments?.map((x) => x.externalId)).toEqual(['a', 'd']);
      expect(r.bundle.tasks?.[0].comments?.[1].body.length).toBeLessThanOrEqual(L.commentBody);
      expect(codes(r).sort()).toEqual(['COMMENT_EMPTY', 'COMMENT_TRUNCATED', 'DUPLICATE_ID']);
    });

    it('a reply to a reply is re-attached to the thread root (threads are one level deep)', () => {
      const r = c([cm('root'), cm('r1', { parentExternalId: 'root' }), cm('r2', { parentExternalId: 'r1' }), cm('r3', { parentExternalId: 'r2' })]);
      expect(Object.fromEntries((r.bundle.tasks?.[0].comments ?? []).map((x) => [x.externalId, x.parentExternalId ?? null]))).toEqual({ root: null, r1: 'root', r2: 'root', r3: 'root' });
      expect(r.issues).toEqual([]);
    });

    it('a reply to something not on the task becomes top-level; a parent LOOP is cut once and the thread survives (reported)', () => {
      const r = c([cm('a', { parentExternalId: 'ghost' }), cm('b', { parentExternalId: 'c' }), cm('c', { parentExternalId: 'b' })]);
      expect(Object.fromEntries((r.bundle.tasks?.[0].comments ?? []).map((x) => [x.externalId, x.parentExternalId ?? null]))).toEqual({ a: null, b: null, c: 'b' });
      expect(codes(r)).toEqual(['COMMENT_PARENT_INVALID', 'COMMENT_PARENT_INVALID']);
    });

    it('editedAt before createdAt is set to createdAt; dates are normalised', () => {
      const r = c([cm('a', { createdAt: '2026-05-10', editedAt: '2026-05-01' })]);
      expect(r.bundle.tasks?.[0].comments?.[0]).toMatchObject({ createdAt: '2026-05-10T00:00:00.000Z', editedAt: '2026-05-10T00:00:00.000Z' });
    });

    it(`over ${L.maxCommentsPerTask} comments: the first ${L.maxCommentsPerTask} are kept and ONE warning says so`, () => {
      const r = c(Array.from({ length: L.maxCommentsPerTask + 20 }, (_, i) => cm(`c${i}`)));
      expect(r.bundle.tasks?.[0].comments).toHaveLength(L.maxCommentsPerTask);
      expect(codes(r)).toEqual(['COMMENTS_LIMIT']);
      expect(r.stats.comments).toBe(L.maxCommentsPerTask);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('attachments', () => {
    const a = (list: unknown[]) => good(base({ tasks: [task({ attachments: list })] }));
    const at = (id: string, extra: Record<string, unknown> = {}) => ({ externalId: id, fileName: 'f.txt', providerRef: `ref-${id}`, ...extra });

    it('a file name can never carry a path; mime and size are checked; each is repaired or dropped with a report', () => {
      const r = a([at('1', { fileName: '../../etc/passwd', mimeType: 'TEXT/Plain', sizeBytes: 12 }), at('2', { mimeType: 'not a mime', sizeBytes: -5 }), at('3', { sizeBytes: 1.5 })]);
      const list = r.bundle.tasks?.[0].attachments ?? [];
      expect(list[0]).toMatchObject({ mimeType: 'text/plain', sizeBytes: 12 });
      expect(list[0].fileName).toBe('___.._etc_passwd'); // no path separators, leading dots neutralised
      expect(list[1]).not.toHaveProperty('mimeType');
      expect(list[1]).not.toHaveProperty('sizeBytes');
      expect(list[2]).not.toHaveProperty('sizeBytes');
      expect(codes(r).sort()).toEqual(['FIELD_INVALID', 'FIELD_INVALID', 'MIME_INVALID']);
    });

    it('without a usable reference to the file the attachment is skipped', () => {
      const r = a([{ externalId: 'x', fileName: 'f' }, at('y', { providerRef: '' }), at('z', { providerRef: 'r'.repeat(L.providerRef + 1) }), at('ok')]);
      expect(r.bundle.tasks?.[0].attachments?.map((x) => x.externalId)).toEqual(['ok']);
      expect(r.stats.skipped).toBe(3);
    });

    it('a missing name becomes "attachment"; duplicates skipped; capped', () => {
      expect(a([at('1', { fileName: '' })]).bundle.tasks?.[0].attachments?.[0].fileName).toBe('attachment');
      expect(codes(a([at('1'), at('1')]))).toEqual(['DUPLICATE_ID']);
      const many = a(Array.from({ length: L.maxAttachmentsPerTask + 5 }, (_, i) => at(`a${i}`)));
      expect(many.bundle.tasks?.[0].attachments).toHaveLength(L.maxAttachmentsPerTask);
      expect(codes(many)).toEqual(['ATTACHMENTS_LIMIT']);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('history', () => {
    const h = (list: unknown[]) => good(base({ tasks: [task({ history: list })] }));
    const he = (id: string, extra: Record<string, unknown> = {}) => ({ externalId: id, at: '2026-01-01T00:00:00Z', field: 'status', ...extra });

    it('an entry needs a time and a field; values are one-line and bounded; null means "was empty"', () => {
      const r = h([he('1', { from: null, to: 'Done\nnow' }), he('2', { at: 'garbage' }), he('3', { field: '  ' }), he('4', { to: 'x'.repeat(900) }), he('5', { from: 7 })]);
      const list = r.bundle.tasks?.[0].history ?? [];
      expect(list.map((x) => x.externalId)).toEqual(['1', '4', '5']);
      expect(list[0]).toMatchObject({ from: null, to: 'Done now' });
      expect(list[1].to).toHaveLength(L.historyValue);
      expect(list[2]).not.toHaveProperty('from');
      expect(codes(r).sort()).toEqual(['DATE_INVALID', 'FIELD_INVALID', 'ITEM_INVALID']);
    });
    it('duplicates skipped; capped with one warning', () => {
      expect(codes(h([he('1'), he('1')]))).toEqual(['DUPLICATE_ID']);
      const many = h(Array.from({ length: L.maxHistoryPerTask + 7 }, (_, i) => he(`h${i}`)));
      expect(many.bundle.tasks?.[0].history).toHaveLength(L.maxHistoryPerTask);
      expect(codes(many)).toEqual(['HISTORY_LIMIT']);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('custom values are checked against their field definition when the page has it', () => {
    const fields = [
      { externalId: 'text', name: 'T', dataType: 'TEXT' },
      { externalId: 'num', name: 'N', dataType: 'NUMBER' },
      { externalId: 'chk', name: 'C', dataType: 'CHECKBOX' },
      { externalId: 'date', name: 'D', dataType: 'DATE' },
      { externalId: 'url', name: 'U', dataType: 'URL' },
      { externalId: 'user', name: 'P', dataType: 'USER' },
      { externalId: 'sel', name: 'S', dataType: 'SELECT', options: [{ label: 'High' }, { label: 'Low' }] },
      { externalId: 'multi', name: 'M', dataType: 'MULTI_SELECT', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
      { externalId: 'free', name: 'F', dataType: 'SELECT' },
    ];
    const cv = (...vals: Array<[string, unknown]>) => good(base({ customFields: fields, tasks: [task({ customValues: vals.map(([fieldExternalId, value]) => ({ fieldExternalId, value })) })] }));
    const valuesOf = (r: ReturnType<typeof cv>) => Object.fromEntries((r.bundle.tasks?.[0].customValues ?? []).map((x) => [x.fieldExternalId, x.value]));

    it('good values pass; dates normalise; option labels match case-insensitively and come back in the field\'s spelling', () => {
      const r = cv(['text', ' hi '], ['num', 4], ['chk', false], ['date', '2026-03-04'], ['url', 'https://x.com'], ['user', 'u1'], ['sel', 'high'], ['multi', ['B', 'a', 'b']], ['free', 'anything']);
      expect(valuesOf(r)).toEqual({ text: 'hi', num: 4, chk: false, date: '2026-03-04T00:00:00.000Z', url: 'https://x.com', user: 'u1', sel: 'High', multi: ['b', 'a'], free: 'anything' });
      expect(r.issues).toEqual([]);
    });
    it.each([
      ['text', 5], ['text', ' '], ['num', '4'], ['num', 'abc'], ['chk', 'true'], ['date', 'soon'], ['url', 'javascript:alert(1)'],
      ['user', ''], ['sel', 'Medium'], ['sel', ['High']], ['multi', 'a'], ['multi', ['zzz']], ['multi', []],
    ])('%s = %j is dropped and reported', (f, val) => {
      const r = cv([f as string, val]);
      expect(r.bundle.tasks?.[0]).not.toHaveProperty('customValues');
      expect(codes(r)).toEqual(['CUSTOM_VALUE_INVALID']);
    });
    it('a field defined on ANOTHER page: only generic type sanity applies', () => {
      const r = good(base({ tasks: [task({ customValues: [{ fieldExternalId: 'other', value: 'x' }, { fieldExternalId: 'other2', value: 3 }, { fieldExternalId: 'other3', value: ['a', 'a', 'b'] }, { fieldExternalId: 'other4', value: { a: 1 } }] })] }));
      expect(r.bundle.tasks?.[0].customValues).toEqual([{ fieldExternalId: 'other', value: 'x' }, { fieldExternalId: 'other2', value: 3 }, { fieldExternalId: 'other3', value: ['a', 'b'] }]);
      expect(codes(r)).toEqual(['CUSTOM_VALUE_INVALID']);
    });
    it('the same field twice keeps the first; entries that are not objects or lack a field are dropped', () => {
      const r = cv(['num', 1], ['num', 2]);
      expect(valuesOf(r)).toEqual({ num: 1 });
      const bad = good(base({ tasks: [task({ customValues: [null, { value: 1 }, { fieldExternalId: 5, value: 1 }] })] }));
      expect(bad.bundle.tasks?.[0]).not.toHaveProperty('customValues');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('projects, statuses, users, tags, fields, issue types, iterations', () => {
    it('statuses: a name that folds to an earlier one is made distinct; bad categories become UNKNOWN; over the cap are left out', () => {
      const r = good(base({ projects: [{ externalId: 'p', name: 'P', statuses: [
        { externalId: 's1', name: 'Done', category: 'DONE' },
        { externalId: 's2', name: ' DONE ', category: 'DONE' },
        { externalId: 's3', name: 'done', category: 'weird' },
        { externalId: 's1', name: 'again', category: 'TODO' },
      ] }] }));
      const st = r.bundle.projects?.[0].statuses ?? [];
      expect(st.map((s) => s.name)).toEqual(['Done', 'DONE (2)', 'done (3)']);
      expect(st[2].category).toBe('UNKNOWN');
      expect(codes(r).sort()).toEqual(['DUPLICATE_ID', 'FIELD_INVALID', 'STATUS_NAME_DUPLICATE', 'STATUS_NAME_DUPLICATE']);
      const many = good(base({ projects: [{ externalId: 'p', name: 'P', statuses: Array.from({ length: L.maxStatusesPerProject + 4 }, (_, i) => ({ externalId: `s${i}`, name: `S${i}`, category: 'TODO' })) }] }));
      expect(many.bundle.projects?.[0].statuses).toHaveLength(L.maxStatusesPerProject);
      expect(codes(many)).toEqual(Array(4).fill('STATUSES_LIMIT'));
    });
    it('status colour: only #rrggbb survives, silently; position only a sane integer', () => {
      const r = good(base({ projects: [{ externalId: 'p', name: 'P', statuses: [{ externalId: 's', name: 'S', category: 'TODO', color: 'red', position: 1.5 }] }] }));
      expect(r.bundle.projects?.[0].statuses?.[0]).toEqual({ externalId: 's', name: 'S', category: 'TODO' });
      expect(r.issues).toEqual([]);
    });
    it('a project without a name is "(unnamed project)"; description cut; statuses all rejected leaves the key out', () => {
      const r = good(base({ projects: [{ externalId: 'p', name: '', description: 'x'.repeat(L.projectDescription + 5), statuses: [null] }] }));
      expect(r.bundle.projects?.[0].name).toBe('(unnamed project)');
      expect(r.bundle.projects?.[0].description?.length).toBeLessThanOrEqual(L.projectDescription);
      expect(r.bundle.projects?.[0]).not.toHaveProperty('statuses');
    });
    it('users: e-mail lower-cased and checked, name falls back to e-mail then id, duplicates skipped', () => {
      const r = good(base({ users: [
        { externalId: 'u1', name: 'Ana', email: ' ANA@Example.COM ' },
        { externalId: 'u2', name: '', email: 'b@x.co' },
        { externalId: 'u3', name: '' },
        { externalId: 'u4', name: 'D', email: 'not-an-email' },
        { externalId: 'u1', name: 'dup' },
      ] }));
      expect(r.bundle.users).toEqual([
        { externalId: 'u1', name: 'Ana', email: 'ana@example.com' },
        { externalId: 'u2', name: 'b@x.co', email: 'b@x.co' },
        { externalId: 'u3', name: 'u3' },
        { externalId: 'u4', name: 'D' },
      ]);
      expect(codes(r).sort()).toEqual(['DUPLICATE_ID', 'FIELD_INVALID']);
    });
    it('tags: folded duplicates merge (INFO); a tag without a name is skipped', () => {
      const r = good(base({ tags: [{ name: 'Bug' }, { name: 'bug ' }, { name: '' }, { name: 'ui', color: '#00ff00' }] }));
      expect(r.bundle.tags).toEqual([{ name: 'Bug' }, { name: 'ui', color: '#00ff00' }]);
      expect(codes(r).sort()).toEqual(['DUPLICATE_ID', 'ITEM_INVALID']);
    });
    it('custom fields: unknown type skipped; options folded-unique and bounded; empty options omitted', () => {
      const r = good(base({ customFields: [
        { externalId: 'a', name: 'A', dataType: 'WHATEVER' },
        { externalId: 'b', name: 'B', dataType: 'SELECT', options: [{ label: 'x' }, { label: 'X' }, { label: '' }, { label: 'y', externalId: 'oy' }, 'junk'] },
        { externalId: 'c', name: 'C', dataType: 'TEXT', options: [] },
      ] }));
      expect(r.bundle.customFields).toEqual([
        { externalId: 'b', name: 'B', dataType: 'SELECT', options: [{ label: 'x' }, { label: 'y', externalId: 'oy' }] },
        { externalId: 'c', name: 'C', dataType: 'TEXT' },
      ]);
    });
    it('issue types and iterations: bad level dropped; unusable kind skips the iteration; end before start dropped', () => {
      const r = good(base({
        issueTypes: [{ externalId: 'i', name: 'Bug', level: 'HUGE' }],
        iterations: [
          { externalId: 'a', kind: 'SPRINT', name: 'S', startDate: '2026-02-01', endDate: '2026-01-01' },
          { externalId: 'b', kind: 'EPOCH', name: 'E' },
        ],
      }));
      expect(r.bundle.issueTypes).toEqual([{ externalId: 'i', name: 'Bug' }]);
      expect(r.bundle.iterations).toEqual([{ externalId: 'a', kind: 'SPRINT', name: 'S', startDate: '2026-02-01T00:00:00.000Z' }]);
      expect(codes(r).sort()).toEqual(['DATE_ORDER', 'FIELD_INVALID', 'FIELD_INVALID', 'ITEM_INVALID'].sort());
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('dependencies', () => {
    const d = (id: string, from: string, to: string, type = 'BLOCKS') => ({ externalId: id, fromExternalId: from, toExternalId: to, type });
    const run = (...deps: unknown[]) => good(base({ dependencies: deps }));

    it('self-links are skipped; the same link twice is merged (INFO)', () => {
      const r = run(d('1', 'a', 'a'), d('2', 'a', 'b'), d('3', 'a', 'b'));
      expect(r.bundle.dependencies?.map((x) => x.externalId)).toEqual(['2']);
      expect(codes(r).sort()).toEqual(['DEPENDENCY_SELF', 'DUPLICATE_ID']);
    });
    it('BLOCKS loops are broken by skipping the link that closes them (cycles are skipped + warned)', () => {
      const r = run(d('1', 'a', 'b'), d('2', 'b', 'c'), d('3', 'c', 'a'), d('4', 'c', 'd'));
      expect(r.bundle.dependencies?.map((x) => x.externalId)).toEqual(['1', '2', '4']);
      expect(r.issues).toEqual([expect.objectContaining({ code: 'DEPENDENCY_CYCLE', externalRef: 'dependency:3' })]);
      expect(codes(run(d('1', 'a', 'b'), d('2', 'b', 'a')))).toEqual(['DEPENDENCY_CYCLE']);
    });
    it('RELATES_TO may go both ways; it never counts toward a BLOCKS loop', () => {
      const r = run(d('1', 'a', 'b', 'RELATES_TO'), d('2', 'b', 'a', 'RELATES_TO'), d('3', 'a', 'b'), d('4', 'b', 'c'));
      expect(r.issues).toEqual([]);
      expect(r.bundle.dependencies).toHaveLength(4);
    });
    it('a link missing a task or a usable type is skipped', () => {
      const r = run(d('1', 'a', ''), { externalId: '2', fromExternalId: 'a', toExternalId: 'b' }, d('3', 'a', 'b', 'NOPE'), d('ok', 'x', 'y'));
      expect(r.bundle.dependencies?.map((x) => x.externalId)).toEqual(['ok']);
    });
    it('a 3000-link chain is checked in reasonable time', () => {
      const deps = Array.from({ length: 3000 }, (_, i) => d(`d${i}`, `t${i}`, `t${i + 1}`));
      const t0 = Date.now();
      expect(good(base({ dependencies: deps })).issues).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(5000);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('issue list bound', () => {
    it(`stops at ${MAX_BUNDLE_ISSUES} issues with one ISSUES_TRUNCATED marker, however many problems the page has`, () => {
      const r = good(base({ tasks: Array.from({ length: L.maxTasks }, (_, i) => task({ externalId: `t${i}`, title: '', estimate: -1, dueDate: 'x', url: 'javascript:1', tags: [5, 6, 7], archived: 'x' })) }));
      expect(r.issues.length).toBe(MAX_BUNDLE_ISSUES + 1);
      expect(r.issues.filter((i) => i.code === 'ISSUES_TRUNCATED')).toHaveLength(1);
      expect(r.issues[r.issues.length - 1].code).toBe('ISSUES_TRUNCATED');
      expect(r.bundle.tasks).toHaveLength(L.maxTasks); // the repairs still happened
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('fuzz', () => {
    function mulberry32(seed: number) {
      return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    }
    it('3000 pages of random valid-ish garbage: never throws; every ok result passes a second validation unchanged and clean', () => {
      const rnd = mulberry32(99);
      const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
      const junk = (): unknown => pick(['', ' ', 'x', 'x'.repeat(400), 'a\u0000b', '2026-03-04', 'not a date', 'https://x.com', 'javascript:1', 0, 1, -1, 5.5, 1e9, true, false, null, [], ['a', 'a'], [1, 'b'], {}, { a: 1 }, '#aabbcc', 'BLOCKS', 'DONE', 'SELECT', 'u1', 't1']);
      const ids = ['t1', 't2', 't3', 'u1', 'p1', 'c1', 'a1', 'h1', 'f1', ''];
      const field = (keys: string[], o: Record<string, unknown>) => { for (const k of keys) if (rnd() < 0.6) o[k] = rnd() < 0.5 ? junk() : pick(ids); return o; };
      const item = (keys: string[]): Record<string, unknown> => field(keys, { externalId: pick(ids) });
      let oks = 0;
      for (let i = 0; i < 3000; i++) {
        const page = base({
          users: [item(['name', 'email', 'avatarUrl', 'isBot'])],
          projects: [{ ...item(['name', 'key', 'description', 'url', 'archived', 'createdAt']), statuses: [item(['name', 'category', 'color', 'position'])] }],
          customFields: [item(['name', 'dataType', 'options'])],
          tasks: Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
            ...item(['title', 'description', 'url', 'projectExternalId', 'parentExternalId', 'statusExternalId', 'priority', 'createdAt', 'updatedAt', 'startDate', 'dueDate', 'estimate', 'tags', 'assigneeExternalIds', 'archived']),
            customValues: [field(['value'], { fieldExternalId: pick(ids) })],
            comments: [field(['body', 'createdAt', 'parentExternalId', 'authorExternalId'], { externalId: pick(ids) })],
            attachments: [field(['fileName', 'mimeType', 'sizeBytes', 'providerRef'], { externalId: pick(ids) })],
            history: [field(['at', 'field', 'from', 'to'], { externalId: pick(ids) })],
          })),
          dependencies: [field(['fromExternalId', 'toExternalId', 'type'], { externalId: pick(ids) }), field(['fromExternalId', 'toExternalId', 'type'], { externalId: pick(ids) })],
        });
        const r = v(page);
        if ('fatal' in r) { expect(['NOT_JSON', 'ADAPTER_BUG', 'PAGE_TOO_LARGE', 'TOO_LARGE']).toContain(r.fatal.code); continue; }
        oks++;
        const again = v(r.bundle);
        expect('fatal' in again).toBe(false);
        if (!('fatal' in again)) { expect(again.bundle).toEqual(r.bundle); expect(again.issues).toEqual([]); }
      }
      expect(oks).toBeGreaterThan(1000); // the generator mostly produces pages the validator can repair
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('the schema and the validator describe the same fields', () => {
    type S = { properties: Record<string, S & { items?: S }> };
    const root = CANONICAL_V1_SCHEMA as unknown as S;
    const props = (o: S) => Object.keys(o.properties).sort();
    const item = (k: string): S => (root.properties[k] as S & { items: S }).items;
    const task = item('tasks') as S & { properties: Record<string, S & { items: S }> };
    const project = item('projects') as S & { properties: Record<string, S & { items: S }> };
    const field = item('customFields') as S & { properties: Record<string, S & { items: S }> };

    it.each([
      ['source', () => root.properties.source, CANONICAL_ITEM_KEYS.source],
      ['user', () => item('users'), CANONICAL_ITEM_KEYS.user],
      ['project', () => item('projects'), CANONICAL_ITEM_KEYS.project],
      ['status', () => project.properties.statuses.items, CANONICAL_ITEM_KEYS.status],
      ['tag', () => item('tags'), CANONICAL_ITEM_KEYS.tag],
      ['customField', () => item('customFields'), CANONICAL_ITEM_KEYS.customField],
      ['option', () => field.properties.options.items, CANONICAL_ITEM_KEYS.option],
      ['issueType', () => item('issueTypes'), CANONICAL_ITEM_KEYS.issueType],
      ['iteration', () => item('iterations'), CANONICAL_ITEM_KEYS.iteration],
      ['task', () => item('tasks'), CANONICAL_ITEM_KEYS.task],
      ['customValue', () => task.properties.customValues.items, CANONICAL_ITEM_KEYS.customValue],
      ['comment', () => task.properties.comments.items, CANONICAL_ITEM_KEYS.comment],
      ['attachment', () => task.properties.attachments.items, CANONICAL_ITEM_KEYS.attachment],
      ['history', () => task.properties.history.items, CANONICAL_ITEM_KEYS.history],
      ['dependency', () => item('dependencies'), CANONICAL_ITEM_KEYS.dependency],
    ] as const)('%s', (_n, schemaOf, keys) => {
      expect([...keys].sort()).toEqual(props(schemaOf()));
    });

    it('the top-level collections the validator walks are exactly the schema\'s', () => {
      expect(Object.keys(root.properties).sort()).toEqual(['customFields', 'dependencies', 'issueTypes', 'iterations', 'projects', 'schemaVersion', 'source', 'tags', 'tasks', 'users'].sort());
    });
  });
});
