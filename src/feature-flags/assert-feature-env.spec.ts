import { assertFeatureFlagEnv } from './assert-feature-env';

function run(env: NodeJS.ProcessEnv) {
  const log = { error: jest.fn(), warn: jest.fn() };
  const exit = jest.fn() as unknown as (code: number) => never;
  assertFeatureFlagEnv(env, exit, log);
  return { log, exit: exit as unknown as jest.Mock };
}

describe('assertFeatureFlagEnv', () => {
  it('does nothing for an environment with no flags', () => {
    const { log, exit } = run({});
    expect(exit).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('exits 1 with every problem listed when a flag lacks its prerequisites', () => {
    const { log, exit } = run({
      FEATURE_IMPORTS: 'true',
      FEATURE_MARKETPLACE: 'true',
    });
    expect(exit).toHaveBeenCalledWith(1);
    const message = log.error.mock.calls[0][0] as string;
    expect(message).toContain('FATAL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('FEATURE_TEMPLATES');
    expect(message).toContain('Refusing to start');
  });

  it('warns but keeps booting for typos and ambiguous values', () => {
    const { log, exit } = run({ FEATURE_WORKFLOW: 'on', FEATURE_OOPS: '1' });
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('boots cleanly with a Redis flag and a valid REDIS_URL', () => {
    const { exit } = run({
      FEATURE_INTEGRATIONS: 'true',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(exit).not.toHaveBeenCalled();
  });
});
