import { BLUEPRINT_SCHEMA_VERSION } from './blueprint.types';

/**
 * Step 3.1. The version-migration hook. A stored blueprint (an immutable TemplateVersion, an
 * uploaded file, a marketplace submission) carries `schemaVersion`. Readers always work on the
 * CURRENT shape, so an older document is upgraded here, in memory, one version at a time, before
 * validation. Stored rows are never rewritten by this (versions are immutable, step 3.5).
 *
 * v1 is the first version, so the registry is empty. When v2 exists, add `1: (doc) => ...`
 * which returns a NEW object with `schemaVersion: 2` (never mutate - the caller may still hold
 * the original), bump BLUEPRINT_SCHEMA_VERSION, and the chain 1 -> 2 -> ... runs by itself.
 *
 * A document NEWER than this build understands is rejected, not guessed at: a rolled-back
 * server must not misread what a newer one wrote.
 */
export type RawDocument = Record<string, unknown>;
export type Migration = (doc: RawDocument) => RawDocument;
/** Keyed by the version the migration migrates FROM. */
export type MigrationRegistry = Readonly<Record<number, Migration>>;

export const MIGRATIONS: MigrationRegistry = {};

export type MigrationResult =
  | { ok: true; doc: RawDocument; fromVersion: number; steps: number }
  | {
      ok: false;
      code:
        | 'NOT_AN_OBJECT'
        | 'VERSION_MISSING'
        | 'VERSION_INVALID'
        | 'VERSION_TOO_NEW'
        | 'MIGRATION_MISSING'
        | 'MIGRATION_BROKEN';
      message: string;
    };

export interface MigrationOptions {
  /** Injectable for tests (the real registry is empty until v2). */
  migrations?: MigrationRegistry;
  currentVersion?: number;
}

export function migrateToCurrent(
  input: unknown,
  options: MigrationOptions = {},
): MigrationResult {
  const registry = options.migrations ?? MIGRATIONS;
  const current = options.currentVersion ?? BLUEPRINT_SCHEMA_VERSION;

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      code: 'NOT_AN_OBJECT',
      message: 'A blueprint must be a JSON object',
    };
  }
  let doc = input as RawDocument;
  if (!Object.prototype.hasOwnProperty.call(doc, 'schemaVersion')) {
    return {
      ok: false,
      code: 'VERSION_MISSING',
      message: 'schemaVersion is required',
    };
  }
  const from = doc.schemaVersion;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
    return {
      ok: false,
      code: 'VERSION_INVALID',
      message: 'schemaVersion must be a whole number, 1 or higher',
    };
  }
  if (from > current) {
    return {
      ok: false,
      code: 'VERSION_TOO_NEW',
      message: `This blueprint is schemaVersion ${from}; this server understands up to ${current}`,
    };
  }

  let version = from;
  let steps = 0;
  while (version < current) {
    const migrate = Object.prototype.hasOwnProperty.call(registry, version)
      ? registry[version]
      : undefined;
    if (!migrate) {
      return {
        ok: false,
        code: 'MIGRATION_MISSING',
        message: `No migration from schemaVersion ${version} to ${version + 1}`,
      };
    }
    let next: RawDocument;
    try {
      next = migrate(doc);
    } catch (err) {
      return {
        ok: false,
        code: 'MIGRATION_BROKEN',
        message: `Migration from schemaVersion ${version} failed: ${(err as Error)?.message ?? 'unknown error'}`,
      };
    }
    if (
      next === null ||
      typeof next !== 'object' ||
      Array.isArray(next) ||
      next === doc ||
      next.schemaVersion !== version + 1
    ) {
      return {
        ok: false,
        code: 'MIGRATION_BROKEN',
        message: `Migration from schemaVersion ${version} must return a new object with schemaVersion ${version + 1}`,
      };
    }
    doc = next;
    version += 1;
    steps += 1;
  }
  return { ok: true, doc, fromVersion: from, steps };
}
