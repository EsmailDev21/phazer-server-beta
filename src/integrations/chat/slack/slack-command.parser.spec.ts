import { ChatUserError } from '../chat.types';
import { HELP_TEXT, parseSlackInteraction, parseSlackText, tokenize } from './slack-command.parser';
import { SLACK_RESPONSE_URL, escapeSlack, renderLinkPrompt, renderResult, slackTextToPlain, toMrkdwn, toSlackMessage, unfurlCard } from './slack.protocol';

describe('tokenize', () => {
  it('splits on spaces, keeps quoted values (straight and smart quotes) whole, drops the quotes', () => {
    expect(tokenize('create Fix login project:"My Web App" due:2026-12-31')).toEqual(['create', 'Fix', 'login', 'project:My Web App', 'due:2026-12-31']);
    expect(tokenize('create \u201cquoted title\u201d')).toEqual(['create', 'quoted title']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('/task text grammar', () => {
  const ok = (t: string) => parseSlackText(t);
  it('create: free words are the title; key:value pairs and a mention fill the rest; public', () => {
    const r = ok('create Fix the login page project:"Web app" priority:high due:2026-12-31 <@U0ALEX01|alex>');
    expect(r.visibility).toBe('public');
    expect(r.intent).toEqual({ kind: 'create', title: 'Fix the login page', projectName: 'Web app', assigneeExternalId: 'U0ALEX01', due: '2026-12-31', priority: 'HIGH' });
    expect(ok('create title:"Explicit title" extra words').intent).toMatchObject({ title: 'Explicit title' });
    expect(ok('create x assignee:<@W0ENTERP1>').intent).toMatchObject({ assigneeExternalId: 'W0ENTERP1' });
  });

  it('create refuses an empty title, a bad priority, a bad date, a non-mention assignee', () => {
    expect(() => ok('create')).toThrow(/title/);
    expect(() => ok('create x priority:EXTREME')).toThrow(/priority/);
    expect(() => ok('create x due:tomorrow')).toThrow(/YYYY-MM-DD/);
    expect(() => ok('create x assignee:alex')).toThrow(/@/);
  });

  it('update / assign / list / link', () => {
    expect(ok('update ENG-12 status:in-progress title:"New one"')).toEqual({ visibility: 'private', intent: { kind: 'update', key: 'ENG-12', title: 'New one', status: 'IN_PROGRESS', priority: undefined, due: undefined } });
    expect(() => ok('update ENG-12')).toThrow(/Nothing to change/);
    expect(() => ok('update status:DONE')).toThrow(/Which task/);
    expect(ok('assign ENG-1 <@U0ALEX01>').intent).toEqual({ kind: 'assign', key: 'ENG-1', assigneeExternalId: 'U0ALEX01' });
    expect(() => ok('assign ENG-1')).toThrow(/person/);
    expect(ok('list mine project:Web').intent).toEqual({ kind: 'list', projectName: 'Web', mine: true });
    expect(ok('list').intent).toEqual({ kind: 'list', projectName: undefined, mine: false });
    expect(ok('link workspace:eng project:"Web app"').intent).toEqual({ kind: 'link', workspaceKey: 'ENG', projectName: 'Web app' });
  });

  it('help, empty and unknown subcommands all answer with the help text', () => {
    for (const t of ['help', '', '   ', 'frobnicate']) expect(() => ok(t)).toThrow(HELP_TEXT);
    expect(() => ok('help')).toThrow(ChatUserError);
  });

  it('a title containing Slack markup is carried verbatim (escaping happens on OUTPUT)', () => {
    expect(ok('create <!channel> look <https://evil.test|click>').intent).toMatchObject({ title: '<!channel> look <https://evil.test|click>' });
  });
});

describe('interactivity parsing', () => {
  const msgAction = (over: Record<string, unknown> = {}) => ({ type: 'message_action', callback_id: 'create_task', team: { id: 'T0TEAM01' }, user: { id: 'U0ALEX01' }, channel: { id: 'C0CHAN001' }, message: { ts: '1700000000.000100', text: 'Login is broken\nsteps: <@U0BOB0001> says &amp; so on' }, ...over });

  it('message shortcut -> a prefilled modal (title = first line, plain text), state in private_metadata', () => {
    const r = parseSlackInteraction(msgAction() as never);
    if (r.kind !== 'open_view') throw new Error();
    const v = r.view as { callback_id: string; private_metadata: string; blocks: Array<{ element: { initial_value?: string } }> };
    expect(v.callback_id).toBe('mt');
    expect(JSON.parse(v.private_metadata)).toEqual({ c: 'C0CHAN001', ts: '1700000000.000100', k: 'M' });
    expect(v.blocks[0].element.initial_value).toBe('Login is broken');
    expect(v.blocks[1].element.initial_value).toContain('@U0BOB0001 says & so on');
  });

  it('a thread root is a THREAD; unknown shortcut and unreadable message are refused', () => {
    const t = parseSlackInteraction(msgAction({ message: { ts: '1700000000.000100', thread_ts: '1700000000.000100', text: 'x' } }) as never);
    expect(JSON.parse(((t as { view: { private_metadata: string } }).view).private_metadata).k).toBe('T');
    expect(() => parseSlackInteraction(msgAction({ callback_id: 'other' }) as never)).toThrow(/Unknown shortcut/);
    expect(() => parseSlackInteraction(msgAction({ message: { ts: '../x', text: '' } }) as never)).toThrow(/read that message/);
  });

  const taskId = 'ckabcdefghij1234';
  it('buttons: Assign to me runs, Set due opens a modal, Open is ignored, garbage refused', () => {
    const b = (a: Record<string, string>) => ({ type: 'block_actions', team: { id: 'T0TEAM01' }, user: { id: 'U0ALEX01' }, channel: { id: 'C0CHAN001' }, actions: [a] });
    expect(parseSlackInteraction(b({ action_id: 'a', value: taskId }) as never)).toEqual({ kind: 'intent', visibility: 'private', intent: { kind: 'assign_me', taskId } });
    const d = parseSlackInteraction(b({ action_id: 'd', value: taskId }) as never);
    expect(d.kind).toBe('open_view'); expect((d as { view: { callback_id: string } }).view.callback_id).toBe(`d:${taskId}`);
    expect(parseSlackInteraction(b({ action_id: 'open', value: '' }) as never)).toEqual({ kind: 'ignore' });
    expect(() => parseSlackInteraction(b({ action_id: 'a', value: '../etc' }) as never)).toThrow(/no longer valid/);
    expect(() => parseSlackInteraction(b({ action_id: 'zzz', value: taskId }) as never)).toThrow(/no longer valid/);
  });

  const submit = (cb: string, meta: unknown, values: Record<string, Record<string, { value: string }>>) =>
    ({ type: 'view_submission', team: { id: 'T0TEAM01' }, user: { id: 'U0ALEX01' }, view: { callback_id: cb, private_metadata: JSON.stringify(meta), state: { values } } }) as never;

  it('mt submit -> create_from_message (public, reply in the message thread, app_redirect link)', () => {
    const r = parseSlackInteraction(submit('mt', { c: 'C0CHAN001', ts: '1700000000.000100', k: 'M' }, { title_b: { title: { value: ' Fix login ' } }, desc_b: { desc: { value: 'steps' } }, project_b: { project: { value: '' } } }));
    expect(r).toEqual({
      kind: 'intent', visibility: 'public',
      intent: { kind: 'create_from_message', title: 'Fix login', description: 'steps', projectName: undefined, source: { kind: 'MESSAGE', externalId: 'C0CHAN001/1700000000.000100', url: 'https://slack.com/app_redirect?team=T0TEAM01&channel=C0CHAN001&message_ts=1700000000.000100' } },
      reply: { channelId: 'C0CHAN001', threadTs: '1700000000.000100', userId: 'U0ALEX01' },
    });
  });

  it('submit validation errors come back as modal field errors, not exceptions', () => {
    expect(parseSlackInteraction(submit('mt', { c: 'C0CHAN001', ts: '1700000000.000100', k: 'M' }, { title_b: { title: { value: '  ' } } }))).toEqual({ kind: 'view_errors', errors: { title_b: 'A task needs a title.' } });
    const bad = parseSlackInteraction(submit(`d:${taskId}`, { c: 'C0CHAN001' }, { date_b: { date: { value: '31/12/2026' } } }));
    expect(bad.kind).toBe('view_errors'); expect((bad as { errors: Record<string, string> }).errors.date_b).toMatch(/YYYY-MM-DD/);
  });

  it('due submit -> set_due, private, answered with an ephemeral post to the user', () => {
    expect(parseSlackInteraction(submit(`d:${taskId}`, { c: 'C0CHAN001' }, { date_b: { date: { value: '2026-12-31' } } }))).toEqual({ kind: 'intent', visibility: 'private', intent: { kind: 'set_due', taskId, due: '2026-12-31' }, reply: { channelId: 'C0CHAN001', userId: 'U0ALEX01' } });
  });

  it('forged metadata is refused: bad ids, bad kind, unparseable', () => {
    expect(() => parseSlackInteraction(submit('mt', { c: '../x', ts: '1700000000.000100', k: 'M' }, { title_b: { title: { value: 'a' } } }))).toThrow(/no longer valid/);
    expect(() => parseSlackInteraction(submit('mt', { c: 'C0CHAN001', ts: '1700000000.000100', k: 'Q' }, { title_b: { title: { value: 'a' } } }))).toThrow(/no longer valid/);
    expect(() => parseSlackInteraction({ type: 'view_submission', view: { callback_id: 'mt', private_metadata: '{not json' } } as never)).toThrow(/no longer valid/);
    expect(parseSlackInteraction({ type: 'view_closed' } as never)).toEqual({ kind: 'ignore' });
  });
});

describe('output safety', () => {
  it('escapeSlack neutralises the three markup characters', () => expect(escapeSlack('<!channel> & <@U1>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt;'));

  it('toMrkdwn escapes FIRST, then converts **bold**: user text cannot smuggle a mention or a link through our formatting', () => {
    expect(toMrkdwn('**KEY-1** created: <!channel> <https://evil.test|click> **x**')).toBe('*KEY-1* created: &lt;!channel&gt; &lt;https://evil.test|click&gt; *x*');
  });

  it('renderResult: public/private decides response_type; lines and the task buttons are included; capped', () => {
    const pub = renderResult({ visibility: 'public', text: '**K-1** created', task: { id: 'ckabcdefghij1234', key: 'K-1', title: 't', url: 'https://app.test/tasks/K-1' } });
    expect(pub.response_type).toBe('in_channel');
    const actions = pub.blocks[1] as { elements: Array<{ action_id: string }> };
    expect(actions.elements.map((e) => e.action_id)).toEqual(['open', 'a', 'd']);
    expect(renderResult({ visibility: 'private', text: 'x'.repeat(9999) }).blocks).toHaveLength(1);
    const big = renderResult({ visibility: 'private', text: 'x'.repeat(9999) });
    expect((big.blocks[0] as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(3000);
    expect(big.text.length).toBeLessThanOrEqual(300);
    const noUrl = renderResult({ visibility: 'public', text: 't', task: { id: 'ckabcdefghij1234', key: 'K', title: 't' } }).blocks[1] as { elements: unknown[] };
    expect(noUrl.elements).toHaveLength(2);
  });

  it('toSlackMessage: title/summary/fields escaped, link only for an http(s) URL without markup characters, colour bar, nothing unfurled', () => {
    const m = toSlackMessage({ title: 'K-1 <!here> Fix', url: 'https://app.test/tasks/K-1', summary: 'Status: A \u2192 B & <c>', fields: [{ label: 'Project', value: '<b>' }], actor: 'Ann <x>', tone: 'success' }) as { text: string; attachments: Array<{ color: string; blocks: Array<{ text?: { text: string } }> }>; unfurl_links: boolean };
    expect(m.unfurl_links).toBe(false);
    expect(m.attachments[0].color).toBe('#2EB67D');
    const text = JSON.stringify(m);
    expect(text).not.toContain('<!here>'); expect(text).toContain('&lt;!here&gt;'); expect(text).not.toContain('<c>');
    expect(m.attachments[0].blocks[0].text!.text).toContain('<https://app.test/tasks/K-1|');
    const evil = toSlackMessage({ title: 't', url: 'https://x.test/a|b>c', summary: 's', fields: [], tone: 'info' }) as { attachments: Array<{ blocks: Array<{ text: { text: string } }> }> };
    expect(evil.attachments[0].blocks[0].text.text).not.toContain('<https://x.test');
  });

  it('response_url is only ever one of Slack\u2019s own hosts (SSRF guard)', () => {
    expect(SLACK_RESPONSE_URL.test('https://hooks.slack.com/commands/T1/397/abcDEF')).toBe(true);
    expect(SLACK_RESPONSE_URL.test('https://hooks.slack.com/actions/T1/397/abc')).toBe(true);
    for (const bad of ['http://hooks.slack.com/commands/T1/1/a', 'https://hooks.slack.com.evil.test/commands/T1/1/a', 'https://evil.test/https://hooks.slack.com/commands/T1/1/a', 'https://hooks.slack.com/services/T1/B1/x', 'https://hooks.slack.com/commands/../../x', 'https://169.254.169.254/'])
      expect(SLACK_RESPONSE_URL.test(bad)).toBe(false);
  });

  it('slackTextToPlain unwraps mentions/links/entities; renderLinkPrompt only offers http(s) buttons; unfurl card escapes', () => {
    expect(slackTextToPlain('hi <@U1|bob> see <https://x.test|this> and <https://y.test> <!channel> &lt;3 <#C1|general>')).toBe('hi @bob see this and https://y.test @channel <3 #general');
    const p = renderLinkPrompt({ text: 'Link', actions: [{ label: 'Link my account', url: 'https://app.test/l?t=1' }, { label: 'bad', url: 'javascript:alert(1)' }] });
    expect((p.blocks[1] as { elements: unknown[] }).elements).toHaveLength(1);
    expect(JSON.stringify(unfurlCard({ key: 'K-1', title: '<!channel> boom', status: 'TODO', priority: 'HIGH', assignees: ['A <b>'], url: 'https://x.test' }))).not.toContain('<!channel>');
    expect(() => unfurlCard({ key: 'K-1', title: 't', status: null as never, priority: null as never, assignees: [] })).not.toThrow(); // a task with no priority must not break the card
  });
});
