import {
  checkExpr,
  DATE_PATTERN,
  Expr,
  HELPERS,
  parseTemplateText,
  variablesRead,
  VariableTypes,
} from './blueprint.expressions';
import { BLUEPRINT_LIMITS } from './blueprint.limits';
import { VariableType } from './blueprint.types';

const VARS: VariableTypes = new Map<string, VariableType>([
  ['course', 'TEXT'],
  ['startDate', 'DATE'],
  ['count', 'NUMBER'],
  ['kind', 'SELECT'],
  ['paid', 'BOOLEAN'],
]);

const ok = (text: string) => {
  const r = parseTemplateText(text);
  if (r.ok === false) throw new Error(`expected ok for ${text}: ${r.message}`);
  return r.segments;
};
const exprOf = (text: string): Expr => {
  const s = ok(text).find((x) => x.type === 'expr');
  if (!s || s.type !== 'expr') throw new Error('no expression');
  return s.expr;
};

describe('parseTemplateText', () => {
  it('splits text and placeholders, in order', () => {
    expect(ok('Hello {{course}}, week {{count}}!')).toEqual([
      { type: 'text', value: 'Hello ' },
      {
        type: 'expr',
        expr: { kind: 'var', name: 'course' },
        raw: '{{course}}',
      },
      { type: 'text', value: ', week ' },
      { type: 'expr', expr: { kind: 'var', name: 'count' }, raw: '{{count}}' },
      { type: 'text', value: '!' },
    ]);
  });

  it('plain text is one text segment, empty text is none', () => {
    expect(ok('no placeholders } here { or }}')).toEqual([
      { type: 'text', value: 'no placeholders } here { or }}' },
    ]);
    expect(ok('')).toEqual([]);
  });

  it('accepts whitespace inside the braces and around arguments', () => {
    expect(exprOf('{{   addDays(  startDate ,  -7 )   }}')).toEqual({
      kind: 'call',
      helper: 'addDays',
      args: [
        { kind: 'var', name: 'startDate' },
        { kind: 'integer', value: -7 },
      ],
    });
  });

  it('reads string arguments, which cannot contain quotes, backslashes or newlines', () => {
    expect(exprOf('{{format(startDate, "MMM d, yyyy")}}')).toEqual({
      kind: 'call',
      helper: 'format',
      args: [
        { kind: 'var', name: 'startDate' },
        { kind: 'string', value: 'MMM d, yyyy' },
      ],
    });
    for (const bad of [
      '{{format(startDate, "a\\"b")}}',
      '{{format(startDate, "a\\nb")}}',
      '{{format(startDate, "unterminated)}}',
    ]) {
      expect(parseTemplateText(bad).ok).toBe(false);
    }
  });

  it('a backslash before {{ makes it literal text - the only escape', () => {
    expect(ok('keep \\{{this}} as is')).toEqual([
      { type: 'text', value: 'keep {{this}} as is' },
    ]);
    // the escaped one is text, the next one is still a placeholder
    expect(ok('\\{{a}}{{course}}').map((s) => s.type)).toEqual([
      'text',
      'expr',
    ]);
    // a backslash anywhere else is just a character
    expect(ok('C:\\temp {{course}}')[0]).toEqual({
      type: 'text',
      value: 'C:\\temp ',
    });
  });

  it.each([
    ['unclosed', '{{course'],
    ['empty', '{{}}'],
    ['blank', '{{   }}'],
    ['starts with a digit', '{{1abc}}'],
    ['two words', '{{a b}}'],
    ['property access', '{{a.b}}'],
    ['index access', '{{a[0]}}'],
    ['operator', '{{count + 1}}'],
    ['ternary', '{{paid ? "a" : "b"}}'],
    ['unclosed call', '{{slug(course}}'],
    ['trailing comma', '{{addDays(startDate, 1,)}}'],
    ['missing comma', '{{addDays(startDate 1)}}'],
    ['extra paren', '{{slug(course))}}'],
    ['text after call', '{{slug(course) x}}'],
    ['nested call', '{{format(addDays(startDate, 1), "d")}}'],
    ['nested placeholder', '{{ {{course}} }}'],
    [
      'number beyond safe integers',
      '{{addDays(startDate, 99999999999999999999)}}',
    ],
    ['float', '{{addDays(startDate, 1.5)}}'],
    ['template literal', '{{`x`}}'],
    ['__proto__ is not even an identifier', '{{__proto__}}'],
    ['__proto__ as a helper', '{{__proto__(course)}}'],
    ['leading underscore', '{{_x}}'],
    ['single quotes', "{{format(startDate, 'd')}}"],
  ])('rejects %s', (_name, text) => {
    expect(parseTemplateText(text).ok).toBe(false);
  });

  it('reports where the problem is', () => {
    const r = parseTemplateText('ok {{course}} then {{ 9 }}');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.offset).toBe(19);
  });

  it('caps placeholders per text and the length of one placeholder', () => {
    const many = '{{course}}'.repeat(
      BLUEPRINT_LIMITS.maxPlaceholdersPerString + 1,
    );
    expect(parseTemplateText(many).ok).toBe(false);
    expect(
      parseTemplateText(
        '{{course}}'.repeat(BLUEPRINT_LIMITS.maxPlaceholdersPerString),
      ).ok,
    ).toBe(true);

    const long = `{{slug(${'a'.repeat(BLUEPRINT_LIMITS.maxPlaceholderLength)})}}`;
    expect(parseTemplateText(long).ok).toBe(false);
  });

  it('is linear on hostile input (no catastrophic scanning)', () => {
    const t0 = Date.now();
    for (const text of [
      '{{'.repeat(250_000),
      '\\{{'.repeat(250_000),
      '}}'.repeat(250_000),
      `{{${'a'.repeat(1_000_000)}`,
      '{{a}} '.repeat(10_000),
    ]) {
      parseTemplateText(text);
    }
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('never throws, whatever it is given (seeded fuzz)', () => {
    let seed = 20261009;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const alphabet = [
      '{{',
      '}}',
      '{',
      '}',
      '(',
      ')',
      ',',
      '"',
      ' ',
      '\\',
      'a',
      'Z',
      '_',
      '1',
      '-',
      'addDays',
      'format',
      'slug',
      '\n',
    ];
    for (let n = 0; n < 5000; n++) {
      let text = '';
      const len = next() % 30;
      for (let i = 0; i < len; i++) text += alphabet[next() % alphabet.length];
      const r = parseTemplateText(text);
      if (r.ok === true) {
        for (const seg of r.segments) {
          if (seg.type === 'expr') {
            expect(seg.raw.startsWith('{{') && seg.raw.endsWith('}}')).toBe(
              true,
            );
          }
        }
        // text is conserved: every character is either literal, escaped or inside a placeholder
        const rebuilt = r.segments
          .map((s) => (s.type === 'text' ? s.value : s.raw))
          .join('');
        expect(rebuilt.length).toBeLessThanOrEqual(text.length);
      }
    }
  });
});

describe('checkExpr - what a placeholder is allowed to reach', () => {
  const check = (text: string) => checkExpr(exprOf(text), VARS);

  it('accepts declared variables and the three helpers with the right argument kinds', () => {
    for (const text of [
      '{{course}}',
      '{{count}}',
      '{{paid}}',
      '{{slug(course)}}',
      '{{slug(count)}}',
      '{{addDays(startDate, 7)}}',
      '{{addDays(startDate, -7)}}',
      '{{format(startDate, "EEEE, d MMMM yyyy")}}',
    ]) {
      expect(check(text)).toBeNull();
    }
  });

  it.each([
    ['undeclared variable', '{{nope}}', /unknown variable "nope"/],
    [
      'no helper called constructor',
      '{{constructor(course)}}',
      /unknown helper/,
    ],
    [
      'no helper called hasOwnProperty',
      '{{hasOwnProperty(course)}}',
      /unknown helper/,
    ],
    ['no helper called eval', '{{eval(course)}}', /unknown helper/],
    [
      'Object.prototype names are not variables',
      '{{toString}}',
      /unknown variable/,
    ],
    ['constructor is not a variable', '{{constructor}}', /unknown variable/],
    ['wrong arity', '{{slug(course, course)}}', /takes 1 argument/],
    [
      'addDays on a non-date',
      '{{addDays(course, 1)}}',
      /must be a DATE variable/,
    ],
    [
      'addDays with a variable offset',
      '{{addDays(startDate, count)}}',
      /must be a whole number/,
    ],
    [
      'addDays out of range',
      `{{addDays(startDate, ${BLUEPRINT_LIMITS.maxOffsetDays + 1})}}`,
      /within/,
    ],
    [
      'format on a non-date',
      '{{format(course, "d")}}',
      /must be a DATE variable/,
    ],
    [
      'format with a variable pattern',
      '{{format(startDate, course)}}',
      /must be a "text" pattern/,
    ],
    [
      'format with an unsupported token',
      '{{format(startDate, "yyyy-MM-dd HH:mm")}}',
      /not a supported date pattern/,
    ],
    [
      'format with a quote in the pattern',
      '{{format(startDate, "d \'x\'")}}',
      /not a supported date pattern/,
    ],
    [
      'format with an empty pattern',
      '{{format(startDate, "")}}',
      /not a supported date pattern/,
    ],
    ['slug of a string literal', '{{slug("x")}}', /must be a variable/],
  ])('rejects %s', (_name, text, reason) => {
    expect(check(text)).toMatch(reason);
  });

  it('the helper table is exactly the three the design names', () => {
    expect(Object.keys(HELPERS).sort()).toEqual(['addDays', 'format', 'slug']);
  });

  it('date pattern tokens', () => {
    for (const p of [
      'yyyy-MM-dd',
      'd MMM yy',
      'EEE, MMMM d',
      'dd/MM/yyyy',
      'M.d',
    ]) {
      expect(DATE_PATTERN.test(p)).toBe(true);
    }
    for (const p of ['HH', 'a', 'yyyyy-Q', '${x}', "d'th'"]) {
      expect(DATE_PATTERN.test(p)).toBe(false);
    }
  });

  it('variablesRead lists the variables an expression reads', () => {
    expect(variablesRead(exprOf('{{course}}'))).toEqual(['course']);
    expect(variablesRead(exprOf('{{addDays(startDate, 3)}}'))).toEqual([
      'startDate',
    ]);
    expect(variablesRead(exprOf('{{format(startDate, "d")}}'))).toEqual([
      'startDate',
    ]);
  });

  it('injection attempts never get past the parser or the checker', () => {
    const attempts = [
      '{{constructor.constructor("return process")()}}',
      '{{process.env.SECRET}}',
      '{{require("fs")}}',
      '{{this}}',
      '{{globalThis}}',
      '{{ ${course} }}',
      '{{"a" + "b"}}',
      '{{course; drop table tasks}}',
      '{{import("x")}}',
      '{{__proto__.polluted}}',
    ];
    // a `${...}` outside a placeholder is just characters; nothing interpolates it
    expect(ok('{{course}}${course}').map((x) => x.type)).toEqual([
      'expr',
      'text',
    ]);

    for (const text of attempts) {
      const parsed = parseTemplateText(text);
      if (parsed.ok === false) continue;
      for (const seg of parsed.segments) {
        if (seg.type === 'expr') {
          expect(checkExpr(seg.expr, VARS)).not.toBeNull();
        }
      }
    }
  });
});
