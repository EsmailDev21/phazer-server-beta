import { createHash } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { MetricsService } from '../../../metrics/metrics.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUES } from '../../../queue/queue.definitions';
import { QueueService } from '../../../queue/queue.service';
import { ConnectorRegistry } from '../../core/connector.registry';
import { ConnectionLifecycleService } from '../../core/connection-lifecycle.service';
import { CredentialService } from '../../core/credential.service';
import { IdentityService } from '../../core/identity.service';
import { RichMessageBuilder } from '../../notify/rich-message.builder';
import { SlackAdapter } from '../../providers/slack.adapter';
import { WebhookDedupeService } from '../../webhooks/webhook-dedupe.service';
import { ChatCommandExecutor } from '../chat-command.executor';
import { CHAT_QUEUE_JOB, ChatActor, ChatUserError } from '../chat.types';
import { parseSlackInteraction, parseSlackText } from './slack-command.parser';
import { verifySlackSignatureWithRotation } from './slack-signature';
import {
  SLACK_CHANNEL, SLACK_ID, SLACK_RESPONSE_URL, SLACK_TEAM, SlackCommandPayload, SlackEventEnvelope, SlackInteractionPayload,
  renderLinkPrompt, toMrkdwn,
} from './slack.protocol';

export type SlackOutcome = { status: 200; body: unknown } | { status: 401 };
export const CHAT_UNFURL_JOB = 'chat.unfurl' as const;
const ACK = '';
const MAX_UNFURL_URLS = 5;

interface Verifiable { rawBody: Buffer; signature?: string; timestamp?: string; nowSeconds?: number }

/**
 * Slack's three entry points (slash command, interactivity, Events API), ADR-0013. Same shape as the Discord service:
 * verify FIRST (nothing is read or written for an unsigned caller), dedupe, then resolve team -> the ONE live connection,
 * caller -> linked user, preflight, enqueue, ack. Slack's 3 seconds apply to every one of these responses.
 */
@Injectable()
export class SlackInteractionService {
  private readonly logger = new Logger(SlackInteractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly dedupe: WebhookDedupeService,
    private readonly identities: IdentityService,
    private readonly executor: ChatCommandExecutor,
    private readonly queue: QueueService,
    private readonly credentials: CredentialService,
    private readonly adapters: ConnectorRegistry,
    private readonly messages: RichMessageBuilder,
    private readonly lifecycle: ConnectionLifecycleService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  private verify(i: Verifiable): boolean {
    const verdict = verifySlackSignatureWithRotation({ signingSecret: this.config.get<string>('SLACK_SIGNING_SECRET'), previousSigningSecret: this.config.get<string>('SLACK_SIGNING_SECRET_PREVIOUS'), signature: i.signature, timestamp: i.timestamp, rawBody: i.rawBody, nowSeconds: i.nowSeconds });
    if (verdict !== 'ok') {
      this.logger.warn(`Rejected Slack request: ${verdict}`); // reason logged, never returned
      this.metrics?.webhookRejected.inc({ provider: 'SLACK', reason: verdict });
    }
    return verdict === 'ok';
  }

  private get slack(): SlackAdapter { return this.adapters.get(IntegrationProvider.SLACK) as SlackAdapter; }

  private async connectionOf(teamId: string | undefined) {
    if (!teamId || !SLACK_TEAM.test(teamId)) throw new ChatUserError('Unsupported workspace.');
    const conn = await this.prisma.integrationConnection.findFirst({
      where: { provider: IntegrationProvider.SLACK, externalAccountId: teamId, status: 'ACTIVE' },
      select: { id: true, accountId: true, provider: true },
    });
    if (!conn) throw new ChatUserError('This Slack workspace is not connected to an account.');
    return conn;
  }

  private ephemeral(text: string) { return { response_type: 'ephemeral', text: toMrkdwn(text).slice(0, 3000) }; }

  private idOf(triggerId: unknown, rawBody: Buffer): string {
    return typeof triggerId === 'string' && /^[0-9A-Za-z.]{5,80}$/.test(triggerId) ? triggerId : `h-${createHash('sha256').update(rawBody).digest('hex').slice(0, 40)}`;
  }

  // ------------------------------------------------------------------ slash command

  async handleCommand(i: Verifiable & { payload: unknown }): Promise<SlackOutcome> {
    if (!this.verify(i)) return { status: 401 };
    const f = (i.payload ?? {}) as SlackCommandPayload;
    const id = this.idOf(f.trigger_id, i.rawBody);
    if (!(await this.dedupe.claim(IntegrationProvider.SLACK, id))) return { status: 200, body: this.ephemeral('This request was already received.') };
    try {
      return { status: 200, body: await this.dispatchCommand(f, id) };
    } catch (e) {
      return { status: 200, body: this.failure(e, `command ${id}`) };
    }
  }

  private failure(e: unknown, what: string) {
    if (e instanceof ChatUserError) return this.ephemeral(e.message);
    this.logger.error(`Slack ${what} failed: ${(e as Error).message}`, (e as Error).stack);
    return this.ephemeral('Something went wrong. Please try again.');
  }

  private async dispatchCommand(f: SlackCommandPayload, interactionId: string): Promise<unknown> {
    if (!f.user_id || !SLACK_ID.test(f.user_id) || !f.channel_id || !SLACK_CHANNEL.test(f.channel_id)) throw new ChatUserError('Unsupported request.');
    if (!f.response_url || !SLACK_RESPONSE_URL.test(f.response_url)) throw new ChatUserError('Unsupported request.');
    const parsed = parseSlackText(f.text ?? '');
    const conn = await this.connectionOf(f.team_id);
    const who = await this.identities.resolve(conn.id, f.user_id);
    if (who.linked === false) return renderLinkPrompt(who.reply);

    const actor: ChatActor = { connectionId: conn.id, accountId: conn.accountId, provider: conn.provider, externalUserId: f.user_id, channelId: f.channel_id, tenantId: f.team_id!, canManageServer: false };
    if (parsed.intent.kind === 'link') {
      // The one command that needs a Slack API call before the ack: is the caller a workspace admin?
      actor.canManageServer = await this.slack.isWorkspaceAdmin(await this.credentials.getAccessToken(conn.id), f.user_id, `connection:${conn.id}`);
    }
    await this.executor.preflight(who.userId, actor, parsed.intent);
    await this.enqueue({ applicationId: f.team_id!, interactionToken: f.response_url, actor, intent: parsed.intent, visibility: parsed.visibility, interactionId });
    return ACK;
  }

  private async enqueue(p: { applicationId: string; interactionToken: string; actor: ChatActor; intent: import('../chat.types').ChatIntent; visibility: 'public' | 'private'; interactionId: string; reply?: { channelId?: string; threadTs?: string; userId?: string } }) {
    try {
      await this.queue.enqueue(QUEUES.CHAT.name, CHAT_QUEUE_JOB, { provider: IntegrationProvider.SLACK, ...p }, { jobId: `chat-${p.interactionId}` });
    } catch (e) {
      this.logger.error(`Could not enqueue chat.command ${p.interactionId}: ${(e as Error).message}`);
      throw new ChatUserError('The task service is busy. Please try again in a moment.');
    }
  }

  // ------------------------------------------------------------------ interactivity (shortcut, buttons, modals)

  async handleInteractivity(i: Verifiable & { payload: unknown }): Promise<SlackOutcome> {
    if (!this.verify(i)) return { status: 401 };
    let p: SlackInteractionPayload;
    try {
      p = JSON.parse(String((i.payload as { payload?: string } | undefined)?.payload ?? ''));
    } catch {
      return { status: 200, body: ACK };
    }
    const id = this.idOf(p.trigger_id, i.rawBody);
    if (!(await this.dedupe.claim(IntegrationProvider.SLACK, id))) return { status: 200, body: ACK };
    try {
      return { status: 200, body: await this.dispatchInteraction(p, id) };
    } catch (e) {
      this.failure(e, `interaction ${id}`);
      // A modal submission can show the problem inside the modal; everything else is told privately below.
      if (p.type === 'view_submission') return { status: 200, body: { response_action: 'errors', errors: { [this.firstBlock(p)]: e instanceof ChatUserError ? e.message.slice(0, 300) : 'Something went wrong. Please try again.' } } };
      await this.tellUser(p, e instanceof ChatUserError ? e.message : 'Something went wrong. Please try again.').catch(() => undefined);
      return { status: 200, body: ACK };
    }
  }

  private firstBlock(p: SlackInteractionPayload): string { return (p.view?.callback_id ?? '').startsWith('d:') ? 'date_b' : 'title_b'; }

  /** A private note to the person, as a message only they see (used where Slack gives us no HTTP response to put it in). */
  private async tellUser(p: SlackInteractionPayload, text: string, extra?: string): Promise<void> {
    const teamId = p.team?.id; const channel = p.channel?.id; const user = p.user?.id;
    if (!teamId || !channel || !user || !SLACK_CHANNEL.test(channel) || !SLACK_ID.test(user)) return;
    const conn = await this.connectionOf(teamId);
    await this.slack.chatReply({ applicationId: teamId, interactionToken: '', reply: { channelId: channel, userId: user }, accessToken: await this.credentials.getAccessToken(conn.id) }, { visibility: 'private', text, ...(extra ? { lines: [extra] } : {}) });
  }

  private async dispatchInteraction(p: SlackInteractionPayload, interactionId: string): Promise<unknown> {
    const userId = p.user?.id;
    if (!userId || !SLACK_ID.test(userId)) throw new ChatUserError('Unsupported caller.');
    const parsed = parseSlackInteraction(p);
    if (parsed.kind === 'ignore') return ACK;
    if (parsed.kind === 'view_errors') return { response_action: 'errors', errors: parsed.errors };
    const conn = await this.connectionOf(p.team?.id);
    const channelId = p.channel?.id ?? (parsed.kind === 'intent' ? parsed.reply?.channelId : undefined) ?? '';

    // Identity. Modal submissions cannot show a prompt, so they only LOOK UP (no token issued); everything else prompts.
    let linkedUser: string | null;
    if (p.type === 'view_submission') {
      linkedUser = await this.identities.lookupLinkedUserId(conn.id, userId);
      if (!linkedUser) throw new ChatUserError('Your Slack account is not linked yet. Run `/task` in a channel to get a link.');
    } else {
      const who = await this.identities.resolve(conn.id, userId);
      if (who.linked === false) {
        await this.tellUser(p, who.reply.text, who.reply.actions[0]?.url);
        return ACK;
      }
      linkedUser = who.userId;
    }

    const actor: ChatActor = { connectionId: conn.id, accountId: conn.accountId, provider: conn.provider, externalUserId: userId, channelId, tenantId: p.team!.id!, canManageServer: false };

    if (parsed.kind === 'open_view') {
      if (p.type === 'message_action') await this.executor.preflight(linkedUser, actor, { kind: 'create', title: 'x' }); // no form for someone who may not create
      if (!p.trigger_id) throw new ChatUserError('Could not open the form. Please try again.');
      try {
        await this.slack.openView(await this.credentials.getAccessToken(conn.id), p.trigger_id, parsed.view, `connection:${conn.id}`);
      } catch (e) {
        this.logger.warn(`views.open failed: ${(e as Error).message}`);
        throw new ChatUserError('Could not open the form (it must open within 3 seconds). Please try again.');
      }
      return ACK;
    }

    await this.executor.preflight(linkedUser, actor, parsed.intent);
    // Buttons answer through their response_url; modal submissions have none, so the job posts (parsed.reply).
    const viaUrl = p.response_url && SLACK_RESPONSE_URL.test(p.response_url) && !parsed.reply?.channelId ? p.response_url : '';
    const reply = viaUrl ? undefined : parsed.reply ?? (SLACK_CHANNEL.test(channelId) ? { channelId, userId } : undefined);
    if (!viaUrl && !reply?.channelId) throw new ChatUserError('Could not tell where to answer. Please run the command again.');
    await this.enqueue({ applicationId: p.team!.id!, interactionToken: viaUrl, actor, intent: parsed.intent, visibility: parsed.visibility, interactionId, reply });
    return ACK;
  }

  // ------------------------------------------------------------------ Events API

  async handleEvent(i: Verifiable & { payload: unknown }): Promise<SlackOutcome> {
    if (!this.verify(i)) return { status: 401 };
    const e = (i.payload ?? {}) as SlackEventEnvelope;
    // Slack's endpoint handshake. Only ever answered AFTER the signature check, and only with the challenge string.
    if (e.type === 'url_verification') return { status: 200, body: { challenge: typeof e.challenge === 'string' ? e.challenge.slice(0, 200) : '' } };
    if (e.type !== 'event_callback' || !e.event_id) return { status: 200, body: ACK };
    if (!(await this.dedupe.claim(IntegrationProvider.SLACK, `ev-${e.event_id}`))) return { status: 200, body: ACK };
    try {
      if (e.event?.type === 'link_shared') await this.onLinkShared(e);
      else if (e.event?.type === 'app_uninstalled') await this.onUninstalled(e, 'Slack app uninstalled');
      else if (e.event?.type === 'tokens_revoked') {
        // `tokens.oauth` are USER tokens (we hold none); only a revoked BOT token ends the connection.
        const bots = e.event.tokens?.bot;
        if (Array.isArray(bots) && bots.length > 0) await this.onUninstalled(e, 'Slack bot token revoked');
      }
    } catch (err) {
      this.logger.error(`Slack event ${e.event_id} failed: ${(err as Error).message}`, (err as Error).stack);
    }
    return { status: 200, body: ACK };
  }

  /** Slack tells us the bot is gone: soft revoke (links paused, kept), one alert; reinstalling + reconnecting revives it. */
  private async onUninstalled(e: SlackEventEnvelope, reason: string): Promise<void> {
    if (!e.team_id || !SLACK_TEAM.test(e.team_id)) return;
    await this.lifecycle.revokeByProvider(IntegrationProvider.SLACK, e.team_id, reason);
  }

  private async onLinkShared(e: SlackEventEnvelope): Promise<void> {
    const ev = e.event!;
    if (!ev.user || !SLACK_ID.test(ev.user) || !ev.channel || !SLACK_CHANNEL.test(ev.channel) || !ev.message_ts) return;
    const urls = (ev.links ?? []).map((l) => l.url ?? '').filter((u) => this.messages.parseTaskKey(u)).slice(0, MAX_UNFURL_URLS);
    if (urls.length === 0) return; // someone else's link: not ours to unfurl
    const conn = await this.prisma.integrationConnection.findFirst({ where: { provider: 'SLACK', externalAccountId: e.team_id ?? '', status: 'ACTIVE' }, select: { id: true, accountId: true } });
    if (!conn) return;
    await this.queue.enqueue(QUEUES.CHAT.name, CHAT_UNFURL_JOB, { connectionId: conn.id, accountId: conn.accountId, teamId: e.team_id!, channel: ev.channel, messageTs: ev.message_ts, userExternalId: ev.user, urls }, { jobId: `unfurl-${e.event_id}` });
  }
}
