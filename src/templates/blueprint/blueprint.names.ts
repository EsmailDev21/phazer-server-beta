/**
 * Step 3.1. How blueprint names are compared. This is the SAME normalisation tags, issue types
 * and workflow statuses use when they are written (NFKC, whitespace collapsed, trimmed,
 * lower-cased - see tags/tag-name.ts and workflow/workflow-name.ts), so "two names collide in
 * the blueprint" is true exactly when "they would collide in the database". Keep in step.
 */
export function collapseName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function foldName(raw: string): string {
  return collapseName(raw)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
