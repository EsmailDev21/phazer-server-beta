import { JobHandlerRegistry } from '../../queue/job-handler.registry';
import { buildEnvelope } from '../../queue/job-envelope';
import { DueDateReminderJob } from './due-date-reminder.job';
import { DueDateReminderService } from './due-date-reminder.service';

describe('DueDateReminderJob', () => {
  function build() {
    const registry = new JobHandlerRegistry();
    const dueDateReminderService = {
      scanAndNotify: jest.fn().mockResolvedValue({ scanned: 3 }),
    } as unknown as DueDateReminderService;
    const job = new DueDateReminderJob(registry, dueDateReminderService);
    return { registry, dueDateReminderService, job };
  }

  it('registers itself on the system queue and a daily schedule', () => {
    const { registry, job } = build();
    job.onModuleInit();

    expect(registry.get('system', 'system.due-date-reminders')).toBe(job);
    const schedules = registry.schedulesFor('system');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      schedulerId: 'due-date-reminders-daily',
      jobName: 'system.due-date-reminders',
      cron: '0 8 * * *',
    });
  });

  it('handle() delegates to scanAndNotify and returns its result', async () => {
    const { dueDateReminderService, job } = build();
    const envelope = buildEnvelope({ withinHours: 48 });

    const result = await job.handle(envelope);

    expect(dueDateReminderService.scanAndNotify).toHaveBeenCalledWith(48);
    expect(result).toEqual({ scanned: 3 });
  });
});
