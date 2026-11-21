import {
  checkExpr,
  Expr,
  parseTemplateText,
  VariableTypes,
} from '../blueprint';
import { addDays, formatDate } from './resolve.dates';
import { VariableValue, VariableValues } from './resolve.types';

/**
 * Step 3.2. Evaluates the AST that step 3.1 parses. There is no `eval`, no property lookup and
 * no function lookup by name other than the three `case`s below, so the language cannot reach
 * anything it does not list. Two properties worth stating:
 *  - SINGLE PASS: substituted values are never scanned again. A variable whose value is
 *    "{{other}}" renders as that literal text; it cannot pull in another variable.
 *  - Values only ever land in the TEXT that was parsed. Keys and structure are not touched
 *    here (callers pass leaf strings only).
 */
export type RenderResult = { ok: true; text: string } | { ok: false; message: string };

const MAX_SLUG = 60;

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

function show(v: VariableValue | undefined): string {
  return v === undefined ? '' : String(v);
}

function evaluate(expr: Expr, values: VariableValues): string {
  if (expr.kind === 'var') return show(values.get(expr.name));
  switch (expr.helper) {
    case 'slug': {
      const a = expr.args[0];
      if (a.kind !== 'var') throw new Error('slug() needs a variable');
      return slugify(show(values.get(a.name)));
    }
    case 'addDays': {
      const [d, n] = expr.args;
      if (d.kind !== 'var' || n.kind !== 'integer') throw new Error('bad addDays() arguments');
      const base = values.get(d.name);
      if (typeof base !== 'string') throw new Error(`"${d.name}" has no value`);
      const out = addDays(base, n.value);
      if (out === null) throw new Error('the date is out of range');
      return out;
    }
    case 'format': {
      const [d, p] = expr.args;
      if (d.kind !== 'var' || p.kind !== 'string') throw new Error('bad format() arguments');
      const base = values.get(d.name);
      if (typeof base !== 'string') throw new Error(`"${d.name}" has no value`);
      return formatDate(base, p.value);
    }
    default:
      // unreachable after checkExpr; fail closed
      throw new Error(`unknown helper "${expr.helper}"`);
  }
}

export function renderText(
  text: string,
  values: VariableValues,
  types: VariableTypes,
): RenderResult {
  if (!text.includes('{{')) return { ok: true, text };
  const parsed = parseTemplateText(text);
  if (parsed.ok === false) return { ok: false, message: parsed.message };
  let out = '';
  for (const seg of parsed.segments) {
    if (seg.type === 'text') {
      out += seg.value;
      continue;
    }
    const problem = checkExpr(seg.expr, types);
    if (problem) return { ok: false, message: `${seg.raw}: ${problem}` };
    try {
      out += evaluate(seg.expr, values);
    } catch (err) {
      return { ok: false, message: `${seg.raw}: ${(err as Error).message}` };
    }
  }
  return { ok: true, text: out };
}
