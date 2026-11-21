import { Priority, TaskStatus } from '@prisma/client';
import { ChatIntent, ChatUserError, ChatVisibility } from './chat.types';
import {
  DiscordCallback,
  DiscordInteraction,
  DiscordOption,
  InteractionType,
  MESSAGE_COMMAND_NAME,
  modal,
} from './discord.protocol';

export type ParsedInteraction =
  | { kind: 'intent'; intent: ChatIntent; visibility: ChatVisibility }
  /** The command needs more input first: answer with this modal; its submit comes back as a MODAL_SUBMIT. */
  | { kind: 'modal'; response: DiscordCallback };

const SNOWFLAKE = /^\d{5,25}$/;
const CUID = /^[a-z0-9]{10,40}$/;
const THREAD_TYPES = new Set([10, 11, 12]);

export function parseDue(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new ChatUserError('Please give the date as YYYY-MM-DD, for example 2026-12-31.');
  }
  return m[0];
}

const enumValue = <T extends string>(raw: unknown, allowed: readonly T[], what: string): T | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ChatUserError(`Unknown ${what}.`);
};

const opts = (o: DiscordOption[] | undefined) => {
  const m = new Map<string, string | number | boolean>();
  for (const x of o ?? []) if (x.value !== undefined) m.set(x.name, x.value);
  return m;
};
const text = (m: Map<string, unknown>, k: string): string | undefined => {
  const v = m.get(k);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/**
 * Discord payload -> ChatIntent (or a modal to show first). Pure; throws ChatUserError for anything the person
 * should read. Every id that will be used in a query or a URL is shape-checked here, so nothing odd reaches the executor.
 */
export function parseInteraction(i: DiscordInteraction): ParsedInteraction {
  const data = i.data;
  if (!data) throw new ChatUserError('Unsupported interaction.');

  if (i.type === InteractionType.APPLICATION_COMMAND) {
    if (data.type === 3 || data.name === MESSAGE_COMMAND_NAME) return parseMessageCommand(i);
    if (data.name !== 'task') throw new ChatUserError('Unknown command.');
    const sub = data.options?.[0];
    if (!sub) throw new ChatUserError('Choose a subcommand: create, update, assign, list or link.');
    const o = opts(sub.options);
    switch (sub.name) {
      case 'create': {
        const title = text(o, 'title');
        if (!title) throw new ChatUserError('A task needs a title.');
        const assignee = text(o, 'assignee');
        if (assignee && !SNOWFLAKE.test(assignee)) throw new ChatUserError('Unknown user.');
        const due = text(o, 'due');
        return {
          kind: 'intent', visibility: 'public',
          intent: { kind: 'create', title: title.slice(0, 200), projectName: text(o, 'project'), assigneeExternalId: assignee, due: due ? parseDue(due) : undefined, priority: enumValue(o.get('priority'), Object.values(Priority), 'priority') },
        };
      }
      case 'update': {
        const key = text(o, 'key');
        if (!key) throw new ChatUserError('Which task? Give its key, for example ENG-12.');
        const due = text(o, 'due');
        const title = text(o, 'title');
        const intent = { kind: 'update' as const, key, title: title?.slice(0, 200), status: enumValue(o.get('status'), Object.values(TaskStatus), 'status'), priority: enumValue(o.get('priority'), Object.values(Priority), 'priority'), due: due ? parseDue(due) : undefined };
        if (!intent.title && !intent.status && !intent.priority && !intent.due) throw new ChatUserError('Nothing to change: give a title, status, priority or due date.');
        return { kind: 'intent', visibility: 'private', intent };
      }
      case 'assign': {
        const key = text(o, 'key');
        const user = text(o, 'user');
        if (!key || !user || !SNOWFLAKE.test(user)) throw new ChatUserError('Give a task key and a user.');
        return { kind: 'intent', visibility: 'private', intent: { kind: 'assign', key, assigneeExternalId: user } };
      }
      case 'list':
        return { kind: 'intent', visibility: 'private', intent: { kind: 'list', projectName: text(o, 'project'), mine: o.get('mine') === true } };
      case 'link':
        return { kind: 'intent', visibility: 'private', intent: { kind: 'link', workspaceKey: text(o, 'workspace')?.toUpperCase(), projectName: text(o, 'project') } };
      default:
        throw new ChatUserError('Unknown subcommand.');
    }
  }

  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const [verb, id] = (data.custom_id ?? '').split(':');
    if (!id || !CUID.test(id)) throw new ChatUserError('This button is no longer valid.');
    if (verb === 'a') return { kind: 'intent', visibility: 'private', intent: { kind: 'assign_me', taskId: id } };
    if (verb === 'd') return { kind: 'modal', response: modal(`d:${id}`, 'Set due date', [{ id: 'date', label: 'Due date (YYYY-MM-DD)', required: true, maxLength: 10, placeholder: '2026-12-31' }]) };
    throw new ChatUserError('This button is no longer valid.');
  }

  if (i.type === InteractionType.MODAL_SUBMIT) {
    const fields = new Map<string, string>();
    for (const row of data.components ?? []) for (const c of row.components ?? []) if (c.custom_id) fields.set(c.custom_id, c.value ?? '');
    const parts = (data.custom_id ?? '').split(':');
    if (parts[0] === 'd' && parts[1] && CUID.test(parts[1])) {
      return { kind: 'intent', visibility: 'private', intent: { kind: 'set_due', taskId: parts[1], due: parseDue(fields.get('date') ?? '') } };
    }
    if (parts[0] === 'mt') {
      const [, k, channelId, messageId] = parts;
      if ((k !== 'M' && k !== 'T') || !SNOWFLAKE.test(channelId ?? '') || (k === 'M' && !SNOWFLAKE.test(messageId ?? ''))) throw new ChatUserError('This form is no longer valid.');
      if (!i.guild_id || !SNOWFLAKE.test(i.guild_id)) throw new ChatUserError('Use this inside a server.');
      const title = (fields.get('title') ?? '').trim();
      if (!title) throw new ChatUserError('A task needs a title.');
      const url = k === 'M' ? `https://discord.com/channels/${i.guild_id}/${channelId}/${messageId}` : `https://discord.com/channels/${i.guild_id}/${channelId}`;
      return {
        kind: 'intent', visibility: 'public',
        intent: {
          kind: 'create_from_message', title: title.slice(0, 200),
          description: (fields.get('description') ?? '').trim().slice(0, 4000) || undefined,
          projectName: (fields.get('project') ?? '').trim() || undefined,
          source: { kind: k === 'T' ? 'THREAD' : 'MESSAGE', externalId: k === 'T' ? channelId : `${channelId}/${messageId}`, url },
        },
      };
    }
  }
  throw new ChatUserError('Unsupported interaction.');
}

function parseMessageCommand(i: DiscordInteraction): ParsedInteraction {
  const targetId = i.data?.target_id;
  const msg = targetId ? i.data?.resolved?.messages?.[targetId] : undefined;
  const channelId = i.channel_id ?? i.channel?.id;
  if (!targetId || !SNOWFLAKE.test(targetId) || !msg || !channelId || !SNOWFLAKE.test(channelId)) throw new ChatUserError('Could not read that message.');
  // A forum post / thread starter: the starter message's id IS the thread's channel id (ADR-0012 d.6).
  const isThreadStarter = THREAD_TYPES.has(i.channel?.type ?? -1) && targetId === channelId;
  const content = (msg.content ?? '').trim();
  const firstLine = content.split('\n')[0] ?? '';
  return {
    kind: 'modal',
    response: modal(`mt:${isThreadStarter ? 'T' : 'M'}:${channelId}:${targetId}`, 'Create task from message', [
      { id: 'title', label: 'Title', value: firstLine.slice(0, 200), required: true, maxLength: 200 },
      { id: 'description', label: 'Description', value: content, paragraph: true, maxLength: 1500 },
      { id: 'project', label: 'Project (optional, default: this channel\u2019s)', maxLength: 100 },
    ]),
  };
}
