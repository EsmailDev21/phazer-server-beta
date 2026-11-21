import {
  buildEnvelope,
  InvalidEnvelopeError,
  parseEnvelope,
} from './job-envelope';

describe('buildEnvelope', () => {
  it('fills a random traceId and null actor/account by default', () => {
    const env = buildEnvelope({ x: 1 });
    expect(env.v).toBe(1);
    expect(env.accountId).toBeNull();
    expect(env.actorId).toBeNull();
    expect(env.payload).toEqual({ x: 1 });
    expect(env.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('two calls get different trace ids', () => {
    expect(buildEnvelope({}).traceId).not.toBe(buildEnvelope({}).traceId);
  });

  it('honours a supplied context', () => {
    const env = buildEnvelope(
      { x: 1 },
      { traceId: 't1', accountId: 'acc_1', actorId: 'user_1' },
    );
    expect(env).toEqual({
      v: 1,
      traceId: 't1',
      accountId: 'acc_1',
      actorId: 'user_1',
      payload: { x: 1 },
    });
  });
});

describe('parseEnvelope', () => {
  it('round-trips what buildEnvelope produced, through JSON (as Redis would)', () => {
    const built = buildEnvelope({ x: 1 }, { accountId: 'a' });
    const roundTripped = JSON.parse(JSON.stringify(built));
    expect(parseEnvelope(roundTripped)).toEqual(built);
  });

  it.each([
    [null, 'not an object'],
    [42, 'not an object'],
    ['x', 'not an object'],
    [[1, 2], 'not an object'],
    [{ v: 2, traceId: 't', payload: {} }, 'unsupported version'],
    [{ traceId: 't', payload: {} }, 'unsupported version'],
    [{ v: 1, payload: {} }, 'traceId missing'],
    [{ v: 1, traceId: '', payload: {} }, 'traceId missing'],
    [{ v: 1, traceId: 't', accountId: 5, payload: {} }, 'accountId must be'],
    [{ v: 1, traceId: 't', actorId: 5, payload: {} }, 'actorId must be'],
    [{ v: 1, traceId: 't', accountId: null }, 'payload missing'],
  ])('rejects %j', (data, expectedMessage) => {
    expect(() => parseEnvelope(data)).toThrow(InvalidEnvelopeError);
    expect(() => parseEnvelope(data)).toThrow(expectedMessage);
  });

  it('accepts null accountId/actorId explicitly, and a falsy-but-present payload', () => {
    expect(
      parseEnvelope({
        v: 1,
        traceId: 't',
        accountId: null,
        actorId: null,
        payload: 0,
      }),
    ).toEqual({
      v: 1,
      traceId: 't',
      accountId: null,
      actorId: null,
      payload: 0,
    });
  });
});
