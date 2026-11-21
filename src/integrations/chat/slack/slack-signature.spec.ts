import { createHmac } from 'crypto';
import { SLACK_MAX_SKEW_SECONDS, verifySlackSignature, verifySlackSignatureWithRotation } from './slack-signature';

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const NOW = 1_800_000_000;
const body = Buffer.from('token=x&team_id=T1&text=create+a');
const sig = (ts: string, b = body, secret = SECRET) => 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:`).update(b).digest('hex');
const call = (o: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({ signingSecret: SECRET, signature: sig(String(NOW)), timestamp: String(NOW), rawBody: body, nowSeconds: NOW, ...o });

describe('verifySlackSignature', () => {
  it('accepts the documented scheme v0=HMAC-SHA256("v0:ts:body")', () => expect(call()).toBe('ok'));

  it('matches Slack\u2019s published example', () => {
    // From Slack\u2019s "Verifying requests" documentation.
    const secret = '8f742231b10e8888abcd99yyyzzz85a5';
    const ts = '1531420618';
    const raw = Buffer.from('token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c');
    const expected = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503';
    expect(verifySlackSignature({ signingSecret: secret, signature: expected, timestamp: ts, rawBody: raw, nowSeconds: 1531420618 })).toBe('ok');
  });

  it('one changed byte of body, timestamp or secret -> bad_signature', () => {
    expect(call({ rawBody: Buffer.from('token=x&team_id=T1&text=create+b') })).toBe('bad_signature');
    expect(call({ timestamp: String(NOW + 1) })).toBe('bad_signature');
    expect(call({ signingSecret: SECRET + 'x' })).toBe('bad_signature');
  });

  it('missing / malformed headers (never throws)', () => {
    expect(call({ signature: undefined })).toBe('missing');
    expect(call({ timestamp: undefined })).toBe('missing');
    expect(call({ signature: 'v1=' + 'a'.repeat(64) })).toBe('malformed');
    expect(call({ signature: sig(String(NOW)).toUpperCase() })).toBe('malformed');
    expect(call({ signature: 'v0=abcd' })).toBe('malformed');
    expect(call({ timestamp: 'now' })).toBe('malformed');
  });

  it('a correctly signed but stale or future request is expired (replay window)', () => {
    const old = String(NOW - SLACK_MAX_SKEW_SECONDS - 1);
    expect(call({ timestamp: old, signature: sig(old) })).toBe('expired');
    const future = String(NOW + SLACK_MAX_SKEW_SECONDS + 1);
    expect(call({ timestamp: future, signature: sig(future) })).toBe('expired');
    const edge = String(NOW - SLACK_MAX_SKEW_SECONDS);
    expect(call({ timestamp: edge, signature: sig(edge) })).toBe('ok');
  });

  it('no / trivially short signing secret fails closed', () => {
    expect(call({ signingSecret: undefined })).toBe('bad_key');
    expect(call({ signingSecret: '' })).toBe('bad_key');
    expect(call({ signingSecret: 'abc' })).toBe('bad_key');
  });
});

describe('verifySlackSignatureWithRotation (zero-downtime secret rotation)', () => {
  const OLD = 'the-previous-slack-signing-secret-01';
  const call = (o: Record<string, unknown> = {}) =>
    verifySlackSignatureWithRotation({ signingSecret: SECRET, previousSigningSecret: OLD, signature: sig(String(NOW)), timestamp: String(NOW), rawBody: body, nowSeconds: NOW, ...o } as never);

  it('accepts a request signed with the new secret or with the previous one', () => {
    expect(call()).toBe('ok');
    expect(call({ signature: sig(String(NOW), body, OLD) })).toBe('ok');
  });
  it('rejects a third secret, and reports the primary\u2019s verdict', () => {
    expect(call({ signature: sig(String(NOW), body, 'some-other-secret-entirely-xx') })).toBe('bad_signature');
  });
  it('the previous secret does not extend the replay window or rescue a malformed request', () => {
    const old = String(NOW - SLACK_MAX_SKEW_SECONDS - 1);
    expect(call({ timestamp: old, signature: sig(old, body, OLD) })).toBe('expired');
    expect(call({ signature: 'v0=abcd' })).toBe('malformed');
  });
  it('without a primary secret nothing is accepted, even a request signed with the previous one (fail closed)', () => {
    expect(call({ signingSecret: undefined, signature: sig(String(NOW), body, OLD) })).toBe('bad_key');
  });
  it('without a previous secret it behaves exactly like verifySlackSignature', () => {
    expect(call({ previousSigningSecret: undefined, signature: sig(String(NOW), body, OLD) })).toBe('bad_signature');
  });
});
