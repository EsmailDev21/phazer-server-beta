import { createHmac, timingSafeEqual } from 'crypto';

/** Slack's documented tolerance; also the replay window (ADR-0013 d.3). */
export const SLACK_MAX_SKEW_SECONDS = 300;
export type SlackVerdict = 'ok' | 'missing' | 'malformed' | 'expired' | 'bad_signature' | 'bad_key';

/**
 * `X-Slack-Signature: v0=<hex HMAC-SHA256(signing secret, "v0:" + timestamp + ":" + RAW body)>`. Pure and total; the caller answers a
 * bare 401 for every verdict but 'ok' and logs the reason. The comparison is constant-time and the timestamp is checked first so a
 * correctly signed but old request is a replay, not an accepted one.
 */
export function verifySlackSignature(input: {
  signingSecret: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
  nowSeconds?: number;
}): SlackVerdict {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signature || !timestamp) return 'missing';
  if (!signingSecret || signingSecret.length < 8) return 'bad_key';
  if (!/^v0=[0-9a-f]{64}$/.test(signature) || !/^\d{1,12}$/.test(timestamp)) return 'malformed';
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_MAX_SKEW_SECONDS) return 'expired';
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'bad_signature';
}

/**
 * Zero-downtime secret rotation (ADR-0015 d.5): Slack applies a regenerated signing secret at once, so for a few minutes requests
 * are signed with either. The PRIMARY must be valid; `previous` is accepted only as an additional key. The verdict of the primary
 * is what is reported on failure, so an old replay is still 'expired', not 'bad_signature'.
 */
export function verifySlackSignatureWithRotation(input: Omit<Parameters<typeof verifySlackSignature>[0], 'signingSecret'> & { signingSecret: string | undefined; previousSigningSecret?: string | undefined }): SlackVerdict {
  const { previousSigningSecret, ...rest } = input;
  const primary = verifySlackSignature(rest);
  if (primary === 'ok' || primary === 'bad_key' || !previousSigningSecret) return primary;
  if (primary !== 'bad_signature') return primary; // missing/malformed/expired: the old secret cannot change that
  return verifySlackSignature({ ...rest, signingSecret: previousSigningSecret }) === 'ok' ? 'ok' : primary;
}
