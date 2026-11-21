import { AttachmentsService } from './attachments.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolver } from '../access-control/access-control.service';
import { ActivityService } from '../events/activity.service';
import { StorageProvider } from './storage/storage-provider.interface';

describe('AttachmentsService.purgeAllForAccount (step 0.3)', () => {
  function build() {
    const prisma = {
      attachment: { findMany: jest.fn(), deleteMany: jest.fn() },
    } as unknown as PrismaService;
    const permissionResolver = {} as PermissionResolver;
    const activityService = {} as ActivityService;
    const storageProvider = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
    } as unknown as StorageProvider;
    const service = new AttachmentsService(
      prisma,
      permissionResolver,
      activityService,
      storageProvider,
    );
    return { prisma, storageProvider, service };
  }

  it('deletes every attachment for the account, regardless of status, storage first then rows', async () => {
    const { prisma, storageProvider, service } = build();
    (prisma.attachment.findMany as jest.Mock).mockResolvedValue([
      { id: 'a1', storageKey: 'k1' },
      { id: 'a2', storageKey: 'k2' },
    ]);
    (prisma.attachment.deleteMany as jest.Mock).mockResolvedValue({
      count: 2,
    });

    const result = await service.purgeAllForAccount('acc_1');

    expect(prisma.attachment.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc_1' },
      select: { id: true, storageKey: true },
    });
    expect(storageProvider.deleteObject).toHaveBeenCalledWith('k1');
    expect(storageProvider.deleteObject).toHaveBeenCalledWith('k2');
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'acc_1' },
    });
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('a failed storage delete does not block the rest, or the DB cleanup', async () => {
    const { prisma, storageProvider, service } = build();
    (prisma.attachment.findMany as jest.Mock).mockResolvedValue([
      { id: 'a1', storageKey: 'k1' },
      { id: 'a2', storageKey: 'k2' },
    ]);
    (storageProvider.deleteObject as jest.Mock).mockRejectedValueOnce(
      new Error('object not found'),
    );
    (prisma.attachment.deleteMany as jest.Mock).mockResolvedValue({
      count: 2,
    });

    const result = await service.purgeAllForAccount('acc_1');

    expect(storageProvider.deleteObject).toHaveBeenCalledTimes(2);
    expect(prisma.attachment.deleteMany).toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('is a no-op when the account has no attachments', async () => {
    const { prisma, storageProvider, service } = build();
    (prisma.attachment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.attachment.deleteMany as jest.Mock).mockResolvedValue({
      count: 0,
    });

    const result = await service.purgeAllForAccount('acc_1');

    expect(storageProvider.deleteObject).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0 });
  });
});
