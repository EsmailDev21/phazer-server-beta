import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { CryptoModule } from '../../crypto/crypto.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { CredentialRotationService } from '../core/credential-rotation.service';

/** Just enough of the app to read and write credentials: no HTTP, no queues, no feature flags. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, CryptoModule],
  providers: [CredentialRotationService],
})
class ReencryptCliModule {}

/**
 * `npm run integrations:reencrypt -- [--dry-run]` (after `npm run build`). Moves every stored provider credential onto the current
 * TOKEN_VAULT_CURRENT_KID. Exit code 0 = nothing left on another key; 1 = some credentials could not be rotated (listed by connection id).
 * See docs/runbooks/key-rotation.md.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(ReencryptCliModule, { logger: ['error', 'warn', 'log'] });
  try {
    const report = await app.get(CredentialRotationService).reencryptAll({ dryRun });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.failed.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((e: Error) => {
  // eslint-disable-next-line no-console
  console.error(`Re-encryption failed to run: ${e.name}: ${e.message}`);
  process.exit(1);
});
