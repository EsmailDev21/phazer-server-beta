import { resolveQueuePrefix, resolveShutdownGraceMs } from './queue.config';

describe('resolveQueuePrefix', () => {
  it('uses QUEUE_PREFIX when set', () => {
    expect(resolveQueuePrefix({ QUEUE_PREFIX: 'custom' })).toBe('custom');
  });
  it('ignores a blank QUEUE_PREFIX', () => {
    expect(resolveQueuePrefix({ QUEUE_PREFIX: '  ', NODE_ENV: 'test' })).toBe(
      'bull-test',
    );
  });
  it('falls back to bull-<NODE_ENV>, defaulting to development', () => {
    expect(resolveQueuePrefix({ NODE_ENV: 'production' })).toBe(
      'bull-production',
    );
    expect(resolveQueuePrefix({})).toBe('bull-development');
  });
  it('different environments cannot collide on the same Redis', () => {
    expect(resolveQueuePrefix({ NODE_ENV: 'test' })).not.toBe(
      resolveQueuePrefix({ NODE_ENV: 'production' }),
    );
  });
});

describe('resolveShutdownGraceMs', () => {
  it('defaults to 25000', () => {
    expect(resolveShutdownGraceMs({})).toBe(25_000);
  });
  it('honours a valid override', () => {
    expect(resolveShutdownGraceMs({ WORKER_SHUTDOWN_GRACE_MS: '5000' })).toBe(
      5_000,
    );
  });
  it.each(['0', '-100', 'abc', ''])('falls back to the default for %j', (v) => {
    expect(resolveShutdownGraceMs({ WORKER_SHUTDOWN_GRACE_MS: v })).toBe(
      25_000,
    );
  });
});
