import { ChatUserError } from './chat.types';
import { parseDue, parseInteraction } from './discord-command.parser';
import { DiscordInteraction, canManageGuild, renderResult, taskButtons } from './discord.protocol';

const base = { id: '900000000000000001', application_id: '111111111111111111', token: 't', guild_id: '222222222222222222', channel_id: '333333333333333333' };
const cmd = (sub: string, options: Array<{ name: string; type?: number; value: string | number | boolean }>): DiscordInteraction =>
  ({ ...base, type: 2, data: { name: 'task', type: 1, options: [{ name: sub, type: 1, options: options.map((o) => ({ type: 3, ...o })) }] } }) as never;
const intent = (i: DiscordInteraction) => { const p = parseInteraction(i); if (p.kind !== 'intent') throw new Error('expected intent'); return p; };

describe('parseDue', () => {
  it.each(['2026-12-31', '2024-02-29', '2000-01-01'])('accepts %s', (d) => expect(parseDue(d)).toBe(d));
  it.each(['2026-02-30', '2026-13-01', '2026-1-1', '31/12/2026', 'tomorrow', '', '2026-12-31T00:00'])('rejects %s', (d) => expect(() => parseDue(d)).toThrow(ChatUserError));
});

describe('/task subcommands', () => {
  it('create: public, trims and caps the title, validates enums and the assignee id', () => {
    const p = intent(cmd('create', [{ name: 'title', value: `  ${'x'.repeat(300)}  ` }, { name: 'priority', value: 'HIGH' }, { name: 'due', value: '2026-12-31' }, { name: 'assignee', value: '444444444444444444' }]));
    expect(p.visibility).toBe('public');
    expect(p.intent).toMatchObject({ kind: 'create', priority: 'HIGH', due: '2026-12-31', assigneeExternalId: '444444444444444444' });
    expect((p.intent as { title: string }).title).toHaveLength(200);
    expect(() => intent(cmd('create', [{ name: 'title', value: 'a' }, { name: 'priority', value: 'EXTREME' }]))).toThrow(/priority/);
    expect(() => intent(cmd('create', [{ name: 'title', value: 'a' }, { name: 'assignee', value: "1'; DROP" }]))).toThrow(/user/i);
    expect(() => intent(cmd('create', [{ name: 'title', value: '   ' }]))).toThrow(/title/);
    expect(() => intent(cmd('create', [{ name: 'title', value: 'a' }, { name: 'due', value: 'soon' }]))).toThrow(/YYYY-MM-DD/);
  });

  it('update: private, needs a key and at least one change', () => {
    expect(intent(cmd('update', [{ name: 'key', value: 'ENG-12' }, { name: 'status', value: 'DONE' }]))).toMatchObject({ visibility: 'private', intent: { kind: 'update', key: 'ENG-12', status: 'DONE' } });
    expect(() => intent(cmd('update', [{ name: 'key', value: 'ENG-12' }]))).toThrow(/Nothing to change/);
    expect(() => intent(cmd('update', [{ name: 'status', value: 'DONE' }]))).toThrow(/key/);
    expect(() => intent(cmd('update', [{ name: 'key', value: 'A-1' }, { name: 'status', value: 'INBOX' }]))).toThrow(/status/);
  });

  it('assign, list, link', () => {
    expect(intent(cmd('assign', [{ name: 'key', value: 'ENG-1' }, { name: 'user', value: '555555555555555555' }])).intent).toEqual({ kind: 'assign', key: 'ENG-1', assigneeExternalId: '555555555555555555' });
    expect(() => intent(cmd('assign', [{ name: 'key', value: 'ENG-1' }, { name: 'user', value: 'bob' }]))).toThrow();
    expect(intent({ ...cmd('list', []), data: { name: 'task', type: 1, options: [{ name: 'list', type: 1, options: [{ name: 'mine', type: 5, value: true }] }] } } as never).intent).toEqual({ kind: 'list', projectName: undefined, mine: true });
    expect(intent(cmd('link', [{ name: 'workspace', value: 'eng' }, { name: 'project', value: 'Web' }])).intent).toEqual({ kind: 'link', workspaceKey: 'ENG', projectName: 'Web' });
  });

  it('unknown command / subcommand / missing subcommand', () => {
    expect(() => parseInteraction({ ...base, type: 2, data: { name: 'other', type: 1 } } as never)).toThrow(/Unknown command/);
    expect(() => parseInteraction(cmd('frobnicate', []))).toThrow(/Unknown subcommand/);
    expect(() => parseInteraction({ ...base, type: 2, data: { name: 'task', type: 1, options: [] } } as never)).toThrow(/subcommand/);
    expect(() => parseInteraction({ ...base, type: 99, data: {} } as never)).toThrow(ChatUserError);
  });
});

describe('message context menu + modals', () => {
  const msgCmd = (over: Partial<DiscordInteraction> = {}, msgId = '666666666666666666', content = 'Login is broken\nsteps: ...'): DiscordInteraction =>
    ({ ...base, type: 2, data: { name: 'Create task from message', type: 3, target_id: msgId, resolved: { messages: { [msgId]: { id: msgId, content } } } }, ...over }) as never;

  it('opens a modal prefilled with the first line and the whole message; state is in custom_id', () => {
    const p = parseInteraction(msgCmd());
    if (p.kind !== 'modal') throw new Error();
    const d = p.response.data as { custom_id: string; components: Array<{ components: Array<{ custom_id: string; value?: string }> }> };
    expect(p.response.type).toBe(9);
    expect(d.custom_id).toBe('mt:M:333333333333333333:666666666666666666');
    const field = (id: string) => d.components.map((r) => r.components[0]).find((c) => c.custom_id === id)!;
    expect(field('title').value).toBe('Login is broken');
    expect(field('description').value).toContain('steps');
  });

  it('a forum post / thread starter (message id == thread id, channel type 11) is a THREAD, any other message is a MESSAGE', () => {
    const t = parseInteraction(msgCmd({ channel: { id: '333333333333333333', type: 11 } }, '333333333333333333'));
    expect((t as unknown as { response: { data: { custom_id: string } } }).response.data.custom_id).toBe('mt:T:333333333333333333:333333333333333333');
    const inThread = parseInteraction(msgCmd({ channel: { id: '333333333333333333', type: 11 } }, '777777777777777777'));
    expect((inThread as unknown as { response: { data: { custom_id: string } } }).response.data.custom_id).toBe('mt:M:333333333333333333:777777777777777777');
  });

  it('an unreadable target is refused', () => {
    expect(() => parseInteraction({ ...base, type: 2, data: { name: 'Create task from message', type: 3, target_id: '1', resolved: {} } } as never)).toThrow(/read that message/);
  });

  const submit = (customId: string, fields: Record<string, string>, over: Partial<DiscordInteraction> = {}): DiscordInteraction =>
    ({ ...base, type: 5, data: { custom_id: customId, components: Object.entries(fields).map(([k, v]) => ({ components: [{ custom_id: k, value: v }] })) }, ...over }) as never;

  it('submit -> create_from_message with the deep link built from signed ids (MESSAGE and THREAD)', () => {
    const m = intent(submit('mt:M:333333333333333333:666666666666666666', { title: ' Fix login ', description: 'd', project: '' }));
    expect(m.visibility).toBe('public');
    expect(m.intent).toEqual({ kind: 'create_from_message', title: 'Fix login', description: 'd', projectName: undefined, source: { kind: 'MESSAGE', externalId: '333333333333333333/666666666666666666', url: 'https://discord.com/channels/222222222222222222/333333333333333333/666666666666666666' } });
    const t = intent(submit('mt:T:333333333333333333:333333333333333333', { title: 'Post' }));
    expect((t.intent as { source: unknown }).source).toEqual({ kind: 'THREAD', externalId: '333333333333333333', url: 'https://discord.com/channels/222222222222222222/333333333333333333' });
  });

  it('submit refuses an empty title, forged ids and a custom_id we did not make', () => {
    expect(() => intent(submit('mt:M:333333333333333333:666666666666666666', { title: '   ' }))).toThrow(/title/);
    expect(() => intent(submit('mt:M:../../x:666666666666666666', { title: 'a' }))).toThrow(/no longer valid/);
    expect(() => intent(submit('mt:Q:333333333333333333:666666666666666666', { title: 'a' }))).toThrow(/no longer valid/);
    expect(() => parseInteraction(submit('zzz:1', { title: 'a' }))).toThrow(ChatUserError);
  });

  it('buttons: assign-me runs, set-due opens a date modal, then the submit validates the date', () => {
    const id = 'ckabcdefghij1234';
    const click = (verb: string) => parseInteraction({ ...base, type: 3, data: { custom_id: `${verb}:${id}` } } as never);
    expect(click('a')).toMatchObject({ kind: 'intent', visibility: 'private', intent: { kind: 'assign_me', taskId: id } });
    const d = click('d'); expect(d.kind).toBe('modal');
    expect(intent(submit(`d:${id}`, { date: '2026-12-31' })).intent).toEqual({ kind: 'set_due', taskId: id, due: '2026-12-31' });
    expect(() => intent(submit(`d:${id}`, { date: '31-12-2026' }))).toThrow(/YYYY-MM-DD/);
    expect(() => click('x')).toThrow(/no longer valid/);
    expect(() => parseInteraction({ ...base, type: 3, data: { custom_id: 'a:../etc' } } as never)).toThrow(/no longer valid/);
  });
});

describe('protocol helpers', () => {
  it('Manage Server / Administrator bits; garbage is false', () => {
    expect(canManageGuild('32')).toBe(true);
    expect(canManageGuild('8')).toBe(true);
    expect(canManageGuild('2048')).toBe(false);
    expect(canManageGuild(undefined)).toBe(false);
    expect(canManageGuild('not a number')).toBe(false);
    // Discord permission bitfields exceed 2^32: must not be truncated by Number arithmetic
    expect(canManageGuild(String(1n << 40n))).toBe(false);
    expect(canManageGuild(String((1n << 40n) | 32n))).toBe(true);
  });

  it('replies never ping: allowed_mentions.parse is empty, content is capped, task replies get Open / Assign / Set due', () => {
    const r = renderResult({ visibility: 'public', text: '@everyone ' + 'x'.repeat(5000), task: { id: 'ckabcdefghij1234', key: 'ENG-1', title: 't', url: 'https://app.test/tasks/ENG-1' } });
    expect(r.allowed_mentions).toEqual({ parse: [] });
    expect((r.content as string).length).toBeLessThanOrEqual(1900);
    const row = (taskButtons({ id: 'abcdefghij12', key: 'K-1', title: 't', url: 'https://x.test' })[0] as { components: Array<{ label: string }> }).components;
    expect(row.map((b) => b.label)).toEqual(['Open', 'Assign to me', 'Set due']);
    expect((taskButtons({ id: 'abcdefghij12', key: 'K-1', title: 't' })[0] as { components: unknown[] }).components).toHaveLength(2); // no URL -> no Open button
  });
});
