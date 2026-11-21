import { checkRedisUrl } from './redis-url';

describe('checkRedisUrl', () => {
  it.each([
    'redis://localhost:6379',
    'redis://:secret@10.0.0.5:6379/2',
    'rediss://user:pw@redis.example.com:6380',
    '  redis://localhost:6379  ',
  ])('accepts %j', (value) => {
    expect(checkRedisUrl(value)).toEqual({ ok: true });
  });

  it.each([undefined, '', '   '])('%j is "not set"', (value) => {
    expect(checkRedisUrl(value)).toEqual({ ok: false, reason: 'is not set' });
  });

  it('rejects non-URLs and the wrong scheme, naming the problem', () => {
    expect(checkRedisUrl('localhost:6379').reason).toMatch(
      /redis:\/\/|valid URL/,
    );
    expect(checkRedisUrl('not a url').reason).toBe('is not a valid URL');
    expect(checkRedisUrl('http://localhost:6379').reason).toContain(
      'redis:// or rediss://',
    );
    expect(checkRedisUrl('postgres://x').ok).toBe(false);
  });
});
