import { createHash } from 'crypto';

/**
 * Step 3.1. Canonical JSON and the checksum a TemplateVersion stores (step 3.5): the same
 * document always yields the same bytes, whatever order its keys were written in.
 *
 * Rules: object keys sorted by UTF-16 code unit order; array order preserved (order is meaning:
 * it is the display position); no whitespace; numbers and strings exactly as JSON.stringify
 * writes them. Input must already be plain JSON (validateBlueprint guarantees that).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    // fromEntries defines properties (it never runs the __proto__ setter that `out[key] =` would)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** "sha256:<64 hex>" of the canonical form. */
export function blueprintChecksum(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
