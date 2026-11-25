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

/** Where a REDIS_URL points, without the password: safe to put in a log. */
export interface RedisTarget {
  host: string;
  port: number;
  /** True for rediss:// (TLS). */
  tls: boolean;
  hasPassword: boolean;
}

export function describeRedisTarget(value: string | undefined): RedisTarget | null {
  if (!checkRedisUrl(value).ok) return null;
  const u = new URL((value as string).trim());
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    tls: u.protocol === 'rediss:',
    hasPassword: u.password !== '',
  };
}

/**
 * ioredis reports "Reached the max retries per request limit" when the connection never became usable, and
 * that message hides WHY (a TLS mismatch just closes the socket quietly). Say what is usually behind it.
 */
export function redisErrorHint(message: string, target: RedisTarget | null): string {
  if (!/max retries per request/i.test(message)) return '';
  if (target && !target.tls) {
    return ' Hint: the connection never became ready. Many hosted Redis providers (Upstash, Redis Cloud, ...) only accept TLS: use a URL that starts with rediss:// (two s). Also check the host, port and password.';
  }
  return ' Hint: the connection never became ready. Check the host, port and password, and that the provider allows connections from this server.';
}
