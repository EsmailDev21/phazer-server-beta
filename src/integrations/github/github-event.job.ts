import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { GITHUB_EVENT_JOB } from './github-event.service';
import { GithubLinkService } from './github-link.service';

/** `github.event` (queue `webhooks`): the deferred half of a verified GitHub delivery. Everything it does is idempotent (upserts, status rules that only move forward), so the queue's retries are safe. */
@Injectable()
export class GithubEventJob implements JobHandler<'github.event'>, OnModuleInit {
  readonly queue = QUEUES.WEBHOOK.name;
  readonly jobName = GITHUB_EVENT_JOB;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly links: GithubLinkService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(envelope: JobEnvelope): Promise<unknown> {
    const p = envelope.payload as { work: Parameters<GithubLinkService['process']>[0] };
    return this.links.process(p.work);
  }
}
