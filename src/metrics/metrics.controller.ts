import { Controller, Get, Header, Headers, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual, createHash } from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * `GET /metrics` (Prometheus text). @Public because it is not a user route: it is guarded by a bearer token instead
 * (`METRICS_TOKEN`; ADR-0015 d.2). No token configured = the route does not exist (404), so an unconfigured
 * deployment never exposes queue depths or tenant counts. Wrong/missing token = 401. The comparison is constant-time.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipThrottle({ default: true })
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    const token = (this.config.get<string>('METRICS_TOKEN') ?? '').trim();
    if (token.length < 16) throw new NotFoundException();
    const m = /^Bearer (.+)$/.exec(authorization ?? '');
    if (!m || !timingSafeEqual(sha(m[1]), sha(token))) throw new UnauthorizedException();
    return this.metrics.render();
  }
}
