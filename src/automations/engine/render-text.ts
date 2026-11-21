import { AUTOMATION_LIMITS } from '../dsl/rule.limits';

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Fills the {{placeholders}} the validator allows. Plain substitution: the values are DATA (a task
 * title may contain anything) and are never re-scanned, so a title cannot smuggle in another
 * placeholder. Unknown names become empty. Clamped to `max` characters.
 */
export function renderText(
  template: string,
  vars: Readonly<Record<string, string>>,
  max: number = AUTOMATION_LIMITS.maxCommentLength,
): string {
  const out = template.replace(TOKEN, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : '',
  );
  return out.length <= max ? out : `${out.slice(0, Math.max(0, max - 1))}…`;
}
