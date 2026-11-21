#!/usr/bin/env node
/**
 * CI smoke test for the built worker (dist/main.worker.js): enqueues a
 * system.ping job with BullMQ directly (no NestJS, so this exercises the
 * SAME queue/prefix the worker will read from independently of the app's own
 * wiring), spawns the worker, and asserts the job actually completes.
 *
 * Exits non-zero on any failure, including the worker process exiting on its
 * own before the job completes.
 */
import { Queue } from 'bullmq';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const REDIS_URL = process.env.REDIS_URL || process.env.TEST_REDIS_URL;
if (!REDIS_URL) {
  console.error('worker-smoke-test: REDIS_URL (or TEST_REDIS_URL) must be set');
  process.exit(1);
}
const prefix = `smoke-${Date.now()}`;
const TIMEOUT_MS = 30_000;

async function main() {
  const queue = new Queue('system', { connection: { url: REDIS_URL }, prefix });
  const job = await queue.add('system.ping', {
    v: 1,
    traceId: 'smoke-test',
    accountId: null,
    actorId: null,
    payload: { note: 'ci-smoke' },
  });
  console.log(`enqueued system.ping id=${job.id}`);

  const worker = spawn('node', ['dist/main.worker.js'], {
    env: { ...process.env, REDIS_URL, QUEUE_PREFIX: prefix, NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  let workerExited = false;
  worker.on('exit', (code) => {
    workerExited = true;
    if (code !== null) console.log(`worker process exited with code ${code}`);
  });

  const deadline = Date.now() + TIMEOUT_MS;
  let finalJob;
  while (Date.now() < deadline) {
    finalJob = await queue.getJob(job.id);
    if (await finalJob?.isCompleted()) break;
    if (workerExited) {
      throw new Error('worker process exited before the job completed');
    }
    await sleep(200);
  }

  if (!(await finalJob?.isCompleted())) {
    throw new Error(`system.ping did not complete within ${TIMEOUT_MS}ms`);
  }
  console.log('system.ping completed:', await finalJob.returnvalue);

  worker.kill('SIGTERM');
  await new Promise((resolve) => worker.on('exit', resolve));

  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  console.log('worker smoke test PASSED');
}

main().catch((err) => {
  console.error('worker smoke test FAILED:', err.message);
  process.exit(1);
});
