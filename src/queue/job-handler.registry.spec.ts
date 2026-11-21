import { JobHandler, JobHandlerRegistry } from './job-handler.registry';
import { QueueName } from './queue.definitions';

// Only "system" is a real QueueName today; the registry itself is queue-name
// agnostic (it just keys a map), so an `as QueueName` cast is enough to
// exercise "two different queues" without inventing a second real queue.
const handler = (
  queue: QueueName = 'system',
  jobName = 'system.ping' as const,
): JobHandler<'system.ping'> => ({
  queue,
  jobName,
  handle: jest.fn(),
});

describe('JobHandlerRegistry', () => {
  it('get returns undefined before registration, and the handler after', () => {
    const reg = new JobHandlerRegistry();
    expect(reg.get('system', 'system.ping')).toBeUndefined();
    const h = handler();
    reg.register(h);
    expect(reg.get('system', 'system.ping')).toBe(h);
  });

  it('rejects a second handler for the same queue+jobName', () => {
    const reg = new JobHandlerRegistry();
    reg.register(handler());
    expect(() => reg.register(handler())).toThrow(/Duplicate job handler/);
  });

  it('the same jobName on a different queue is independent', () => {
    const reg = new JobHandlerRegistry();
    reg.register(handler('system'));
    expect(() => reg.register(handler('other' as QueueName))).not.toThrow();
  });

  it('registerSchedule requires exactly one of everyMs / cron', () => {
    const reg = new JobHandlerRegistry();
    expect(() =>
      reg.registerSchedule({
        queue: 'system',
        schedulerId: 's1',
        jobName: 'system.ping',
        payload: {},
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      reg.registerSchedule({
        queue: 'system',
        schedulerId: 's2',
        jobName: 'system.ping',
        payload: {},
        everyMs: 1000,
        cron: '* * * * *',
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects a duplicate schedulerId', () => {
    const reg = new JobHandlerRegistry();
    reg.registerSchedule({
      queue: 'system',
      schedulerId: 'dup',
      jobName: 'system.ping',
      payload: {},
      everyMs: 1000,
    });
    expect(() =>
      reg.registerSchedule({
        queue: 'system',
        schedulerId: 'dup',
        jobName: 'system.ping',
        payload: {},
        everyMs: 2000,
      }),
    ).toThrow(/Duplicate schedulerId/);
  });

  it('schedulesFor filters by queue', () => {
    const reg = new JobHandlerRegistry();
    reg.registerSchedule({
      queue: 'system',
      schedulerId: 'a',
      jobName: 'system.ping',
      payload: {},
      everyMs: 1000,
    });
    reg.registerSchedule({
      queue: 'other' as QueueName,
      schedulerId: 'b',
      jobName: 'system.ping',
      payload: {},
      cron: '* * * * *',
    });
    expect(reg.schedulesFor('system').map((s) => s.schedulerId)).toEqual(['a']);
    expect(reg.schedulesFor('nope')).toEqual([]);
  });
});
