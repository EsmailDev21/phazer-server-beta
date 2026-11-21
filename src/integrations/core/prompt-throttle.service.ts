import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

export const DEFAULT_PROMPT_MAX_PER_USER = 3;
export const DEFAULT_PROMPT_MAX_PER_CONNECTION = 60;
/** Same as the link token's life: while a token is live, one more per user is plenty. */
export const DEFAULT_PROMPT_WINDOW_SECONDS = 15 * 60;

// KEYS[1]; ARGV: window ms. INCR and set the expiry on the first hit (a fixed window), return the new count.
const HIT = `local n = redis.call('incr', KEYS[1]); if n == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end; return n`;

const intOr = (raw: string | undefined, fallback: number): number => {
  const n = Number((raw ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

/**
 * Step 2.7 (closes the ADR-0010 gap "no throttle on identity prompts"). An unlinked chat user who keeps running commands would
 * otherwise cost, every time: one provider lookup (spending the connection's shared rate budget), one token delete + insert, and
 * a fresh ephemeral message. Fixed window per (connection, chat user) AND per connection (a flood from many users of one workspace).
 *
 * Shared across instances through Redis; without Redis it falls back to a per-process counter (it never fails closed: an unlinked
 * user must still be able to link while Redis is down). A throttled caller gets a reply WITHOUT a token, so nothing is issued.
 */
@Injectable()
export class PromptThrottleService {
  private readonly logger = new Logger(PromptThrottleService.name);
  private readonly mem = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** True = go ahead (and this attempt is counted); false = the caller is over its limit. */
  async allow(connectionId: string, externalUserId: string): Promise<boolean> {
    const perUser = intOr(this.config.get<string>('IDENTITY_PROMPT_MAX_PER_USER'), DEFAULT_PROMPT_MAX_PER_USER);
    const perConn = intOr(this.config.get<string>('IDENTITY_PROMPT_MAX_PER_CONNECTION'), DEFAULT_PROMPT_MAX_PER_CONNECTION);
    const windowMs = intOr(this.config.get<string>('IDENTITY_PROMPT_WINDOW_SECONDS'), DEFAULT_PROMPT_WINDOW_SECONDS) * 1000;
    // The per-user counter first: a throttled user must not also burn the connection-wide budget of everyone else.
    const user = await this.hit(`idprompt:u:${connectionId}:${externalUserId}`, windowMs);
    if (user > perUser) return false;
    const conn = await this.hit(`idprompt:c:${connectionId}`, windowMs);
    return conn <= perConn;
  }

  private async hit(key: string, windowMs: number): Promise<number> {
    if (this.redis.configured && this.redis.isReady()) {
      try {
        return Number(await this.redis.getClient().eval(HIT, 1, key, windowMs));
      } catch (e) {
        this.logger.warn(`Redis prompt counter failed, using the in-process one: ${(e as Error).message}`);
      }
    }
    const now = Date.now();
    const cur = this.mem.get(key);
    const entry = cur && cur.resetAt > now ? cur : { n: 0, resetAt: now + windowMs };
    entry.n += 1;
    this.mem.set(key, entry);
    if (this.mem.size > 10_000) for (const [k, v] of this.mem) if (v.resetAt <= now) this.mem.delete(k);
    return entry.n;
  }
}
