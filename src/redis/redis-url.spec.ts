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

describe('describeRedisTarget and redisErrorHint', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { describeRedisTarget, redisErrorHint } = require('./redis-url');

  it('says where the URL points without the password, with the default port', () => {
    expect(describeRedisTarget('rediss://default:s3cret@host.example.com:6380')).toEqual({ host: 'host.example.com', port: 6380, tls: true, hasPassword: true });
    expect(describeRedisTarget('redis://localhost')).toEqual({ host: 'localhost', port: 6379, tls: false, hasPassword: false });
    expect(describeRedisTarget('https://x')).toBeNull();
    expect(JSON.stringify(describeRedisTarget('rediss://default:s3cret@h:1'))).not.toContain('s3cret');
  });

  it('points at TLS when the connection never became ready on a plain redis:// URL', () => {
    const msg = 'Reached the max retries per request limit (which is 1).';
    expect(redisErrorHint(msg, { host: 'h', port: 1, tls: false, hasPassword: true })).toContain('rediss://');
    expect(redisErrorHint(msg, { host: 'h', port: 1, tls: true, hasPassword: true })).toContain('host, port and password');
    expect(redisErrorHint('ECONNREFUSED', null)).toBe('');
  });
});
