import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobEnvelope } from '../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { ConnectorRegistry } from '../core/connector.registry';
import { CredentialService } from '../core/credential.service';
import { IdentityService, UnlinkedCallerError } from '../core/identity.service';
import { ChatCommandExecutor } from './chat-command.executor';
import { CHAT_QUEUE_JOB, ChatCommandPayload, ChatResult, ChatUserError } from './chat.types';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'chat.command': ChatCommandPayload & { interactionId: string };
  }
}

const UNKNOWN_OUTCOME: ChatResult = {
  visibility: 'private',
  text: 'This command may or may not have completed (it was interrupted). Please check before running it again.',
};
const GENERIC_FAILURE: ChatResult = { visibility: 'private', text: 'Something went wrong. Nothing was changed that you need to undo; please try again.' };

/**
 * `chat.command`: the deferred half of a command (ADR-0012 d.5/d.7). WRITES are at-most-once, REPLIES at-least-once:
 *  - a `chat_command_runs` row keyed by the provider's interaction id is inserted before the executor runs;
 *  - a retried job finds it: DONE -> re-post the stored result; RUNNING -> the previous attempt died mid-write, so we
 *    do NOT run again (it might double-create) and say the outcome is unknown;
 *  - the provider reply failing throws, so the queue retries only the reply.
 */
@Injectable()
export class ChatCommandJob implements JobHandler<'chat.command'>, OnModuleInit {
  private readonly logger = new Logger(ChatCommandJob.name);
  readonly queue = QUEUES.CHAT.name;
  readonly jobName = CHAT_QUEUE_JOB;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly identities: IdentityService,
    private readonly executor: ChatCommandExecutor,
    private readonly adapters: ConnectorRegistry,
    private readonly credentials: CredentialService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(envelope: JobEnvelope): Promise<unknown> {
    const job = envelope.payload as ChatCommandPayload & { interactionId: string };
    const result = await this.resultFor(job);
    const adapter = this.adapters.get(job.provider);
    if (!adapter.chatReply) throw new Error(`${job.provider} adapter cannot deliver chat replies`);
    // A reply that is POSTED (Slack modal submissions) needs the connection's token; a response_url / interaction token is its own credential.
    const accessToken = job.reply?.channelId ? await this.credentials.getAccessToken(job.actor.connectionId) : undefined;
    await adapter.chatReply({ applicationId: job.applicationId, interactionToken: job.interactionToken, reply: job.reply, accessToken }, result);
    return { delivered: true };
  }

  private async resultFor(job: ChatCommandPayload & { interactionId: string }): Promise<ChatResult> {
    try {
      await this.prisma.chatCommandRun.create({ data: { provider: job.provider, interactionId: job.interactionId, status: 'RUNNING' } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      const prior = await this.prisma.chatCommandRun.findUnique({ where: { provider_interactionId: { provider: job.provider, interactionId: job.interactionId } } });
      return prior?.status === 'DONE' && prior.result ? (prior.result as unknown as ChatResult) : UNKNOWN_OUTCOME;
    }

    const result = await this.run(job);
    await this.prisma.chatCommandRun.update({
      where: { provider_interactionId: { provider: job.provider, interactionId: job.interactionId } },
      data: { status: 'DONE', result: result as unknown as Prisma.InputJsonValue },
    });
    return result;
  }

  private async run(job: ChatCommandPayload): Promise<ChatResult> {
    try {
      // Identity again: the link may have been removed between the ack and now. Fails closed.
      const userId = await this.identities.requireLinkedUser(job.actor.connectionId, job.actor.externalUserId);
      return await this.executor.execute(userId, job.actor, job.intent);
    } catch (e) {
      if (e instanceof UnlinkedCallerError) return { visibility: 'private', text: e.reply.text, lines: e.reply.actions.map((a) => `${a.label}: ${a.url}`) };
      if (e instanceof ChatUserError) return { visibility: 'private', text: e.message };
      this.logger.error(`chat.command failed: ${(e as Error).message}`, (e as Error).stack);
      return GENERIC_FAILURE;
    }
  }
}
