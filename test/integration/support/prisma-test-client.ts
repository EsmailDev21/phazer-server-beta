/**
 * One PrismaService for the whole integration test process, not one per
 * test file — Postgres connection setup is expensive enough (and the
 * container's connection limit low enough) that per-file clients don't
 * scale once this suite grows across phases.
 */
import { PrismaService } from '../../../src/prisma/prisma.service';

let client: PrismaService | undefined;

export function getTestPrisma(): PrismaService {
  if (!client) {
    client = new PrismaService();
  }
  return client;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
