import {
  badTextReasonOf,
  BLUEPRINT_LIMITS as L,
  BlueprintVariable,
  isCalendarDate,
} from './resolve.deps';
import { Issues, VariableValue, VariableValues } from './resolve.types';

/**
 * Step 3.2 / pipeline step 2a. Turns what the person typed into the wizard into typed values.
 * STRICT: no coercion ("5" is not a number), unknown names are errors (typo guard), and a TEXT
 * value is one clean line - so a value can never smuggle a line break or control character into
 * a title. Defaults fill what was not supplied; `required` without a default must be supplied.
 * An optional variable with neither stays UNSET (renders as "" in plain `{{v}}`).
 */
export function resolveVariables(
  declared: BlueprintVariable[] | undefined,
  supplied: unknown,
  issues: Issues,
): VariableValues {
  const values = new Map<string, VariableValue>();
  const decl = new Map((declared ?? []).map((v) => [v.key, v]));

  let input: Record<string, unknown> = {};
  if (supplied !== undefined && supplied !== null) {
    if (typeof supplied !== 'object' || Array.isArray(supplied)) {
      issues.add('VARIABLE_INVALID', '/variables', 'Variable values must be an object');
      return values;
    }
    input = supplied as Record<string, unknown>;
  }

  for (const name of Object.keys(input)) {
    if (!decl.has(name)) {
      issues.add('VARIABLE_UNKNOWN', `/variables/${name}`, `"${name}" is not a variable of this template`);
    }
  }

  for (const v of declared ?? []) {
    const given = Object.prototype.hasOwnProperty.call(input, v.key) ? input[v.key] : undefined;
    const path = `/variables/${v.key}`;
    const raw = given !== undefined && given !== null ? given : v.default;
    if (raw === undefined) {
      if (v.required) issues.add('VARIABLE_MISSING', path, `"${v.label}" is required`);
      continue;
    }
    const problem = valueProblem(v, raw);
    if (problem) {
      issues.add('VARIABLE_INVALID', path, `"${v.label}": ${problem}`);
      continue;
    }
    values.set(v.key, raw as VariableValue);
  }
  return values;
}

function valueProblem(v: BlueprintVariable, raw: unknown): string | null {
  switch (v.type) {
    case 'TEXT': {
      if (typeof raw !== 'string') return 'expected text';
      if (raw.trim() === '') return 'must not be blank';
      if (raw.length > L.variableTextDefault) return `at most ${L.variableTextDefault} characters`;
      if (/[\r\n\t]/.test(raw)) return 'must be a single line';
      const bad = badTextReasonOf(raw);
      return bad ? `text ${bad}` : null;
    }
    case 'NUMBER':
      return typeof raw === 'number' && Number.isFinite(raw) ? null : 'expected a number';
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? null : 'expected true or false';
    case 'DATE':
      return typeof raw === 'string' && isCalendarDate(raw) ? null : 'expected a real date, "YYYY-MM-DD"';
    case 'SELECT':
      return typeof raw === 'string' && v.options?.includes(raw) ? null : 'expected one of the options';
  }
}
