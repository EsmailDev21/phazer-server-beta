import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES } from '../../queue/queue.definitions';
import { QueueService } from '../../queue/queue.service';
import { IdentityService } from '../core/identity.service';
import { WebhookDedupeService } from '../webhooks/webhook-dedupe.service';
import { ChatCommandExecutor } from './chat-command.executor';
import { CHAT_QUEUE_JOB, ChatActor, ChatUserError } from './chat.types';
import { parseInteraction } from './discord-command.parser';
import { verifyDiscordSignature } from './discord-signature';
import {
  CallbackType,
  DiscordCallback,
  DiscordInteraction,
  InteractionType,
  canManageGuild,
  deferred,
  ephemeralMessage,
  pong,
  renderLinkPrompt,
} from './discord.protocol';

export type InteractionOutcome = { status: 200; body: DiscordCallback } | { status: 401 };

/** Small head start so the worker's follow-up cannot overtake Discord processing our deferral (a 404 retries anyway). */
export const FOLLOW_UP_DELAY_MS = 250;

/**
 * The synchronous half of a Discord interaction (ADR-0012 d.3-d.5). Everything here must finish inside Discord's
 * 3 seconds, so it is verification + a few indexed reads + one enqueue; the real work is the `chat.command` job.
 * Order matters: verify FIRST (nothing is written for an unsigned caller), then dedupe, then resolve who is calling.
 */
@Injectable()
export class DiscordInteractionService {
  private readonly logger = new Logger(DiscordInteractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly dedupe: WebhookDedupeService,
    private readonly identities: IdentityService,
    private readonly executor: ChatCommandExecutor,
    private readonly queue: QueueService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async handle(input: { rawBody: Buffer; signature?: string; timestamp?: string; payload: unknown; nowSeconds?: number }): Promise<InteractionOutcome> {
    const verdict = verifyDiscordSignature({
      publicKeyHex: this.config.get<string>('DISCORD_PUBLIC_KEY'),
      signatureHex: input.signature,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
      nowSeconds: input.nowSeconds,
    });
    if (verdict !== 'ok') {
      // Discord probes the endpoint with bad signatures on purpose and expects 401; log the reason, never return it.
      this.logger.warn(`Rejected Discord interaction: ${verdict}`);
      this.metrics?.webhookRejected.inc({ provider: 'DISCORD', reason: verdict });
      return { status: 401 };
    }
    const i = input.payload as DiscordInteraction;
    if (!i || typeof i !== 'object' || typeof i.id !== 'string' || typeof i.type !== 'number') {
      return { status: 200, body: ephemeralMessage('Unsupported request.') };
    }
    if (i.type === InteractionType.PING) return { status: 200, body: pong() };
    if (i.type === InteractionType.AUTOCOMPLETE) return { status: 200, body: { type: CallbackType.AUTOCOMPLETE_RESULT, data: { choices: [] } } };

    if (!(await this.dedupe.claim(IntegrationProvider.DISCORD, i.id))) {
      return { status: 200, body: ephemeralMessage('This request was already received.') };
    }
    try {
      return { status: 200, body: await this.dispatch(i) };
    } catch (e) {
      if (e instanceof ChatUserError) return { status: 200, body: ephemeralMessage(e.message) };
      this.logger.error(`Interaction ${i.id} failed: ${(e as Error).message}`, (e as Error).stack);
      return { status: 200, body: ephemeralMessage('Something went wrong. Please try again.') };
    }
  }

  private async dispatch(i: DiscordInteraction): Promise<DiscordCallback> {
    const user = i.member?.user ?? i.user;
    if (!i.guild_id || !/^\d{5,25}$/.test(i.guild_id)) throw new ChatUserError('Use this inside a server where the app is installed.');
    if (!user || user.bot || !/^\d{5,25}$/.test(user.id)) throw new ChatUserError('Unsupported caller.');
    const channelId = i.channel_id ?? i.channel?.id;
    if (!channelId || !/^\d{5,25}$/.test(channelId)) throw new ChatUserError('Unsupported channel.');

    // Parse first (pure): a malformed command never causes a link token to be issued.
    const parsed = parseInteraction(i);

    const conn = await this.prisma.integrationConnection.findFirst({
      where: { provider: IntegrationProvider.DISCORD, externalAccountId: i.guild_id, status: 'ACTIVE' },
      select: { id: true, accountId: true, provider: true },
    });
    if (!conn) throw new ChatUserError('This server is not connected to an account.');

    const who = await this.identities.resolve(conn.id, user.id);
    if (who.linked === false) return renderLinkPrompt(who.reply); // ephemeral; the token is only in this reply

    if (parsed.kind === 'modal') return parsed.response;

    const actor: ChatActor = {
      connectionId: conn.id, accountId: conn.accountId, provider: conn.provider,
      externalUserId: user.id, channelId, tenantId: i.guild_id,
      canManageServer: canManageGuild(i.member?.permissions),
    };
    // Refuse what is already refusable while a refusal can still be private (see executor.preflight).
    await this.executor.preflight(who.userId, actor, parsed.intent);

    try {
      await this.queue.enqueue(
        QUEUES.CHAT.name, CHAT_QUEUE_JOB,
        { provider: conn.provider, applicationId: i.application_id, interactionToken: i.token, actor, intent: parsed.intent, visibility: parsed.visibility, interactionId: i.id },
        { jobId: `chat-${i.id}`, delayMs: FOLLOW_UP_DELAY_MS },
      );
    } catch (e) {
      this.logger.error(`Could not enqueue chat.command for ${i.id}: ${(e as Error).message}`);
      throw new ChatUserError('The task service is busy. Please try again in a moment.');
    }
    return deferred(parsed.visibility === 'private');
  }
}
