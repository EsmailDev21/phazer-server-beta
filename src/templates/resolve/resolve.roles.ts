import { BlueprintRole } from '../blueprint';
import { Issues, ResolvedRole, RoleAssignment } from './resolve.types';

/**
 * Step 3.2 / pipeline step 5. Maps role placeholders to people the PERSON APPLYING chose:
 *   MEMBER   - an existing member of the target workspace (the caller passes who qualifies)
 *   INVITE   - an email to invite later (the applier decides when; nothing is sent here)
 *   UNASSIGNED (default)
 * A template can never name a person, and resolving a role grants NOTHING: `suggestedAccess` is
 * advice shown in the wizard, not an action taken here. The cap on invites keeps one apply from
 * becoming an email cannon.
 */
export const MAX_INVITES_PER_APPLY = 20;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function resolveRoles(
  roles: BlueprintRole[] | undefined,
  choices: unknown,
  eligibleUserIds: ReadonlySet<string>,
  issues: Issues,
): ResolvedRole[] {
  const declared = new Map((roles ?? []).map((r) => [r.key, r]));
  let given: Record<string, unknown> = {};
  if (choices !== undefined && choices !== null) {
    if (typeof choices !== 'object' || Array.isArray(choices)) {
      issues.add('ROLE_INVALID', '/roles', 'Role choices must be an object');
    } else {
      given = choices as Record<string, unknown>;
    }
  }
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) issues.add('ROLE_UNKNOWN', `/roles/${key}`, `"${key}" is not a role of this template`);
  }

  let invites = 0;
  return (roles ?? []).map((r): ResolvedRole => {
    const path = `/roles/${r.key}`;
    const raw = Object.prototype.hasOwnProperty.call(given, r.key) ? given[r.key] : undefined;
    const base = { key: r.key, label: r.label, suggestedAccess: r.suggestedAccess };
    const unassigned: RoleAssignment = { type: 'UNASSIGNED' };
    if (raw === undefined || raw === null) return { ...base, assignment: unassigned };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      issues.add('ROLE_INVALID', path, 'Expected { type, ... }');
      return { ...base, assignment: unassigned };
    }
    const c = raw as { type?: unknown; userId?: unknown; email?: unknown };
    if (c.type === 'UNASSIGNED') return { ...base, assignment: unassigned };
    if (c.type === 'MEMBER') {
      if (typeof c.userId !== 'string' || !eligibleUserIds.has(c.userId)) {
        issues.add('ROLE_INVALID', path, 'That person is not a member of the target workspace');
        return { ...base, assignment: unassigned };
      }
      return { ...base, assignment: { type: 'MEMBER', userId: c.userId } };
    }
    if (c.type === 'INVITE') {
      const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
      if (email.length === 0 || email.length > 254 || !EMAIL.test(email)) {
        issues.add('ROLE_INVALID', path, 'Not a valid email address');
        return { ...base, assignment: unassigned };
      }
      invites += 1;
      if (invites > MAX_INVITES_PER_APPLY) {
        issues.add('TOO_MANY_INVITES', path, `At most ${MAX_INVITES_PER_APPLY} invitations per apply`);
        return { ...base, assignment: unassigned };
      }
      return { ...base, assignment: { type: 'INVITE', email } };
    }
    issues.add('ROLE_INVALID', path, 'type must be MEMBER, INVITE or UNASSIGNED');
    return { ...base, assignment: unassigned };
  });
}

/** Distinct member ids for a task's roles (invited and unassigned roles contribute nobody). */
export function assigneesFor(roleKeys: readonly string[], resolved: readonly ResolvedRole[]): string[] {
  const byKey = new Map(resolved.map((r) => [r.key, r]));
  const out: string[] = [];
  for (const k of roleKeys) {
    const a = byKey.get(k)?.assignment;
    if (a?.type === 'MEMBER' && !out.includes(a.userId)) out.push(a.userId);
  }
  return out;
}
