import { BLUEPRINT_LIMITS } from './blueprint.limits';
import { VariableType } from './blueprint.types';

/**
 * Step 3.1. The placeholder language of blueprint text, as a GRAMMAR plus a static checker.
 * Nothing here evaluates anything: step 3.2's resolver walks the AST this file produces, which
 * is what makes "no evaluation" a property of the design instead of a promise (there is no
 * code path from a string to a function call other than a lookup in HELPERS).
 *
 *   text        := ( literal | '\{{' | placeholder )*
 *   placeholder := '{{' ws expr ws '}}'
 *   expr        := ident | ident ws '(' ws [ arg ( ws ',' ws arg )* ] ws ')'
 *   arg         := ident | string | integer          -- an ident is always a VARIABLE
 *   ident       := [A-Za-z][A-Za-z0-9_]*
 *   string      := '"' [^"\\\r\n]* '"'               -- no escapes at all
 *   integer     := '-'? [0-9]+
 *
 * No nesting, no operators, no property access, no loops, no conditionals. A backslash right
 * before `{{` makes it literal text (`\{{` renders `{{`); that is the only escape.
 */

export type Arg =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'integer'; value: number };

export type Expr =
  { kind: 'var'; name: string } | { kind: 'call'; helper: string; args: Arg[] };

export type Segment =
  { type: 'text'; value: string } | { type: 'expr'; expr: Expr; raw: string };

export type ParseResult =
  | { ok: true; segments: Segment[] }
  | { ok: false; offset: number; message: string };

const IDENT = /^[A-Za-z][A-Za-z0-9_]*/;
const INTEGER = /^-?[0-9]+/;
const STRING = /^"([^"\\\r\n]*)"/;

export function parseTemplateText(text: string): ParseResult {
  const segments: Segment[] = [];
  let literal = '';
  let placeholders = 0;
  let i = 0;

  const flush = () => {
    if (literal) segments.push({ type: 'text', value: literal });
    literal = '';
  };

  while (i < text.length) {
    if (text.startsWith('\\{{', i)) {
      literal += '{{';
      i += 3;
      continue;
    }
    if (!text.startsWith('{{', i)) {
      literal += text[i];
      i += 1;
      continue;
    }
    const close = text.indexOf('}}', i + 2);
    if (close === -1) {
      return {
        ok: false,
        offset: i,
        message: 'placeholder is not closed with }}',
      };
    }
    const inner = text.slice(i + 2, close);
    if (inner.includes('{{')) {
      return { ok: false, offset: i, message: 'placeholders cannot be nested' };
    }
    if (inner.length > BLUEPRINT_LIMITS.maxPlaceholderLength) {
      return {
        ok: false,
        offset: i,
        message: `placeholder is longer than ${BLUEPRINT_LIMITS.maxPlaceholderLength} characters`,
      };
    }
    placeholders += 1;
    if (placeholders > BLUEPRINT_LIMITS.maxPlaceholdersPerString) {
      return {
        ok: false,
        offset: i,
        message: `more than ${BLUEPRINT_LIMITS.maxPlaceholdersPerString} placeholders in one text`,
      };
    }
    const parsed = parseExpr(inner);
    if (parsed.ok === false) {
      return { ok: false, offset: i, message: parsed.message };
    }
    flush();
    segments.push({
      type: 'expr',
      expr: parsed.expr,
      raw: text.slice(i, close + 2),
    });
    i = close + 2;
  }
  flush();
  return { ok: true, segments };
}

function parseExpr(
  inner: string,
): { ok: true; expr: Expr } | { ok: false; message: string } {
  let s = inner.trim();
  const id = IDENT.exec(s);
  if (!id) return { ok: false, message: 'expected a variable or helper name' };
  const name = id[0];
  s = s.slice(name.length).trimStart();
  if (s === '') return { ok: true, expr: { kind: 'var', name } };
  if (s[0] !== '(') {
    return { ok: false, message: `unexpected "${s[0]}" after "${name}"` };
  }
  s = s.slice(1).trimStart();
  const args: Arg[] = [];
  if (s[0] === ')') {
    s = s.slice(1);
  } else {
    for (;;) {
      const arg = parseArg(s);
      if (!arg)
        return {
          ok: false,
          message: 'expected a variable, "text" or whole number',
        };
      args.push(arg.arg);
      s = s.slice(arg.length).trimStart();
      if (s[0] === ',') {
        s = s.slice(1).trimStart();
        continue;
      }
      if (s[0] === ')') {
        s = s.slice(1);
        break;
      }
      return { ok: false, message: 'expected "," or ")"' };
    }
  }
  if (s.trim() !== '') {
    return { ok: false, message: `unexpected "${s.trim()[0]}" after ")"` };
  }
  return { ok: true, expr: { kind: 'call', helper: name, args } };
}

function parseArg(s: string): { arg: Arg; length: number } | null {
  const str = STRING.exec(s);
  if (str)
    return { arg: { kind: 'string', value: str[1] }, length: str[0].length };
  const int = INTEGER.exec(s);
  if (int) {
    const value = Number(int[0]);
    if (!Number.isSafeInteger(value)) return null;
    return { arg: { kind: 'integer', value }, length: int[0].length };
  }
  const id = IDENT.exec(s);
  if (id) return { arg: { kind: 'var', name: id[0] }, length: id[0].length };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Helpers: a closed list. Adding one is a schemaVersion decision, not a refactor.
// ---------------------------------------------------------------------------------------------

type ParamKind = 'ANY_VAR' | 'DATE_VAR' | 'OFFSET' | 'DATE_PATTERN';

interface HelperSpec {
  params: readonly ParamKind[];
  /** What the placeholder is worth where it appears. */
  returns: 'TEXT' | 'DATE';
}

export const HELPERS: Readonly<Record<string, HelperSpec>> = {
  /** slug(var): lower-case, a-z0-9 and hyphens. */
  slug: { params: ['ANY_VAR'], returns: 'TEXT' },
  /** addDays(dateVar, n): the date n days later (n may be negative). */
  addDays: { params: ['DATE_VAR', 'OFFSET'], returns: 'DATE' },
  /** format(dateVar, "MMM d"): see DATE_PATTERN. */
  format: { params: ['DATE_VAR', 'DATE_PATTERN'], returns: 'TEXT' },
};

/** Tokens: yyyy yy MMMM MMM MM M dd d EEEE EEE, separators: space - / . , */
export const DATE_PATTERN =
  /^(?:yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|[ \-/.,])+$/;
export const DATE_PATTERN_MAX_LENGTH = 32;

export type VariableTypes = ReadonlyMap<string, VariableType>;

/**
 * Static check of one expression against the declared variables. Returns the reason it is not
 * allowed, or null. Only variables that exist, helpers in HELPERS, argument kinds that match.
 */
export function checkExpr(expr: Expr, variables: VariableTypes): string | null {
  if (expr.kind === 'var') {
    return variables.has(expr.name) ? null : `unknown variable "${expr.name}"`;
  }
  const spec = Object.prototype.hasOwnProperty.call(HELPERS, expr.helper)
    ? HELPERS[expr.helper]
    : undefined;
  if (!spec) return `unknown helper "${expr.helper}"`;
  if (expr.args.length !== spec.params.length) {
    return `${expr.helper}() takes ${spec.params.length} argument(s), got ${expr.args.length}`;
  }
  for (let n = 0; n < spec.params.length; n++) {
    const param = spec.params[n];
    const arg = expr.args[n];
    const where = `argument ${n + 1} of ${expr.helper}()`;
    switch (param) {
      case 'ANY_VAR':
        if (arg.kind !== 'var') return `${where} must be a variable`;
        if (!variables.has(arg.name)) return `unknown variable "${arg.name}"`;
        break;
      case 'DATE_VAR':
        if (arg.kind !== 'var') return `${where} must be a date variable`;
        if (!variables.has(arg.name)) return `unknown variable "${arg.name}"`;
        if (variables.get(arg.name) !== 'DATE') {
          return `${where} must be a DATE variable, "${arg.name}" is ${variables.get(arg.name)}`;
        }
        break;
      case 'OFFSET':
        if (arg.kind !== 'integer') return `${where} must be a whole number`;
        if (Math.abs(arg.value) > BLUEPRINT_LIMITS.maxOffsetDays) {
          return `${where} must be within +-${BLUEPRINT_LIMITS.maxOffsetDays}`;
        }
        break;
      case 'DATE_PATTERN':
        if (arg.kind !== 'string') return `${where} must be a "text" pattern`;
        if (
          arg.value.length === 0 ||
          arg.value.length > DATE_PATTERN_MAX_LENGTH ||
          !DATE_PATTERN.test(arg.value)
        ) {
          return `${where} is not a supported date pattern`;
        }
        break;
    }
  }
  return null;
}

/** Names of the variables an expression reads (for "unused variable" reporting). */
export function variablesRead(expr: Expr): string[] {
  if (expr.kind === 'var') return [expr.name];
  return expr.args.flatMap((a) => (a.kind === 'var' ? [a.name] : []));
}
