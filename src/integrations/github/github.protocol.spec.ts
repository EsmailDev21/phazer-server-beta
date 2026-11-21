import { createHmac } from 'crypto';
import { MAX_BODY, MAX_COMMITS, MAX_TITLE, extractGithubWork, verifyGithubSignature, verifyGithubSignatureWithRotation } from './github.protocol';

const SECRET = 'a-webhook-secret-of-sufficient-length';
const sign = (raw: Buffer, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

describe('verifyGithubSignature', () => {
  const raw = Buffer.from('{"zen":"Keep it logically awesome."}');

  it("passes GitHub's own published example (secret \"It's a Secret to Everybody\", body \"Hello, World!\")", () => {
    expect(verifyGithubSignature({
      secret: "It's a Secret to Everybody",
      signature: 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      rawBody: Buffer.from('Hello, World!'),
    })).toBe('ok');
  });

  it('accepts a correct signature', () => {
    expect(verifyGithubSignature({ secret: SECRET, signature: sign(raw), rawBody: raw })).toBe('ok');
  });

  it('rejects wrong secret, tampered body, missing/malformed header', () => {
    expect(verifyGithubSignature({ secret: SECRET, signature: sign(raw, 'another-secret-entirely-xx'), rawBody: raw })).toBe('mismatch');
    expect(verifyGithubSignature({ secret: SECRET, signature: sign(raw), rawBody: Buffer.concat([raw, Buffer.from(' ')]) })).toBe('mismatch');
    expect(verifyGithubSignature({ secret: SECRET, signature: undefined, rawBody: raw })).toBe('missing');
    expect(verifyGithubSignature({ secret: SECRET, signature: sign(raw), rawBody: undefined })).toBe('missing');
    expect(verifyGithubSignature({ secret: SECRET, signature: 'sha1=' + 'a'.repeat(40), rawBody: raw })).toBe('malformed');
    expect(verifyGithubSignature({ secret: SECRET, signature: 'sha256=zz', rawBody: raw })).toBe('malformed');
  });

  it('fails closed without a (long enough) secret, even for a "correct" signature', () => {
    expect(verifyGithubSignature({ secret: undefined, signature: sign(raw, ''), rawBody: raw })).toBe('no-secret');
    expect(verifyGithubSignature({ secret: '', signature: sign(raw, ''), rawBody: raw })).toBe('no-secret');
    expect(verifyGithubSignature({ secret: 'short', signature: sign(raw, 'short'), rawBody: raw })).toBe('no-secret');
  });
});

describe('extractGithubWork', () => {
  const base = { installation: { id: 777 }, repository: { id: 4242, full_name: 'acme/web' }, sender: { id: 9, login: 'octo' } };
  const pr = (over: Record<string, unknown> = {}, action = 'opened') => ({ ...base, action, pull_request: { number: 12, title: 'ENG-1 fix', body: 'b', head: { ref: 'eng-1-fix' }, draft: false, merged: false, state: 'open', ...over } });

  it('pull_request: reduces to validated fields only', () => {
    expect(extractGithubWork('pull_request', { ...pr(), extra: 'ignored', pull_request: { ...pr().pull_request, huge: 'x'.repeat(1e5) } })).toEqual({
      kind: 'pr', action: 'opened', installationId: '777', repo: { id: 4242, fullName: 'acme/web' }, sender: { id: '9', login: 'octo' },
      pr: { number: 12, title: 'ENG-1 fix', body: 'b', headRef: 'eng-1-fix', draft: false, merged: false, closed: false },
    });
  });

  it('pull_request: merged/closed/draft flags, only handled actions, caps on title and body', () => {
    const closed = extractGithubWork('pull_request', pr({ merged: true, state: 'closed' }, 'closed'));
    expect(closed).toMatchObject({ kind: 'pr', pr: { merged: true, closed: true } });
    expect(extractGithubWork('pull_request', pr({}, 'labeled'))).toBeNull();
    expect(extractGithubWork('pull_request', pr({}, 'synchronize'))).toBeNull();
    const long = extractGithubWork('pull_request', pr({ title: 't'.repeat(5000), body: 'b'.repeat(50000) })) as { pr: { title: string; body: string } };
    expect(long.pr.title).toHaveLength(MAX_TITLE);
    expect(long.pr.body).toHaveLength(MAX_BODY);
  });

  it('rejects malformed payloads instead of throwing', () => {
    for (const bad of [null, 'x', 5, [], {}, { installation: {} }, { ...base, installation: { id: 'abc' } }, { ...base, installation: { id: -1 } }]) {
      expect(extractGithubWork('pull_request', bad)).toBeNull();
    }
    expect(extractGithubWork('pull_request', { ...pr(), repository: { id: 1, full_name: 'no-slash' } })).toBeNull();
    expect(extractGithubWork('pull_request', { ...pr(), repository: { id: 1, full_name: '../etc/passwd' } })).toBeNull();
    expect(extractGithubWork('pull_request', { ...pr(), repository: { id: 'x', full_name: 'a/b' } })).toBeNull();
    expect(extractGithubWork('pull_request', { ...pr(), pull_request: { title: 'no number' } })).toBeNull();
    expect(extractGithubWork('nonsense', pr())).toBeNull();
  });

  it('issues: not for pull requests (GitHub sends those as issues too)', () => {
    const issue = (over: Record<string, unknown> = {}) => ({ ...base, action: 'opened', issue: { number: 3, title: 'ENG-2 bug', body: null, state: 'open', ...over } });
    expect(extractGithubWork('issues', issue())).toMatchObject({ kind: 'issue', issue: { number: 3, closed: false, body: '' } });
    expect(extractGithubWork('issues', issue({ pull_request: {} }))).toBeNull();
    expect(extractGithubWork('issues', { ...issue(), action: 'labeled' })).toBeNull();
  });

  it('push: branch pushes only, commits capped, bad shas dropped, deletions and tags ignored', () => {
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    const commits = Array.from({ length: 50 }, (_, i) => ({ id: sha(i + 1), message: `ENG-${i + 1} work` }));
    const w = extractGithubWork('push', { ...base, ref: 'refs/heads/eng-5-x', commits: [...commits, { id: 'not-a-sha', message: 'ENG-9' }] }) as { kind: string; branch: string; commits: unknown[] };
    expect(w.kind).toBe('push');
    expect(w.branch).toBe('eng-5-x');
    expect(w.commits).toHaveLength(MAX_COMMITS);
    expect(extractGithubWork('push', { ...base, ref: 'refs/heads/x', commits: [{ id: 'zzz', message: 'm' }] })).toMatchObject({ commits: [] });
    expect(extractGithubWork('push', { ...base, ref: 'refs/tags/v1', commits: [] })).toBeNull();
    expect(extractGithubWork('push', { ...base, ref: 'refs/heads/x', deleted: true, commits: [] })).toBeNull();
  });

  it('create: only branches', () => {
    expect(extractGithubWork('create', { ...base, ref_type: 'branch', ref: 'eng-1-x' })).toMatchObject({ kind: 'branch', branch: 'eng-1-x' });
    expect(extractGithubWork('create', { ...base, ref_type: 'tag', ref: 'v1' })).toBeNull();
  });

  it('installation / installation_repositories', () => {
    expect(extractGithubWork('installation', { installation: { id: 5 }, action: 'deleted' })).toEqual({ kind: 'installation', action: 'deleted', installationId: '5' });
    expect(extractGithubWork('installation', { installation: { id: 5 }, action: 'suspend' })).toMatchObject({ action: 'suspend' });
    expect(extractGithubWork('installation', { installation: { id: 5 }, action: 'created' })).toBeNull();
    expect(extractGithubWork('installation_repositories', { installation: { id: 5 }, repositories_added: [{ id: 1 }, { id: 'x' }], repositories_removed: [{ id: 2 }] }))
      .toEqual({ kind: 'installation_repos', installationId: '5', added: [1], removed: [2] });
    expect(extractGithubWork('installation_repositories', { installation: { id: 5 }, repositories_added: [], repositories_removed: [] })).toBeNull();
  });
});

describe('verifyGithubSignatureWithRotation (zero-downtime secret rotation)', () => {
  const raw = Buffer.from('{"zen":"x"}');
  const OLD = 'the-previous-github-webhook-secret';
  const call = (o: Record<string, unknown> = {}) => verifyGithubSignatureWithRotation({ secret: SECRET, previousSecret: OLD, signature: sign(raw), rawBody: raw, ...o } as never);

  it('accepts the new secret and the previous one; rejects a third', () => {
    expect(call()).toBe('ok');
    expect(call({ signature: sign(raw, OLD) })).toBe('ok');
    expect(call({ signature: sign(raw, 'a-third-secret-that-is-long-enough') })).toBe('mismatch');
  });
  it('a tampered body is rejected under both secrets', () => {
    expect(call({ signature: sign(raw, OLD), rawBody: Buffer.concat([raw, Buffer.from(' ')]) })).toBe('mismatch');
  });
  it('fails closed without a valid primary, whatever the previous secret says', () => {
    expect(call({ secret: undefined, signature: sign(raw, OLD) })).toBe('no-secret');
    expect(call({ secret: 'short', signature: sign(raw, OLD) })).toBe('no-secret');
  });
  it('missing / malformed headers stay missing / malformed', () => {
    expect(call({ signature: undefined })).toBe('missing');
    expect(call({ signature: 'sha256=zz' })).toBe('malformed');
  });
});
