import { VariableTypes } from '../blueprint';
import { renderText, slugify } from './resolve.text';
import { VariableValue } from './resolve.types';

const types: VariableTypes = new Map([
  ['course', 'TEXT'], ['start', 'DATE'], ['n', 'NUMBER'], ['flag', 'BOOLEAN'], ['pick', 'SELECT'], ['other', 'TEXT'],
]);
const vals = (o: Record<string, VariableValue>) => new Map(Object.entries(o));
const render = (t: string, o: Record<string, VariableValue>) => {
  const r = renderText(t, vals(o), types);
  if (r.ok === false) throw new Error(r.message);
  return r.text;
};

describe('renderText', () => {
  it('substitutes variables of every type', () => {
    expect(render('{{course}} #{{n}} {{flag}} {{pick}} {{start}}', { course: 'Bio', n: 3, flag: false, pick: 'a', start: '2026-09-01' }))
      .toBe('Bio #3 false a 2026-09-01');
  });

  it('runs the three helpers', () => {
    const v = { course: 'Intro à la Biologie!', start: '2026-09-30' };
    expect(render('{{slug(course)}}', v)).toBe('intro-a-la-biologie');
    expect(render('{{addDays(start, 2)}}', v)).toBe('2026-10-02');
    expect(render('{{addDays(start, -30)}}', v)).toBe('2026-08-31');
    expect(render('{{format(start, "EEE d MMM yyyy")}}', v)).toBe('Wed 30 Sep 2026');
  });

  it('an unset variable renders empty; a helper on an unset DATE fails', () => {
    expect(render('[{{course}}]', {})).toBe('[]');
    expect(renderText('{{format(start, "d")}}', vals({}), types)).toMatchObject({ ok: false });
    expect(renderText('{{addDays(start, 1)}}', vals({}), types)).toMatchObject({ ok: false });
  });

  it('a date pushed out of range fails instead of wrapping', () => {
    expect(renderText('{{addDays(start, 3650)}}', vals({ start: '2199-01-01' }), types)).toMatchObject({ ok: false });
  });

  it('escaped braces become literal braces', () => {
    expect(render('use \\{{course}} for {{course}}', { course: 'X' })).toBe('use {{course}} for X');
  });

  it('SINGLE PASS: a value that looks like a placeholder stays text', () => {
    const v = { course: '{{other}}', other: 'LEAKED' };
    expect(render('{{course}}', v)).toBe('{{other}}');
    expect(render('{{course}} {{other}}', v)).toBe('{{other}} LEAKED');
    expect(render('{{slug(course)}}', v)).toBe('other');
    const nasty = { course: '{{addDays(start, 1)}}\\{{x}}}}{{', start: '2026-01-01' };
    expect(render('A{{course}}B', nasty)).toBe('A{{addDays(start, 1)}}\\{{x}}}}{{B');
  });

  it('fails closed on anything the 3.1 checker would refuse (defence in depth)', () => {
    for (const t of ['{{nope}}', '{{eval(course)}}', '{{constructor}}', '{{__proto__}}', '{{course', '{{addDays(course, 1)}}', '{{format(start, "HH")}}']) {
      expect(renderText(t, vals({ course: 'x', start: '2026-01-01' }), types).ok).toBe(false);
    }
  });

  it('property: text without placeholders is returned unchanged; placeholders only ever add their value (2000 random)', () => {
    let seed = 99;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const bits = ['a', ' ', 'Z', '}', '😀', '\n', '$', '%s', '[', ')'];
    for (let i = 0; i < 2000; i++) {
      let plain = '';
      for (let j = next(20); j > 0; j--) plain += bits[next(bits.length)];
      expect(render(plain, {})).toBe(plain);
      const value = Array.from({ length: next(12) }, () => bits[next(bits.length)]).join('') || 'v';
      expect(render(`${plain}{{course}}${plain}`, { course: value })).toBe(`${plain}${value}${plain}`);
    }
  });
});

describe('slugify', () => {
  it.each([
    ['Hello World', 'hello-world'], ['  --Spaces--  ', 'spaces'], ['Ünïcödé Çafé', 'unicode-cafe'],
    ['a/b\\c?d', 'a-b-c-d'], ['日本語', ''], ['', ''], ['A_B', 'a-b'], ['x'.repeat(100), 'x'.repeat(60)],
  ])('%s -> %s', (i, o) => expect(slugify(i)).toBe(o));
  it('never ends or starts with a hyphen, only [a-z0-9-]', () => {
    for (const s of ['a'.repeat(59) + ' b', '!!!a!!!', '-', 'a - b']) expect(slugify(s)).toMatch(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/);
  });
});
