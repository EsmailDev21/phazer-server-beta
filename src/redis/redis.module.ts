import { Global, Module } from '@nestjs/common';
import { RedisHealthIndicator } from './redis-health.indicator';
import { RedisPubSubService } from './redis-pubsub.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: RedisService,
      useFactory: () => new RedisService(process.env.REDIS_URL),
    },
    RedisHealthIndicator,
    RedisPubSubService,
  ],
  exports: [RedisService, RedisHealthIndicator, RedisPubSubService],
})
export class RedisModule {}
