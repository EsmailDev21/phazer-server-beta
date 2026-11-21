import { BLUEPRINT_LIMITS } from './blueprint.limits';

/**
 * Step 3.1. What validation reports. `code` is STABLE (clients and tests switch on it);
 * `message` is for humans and may change; `path` is an RFC 6901 JSON Pointer into the
 * document ("" = the document itself).
 */
export type BlueprintIssueCode =
  // the document is not even a usable JSON value
  | 'NOT_JSON'
  | 'JSON_SYNTAX'
  | 'TOO_LARGE'
  | 'TOO_DEEP'
  | 'BAD_TEXT'
  // versioning
  | 'VERSION_MISSING'
  | 'VERSION_INVALID'
  | 'VERSION_TOO_NEW'
  | 'MIGRATION_MISSING'
  | 'MIGRATION_BROKEN'
  // shape (JSON Schema)
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'SCHEMA'
  // limits the schema cannot express
  | 'TOO_MANY_NODES'
  | 'TASK_TOO_DEEP'
  | 'ASSETS_TOO_LARGE'
  | 'OPAQUE_TOO_LARGE'
  // step 5.5: a portable automation / saved view (kind rule.v1 / view.v1) that does not hold up
  | 'AUTOMATION_INVALID'
  | 'VIEW_INVALID'
  // references and uniqueness
  | 'DUPLICATE'
  | 'UNKNOWN_REF'
  | 'KIND_MISMATCH'
  // placeholders
  | 'PLACEHOLDER_SYNTAX'
  | 'PLACEHOLDER_INVALID'
  | 'PLACEHOLDER_NOT_ALLOWED'
  // domain rules
  | 'VARIABLE_INVALID'
  | 'ANCHOR_INVALID'
  | 'WORKFLOW_INVALID'
  | 'FIELD_INVALID'
  | 'VALUE_INVALID'
  | 'DATE_RANGE'
  | 'ITERATION_SCOPE'
  | 'DEPENDENCY_INVALID'
  | 'DEPENDENCY_CYCLE'
  | 'MODULE_INVALID'
  | 'ASSET_INVALID'
  | 'NAME_INVALID'
  // non-blocking
  | 'UNUSED_VARIABLE'
  | 'UNUSED_ROLE'
  | 'UNUSED_ASSET';

export interface BlueprintIssue {
  code: BlueprintIssueCode;
  path: string;
  message: string;
}

/** Collects issues up to a ceiling; `truncated` says some were dropped. */
export class IssueList {
  readonly items: BlueprintIssue[] = [];
  truncated = false;

  constructor(private readonly max = BLUEPRINT_LIMITS.maxIssues) {}

  get full(): boolean {
    return this.items.length >= this.max;
  }
  get count(): number {
    return this.items.length;
  }

  add(code: BlueprintIssueCode, path: string, message: string): void {
    if (this.full) {
      this.truncated = true;
      return;
    }
    this.items.push({ code, path, message });
  }
}

/** RFC 6901 escaping of one path segment. */
export function pointer(
  base: string,
  ...segments: Array<string | number>
): string {
  return segments.reduce<string>(
    (acc, s) => `${acc}/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`,
    base,
  );
}
