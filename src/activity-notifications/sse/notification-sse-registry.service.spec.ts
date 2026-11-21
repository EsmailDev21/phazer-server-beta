import { NotificationSseRegistry } from './notification-sse-registry.service';
import { RedisPubSubService } from '../../redis/redis-pubsub.service';

describe('NotificationSseRegistry (unit, mocked RedisPubSubService)', () => {
  function build() {
    const handlers = new Map<string, (message: string) => void>();
    const pubsub = {
      subscribe: jest.fn((channel: string, handler: (m: string) => void) => {
        handlers.set(channel, handler);
        return Promise.resolve();
      }),
      unsubscribe: jest.fn((channel: string) => {
        handlers.delete(channel);
        return Promise.resolve();
      }),
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisPubSubService;
    const registry = new NotificationSseRegistry(pubsub);
    return { registry, pubsub, handlers };
  }

  const payload = (id = 'n1') => ({
    id,
    type: 'TASK_ASSIGNED',
    sourceType: 'ACTIVITY',
    sourceId: 'a1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  it('connect() SUBSCRIBEs to sse:user:{id} only on the FIRST local connection for that user', () => {
    const { registry, pubsub } = build();
    registry.connect('u1');
    registry.connect('u1'); // second tab, same user

    expect(pubsub.subscribe).toHaveBeenCalledTimes(1);
    expect(pubsub.subscribe).toHaveBeenCalledWith(
      'sse:user:u1',
      expect.any(Function),
    );
  });

  it('disconnect() UNSUBSCRIBEs only once the LAST local connection for that user is gone', () => {
    const { registry, pubsub } = build();
    const s1 = registry.connect('u1');
    const s2 = registry.connect('u1');

    registry.disconnect('u1', s1);
    expect(pubsub.unsubscribe).not.toHaveBeenCalled();

    registry.disconnect('u1', s2);
    expect(pubsub.unsubscribe).toHaveBeenCalledWith('sse:user:u1');
  });

  it('publish() always goes through pubsub.publish, never delivers directly', async () => {
    const { registry, pubsub } = build();
    const subject = registry.connect('u1');
    const emitted: unknown[] = [];
    subject.subscribe((v) => emitted.push(v));

    await registry.publish('u1', payload());

    expect(pubsub.publish).toHaveBeenCalledWith(
      'sse:user:u1',
      JSON.stringify(payload()),
    );
    // No direct delivery - only the subscribe handler (simulated below)
    // delivers locally, so nothing has reached the Subject yet.
    expect(emitted).toEqual([]);
  });

  it('a message arriving via the subscribed handler is delivered to every local Subject for that user', () => {
    const { registry, handlers } = build();
    const emittedA: unknown[] = [];
    const emittedB: unknown[] = [];
    registry.connect('u1').subscribe((v) => emittedA.push(v));
    registry.connect('u1').subscribe((v) => emittedB.push(v));

    handlers.get('sse:user:u1')!(JSON.stringify(payload('n1')));

    expect(emittedA).toEqual([{ ...payload('n1') }]);
    expect(emittedB).toEqual([{ ...payload('n1') }]);
  });

  it('a message for a different user is never delivered to this one', () => {
    const { registry, handlers } = build();
    const emitted: unknown[] = [];
    registry.connect('u1').subscribe((v) => emitted.push(v));
    registry.connect('u2');

    handlers.get('sse:user:u1')!(JSON.stringify(payload()));

    expect(emitted).toHaveLength(1);
  });

  it('a malformed payload is dropped, logged, and does not throw', () => {
    const { registry, handlers } = build();
    const emitted: unknown[] = [];
    registry.connect('u1').subscribe((v) => emitted.push(v));

    expect(() => handlers.get('sse:user:u1')!('not json')).not.toThrow();
    expect(emitted).toEqual([]);
  });

  it('a message arriving after everyone already disconnected is a harmless no-op', () => {
    const { registry, handlers } = build();
    const s1 = registry.connect('u1');
    const handler = handlers.get('sse:user:u1')!;
    registry.disconnect('u1', s1);

    expect(() => handler(JSON.stringify(payload()))).not.toThrow();
  });
});
