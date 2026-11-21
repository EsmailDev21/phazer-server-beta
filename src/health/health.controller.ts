import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { RedisHealthIndicator } from '../redis/redis-health.indicator';
import { PrismaHealthIndicator } from './prisma.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
  ) {}

  /**
   * The database decides the status code: it is required for everything, and
   * this is what an orchestrator's readiness check keys off.
   *
   * Redis is reported alongside but can NEVER change the status code (step 0.1:
   * "connection failure degrades health, not boot"). When it is down it shows
   * up as `degraded: ['redis']`; `details.redis.required` says whether a
   * feature that depends on it is actually switched on, so monitoring can
   * alert on `degraded` + `required` without paging on an optional dependency.
   * The existing response fields are unchanged; `degraded` is additive.
   */
  @Public()
  @Get()
  @HealthCheck()
  async check() {
    const result = await this.health.check([
      () => this.prismaHealth.isHealthy('database'),
    ]);
    const redis = await this.redisHealth.probe();

    return {
      ...result,
      details: { ...result.details, redis },
      degraded: redis.status === 'down' ? ['redis'] : [],
    };
  }
}
