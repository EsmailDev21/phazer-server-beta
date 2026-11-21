/**
 * Minimal fuzzy string matching — token-overlap (Jaccard-ish) + substring
 * boost. No external library added for this; it's a small enough
 * heuristic that a dependency isn't worth it, and it's explicitly a v1
 * placeholder (see SNAP__EXEC__ACTION_MAP) — swap for something more
 * sophisticated later if match quality turns out to matter more than
 * this gets right.
 *
 * Score is normalized to 0-1. Used to resolve a free-text reference
 * (e.g. "the mockup task") against real Task titles / member names
 * within the already-permission-scoped candidate set — this utility
 * itself does no authorization, callers must pre-filter candidates.
 */
export interface FuzzyMatchResult<T> {
  candidate: T;
  score: number;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '');
}

function tokenize(text: string): Set<string> {
  return new Set(normalize(text).split(/\s+/).filter(Boolean));
}

export function scoreSimilarity(query: string, candidate: string): number {
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  const intersection = [...queryTokens].filter((t) =>
    candidateTokens.has(t),
  ).length;
  const union = new Set([...queryTokens, ...candidateTokens]).size;
  const jaccard = intersection / union;

  const substringBoost =
    normalize(candidate).includes(normalize(query)) ||
    normalize(query).includes(normalize(candidate))
      ? 0.25
      : 0;

  return Math.min(1, jaccard + substringBoost);
}

/** Returns candidates sorted by score descending, filtered to a minimum threshold. */
export function fuzzyMatch<T>(
  query: string,
  candidates: T[],
  getText: (item: T) => string,
  minScore = 0.15,
): FuzzyMatchResult<T>[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreSimilarity(query, getText(candidate)),
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
