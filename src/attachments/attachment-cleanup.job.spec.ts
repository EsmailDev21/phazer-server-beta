import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { buildEnvelope } from '../queue/job-envelope';
import { AttachmentCleanupJob } from './attachment-cleanup.job';
import { AttachmentsService } from './attachments.service';

describe('AttachmentCleanupJob', () => {
  function build() {
    const registry = new JobHandlerRegistry();
    const attachmentsService = {
      cleanupAbandoned: jest.fn().mockResolvedValue({ deletedCount: 5 }),
    } as unknown as AttachmentsService;
    const job = new AttachmentCleanupJob(registry, attachmentsService);
    return { registry, attachmentsService, job };
  }

  it('registers itself on the system queue and an hourly schedule', () => {
    const { registry, job } = build();
    job.onModuleInit();

    expect(registry.get('system', 'system.attachments-cleanup-abandoned')).toBe(
      job,
    );
    const schedules = registry.schedulesFor('system');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      schedulerId: 'attachments-cleanup-abandoned-hourly',
      jobName: 'system.attachments-cleanup-abandoned',
      everyMs: 60 * 60 * 1000,
    });
  });

  it('handle() delegates to cleanupAbandoned and returns its result', async () => {
    const { attachmentsService, job } = build();
    const result = await job.handle(buildEnvelope({}));

    expect(attachmentsService.cleanupAbandoned).toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 5 });
  });
});
