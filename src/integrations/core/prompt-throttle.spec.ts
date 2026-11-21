import { PromptThrottleService } from './prompt-throttle.service';

const cfg = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] }) as never;
const noRedis = { configured: false, isReady: () => false } as never;

describe('PromptThrottleService', () => {
  it('allows 3 prompts per user per window by default, then refuses', async () => {
    const t = new PromptThrottleService(noRedis, cfg());
    expect([await t.allow('c1', 'U1'), await t.allow('c1', 'U1'), await t.allow('c1', 'U1')]).toEqual([true, true, true]);
    expect(await t.allow('c1', 'U1')).toBe(false);
    expect(await t.allow('c1', 'U1')).toBe(false);
  });

  it('users and connections are counted separately', async () => {
    const t = new PromptThrottleService(noRedis, cfg());
    for (let i = 0; i < 4; i++) await t.allow('c1', 'U1');
    expect(await t.allow('c1', 'U2')).toBe(true);
    expect(await t.allow('c2', 'U1')).toBe(true);
  });

  it('a flood from many users of ONE connection hits the connection-wide limit; a throttled user does not burn it', async () => {
    const t = new PromptThrottleService(noRedis, cfg({ IDENTITY_PROMPT_MAX_PER_CONNECTION: '5' }));
    for (let i = 0; i < 10; i++) await t.allow('c1', 'U-spam'); // 3 allowed, 7 refused at the user level
    for (let i = 0; i < 2; i++) expect(await t.allow('c1', `U-${i}`)).toBe(true); // 3 + 2 = 5 used
    expect(await t.allow('c1', 'U-late')).toBe(false); // the 6th counted attempt
    expect(await t.allow('c2', 'U-late')).toBe(true); // other workspace unaffected
  });

  it('the window expires', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const t = new PromptThrottleService(noRedis, cfg({ IDENTITY_PROMPT_WINDOW_SECONDS: '60' }));
      for (let i = 0; i < 3; i++) await t.allow('c1', 'U1');
      expect(await t.allow('c1', 'U1')).toBe(false);
      jest.setSystemTime(1_000_000 + 61_000);
      expect(await t.allow('c1', 'U1')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bad settings fall back to the defaults instead of disabling the limit', async () => {
    const t = new PromptThrottleService(noRedis, cfg({ IDENTITY_PROMPT_MAX_PER_USER: '0', IDENTITY_PROMPT_WINDOW_SECONDS: 'abc', IDENTITY_PROMPT_MAX_PER_CONNECTION: '-4' }));
    for (let i = 0; i < 3; i++) expect(await t.allow('c1', 'U1')).toBe(true);
    expect(await t.allow('c1', 'U1')).toBe(false);
  });

  it('uses Redis when it is ready (shared across instances) and falls back to the in-process counter when a call fails', async () => {
    const counts = new Map<string, number>();
    const evalFn = jest.fn(async (_s: string, _n: number, key: string) => { counts.set(key, (counts.get(key) ?? 0) + 1); return counts.get(key); });
    const redis = { configured: true, isReady: () => true, getClient: () => ({ eval: evalFn }) } as never;
    const t = new PromptThrottleService(redis, cfg({ IDENTITY_PROMPT_MAX_PER_USER: '1' }));
    expect(await t.allow('c1', 'U1')).toBe(true);
    expect(await t.allow('c1', 'U1')).toBe(false);
    expect(evalFn).toHaveBeenCalled();

    const broken = { configured: true, isReady: () => true, getClient: () => ({ eval: async () => { throw new Error('boom'); } }) } as never;
    const t2 = new PromptThrottleService(broken, cfg({ IDENTITY_PROMPT_MAX_PER_USER: '1' }));
    expect(await t2.allow('c1', 'U1')).toBe(true); // never fails closed
    expect(await t2.allow('c1', 'U1')).toBe(false);
  });
});
