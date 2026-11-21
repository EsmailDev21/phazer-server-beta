import { blueprintChecksum, canonicalJson } from '../../templates/blueprint/blueprint.canonical';

/**
 * Step 4.2. `ExternalRef.contentHash`: "unchanged on re-run = skip, changed = update" (diagram 05). It is the Blueprint's
 * canonical-JSON SHA-256 (same bytes for the same content whatever the key order), computed over the item AS WRITTEN
 * AFTER VALIDATION (repairs included), so a repair rule change re-imports instead of silently skipping.
 *
 * `volatile` fields are left out: they change without the content changing (a provider "updatedAt" bumped by a view, or
 * the comment list growing when the task text did not). Pass the entity and which nested lists to exclude.
 */
export function contentHash(value: unknown, omit: readonly string[] = []): string {
  if (omit.length === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return blueprintChecksum(value);
  }
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of omit) delete copy[k];
  return blueprintChecksum(copy);
}

/**
 * The hash of a TASK's own content: its fields, not its comments / attachments / history (those are separate
 * ExternalRef types with their own hashes, so a new comment must not re-write the task) and not `updatedAt`.
 */
export function taskContentHash(task: unknown): string {
  return contentHash(task, ['comments', 'attachments', 'history', 'updatedAt']);
}

export { canonicalJson };
