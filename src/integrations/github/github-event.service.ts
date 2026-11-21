import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { QUEUES } from '../../queue/queue.definitions';
import { QueueService } from '../../queue/queue.service';
import { WebhookDedupeService } from '../webhooks/webhook-dedupe.service';
import { MetricsService } from '../../metrics/metrics.service';
import { GithubWork, HANDLED_EVENTS, extractGithubWork, verifyGithubSignatureWithRotation } from './github.protocol';

export const GITHUB_EVENT_JOB = 'github.event' as const;
export type GithubOutcome = { status: 200; body: { ok: true; ignored?: string; duplicate?: boolean } } | { status: 401 };

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'github.event': { deliveryId: string; event: string; work: GithubWork };
  }
}

/**
 * `POST /integrations/github/webhook` (ADR-0014 d.2), following the 0.9 contract:
 *   1. verify X-Hub-Signature-256 over the RAW body FIRST: nothing is read, written or enqueued for an unverified caller;
 *   2. reduce the payload (untrusted even when signed) to the few validated fields we use; events/actions we do not handle are
 *      acknowledged and dropped BEFORE dedupe, so they never fill `integration_webhook_events`;
 *   3. dedupe by X-GitHub-Delivery and enqueue in one step (the claim is undone if the enqueue fails, so GitHub's redelivery works);
 *   4. answer 200 for a duplicate too.
 * The work itself (DB, GitHub-side effects) runs in the worker (`github.event`).
 */
@Injectable()
export class GithubEventService {
  private readonly logger = new Logger(GithubEventService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly dedupe: WebhookDedupeService,
    private readonly queue: QueueService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async handle(i: { rawBody: Buffer; payload: unknown; signature?: string; event?: string; deliveryId?: string }): Promise<GithubOutcome> {
    const verdict = verifyGithubSignatureWithRotation({ secret: this.config.get<string>('GITHUB_WEBHOOK_SECRET'), previousSecret: this.config.get<string>('GITHUB_WEBHOOK_SECRET_PREVIOUS'), signature: i.signature, rawBody: i.rawBody });
    if (verdict !== 'ok') {
      this.logger.warn(`Rejected GitHub webhook: ${verdict}`); // reason logged, never returned
      this.metrics?.webhookRejected.inc({ provider: 'GITHUB', reason: verdict === 'mismatch' ? 'bad_signature' : verdict === 'no-secret' ? 'no_secret' : verdict });
      return { status: 401 };
    }
    const event = (i.event ?? '').slice(0, 50);
    if (event === 'ping') return { status: 200, body: { ok: true, ignored: 'ping' } };
    if (!HANDLED_EVENTS.has(event)) return { status: 200, body: { ok: true, ignored: 'event' } };

    const work = extractGithubWork(event, i.payload);
    if (!work) return { status: 200, body: { ok: true, ignored: 'payload' } };

    const deliveryId = i.deliveryId ?? '';
    const { duplicate } = await this.dedupe.acceptDelivery({
      provider: IntegrationProvider.GITHUB,
      deliveryId,
      enqueue: () => this.queue.enqueue(QUEUES.WEBHOOK.name, GITHUB_EVENT_JOB, { deliveryId, event, work }, { jobId: `gh-${deliveryId}` }),
    });
    return { status: 200, body: duplicate ? { ok: true, duplicate: true } : { ok: true } };
  }
}
