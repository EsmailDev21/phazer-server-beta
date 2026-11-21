/**
 * Pure helper, kept free of ioredis so feature-flag boot validation can use it
 * without pulling the Redis client in.
 */
// A plain shape rather than a discriminated union: this project compiles
// without strictNullChecks, where `!check.ok` does not narrow a union.
export interface RedisUrlCheck {
  ok: boolean;
  reason?: string;
}

export function checkRedisUrl(value: string | undefined): RedisUrlCheck {
  if (value === undefined || value.trim() === '') {
    return { ok: false, reason: 'is not set' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'is not a valid URL' };
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    return {
      ok: false,
      reason: `must start with redis:// or rediss:// (got ${parsed.protocol}//)`,
    };
  }
  return { ok: true };
}
