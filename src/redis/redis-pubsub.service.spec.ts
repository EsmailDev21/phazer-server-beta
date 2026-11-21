import { RedisPubSubService } from './redis-pubsub.service';
import { RedisService } from './redis.service';

describe('RedisPubSubService (unit, mocked RedisService)', () => {
  function build(configured = true) {
    const client = {
      publish: jest.fn().mockResolvedValue(1),
      duplicate: jest.fn(),
    };
    const redis = {
      configured,
      getClient: jest.fn(() => client),
    } as unknown as RedisService;
    const service = new RedisPubSubService(redis);
    return { client, redis, service };
  }

  describe('when Redis is not configured', () => {
    it('publish is a silent no-op', async () => {
      const { client, service } = build(false);
      await expect(
        service.publish('sse:user:u1', 'hello'),
      ).resolves.toBeUndefined();
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('subscribe is a silent no-op (handler never registered)', async () => {
      const { client, service } = build(false);
      const handler = jest.fn();
      await service.subscribe('sse:user:u1', handler);
      expect(client.duplicate).not.toHaveBeenCalled();
    });
  });

  describe('when Redis is configured', () => {
    it('publish calls PUBLISH on the shared client', async () => {
      const { client, service } = build();
      await service.publish('sse:user:u1', 'hello');
      expect(client.publish).toHaveBeenCalledWith('sse:user:u1', 'hello');
    });

    it('publish swallows a rejected PUBLISH rather than throwing', async () => {
      const { client, service } = build();
      client.publish.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(
        service.publish('sse:user:u1', 'hello'),
      ).resolves.toBeUndefined();
    });

    it('subscribe lazily creates ONE duplicated subscriber connection, reused across channels', async () => {
      const subConn = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const { client, service } = build();
      client.duplicate.mockReturnValue(subConn);

      await service.subscribe('sse:user:u1', jest.fn());
      await service.subscribe('sse:user:u2', jest.fn());

      expect(client.duplicate).toHaveBeenCalledTimes(1);
      expect(subConn.subscribe).toHaveBeenCalledWith('sse:user:u1');
      expect(subConn.subscribe).toHaveBeenCalledWith('sse:user:u2');
    });

    it("dispatches an incoming 'message' event to the handler registered for that channel only", async () => {
      let messageListener: (
        channel: string,
        message: string,
      ) => void = () => {};
      const subConn = {
        on: jest.fn((event: string, cb: any) => {
          if (event === 'message') messageListener = cb;
        }),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const { client, service } = build();
      client.duplicate.mockReturnValue(subConn);

      const h1 = jest.fn();
      const h2 = jest.fn();
      await service.subscribe('sse:user:u1', h1);
      await service.subscribe('sse:user:u2', h2);

      messageListener('sse:user:u1', 'payload-for-u1');

      expect(h1).toHaveBeenCalledWith('payload-for-u1');
      expect(h2).not.toHaveBeenCalled();
    });

    it('unsubscribe removes the handler and issues UNSUBSCRIBE', async () => {
      const subConn = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const { client, service } = build();
      client.duplicate.mockReturnValue(subConn);

      await service.subscribe('sse:user:u1', jest.fn());
      await service.unsubscribe('sse:user:u1');

      expect(subConn.unsubscribe).toHaveBeenCalledWith('sse:user:u1');
    });

    it('unsubscribe before any subscribe is a harmless no-op', async () => {
      const { service } = build();
      await expect(service.unsubscribe('sse:user:u1')).resolves.toBeUndefined();
    });

    it('onModuleDestroy disconnects the subscriber connection', async () => {
      const subConn = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
      };
      const { client, service } = build();
      client.duplicate.mockReturnValue(subConn);

      await service.subscribe('sse:user:u1', jest.fn());
      await service.onModuleDestroy();

      expect(subConn.disconnect).toHaveBeenCalled();
    });
  });
});
