import { Injectable } from '@nestjs/common';
import { FLAGS_REQUIRING_REDIS } from '../feature-flags/feature-flags';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { RedisService } from './redis.service';

export interface RedisProbe {
  status: 'up' | 'down' | 'not_configured';
  /** True when a flag that needs Redis is on, i.e. "down" is an actual problem. */
  required: boolean;
  latencyMs?: number;
}

/**
 * Reports Redis state for /health. Two deliberate choices:
 *
 *  - It NEVER throws and is NOT a Terminus indicator, so a Redis outage cannot
 *    turn /health into a 503. If it could, every API instance would fail its
 *    readiness check at once during a Redis blip and take down the parts of
 *    the API that do not use Redis at all. (HealthController reports it as
 *    `degraded` instead.)
 *  - It returns no error text. /health is public; connection errors name hosts
 *    and ports. Detail goes to the server log (RedisService), not the response.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly flags: FeatureFlagsService,
  ) {}

  async probe(timeoutMs = 1_000): Promise<RedisProbe> {
    const required = FLAGS_REQUIRING_REDIS.some((flag) =>
      this.flags.isEnabled(flag),
    );

    if (!this.redis.configured) return { status: 'not_configured', required };
    // Not connected: answer immediately rather than queue a PING behind a
    // dead connection.
    if (!this.redis.isReady()) return { status: 'down', required };

    const startedAt = Date.now();
    let timer: NodeJS.Timeout;
    try {
      const reply = await Promise.race([
        this.redis.getClient().ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      if (reply !== 'PONG') return { status: 'down', required };
      return { status: 'up', required, latencyMs: Date.now() - startedAt };
    } catch {
      return { status: 'down', required };
    } finally {
      clearTimeout(timer);
    }
  }
}
