import { ChatResult, ChatTaskCard, ChatTaskRef } from '../chat.types';
import { RichMessage } from '../../core/integration.types';

// ---- payload shapes (only what we read)

export interface SlackCommandPayload { team_id?: string; user_id?: string; channel_id?: string; command?: string; text?: string; response_url?: string; trigger_id?: string }
export interface SlackInteractionPayload {
  type?: string;
  callback_id?: string;
  trigger_id?: string;
  response_url?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; text?: string; user?: string; bot_id?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
}
export interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: { type?: string; user?: string; channel?: string; message_ts?: string; links?: Array<{ url?: string; domain?: string }>; tokens?: { oauth?: unknown; bot?: unknown } };
}

export const SLACK_ID = /^[UW][A-Z0-9]{2,20}$/;
export const SLACK_TEAM = /^[TE][A-Z0-9]{2,20}$/;
export const SLACK_CHANNEL = /^[CGD][A-Z0-9]{2,20}$/;
export const SLACK_TS = /^\d{10}\.\d{6}$/;
/** response_url is attacker-influenced input that we will POST to: only Slack's own hosts, only the two documented path prefixes (SSRF guard). */
export const SLACK_RESPONSE_URL = /^https:\/\/hooks\.slack\.com\/(commands|actions)\/[A-Za-z0-9/_-]{1,200}$/;

// ---- text safety

/** Slack treats & < > as markup (`<!channel>`, `<@U1>`, `<http://x|y>`): user text must be escaped or it can ping everyone / forge links. */
export const escapeSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Our own replies use `**bold**` (Discord style); Slack's is `*bold*`. Escape FIRST, then convert, so user text can never inject markup. */
export const toMrkdwn = (s: string): string => escapeSlack(s).replace(/\*\*(.+?)\*\*/g, '*$1*');

/** A Slack message's text -> plain text for prefilling an input (mentions and links unwrapped, entities decoded). */
export function slackTextToPlain(text: string): string {
  return text
    .replace(/<!(?:channel|here|everyone)(?:\|[^>]*)?>/g, (m) => `@${m.slice(2).split(/[|>]/)[0]}`)
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, name) => `@${name || id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, name) => `#${name || id}`)
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---- Block Kit renderers

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } });

/** ChatResult -> a message body. `response_type` is decided HERE per post (Slack, unlike Discord, lets every reply choose). */
export function renderResult(r: ChatResult): { response_type: 'in_channel' | 'ephemeral'; text: string; blocks: unknown[] } {
  const body = toMrkdwn([r.text, ...(r.lines ?? [])].join('\n')).slice(0, 3000);
  const blocks: unknown[] = [section(body)];
  if (r.task) blocks.push(taskActions(r.task));
  return { response_type: r.visibility === 'public' ? 'in_channel' : 'ephemeral', text: body.slice(0, 300), blocks };
}

export function taskActions(task: ChatTaskRef): unknown {
  const els: unknown[] = [];
  if (task.url && /^https?:\/\//.test(task.url)) els.push({ type: 'button', text: { type: 'plain_text', text: 'Open' }, url: task.url, action_id: 'open' });
  els.push({ type: 'button', text: { type: 'plain_text', text: 'Assign to me' }, action_id: 'a', value: task.id });
  els.push({ type: 'button', text: { type: 'plain_text', text: 'Set due' }, action_id: 'd', value: task.id });
  return { type: 'actions', elements: els };
}

/** The identity prompt as an ephemeral message with a link button. */
export function renderLinkPrompt(reply: { text: string; actions: Array<{ label: string; url: string }> }) {
  const buttons = reply.actions.filter((a) => /^https?:\/\//.test(a.url)).slice(0, 5).map((a, i) => ({ type: 'button', text: { type: 'plain_text', text: a.label.slice(0, 75) }, url: a.url, action_id: `link${i}` }));
  return { response_type: 'ephemeral' as const, text: reply.text.slice(0, 300), blocks: [section(toMrkdwn(reply.text)), ...(buttons.length ? [{ type: 'actions', elements: buttons }] : [])] };
}

const TONE_COLOR: Record<RichMessage['tone'], string> = { info: '#5865F2', success: '#2EB67D', warning: '#ECB22E', danger: '#E01E5A' };

/** RichMessage -> chat.postMessage body (colour bar via an attachment, nothing unfurled, nothing pinged). */
export function toSlackMessage(m: RichMessage): Record<string, unknown> {
  const link = m.url && /^https?:\/\/[^|<>\s]+$/.test(m.url) ? `<${m.url}|${escapeSlack(m.title).replace(/\|/g, '\u2223')}>` : escapeSlack(m.title);
  const blocks: unknown[] = [section(`*${link}*\n${escapeSlack(m.summary)}`)];
  if (m.fields.length) blocks.push({ type: 'section', fields: m.fields.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: `*${escapeSlack(f.label).slice(0, 100)}*\n${escapeSlack(f.value).slice(0, 500) || '\u200b'}` })) });
  if (m.actor) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlack(m.actor).slice(0, 300) }] });
  return { text: escapeSlack(`${m.title}: ${m.summary}`).slice(0, 300), attachments: [{ color: TONE_COLOR[m.tone], blocks }], unfurl_links: false, unfurl_media: false };
}

/** A link-unfurl card for one task. */
export function unfurlCard(c: ChatTaskCard): unknown {
  const fields = [
    { type: 'mrkdwn', text: `*Status*\n${escapeSlack(String(c.status ?? ''))}` },
    { type: 'mrkdwn', text: `*Priority*\n${escapeSlack(String(c.priority ?? ''))}` },
    ...(c.due ? [{ type: 'mrkdwn', text: `*Due*\n${c.due}` }] : []),
    ...(c.assignees.length ? [{ type: 'mrkdwn', text: `*Assignees*\n${escapeSlack(c.assignees.join(', ')).slice(0, 300)}` }] : []),
  ];
  return { blocks: [section(`*${escapeSlack(c.key)}* ${escapeSlack(c.title)}${c.project ? `\n_${escapeSlack(c.project)}_` : ''}`), { type: 'section', fields }] };
}

// ---- modals (views.open)

const input = (blockId: string, actionId: string, label: string, o: { initial?: string; multiline?: boolean; optional?: boolean; max?: number; placeholder?: string } = {}) => ({
  type: 'input', block_id: blockId, optional: o.optional ?? false,
  label: { type: 'plain_text', text: label.slice(0, 2000) },
  element: { type: 'plain_text_input', action_id: actionId, multiline: o.multiline ?? false, max_length: o.max ?? 200, ...(o.initial ? { initial_value: o.initial.slice(0, o.max ?? 200) } : {}), ...(o.placeholder ? { placeholder: { type: 'plain_text', text: o.placeholder } } : {}) },
});

export function messageTaskView(o: { titleValue: string; descriptionValue: string; metadata: string }) {
  return {
    type: 'modal', callback_id: 'mt', private_metadata: o.metadata,
    title: { type: 'plain_text', text: 'Create task' }, submit: { type: 'plain_text', text: 'Create' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      input('title_b', 'title', 'Title', { initial: o.titleValue }),
      input('desc_b', 'desc', 'Description', { initial: o.descriptionValue, multiline: true, optional: true, max: 3000 }),
      input('project_b', 'project', 'Project (default: this channel\u2019s)', { optional: true, max: 100 }),
    ],
  };
}

export function dueView(o: { taskId: string; metadata: string }) {
  return {
    type: 'modal', callback_id: `d:${o.taskId}`, private_metadata: o.metadata,
    title: { type: 'plain_text', text: 'Set due date' }, submit: { type: 'plain_text', text: 'Save' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [input('date_b', 'date', 'Due date (YYYY-MM-DD)', { max: 10, placeholder: '2026-12-31' })],
  };
}

export const viewValue = (p: SlackInteractionPayload, block: string, action: string): string =>
  p.view?.state?.values?.[block]?.[action]?.value ?? '';
