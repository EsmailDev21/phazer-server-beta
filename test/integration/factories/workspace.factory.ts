import type { PrismaService } from '../../../src/prisma/prisma.service';
import type { Workspace, Prisma } from '@prisma/client';
import { nextSeq } from './sequence';

export type WorkspaceOverrides = Partial<
  Omit<Prisma.WorkspaceUncheckedCreateInput, 'accountId'>
>;

export function createWorkspace(
  prisma: PrismaService,
  params: { accountId: string } & WorkspaceOverrides,
): Promise<Workspace> {
  const { accountId, ...overrides } = params;
  const data: Prisma.WorkspaceUncheckedCreateInput = {
    accountId,
    name: `Test Workspace ${nextSeq()}`,
    // step 1.1c: key is NOT NULL. 'T' + digits is always a valid, per-process-unique key
    // (^[A-Z][A-Z0-9]{1,9}$ while the sequence stays below 10^9).
    key: `T${nextSeq()}`,
    ...overrides,
  };
  return prisma.workspace.create({ data });
}
