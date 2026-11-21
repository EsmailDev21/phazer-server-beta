// Shared by the automation rule DSL (step 5.1) and the saved-view config (step 5.4).
/** One thing wrong with a document (an automation rule, a saved view's config). `path` is an RFC 6901 JSON Pointer into the submitted rule. */
export interface RuleIssue {
  code: string;
  path: string;
  message: string;
}

/** Valid, but this build cannot execute it (yet). The rule is stored and cannot be enabled. */
export interface UnsupportedConstruct {
  path: string;
  construct: string;
  reason: string;
}

/** Reported issues are capped so a hostile document cannot make the answer huge. */
export const MAX_REPORTED_ISSUES = 50;

export class Sink {
  readonly issues: RuleIssue[] = [];
  readonly unsupported: UnsupportedConstruct[] = [];
  private truncated = false;

  add(code: string, path: string, message: string): void {
    if (this.issues.length >= MAX_REPORTED_ISSUES) {
      if (!this.truncated) {
        this.truncated = true;
        this.issues.push({
          code: 'TOO_MANY_ISSUES',
          path: '',
          message: 'More problems exist; fix these first',
        });
      }
      return;
    }
    this.issues.push({ code, path, message });
  }
  get full(): boolean {
    return this.truncated;
  }
}

export type Check = (v: unknown, path: string, sink: Sink) => void;
export interface Field {
  check: Check;
  required: boolean;
}

export const esc = (segment: string): string =>
  segment.replace(/~/g, '~0').replace(/\//g, '~1');
export const at = (path: string, segment: string | number): string =>
  `${path}/${esc(String(segment))}`;
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const req = (check: Check): Field => ({ check, required: true });
export const opt = (check: Check): Field => ({ check, required: false });

export function str(o: {
  min?: number;
  max: number;
  pattern?: RegExp;
  what?: string;
}): Check {
  return (v, path, sink) => {
    if (typeof v !== 'string')
      return sink.add(
        'WRONG_TYPE',
        path,
        `${o.what ?? 'value'} must be a string`,
      );
    if (v.length < (o.min ?? 1))
      return sink.add(
        'TOO_SHORT',
        path,
        `${o.what ?? 'value'} must not be empty`,
      );
    if (v.length > o.max)
      return sink.add(
        'TOO_LONG',
        path,
        `${o.what ?? 'value'} is longer than ${o.max} characters`,
      );
    if (o.pattern && !o.pattern.test(v))
      sink.add(
        'BAD_FORMAT',
        path,
        `${o.what ?? 'value'} has an invalid format`,
      );
  };
}

export function int(o: { min: number; max: number }): Check {
  return (v, path, sink) => {
    if (typeof v !== 'number' || !Number.isInteger(v))
      return sink.add('WRONG_TYPE', path, 'must be a whole number');
    if (v < o.min || v > o.max)
      sink.add('OUT_OF_RANGE', path, `must be between ${o.min} and ${o.max}`);
  };
}

export function num(o: { min: number; max: number }): Check {
  return (v, path, sink) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      return sink.add('WRONG_TYPE', path, 'must be a number');
    if (v < o.min || v > o.max)
      sink.add('OUT_OF_RANGE', path, `must be between ${o.min} and ${o.max}`);
  };
}

export const bool: Check = (v, path, sink) => {
  if (typeof v !== 'boolean')
    sink.add('WRONG_TYPE', path, 'must be true or false');
};

export function oneOf(values: readonly string[], what = 'value'): Check {
  return (v, path, sink) => {
    if (typeof v !== 'string')
      return sink.add('WRONG_TYPE', path, `${what} must be a string`);
    if (!values.includes(v))
      sink.add(
        'BAD_VALUE',
        path,
        `${what} must be one of ${values.join(', ')}`,
      );
  };
}

export function literal(value: string): Check {
  return (v, path, sink) => {
    if (v !== value) sink.add('BAD_VALUE', path, `must be "${value}"`);
  };
}

export function arr(item: Check, o: { min: number; max: number }): Check {
  return (v, path, sink) => {
    if (!Array.isArray(v))
      return sink.add('WRONG_TYPE', path, 'must be a list');
    if (v.length < o.min)
      sink.add(
        'TOO_FEW',
        path,
        `needs at least ${o.min} item${o.min === 1 ? '' : 's'}`,
      );
    if (v.length > o.max)
      return sink.add('TOO_MANY', path, `has more than ${o.max} items`);
    v.forEach((x, i) => item(x, at(path, i), sink));
  };
}

export function nullable(check: Check): Check {
  return (v, path, sink) => {
    if (v !== null) check(v, path, sink);
  };
}

/** An object with exactly these keys (unknown keys are refused: a typo must not silently do nothing). */
export function obj(shape: Record<string, Field>): Check {
  return (v, path, sink) => {
    if (!isObject(v)) return sink.add('WRONG_TYPE', path, 'must be an object');
    for (const key of Object.keys(v)) {
      if (!(key in shape))
        sink.add('UNKNOWN_KEY', at(path, key), `"${key}" is not allowed here`);
    }
    for (const [key, field] of Object.entries(shape)) {
      if (!(key in v) || v[key] === undefined) {
        if (field.required)
          sink.add('MISSING', at(path, key), `"${key}" is required`);
        continue;
      }
      field.check(v[key], at(path, key), sink);
    }
  };
}

/** `obj`, plus: exactly one of `keys` must be present. */
export function objExactlyOne(
  keys: string[],
  shape: Record<string, Field>,
): Check {
  const base = obj(shape);
  return (v, path, sink) => {
    base(v, path, sink);
    if (!isObject(v)) return;
    const present = keys.filter((k) => v[k] !== undefined);
    if (present.length !== 1)
      sink.add(
        'EXACTLY_ONE_OF',
        path,
        `give exactly one of ${keys.join(' / ')}`,
      );
  };
}

export interface Variant {
  check: Check;
  /** present = this build cannot execute it; the text says why */
  unavailable?: string;
}

/** A union picked by a string key (`type`). An unknown tag is an error; an unavailable one is recorded. */
export function tagged(
  key: string,
  variants: Record<string, Variant>,
  what: string,
): Check {
  return (v, path, sink) => {
    if (!isObject(v)) return sink.add('WRONG_TYPE', path, 'must be an object');
    const tag = v[key];
    if (typeof tag !== 'string')
      return sink.add('MISSING', at(path, key), `"${key}" is required`);
    const variant = Object.prototype.hasOwnProperty.call(variants, tag)
      ? variants[tag]
      : undefined;
    if (!variant)
      return sink.add(
        `UNKNOWN_${what.toUpperCase()}`,
        at(path, key),
        `unknown ${what} "${tag.slice(0, 40)}"`,
      );
    variant.check(v, path, sink);
    if (variant.unavailable)
      sink.unsupported.push({
        path,
        construct: tag,
        reason: variant.unavailable,
      });
  };
}

/** Max nesting of objects/arrays; guards the recursive checks above against a hostile document. */
export function depthOf(v: unknown, limit: number): number {
  if (typeof v !== 'object' || v === null) return 0;
  if (limit <= 0) return 1;
  let max = 0;
  for (const child of Array.isArray(v) ? v : Object.values(v))
    max = Math.max(max, depthOf(child, limit - 1));
  return 1 + max;
}
