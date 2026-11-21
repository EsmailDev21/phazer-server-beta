import type { PrismaService } from '../../../src/prisma/prisma.service';
import type { Account, AccountMember, Role, User } from '@prisma/client';
import { AccountType } from '@prisma/client';
import { createUser } from './user.factory';

export type AccountOverrides = Partial<
  Parameters<PrismaService['account']['create']>[0]['data']
>;

export function createAccount(
  prisma: PrismaService,
  overrides: AccountOverrides = {},
): Promise<Account> {
  return prisma.account.create({
    data: {
      type: AccountType.PERSONAL,
      ...overrides,
    },
  });
}

export function addAccountMember(
  prisma: PrismaService,
  params: { accountId: string; userId: string; role?: Role },
): Promise<AccountMember> {
  return prisma.accountMember.create({
    data: {
      accountId: params.accountId,
      userId: params.userId,
      role: params.role,
    },
  });
}

/**
 * The common case: a brand-new user who owns a brand-new personal account.
 * Covers the majority of "just give me someone who can act" needs in tests
 * without three separate factory calls at every call site.
 */
export async function createUserWithAccount(
  prisma: PrismaService,
  opts: { role?: Role; accountType?: AccountType } = {},
): Promise<{ user: User; account: Account; membership: AccountMember }> {
  const user = await createUser(prisma);
  const account = await createAccount(prisma, {
    type: opts.accountType ?? AccountType.PERSONAL,
  });
  const membership = await addAccountMember(prisma, {
    accountId: account.id,
    userId: user.id,
    role: opts.role,
  });
  return { user, account, membership };
}
