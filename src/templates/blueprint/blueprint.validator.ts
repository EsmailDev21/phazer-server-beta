import Ajv, { ErrorObject } from 'ajv';
import {
  BlueprintIssue,
  BlueprintIssueCode,
  IssueList,
  pointer,
} from './blueprint.issues';
import { inspectJson } from './blueprint.json-guard';
import { BLUEPRINT_LIMITS as L } from './blueprint.limits';
import { MigrationOptions, migrateToCurrent } from './blueprint.migrations';
import { BLUEPRINT_V1_SCHEMA } from './blueprint.schema';
import { checkSemantics } from './blueprint.semantics';
import { BlueprintStats, computeBlueprintStats } from './blueprint.stats';
import { BlueprintV1 } from './blueprint.types';

/**
 * Step 3.1. THE entry point for any blueprint that is not already known good: an upload, an
 * extractor's output, a marketplace submission, a stored version about to be read.
 *
 *   JSON guard -> size -> migrate -> JSON Schema -> node limit -> semantic rules
 *
 * Each stage runs only if the previous one passed, so later stages can trust what earlier
 * ones guaranteed (a recursive validator never sees a 50 000-level document; semantic code
 * never sees a task without a nodeKey).
 */

export type BlueprintValidation =
  | {
      ok: true;
      /** The document at the CURRENT schemaVersion. Do not mutate it. */
      blueprint: BlueprintV1;
      /** The version it arrived as; null when no migration was needed. */
      migratedFrom: number | null;
      stats: BlueprintStats;
      warnings: BlueprintIssue[];
    }
  | { ok: false; issues: BlueprintIssue[]; truncated: boolean };

export interface ValidateOptions {
  /** For tests of the migration hook. */
  migration?: MigrationOptions;
}

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  // never "helpful": the validator must not change the document it is judging
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateShape = ajv.compile<BlueprintV1>(BLUEPRINT_V1_SCHEMA);

/** For text that has not been parsed yet (a request body, a file). Checks the size FIRST. */
export function parseBlueprintJson(
  text: string,
  options: ValidateOptions = {},
): BlueprintValidation {
  if (typeof text !== 'string') {
    return fail([
      { code: 'NOT_JSON', path: '', message: 'Expected JSON text' },
    ]);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > L.maxBytes) {
    return fail([
      {
        code: 'TOO_LARGE',
        path: '',
        message: `The blueprint is ${bytes} bytes; the limit is ${L.maxBytes}`,
      },
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return fail([
      {
        code: 'JSON_SYNTAX',
        path: '',
        message: `Not valid JSON: ${(err as Error).message}`,
      },
    ]);
  }
  return validateBlueprint(parsed, options);
}

export function validateBlueprint(
  input: unknown,
  options: ValidateOptions = {},
): BlueprintValidation {
  const issues = new IssueList();

  // 1. plain JSON, bounded depth, clean text
  if (!inspectJson(input, issues)) return fail(issues.items, issues.truncated);

  // 2. size (the object may not have come from text)
  const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (bytes > L.maxBytes) {
    return fail([
      {
        code: 'TOO_LARGE',
        path: '',
        message: `The blueprint is ${bytes} bytes; the limit is ${L.maxBytes}`,
      },
    ]);
  }

  // 3. bring an older document up to the current shape
  const migrated = migrateToCurrent(input, options.migration);
  if (migrated.ok === false) {
    const code: BlueprintIssueCode =
      migrated.code === 'NOT_AN_OBJECT' ? 'SCHEMA' : migrated.code;
    return fail([
      {
        code,
        path: migrated.code.startsWith('VERSION') ? '/schemaVersion' : '',
        message: migrated.message,
      },
    ]);
  }
  const doc = migrated.doc;
  // a migration's output is untrusted too: it goes through the same gates
  if (migrated.steps > 0 && !inspectJson(doc, issues)) {
    return fail(issues.items, issues.truncated);
  }

  // 4. shape
  if (!validateShape(doc)) {
    for (const error of validateShape.errors ?? [])
      addSchemaIssue(issues, error);
    return fail(issues.items, issues.truncated);
  }
  const blueprint = doc as unknown as BlueprintV1;

  // 5. the limit the schema cannot express, BEFORE the per-node semantic work
  const stats = computeBlueprintStats(blueprint);
  if (stats.nodes > L.maxNodes) {
    return fail([
      {
        code: 'TOO_MANY_NODES',
        path: '',
        message: `${stats.nodes} projects, tasks and iterations; the limit is ${L.maxNodes}`,
      },
    ]);
  }

  // 6. references, uniqueness, placeholders, workflow, dependencies...
  const warnings = new IssueList();
  checkSemantics(blueprint, issues, warnings);
  if (issues.count > 0) return fail(issues.items, issues.truncated);

  return {
    ok: true,
    blueprint,
    migratedFrom: migrated.steps > 0 ? migrated.fromVersion : null,
    stats,
    warnings: warnings.items,
  };
}

function fail(items: BlueprintIssue[], truncated = false): BlueprintValidation {
  return { ok: false, issues: items, truncated };
}

function addSchemaIssue(issues: IssueList, e: ErrorObject): void {
  const base = e.instancePath;
  switch (e.keyword) {
    case 'additionalProperties': {
      const name = String(e.params.additionalProperty);
      issues.add(
        'UNKNOWN_FIELD',
        pointer(base, name),
        `Unknown field "${name}"`,
      );
      return;
    }
    case 'required': {
      const name = String(e.params.missingProperty);
      issues.add(
        'MISSING_FIELD',
        pointer(base, name),
        `Missing required field "${name}"`,
      );
      return;
    }
    case 'enum': {
      const allowed = (e.params.allowedValues as unknown[])
        .slice(0, 12)
        .join(', ');
      issues.add('SCHEMA', base, `Must be one of: ${allowed}`);
      return;
    }
    case 'propertyNames':
      return; // the nested pattern error below carries the useful message
    case 'pattern':
      issues.add(
        'SCHEMA',
        base,
        e.params.propertyName !== undefined
          ? `The key "${String(e.params.propertyName)}" is not allowed here`
          : `Does not match the required format (${String(e.params.pattern)})`,
      );
      return;
    case 'const':
      issues.add(
        'SCHEMA',
        base,
        `Must be ${JSON.stringify(e.params.allowedValue)}`,
      );
      return;
    default:
      issues.add('SCHEMA', base, `${e.message ?? 'Invalid'}`);
  }
}
