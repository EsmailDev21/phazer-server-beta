import { IntegrationProvider, Priority, TaskStatus } from '@prisma/client';

/**
 * Provider-neutral chat commands (ADR-0012 d.2). Discord (2.4) and Slack (2.5) PARSE their payloads into a
 * ChatIntent; ONE executor runs it as the linked user. Nothing below knows what Discord or Slack look like.
 */
export type ChatIntent =
  | { kind: 'create'; title: string; projectName?: string; assigneeExternalId?: string; due?: string; priority?: Priority }
  | {
      kind: 'create_from_message';
      title: string;
      description?: string;
      projectName?: string;
      source: { kind: 'MESSAGE' | 'THREAD'; externalId: string; url: string };
    }
  | { kind: 'update'; key: string; title?: string; status?: TaskStatus; priority?: Priority; due?: string }
  | { kind: 'assign'; key: string; assigneeExternalId: string }
  | { kind: 'assign_me'; taskId: string }
  | { kind: 'set_due'; taskId: string; due: string }
  | { kind: 'list'; projectName?: string; mine?: boolean }
  | { kind: 'link'; workspaceKey?: string; projectName?: string };

/** Who is calling, from the provider's signed payload (never from user-supplied text). */
export interface ChatActor {
  connectionId: string;
  accountId: string;
  provider: IntegrationProvider;
  externalUserId: string;
  /** The channel the command was typed in; the echo guard compares against it. */
  channelId: string;
  /** Provider tenant id: Discord guild id. */
  tenantId: string;
  /** Discord "Manage Server" (or Administrator) held by the caller in this guild. Required for `link`. */
  canManageServer: boolean;
}

/** Whether the command's reply may be seen by the channel. Errors and lists are always private. */
export type ChatVisibility = 'public' | 'private';

export interface ChatTaskRef {
  id: string;
  key: string;
  title: string;
  url?: string;
}

export interface ChatResult {
  visibility: ChatVisibility;
  text: string;
  /** Present when the reply is about one task: the renderer adds Open / Assign to me / Set due. */
  task?: ChatTaskRef;
  /** Compact lines for `list`. */
  lines?: string[];
}

/** An outcome the person should read as-is ("no such task", "not allowed"). Never carries internals. */
export class ChatUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatUserError';
  }
}

export const CHAT_QUEUE_JOB = 'chat.command' as const;

export interface ChatCommandPayload {
  provider: IntegrationProvider;
  /** Discord: application id + interaction token (follow-up webhook valid 15 min). Slack: team id + `response_url` ('' when there is none). */
  applicationId: string;
  interactionToken: string;
  /**
   * Slack modal submissions carry no response_url, so the result is POSTED instead: `channelId` (+ `threadTs` to reply in
   * the thread) with `userId` for private (ephemeral) results. Absent for Discord and for Slack commands/buttons.
   */
  reply?: { channelId?: string; threadTs?: string; userId?: string };
  actor: ChatActor;
  intent: ChatIntent;
  /** What the deferred ack promised; the follow-up cannot change it. */
  visibility: ChatVisibility;
}

/** What a task looks like when shown away from the board (Slack link unfurl). Only built for a viewer who may see the task. */
export interface ChatTaskCard {
  key: string;
  title: string;
  url?: string;
  status: string;
  priority: string;
  due?: string;
  assignees: string[];
  project?: string;
}
