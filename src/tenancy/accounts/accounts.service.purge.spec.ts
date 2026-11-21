import { AccountsService } from './accounts.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../events/audit-log.service';

describe('AccountsService — purge (step 0.3)', () => {
  function build() {
    const prisma = {
      account: { findMany: jest.fn(), delete: jest.fn() },
    } as unknown as PrismaService;
    const auditLogService = {} as AuditLogService;
    const service = new AccountsService(prisma, auditLogService);
    return { prisma, service };
  }

  describe('listExpiredSoftDeletes', () => {
    it('queries only accounts soft-deleted past the grace period, oldest first', async () => {
      const { prisma, service } = build();
      (prisma.account.findMany as jest.Mock).mockResolvedValue([
        { id: 'acc_1' },
      ]);

      const result = await service.listExpiredSoftDeletes(30);

      expect(result).toEqual([{ id: 'acc_1' }]);
      const arg = (prisma.account.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.deletedAt.not).toBeNull();
      expect(arg.orderBy).toEqual({ deletedAt: 'asc' });
      const cutoff = arg.where.deletedAt.lte as Date;
      const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
    });
  });

  describe('hardDelete', () => {
    it('deletes the account row', async () => {
      const { prisma, service } = build();
      await service.hardDelete('acc_1');
      expect(prisma.account.delete).toHaveBeenCalledWith({
        where: { id: 'acc_1' },
      });
    });

    it('is a no-op, not an error, when the account is already gone (Prisma P2025)', async () => {
      const { prisma, service } = build();
      (prisma.account.delete as jest.Mock).mockRejectedValue({
        code: 'P2025',
      });

      await expect(service.hardDelete('missing')).resolves.toBeUndefined();
    });

    it('rethrows any other error', async () => {
      const { prisma, service } = build();
      (prisma.account.delete as jest.Mock).mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(service.hardDelete('acc_1')).rejects.toThrow(
        'connection reset',
      );
    });
  });
});
