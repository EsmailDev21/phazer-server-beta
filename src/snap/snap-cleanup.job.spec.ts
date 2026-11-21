import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { buildEnvelope } from '../queue/job-envelope';
import { SnapCleanupJob } from './snap-cleanup.job';
import { SnapSessionsService } from './snap-sessions.service';

describe('SnapCleanupJob', () => {
  function build() {
    const registry = new JobHandlerRegistry();
    const snapSessionsService = {
      expireStaleSessions: jest.fn().mockResolvedValue({ expiredCount: 2 }),
    } as unknown as SnapSessionsService;
    const job = new SnapCleanupJob(registry, snapSessionsService);
    return { registry, snapSessionsService, job };
  }

  it('registers itself on the system queue and a 15-minute schedule', () => {
    const { registry, job } = build();
    job.onModuleInit();

    expect(registry.get('system', 'system.snap-expire-stale-sessions')).toBe(
      job,
    );
    const schedules = registry.schedulesFor('system');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      schedulerId: 'snap-expire-stale-sessions-every-15m',
      jobName: 'system.snap-expire-stale-sessions',
      everyMs: 15 * 60 * 1000,
    });
  });

  it('handle() delegates to expireStaleSessions and returns its result', async () => {
    const { snapSessionsService, job } = build();
    const result = await job.handle(buildEnvelope({}));

    expect(snapSessionsService.expireStaleSessions).toHaveBeenCalled();
    expect(result).toEqual({ expiredCount: 2 });
  });
});
