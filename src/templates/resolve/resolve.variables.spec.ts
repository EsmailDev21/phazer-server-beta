import { BlueprintVariable } from '../blueprint';
import { Issues } from './resolve.types';
import { resolveVariables } from './resolve.variables';

const decl: BlueprintVariable[] = [
  { key: 'course', label: 'Course', type: 'TEXT', default: 'Bio' },
  { key: 'start', label: 'Start', type: 'DATE', required: true },
  { key: 'n', label: 'N', type: 'NUMBER' },
  { key: 'pick', label: 'Pick', type: 'SELECT', options: ['a', 'b'], default: 'a' },
  { key: 'flag', label: 'Flag', type: 'BOOLEAN' },
];
const run = (supplied: unknown, d = decl) => {
  const issues = new Issues();
  const values = resolveVariables(d, supplied, issues);
  return { values: Object.fromEntries(values), issues: issues.items };
};

describe('resolveVariables', () => {
  it('applies defaults, takes supplied values, leaves optional ones unset', () => {
    expect(run({ start: '2026-09-01', n: 4 })).toEqual({ values: { course: 'Bio', start: '2026-09-01', n: 4, pick: 'a' }, issues: [] });
    expect(run({ start: '2026-09-01', course: 'Chem', pick: 'b', flag: true }).values)
      .toEqual({ course: 'Chem', start: '2026-09-01', pick: 'b', flag: true });
  });

  it('a required variable without a default must be supplied', () => {
    expect(run({}).issues).toEqual([{ code: 'VARIABLE_MISSING', path: '/variables/start', message: '"Start" is required' }]);
    expect(run(undefined).issues.map((i) => i.code)).toEqual(['VARIABLE_MISSING']);
    expect(run({ start: null }).issues.map((i) => i.code)).toEqual(['VARIABLE_MISSING']);
  });

  it('is strict: no coercion', () => {
    for (const [k, bad] of [['n', '5'], ['flag', 'true'], ['flag', 1], ['start', '2026-02-30'], ['start', 20260901], ['pick', 'c'], ['course', 5], ['n', NaN], ['n', Infinity]] as const) {
      const r = run({ start: '2026-09-01', [k]: bad });
      expect(r.issues.map((i) => i.code)).toEqual(['VARIABLE_INVALID']);
      expect(r.issues[0].path).toBe(`/variables/${k}`);
    }
  });

  it('TEXT is one clean, non-blank line, within the limit', () => {
    for (const bad of ['', '   ', 'a\nb', 'a\tb', 'a\u0000b', 'a\ud800b', 'x'.repeat(501)]) {
      expect(run({ start: '2026-09-01', course: bad }).issues.map((i) => i.code)).toEqual(['VARIABLE_INVALID']);
    }
    expect(run({ start: '2026-09-01', course: 'x'.repeat(500) }).issues).toEqual([]);
  });

  it('unknown names are errors, including prototype names, which are never "found"', () => {
    for (const name of ['nope', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(run({ start: '2026-09-01', [name]: 'x' }).issues.map((i) => i.code)).toEqual(['VARIABLE_UNKNOWN']);
    }
    const hostile = JSON.parse('{"start":"2026-09-01","__proto__":{"course":"owned"}}');
    const r = run(hostile);
    expect(r.issues.map((i) => i.code)).toEqual(['VARIABLE_UNKNOWN']);
    expect(r.values.course).toBe('Bio');
  });

  it('does not read inherited values', () => {
    const inherited = Object.create({ course: 'inherited' });
    inherited.start = '2026-09-01';
    expect(run(inherited).values.course).toBe('Bio');
  });

  it('rejects a non-object', () => {
    for (const bad of ['x', 3, [1], true]) expect(run(bad).issues.map((i) => i.code)).toContain('VARIABLE_INVALID');
  });

  it('a template with no variables takes none', () => {
    expect(run(undefined, [])).toEqual({ values: {}, issues: [] });
    expect(run({ a: 1 }, []).issues.map((i) => i.code)).toEqual(['VARIABLE_UNKNOWN']);
  });
});
