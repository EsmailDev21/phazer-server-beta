import { Priority, TaskStatus } from '@prisma/client';
import { ChatIntent, ChatUserError, ChatVisibility } from '../chat.types';
import { parseDue } from '../discord-command.parser';
import {
  SLACK_CHANNEL, SLACK_ID, SLACK_TS, SlackInteractionPayload, dueView, messageTaskView, slackTextToPlain, viewValue,
} from './slack.protocol';

export const HELP_TEXT = [
  '*/task* commands:',
  '`/task create Fix the login [project:"Web app"] [due:2026-12-31] [priority:HIGH] [@person]`',
  '`/task update ENG-12 [status:DONE] [title:"New title"] [priority:LOW] [due:2026-12-31]`',
  '`/task assign ENG-12 @person`',
  '`/task list [project:"Web app"] [mine]`',
  '`/task link workspace:ENG [project:"Web app"]` (workspace admins)',
].join('\n');

export type ParsedSlack =
  | { kind: 'intent'; intent: ChatIntent; visibility: ChatVisibility; reply?: { channelId?: string; threadTs?: string; userId?: string } }
  | { kind: 'open_view'; view: unknown }
  | { kind: 'view_errors'; errors: Record<string, string> };

/** Words, honouring "double quotes" (and smart quotes) so `project:"My project"` stays one token. */
export function tokenize(text: string): string[] {
  const out = text.match(/(?:[^\s"\u201c\u201d]+|["\u201c][^"\u201c\u201d]*["\u201d])+/g) ?? [];
  return out.map((t) => t.replace(/["\u201c\u201d]/g, ''));
}

const MENTION = /^<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>$/;
const KV = /^(project|due|priority|assignee|status|title|workspace|mine|user):(.*)$/i;

const enumValue = <T extends string>(raw: string | undefined, allowed: readonly T[], what: string): T | undefined => {
  if (!raw) return undefined;
  const v = raw.toUpperCase().replace(/[ -]/g, '_');
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new ChatUserError(`Unknown ${what}.`);
};
const mentionId = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const m = MENTION.exec(raw.trim());
  const id = m ? m[1] : raw.trim();
  if (!SLACK_ID.test(id)) throw new ChatUserError('Mention the person with @, for example @alex.');
  return id;
};

/**
 * `/task ...` text -> ChatIntent. Slack sends one free-text string, so the grammar is: subcommand, then words and `key:value`
 * pairs (quote values with spaces). Mentions must arrive as `<@U123>`, which needs "Escape channels, users, and links" enabled
 * on the slash command (the app manifest sets it). Pure; throws ChatUserError carrying the help text for anything unclear.
 */
export function parseSlackText(text: string): { intent: ChatIntent; visibility: ChatVisibility } {
  const tokens = tokenize(text ?? '');
  const sub = (tokens.shift() ?? 'help').toLowerCase();
  const kv = new Map<string, string>();
  const free: string[] = [];
  const mentions: string[] = [];
  for (const t of tokens) {
    const k = KV.exec(t);
    if (k) kv.set(k[1].toLowerCase(), k[2]);
    else if (MENTION.test(t)) mentions.push(t);
    else free.push(t);
  }
  const due = kv.get('due') ? parseDue(kv.get('due')!) : undefined;
  const priority = enumValue(kv.get('priority'), Object.values(Priority), 'priority');

  switch (sub) {
    case 'create': {
      const title = (kv.get('title') ?? free.join(' ')).trim();
      if (!title) throw new ChatUserError(`A task needs a title.\n${HELP_TEXT}`);
      return { visibility: 'public', intent: { kind: 'create', title: title.slice(0, 200), projectName: kv.get('project')?.trim() || undefined, assigneeExternalId: mentionId(kv.get('assignee') ?? mentions[0]), due, priority } };
    }
    case 'update': {
      const key = free[0];
      if (!key) throw new ChatUserError(`Which task? Give its key, for example ENG-12.\n${HELP_TEXT}`);
      const title = kv.get('title')?.trim();
      const status = enumValue(kv.get('status'), Object.values(TaskStatus), 'status');
      if (!title && !status && !priority && !due) throw new ChatUserError('Nothing to change: give title:, status:, priority: or due:.');
      return { visibility: 'private', intent: { kind: 'update', key, title: title?.slice(0, 200), status, priority, due } };
    }
    case 'assign': {
      const key = free[0];
      const user = mentionId(kv.get('user') ?? mentions[0]);
      if (!key || !user) throw new ChatUserError('Give a task key and a person: `/task assign ENG-12 @alex`.');
      return { visibility: 'private', intent: { kind: 'assign', key, assigneeExternalId: user } };
    }
    case 'list':
      return { visibility: 'private', intent: { kind: 'list', projectName: kv.get('project')?.trim() || undefined, mine: free.some((f) => f.toLowerCase() === 'mine') || kv.get('mine') === 'true' } };
    case 'link':
      return { visibility: 'private', intent: { kind: 'link', workspaceKey: kv.get('workspace')?.trim().toUpperCase() || undefined, projectName: kv.get('project')?.trim() || undefined } };
    default:
      throw new ChatUserError(HELP_TEXT);
  }
}

/** Interactivity payload -> what to do. Pure; the service performs views.open / enqueue. */
export function parseSlackInteraction(p: SlackInteractionPayload): ParsedSlack | { kind: 'ignore' } {
  const team = p.team?.id ?? '';
  if (p.type === 'message_action') {
    if (p.callback_id !== 'create_task') throw new ChatUserError('Unknown shortcut.');
    const channel = p.channel?.id ?? '';
    const ts = p.message?.ts ?? '';
    if (!SLACK_CHANNEL.test(channel) || !SLACK_TS.test(ts)) throw new ChatUserError('Could not read that message.');
    const text = slackTextToPlain(p.message?.text ?? '').trim();
    // A thread root (thread_ts == ts) is a THREAD, any other message a MESSAGE.
    const kind = p.message?.thread_ts && p.message.thread_ts === ts ? 'T' : 'M';
    const meta = JSON.stringify({ c: channel, ts, k: kind });
    return { kind: 'open_view', view: messageTaskView({ titleValue: (text.split('\n')[0] ?? '').slice(0, 200), descriptionValue: text, metadata: meta }) };
  }

  if (p.type === 'block_actions') {
    const a = p.actions?.[0];
    const taskId = a?.value ?? '';
    if (a?.action_id === 'open') return { kind: 'ignore' }; // URL button: Slack still sends an event; nothing to do
    if (!/^[a-z0-9]{10,40}$/.test(taskId)) throw new ChatUserError('This button is no longer valid.');
    if (a?.action_id === 'a') return { kind: 'intent', visibility: 'private', intent: { kind: 'assign_me', taskId } };
    if (a?.action_id === 'd') return { kind: 'open_view', view: dueView({ taskId, metadata: JSON.stringify({ c: p.channel?.id ?? '' }) }) };
    throw new ChatUserError('This button is no longer valid.');
  }

  if (p.type === 'view_submission') {
    const cb = p.view?.callback_id ?? '';
    let meta: { c?: string; ts?: string; k?: string } = {};
    try { meta = JSON.parse(p.view?.private_metadata ?? '{}'); } catch { throw new ChatUserError('This form is no longer valid.'); }
    const userId = p.user?.id ?? '';

    if (cb.startsWith('d:')) {
      const taskId = cb.slice(2);
      if (!/^[a-z0-9]{10,40}$/.test(taskId)) throw new ChatUserError('This form is no longer valid.');
      let dueValue: string;
      try { dueValue = parseDue(viewValue(p, 'date_b', 'date')); } catch (e) { return { kind: 'view_errors', errors: { date_b: (e as Error).message } }; }
      return { kind: 'intent', visibility: 'private', intent: { kind: 'set_due', taskId, due: dueValue }, reply: { channelId: SLACK_CHANNEL.test(meta.c ?? '') ? meta.c : undefined, userId } };
    }
    if (cb === 'mt') {
      const channel = meta.c ?? ''; const ts = meta.ts ?? '';
      if (!SLACK_CHANNEL.test(channel) || !SLACK_TS.test(ts) || (meta.k !== 'M' && meta.k !== 'T')) throw new ChatUserError('This form is no longer valid.');
      const title = viewValue(p, 'title_b', 'title').trim();
      if (!title) return { kind: 'view_errors', errors: { title_b: 'A task needs a title.' } };
      const url = `https://slack.com/app_redirect?team=${encodeURIComponent(team)}&channel=${channel}&message_ts=${ts}`;
      return {
        kind: 'intent', visibility: 'public',
        intent: {
          kind: 'create_from_message', title: title.slice(0, 200),
          description: viewValue(p, 'desc_b', 'desc').trim().slice(0, 4000) || undefined,
          projectName: viewValue(p, 'project_b', 'project').trim() || undefined,
          source: { kind: meta.k === 'T' ? 'THREAD' : 'MESSAGE', externalId: `${channel}/${ts}`, url },
        },
        // posted as a reply in the message's thread, visible to the channel
        reply: { channelId: channel, threadTs: ts, userId },
      };
    }
  }
  return { kind: 'ignore' };
}
