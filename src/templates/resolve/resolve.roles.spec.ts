import { assigneesFor, MAX_INVITES_PER_APPLY, resolveRoles } from './resolve.roles';
import { Issues } from './resolve.types';

const roles = [
  { key: 'student', label: 'Student', suggestedAccess: 'MEMBER' as const },
  { key: 'prof', label: 'Professor', suggestedAccess: 'VIEWER' as const },
  { key: 'ta', label: 'TA' },
];
const members = new Set(['u1', 'u2']);
const run = (choices: unknown, r = roles) => {
  const issues = new Issues();
  const out = resolveRoles(r, choices, members, issues);
  return { out, issues: issues.items, byKey: Object.fromEntries(out.map((x) => [x.key, x.assignment])) };
};

describe('resolveRoles', () => {
  it('everything is UNASSIGNED unless chosen, and grants nothing', () => {
    const r = run(undefined);
    expect(r.byKey).toEqual({ student: { type: 'UNASSIGNED' }, prof: { type: 'UNASSIGNED' }, ta: { type: 'UNASSIGNED' } });
    expect(r.out[0]).toMatchObject({ suggestedAccess: 'MEMBER' });
  });

  it('maps members and invites; emails are trimmed and lower-cased', () => {
    const r = run({ student: { type: 'MEMBER', userId: 'u1' }, prof: { type: 'INVITE', email: '  Prof@Uni.EDU ' } });
    expect(r.issues).toEqual([]);
    expect(r.byKey.student).toEqual({ type: 'MEMBER', userId: 'u1' });
    expect(r.byKey.prof).toEqual({ type: 'INVITE', email: 'prof@uni.edu' });
  });

  it('a member must be someone the caller said is eligible', () => {
    const r = run({ student: { type: 'MEMBER', userId: 'stranger' } });
    expect(r.issues.map((i) => i.code)).toEqual(['ROLE_INVALID']);
    expect(r.byKey.student).toEqual({ type: 'UNASSIGNED' });
    expect(run({ student: { type: 'MEMBER' } }).issues).toHaveLength(1);
    expect(run({ student: { type: 'MEMBER', userId: 5 } }).issues).toHaveLength(1);
  });

  it.each(['', 'nope', 'a@b', 'a b@c.com', '@c.com', 'a@c.com,b@c.com', 'a@c.com;b@d.com', '<a@c.com>', `${'x'.repeat(250)}@c.com`])(
    'rejects the email %p', (email) => {
      expect(run({ prof: { type: 'INVITE', email } }).issues.map((i) => i.code)).toEqual(['ROLE_INVALID']);
    });

  it('unknown roles, bad shapes and bad types are errors', () => {
    expect(run({ ghost: { type: 'UNASSIGNED' } }).issues.map((i) => i.code)).toEqual(['ROLE_UNKNOWN']);
    expect(run({ student: 'u1' }).issues.map((i) => i.code)).toEqual(['ROLE_INVALID']);
    expect(run({ student: { type: 'OWNER' } }).issues.map((i) => i.code)).toEqual(['ROLE_INVALID']);
    expect(run('x').issues.map((i) => i.code)).toEqual(['ROLE_INVALID']);
    expect(run(JSON.parse('{"__proto__":{"type":"MEMBER","userId":"u1"}}')).issues.map((i) => i.code)).toEqual(['ROLE_UNKNOWN']);
  });

  it('caps invitations per apply', () => {
    const many = Array.from({ length: MAX_INVITES_PER_APPLY + 1 }, (_, i) => ({ key: `r${i}`, label: 'r' }));
    const choices = Object.fromEntries(many.map((r, i) => [r.key, { type: 'INVITE', email: `p${i}@x.com` }]));
    expect(run(choices, many).issues.map((i) => i.code)).toEqual(['TOO_MANY_INVITES']);
  });

  it('assigneesFor: only members count, once each, in role order', () => {
    const { out } = run({ student: { type: 'MEMBER', userId: 'u2' }, prof: { type: 'INVITE', email: 'p@x.com' }, ta: { type: 'MEMBER', userId: 'u2' } });
    expect(assigneesFor(['prof', 'student', 'ta', 'ghost'], out)).toEqual(['u2']);
    expect(assigneesFor([], out)).toEqual([]);
  });
});
