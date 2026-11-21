import { Priority, TaskStatus } from '@prisma/client';
import { ChatResult, ChatTaskRef } from './chat.types';

/** Interaction request types (Discord docs). */
export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;
/** Interaction callback types. */
export const CallbackType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, AUTOCOMPLETE_RESULT: 8, MODAL: 9 } as const;
export const EPHEMERAL = 64;
export const MANAGE_GUILD = 0x20n;
export const ADMINISTRATOR = 0x8n;

export interface DiscordUser { id: string; username?: string; global_name?: string | null; bot?: boolean }
export interface DiscordOption { name: string; type: number; value?: string | number | boolean; options?: DiscordOption[] }
export interface DiscordMessage { id: string; content?: string; author?: DiscordUser; channel_id?: string }
export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string; type?: number; parent_id?: string };
  member?: { user: DiscordUser; permissions?: string };
  user?: DiscordUser;
  data?: {
    id?: string;
    name?: string;
    type?: number;
    custom_id?: string;
    target_id?: string;
    options?: DiscordOption[];
    resolved?: { users?: Record<string, DiscordUser>; messages?: Record<string, DiscordMessage> };
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
  };
}

/** Does the caller hold Manage Server (or Administrator) in this guild? `permissions` is a decimal string bitfield. */
export function canManageGuild(permissions: string | undefined): boolean {
  try {
    const p = BigInt(permissions ?? '0');
    return (p & MANAGE_GUILD) !== 0n || (p & ADMINISTRATOR) !== 0n;
  } catch {
    return false;
  }
}

// ---- command registration payload (PUT /applications/{app}/guilds/{guild}/commands)

const choice = (values: string[]) => values.map((v) => ({ name: v.toLowerCase().replace('_', ' '), value: v }));
const str = (name: string, description: string, extra: Record<string, unknown> = {}) => ({ type: 3, name, description, ...extra });

export const DISCORD_COMMANDS = [
  {
    name: 'task',
    type: 1,
    description: 'Create, update, assign and list tasks',
    dm_permission: false,
    options: [
      { type: 1, name: 'create', description: 'Create a task', options: [
        str('title', 'What needs doing', { required: true, max_length: 200 }),
        str('project', 'Project name (default: this channel\u2019s project)', { max_length: 100 }),
        { type: 6, name: 'assignee', description: 'Who should do it' },
        str('due', 'Due date, YYYY-MM-DD', { max_length: 10 }),
        str('priority', 'Priority', { choices: choice(Object.values(Priority)) }),
      ] },
      { type: 1, name: 'update', description: 'Change a task', options: [
        str('key', 'Task key, e.g. ENG-12', { required: true, max_length: 40 }),
        str('title', 'New title', { max_length: 200 }),
        str('status', 'New status', { choices: choice(Object.values(TaskStatus)) }),
        str('priority', 'New priority', { choices: choice(Object.values(Priority)) }),
        str('due', 'New due date, YYYY-MM-DD', { max_length: 10 }),
      ] },
      { type: 1, name: 'assign', description: 'Assign a task to someone', options: [
        str('key', 'Task key, e.g. ENG-12', { required: true, max_length: 40 }),
        { type: 6, name: 'user', description: 'Who', required: true },
      ] },
      { type: 1, name: 'list', description: 'List tasks', options: [
        str('project', 'Project name (default: this channel\u2019s project)', { max_length: 100 }),
        { type: 5, name: 'mine', description: 'Only tasks assigned to me' },
      ] },
      { type: 1, name: 'link', description: 'Link this server to a workspace and this channel to a project (needs Manage Server)', options: [
        str('workspace', 'Workspace key, e.g. ENG', { max_length: 20 }),
        str('project', 'Project name for THIS channel', { max_length: 100 }),
      ] },
    ],
  },
  { name: 'Create task from message', type: 3, dm_permission: false },
] as const;

export const MESSAGE_COMMAND_NAME = 'Create task from message';

// ---- response builders

export interface DiscordCallback { type: number; data?: Record<string, unknown> }

export const pong = (): DiscordCallback => ({ type: CallbackType.PONG });
export const deferred = (ephemeral: boolean): DiscordCallback => ({
  type: CallbackType.DEFERRED_MESSAGE,
  data: ephemeral ? { flags: EPHEMERAL } : {},
});
export const ephemeralMessage = (content: string, components?: unknown[]): DiscordCallback => ({
  type: CallbackType.MESSAGE,
  data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) },
});

/** A modal with short text inputs. `custom_id` carries the state we need back (<= 100 chars). */
export function modal(customId: string, title: string, inputs: Array<{ id: string; label: string; value?: string; required?: boolean; paragraph?: boolean; maxLength?: number; placeholder?: string }>): DiscordCallback {
  return {
    type: CallbackType.MODAL,
    data: {
      custom_id: customId,
      title: title.slice(0, 45),
      components: inputs.map((i) => ({
        type: 1,
        components: [{
          type: 4, custom_id: i.id, label: i.label.slice(0, 45), style: i.paragraph ? 2 : 1,
          required: i.required ?? false, max_length: i.maxLength ?? (i.paragraph ? 1500 : 200),
          ...(i.value ? { value: i.value.slice(0, i.maxLength ?? (i.paragraph ? 1500 : 200)) } : {}),
          ...(i.placeholder ? { placeholder: i.placeholder } : {}),
        }],
      })),
    },
  };
}

/** Buttons under a task reply: Open (link), Assign to me, Set due. custom_id: `a:<taskId>` / `d:<taskId>`. */
export function taskButtons(task: ChatTaskRef): unknown[] {
  const row: unknown[] = [];
  if (task.url) row.push({ type: 2, style: 5, label: 'Open', url: task.url });
  row.push({ type: 2, style: 1, label: 'Assign to me', custom_id: `a:${task.id}` });
  row.push({ type: 2, style: 2, label: 'Set due', custom_id: `d:${task.id}` });
  return [{ type: 1, components: row }];
}

/** ChatResult -> the body of a message edit/follow-up. Mentions are always disabled: user text must never ping @everyone. */
export function renderResult(r: ChatResult): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: [r.text, ...(r.lines ?? [])].join('\n').slice(0, 1900),
    allowed_mentions: { parse: [] },
  };
  if (r.task) body.components = taskButtons(r.task);
  return body;
}

/** The identity prompt (ChatReply) as an ephemeral message with a link button. */
export function renderLinkPrompt(reply: { text: string; actions: Array<{ label: string; url: string }> }): DiscordCallback {
  const buttons = reply.actions.slice(0, 5).map((a) => ({ type: 2, style: 5, label: a.label.slice(0, 80), url: a.url }));
  return ephemeralMessage(reply.text.slice(0, 1900), buttons.length ? [{ type: 1, components: buttons }] : undefined);
}
