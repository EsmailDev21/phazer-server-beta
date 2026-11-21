import type { PrismaService } from '../../../src/prisma/prisma.service';
import type { User } from '@prisma/client';
import { nextSeq } from './sequence';

export type UserOverrides = Partial<
  Parameters<PrismaService['user']['create']>[0]['data']
>;

/** A minimal, valid User. Every field the DB requires is filled in; every
 * caller-supplied override wins over the generated default. */
export function createUser(
  prisma: PrismaService,
  overrides: UserOverrides = {},
): Promise<User> {
  const seq = nextSeq();
  return prisma.user.create({
    data: {
      email: `user-${seq}@test.local`,
      username: `user${seq}`,
      name: `Test User ${seq}`,
      emailVerified: true,
      ...overrides,
    },
  });
}
