import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../../queue/job-handler.registry';
import { QUEUES } from '../../../queue/queue.definitions';
import { ConnectorRegistry } from '../../core/connector.registry';
import { CredentialService } from '../../core/credential.service';
import { IdentityService } from '../../core/identity.service';
import { RichMessageBuilder } from '../../notify/rich-message.builder';
import { SlackAdapter } from '../../providers/slack.adapter';
import { ChatCommandExecutor } from '../chat-command.executor';
import { ChatActor } from '../chat.types';
import { unfurlCard } from './slack.protocol';
import { CHAT_UNFURL_JOB } from './slack-interaction.service';

export interface ChatUnfurlPayload { connectionId: string; accountId: string; teamId: string; channel: string; messageTs: string; userExternalId: string; urls: string[] }

declare module '../../../queue/queue.definitions' {
  interface JobPayloads {
    'chat.unfurl': ChatUnfurlPayload;
  }
}

/**
 * `chat.unfurl` (ADR-0013 d.7): show a task card under a pasted task link. An unfurl is visible to the WHOLE channel, so it is
 * shown only for a task the person who pasted the link is allowed to see; an unlinked poster, an invisible task, or a task of
 * another account unfurls nothing (and never produces a "link your account" prompt for a link someone merely pasted).
 */
@Injectable()
export class ChatUnfurlJob implements JobHandler<'chat.unfurl'>, OnModuleInit {
  private readonly logger = new Logger(ChatUnfurlJob.name);
  readonly queue = QUEUES.CHAT.name;
  readonly jobName = CHAT_UNFURL_JOB;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly identities: IdentityService,
    private readonly executor: ChatCommandExecutor,
    private readonly credentials: CredentialService,
    private readonly adapters: ConnectorRegistry,
    private readonly messages: RichMessageBuilder,
  ) {}

  onModuleInit(): void { this.registry.register(this); }

  async handle(envelope: JobEnvelope): Promise<unknown> {
    const p = envelope.payload as ChatUnfurlPayload;
    const userId = await this.identities.lookupLinkedUserId(p.connectionId, p.userExternalId);
    if (!userId) return { skipped: 'unlinked' };
    const actor: ChatActor = { connectionId: p.connectionId, accountId: p.accountId, provider: 'SLACK', externalUserId: p.userExternalId, channelId: p.channel, tenantId: p.teamId, canManageServer: false };
    const unfurls: Record<string, unknown> = {};
    for (const url of p.urls) {
      const key = this.messages.parseTaskKey(url);
      const card = key ? await this.executor.describeTask(userId, actor, key) : null;
      if (card) unfurls[url] = unfurlCard(card);
    }
    if (Object.keys(unfurls).length === 0) return { skipped: 'nothing_visible' };
    const token = await this.credentials.getAccessToken(p.connectionId);
    await (this.adapters.get('SLACK') as SlackAdapter).unfurl(token, { channel: p.channel, ts: p.messageTs, unfurls }, `connection:${p.connectionId}`);
    return { unfurled: Object.keys(unfurls).length };
  }
}
