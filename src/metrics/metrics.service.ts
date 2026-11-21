import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** Why a signed webhook / interaction was turned away. Matches the verdicts of the three signature checkers. */
export type WebhookRejectReason = 'missing' | 'malformed' | 'expired' | 'bad_signature' | 'bad_key' | 'no_secret';

export type ProviderCallOutcome = 'ok' | 'client_error' | 'server_error' | 'rate_limited' | 'network_error' | 'circuit_open';

/** A collector refreshes gauges from shared state (DB, Redis) just before a scrape is rendered. */
export type GaugeCollector = (m: MetricsService) => Promise<void>;

/**
 * Step 2.7 (ADR-0015). One Prometheus registry per process.
 *
 * TWO KINDS of series, on purpose:
 *  - IN-PROCESS counters (webhook rejections / duplicates, provider calls, breaker trips). Only the process that
 *    serves /metrics (the API) exposes them; the worker has no HTTP listener, so its own counters are not scraped.
 *  - SHARED-STATE gauges (queue depth, delivery outcomes, connection states, credential key ids), computed at scrape
 *    time from Redis and Postgres by the registered collectors. These are correct whichever process did the work,
 *    which is why queue depth and delivery failures are gauges and not counters.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();
  private readonly collectors: GaugeCollector[] = [];

  readonly webhookRejected = new Counter({
    name: 'integration_webhook_rejected_total',
    help: 'Signed provider requests rejected before any work was done, by provider and reason (replays show as expired).',
    labelNames: ['provider', 'reason'],
    registers: [this.registry],
  });
  readonly webhookDuplicate = new Counter({
    name: 'integration_webhook_duplicates_total',
    help: 'Correctly signed provider requests dropped as already-seen (delivery-id dedupe).',
    labelNames: ['provider'],
    registers: [this.registry],
  });
  readonly providerCalls = new Counter({
    name: 'integration_provider_http_requests_total',
    help: 'Outbound provider HTTP calls made by this process, by host and outcome.',
    labelNames: ['host', 'outcome'],
    registers: [this.registry],
  });
  readonly breakerOpened = new Counter({
    name: 'integration_provider_breaker_opened_total',
    help: 'Times this process opened the circuit breaker for a provider host.',
    labelNames: ['host'],
    registers: [this.registry],
  });
  readonly collectorErrors = new Counter({
    name: 'metrics_collector_errors_total',
    help: 'Gauge collectors that failed during a scrape (the scrape still succeeds without their series).',
    labelNames: ['collector'],
    registers: [this.registry],
  });

  readonly queueJobs = new Gauge({
    name: 'queue_jobs',
    help: 'Jobs per queue and state (from Redis, whichever process owns them).',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });
  readonly queueOldestWaitingSeconds = new Gauge({
    name: 'queue_oldest_waiting_age_seconds',
    help: 'Age of the oldest waiting job per queue; a growing value with workers running means jobs are stuck.',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  readonly queueUp = new Gauge({
    name: 'queue_inspection_up',
    help: '1 if queue depth could be read from Redis during this scrape, else 0.',
    registers: [this.registry],
  });
  readonly connections = new Gauge({
    name: 'integration_connections',
    help: 'Integration connections by provider and status.',
    labelNames: ['provider', 'status'],
    registers: [this.registry],
  });
  readonly deliveriesLastHour = new Gauge({
    name: 'integration_channel_deliveries_last_hour',
    help: 'Channel deliveries created in the last hour, by provider and final status.',
    labelNames: ['provider', 'status'],
    registers: [this.registry],
  });
  readonly oldestPendingDeliverySeconds = new Gauge({
    name: 'integration_channel_delivery_oldest_pending_age_seconds',
    help: 'Age of the oldest delivery still PENDING (0 when none).',
    registers: [this.registry],
  });
  readonly disabledSubscriptions = new Gauge({
    name: 'integration_subscriptions_disabled',
    help: 'Channel subscriptions currently disabled (repeated delivery failures or manual).',
    registers: [this.registry],
  });
  readonly credentialsByKid = new Gauge({
    name: 'integration_credentials_by_kid',
    help: 'Stored provider credentials per encryption key id; a retired key must reach 0 before it is removed from the ring.',
    labelNames: ['kid'],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  registerCollector(fn: GaugeCollector): void {
    this.collectors.push(fn);
  }

  /** Prometheus text exposition. A failing collector drops its own series, never the whole scrape. */
  async render(): Promise<string> {
    for (const [i, fn] of this.collectors.entries()) {
      try {
        await fn(this);
      } catch (e) {
        this.collectorErrors.inc({ collector: String(fn.name || i) });
        this.logger.warn(`Metrics collector ${fn.name || i} failed: ${(e as Error).message}`);
      }
    }
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
