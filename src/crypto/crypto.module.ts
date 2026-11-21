import { Global, Module } from '@nestjs/common';
import { TokenVaultService } from './token-vault.service';

/**
 * @Global, same reasoning and same shape as RedisModule/FeatureFlagsModule:
 * infra any future module can inject without importing this one
 * explicitly. Built from a factory (not a bare `@Injectable()` class) so
 * a real Nest DI resolution of TokenVaultService reads `process.env` at
 * the moment the module boots, matching RedisService/FeatureFlagsService.
 */
@Global()
@Module({
  providers: [
    {
      provide: TokenVaultService,
      useFactory: () => new TokenVaultService(process.env),
    },
  ],
  exports: [TokenVaultService],
})
export class CryptoModule {}
