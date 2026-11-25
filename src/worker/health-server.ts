import { createServer, type Server } from 'node:http';

/**
 * An optional tiny HTTP listener for the worker, answering 200 on every path.
 *
 * The worker consumes queues and normally listens on nothing. Some hosts only run a process as a "web service"
 * if it opens the port they hand it (Render's free plan has no background workers, for one). Set
 * WORKER_HEALTH_PORT (on Render: start command `WORKER_HEALTH_PORT=$PORT npm run start:worker:prod`) and the
 * worker answers there, which satisfies the host's port check and gives an uptime monitor something to ping.
 * Unset, nothing is opened. It carries no data and no secrets.
 */
export function startHealthServer(port: number, startedAt: number = Date.now()): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', role: 'worker', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

/** The port from WORKER_HEALTH_PORT, or null when it is unset or not a usable port. */
export function healthPortFrom(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.WORKER_HEALTH_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}
