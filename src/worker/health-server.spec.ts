import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { healthPortFrom, startHealthServer } from './health-server';

describe('worker health server', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it('answers 200 with a small JSON body on any path', async () => {
    server = await startHealthServer(0);
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/anything`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', role: 'worker' });
  });

  it('is off unless WORKER_HEALTH_PORT is a real port', () => {
    expect(healthPortFrom({})).toBeNull();
    expect(healthPortFrom({ WORKER_HEALTH_PORT: ' ' })).toBeNull();
    expect(healthPortFrom({ WORKER_HEALTH_PORT: 'abc' })).toBeNull();
    expect(healthPortFrom({ WORKER_HEALTH_PORT: '70000' })).toBeNull();
    expect(healthPortFrom({ WORKER_HEALTH_PORT: '10000' })).toBe(10000);
  });
});
