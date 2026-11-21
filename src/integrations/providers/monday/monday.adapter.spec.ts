import { Readable } from 'node:stream';
import { FieldType } from '@prisma/client';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { resolveFieldRoles, suggestFieldRoles } from '../../../imports/field-roles';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { suggestStatus } from '../../../imports/mapping/mapping.suggest';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { MondayAdapter } from './monday.adapter';
import { MondayClient, msUntilMidnightUtc } from './monday.client';
import { ACCOUNT, BID, BOARDS, DATASET, DL_EXTRA, DL_OK, DL_S3, FILES, ME, fakeMonday } from './fixtures/monday-responses';
import {
  assetRef, buildBoard, customValueOf, dateInstant, dateOf, fieldsOfBoard, isAllowedDownloadUrl, isoInstant, linkedItemIds, parseAssetRef, parseValue, personIds, safeFileName,
  splitTimelineId, statusIndex, statusLabels, timelineOf, toAttachments, toComments, toDependencies, toSubitem, toTask, toUser, GROUP_FIELD_ID,
} from './monday.normalize';
import type { BoardPlan } from './monday.normalize';
import { MnBoard, MnColumnValue, MnItem } from './monday.types';

const noRedis = { configured: false, isReady: () => false } as never;
const cfgOf = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
function make(fake: ReturnType<typeof fakeMonday>, env: Record<string, string> = {}, httpOpts: Record<string, unknown> = {}) {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0, ...httpOpts });
  const e = { MONDAY_CLIENT_ID: 'cid', MONDAY_CLIENT_SECRET: 'sec', MONDAY_REQUESTS_PER_MINUTE: '5000', ...env };
  const client = new MondayClient(http, cfgOf(e));
  const sleep = jest.fn(async (_ms: number) => undefined);
  client.sleep = sleep;
  return { adapter: new MondayAdapter(cfgOf(e), http, client), client, sleep };
}
const ctx = { connectionId: 'conn-1', externalAccountId: ACCOUNT.id, accessToken: 'tok' };
const sel = (...s: Array<[string, string, Record<string, string | null>?]>) => ({ sources: s.map(([type, id, fieldRoles]) => ({ id, type, ...(fieldRoles ? { fieldRoles } : {}) })) });
const read = async (s: Readable) => { const p: Buffer[] = []; for await (const c of s) p.push(Buffer.from(c)); return Buffer.concat(p).toString(); };
const OPTS = { ...DEFAULT_IMPORT_OPTIONS };
const QUIET = { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false };

async function runAll(a: MondayAdapter, selection = sel(['board', BID.sprint], ['board', BID.groups]), options = OPTS, between?: (callIndex: number) => void) {
  const pages: CanonicalBundle[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = null;
  for (let n = 0; n < 80; n++) {
    between?.(n);
    cursors.push(cursor);
    const r = await a.fetchBundle({ ctx, selection, options, cursor });
    pages.push(r.bundle as CanonicalBundle);
    if (r.next === null) return { pages, cursors };
    cursor = r.next;
  }
  throw new Error('did not terminate');
}
const tasksOf = (pages: CanonicalBundle[]) => pages.flatMap((p) => p.tasks ?? []);
const byId = (pages: CanonicalBundle[]) => new Map(tasksOf(pages).map((t) => [t.externalId, t]));

const v = (id: string, type: string, text: string | null, value: unknown): MnColumnValue => ({ id, type, text, value: value === null ? null : JSON.stringify(value) });
const board = (over: Partial<MnBoard> = {}): MnBoard => ({ ...BOARDS.b1, ...over });
const rolesOf = (b: MnBoard, chosen?: Record<string, string | null>) => resolveFieldRoles(suggestFieldRoles(fieldsOfBoard(b)), chosen as never);
const planOf = (b: MnBoard, chosen?: Record<string, string | null>): BoardPlan => buildBoard(b, rolesOf(b, chosen)).plan;

describe('monday normalizers: values', () => {
  it('instants and dates', () => {
    expect(isoInstant('2026-01-02T10:00:00Z')).toBe('2026-01-02T10:00:00.000Z');
    for (const bad of [undefined, null, '', 'x', 5]) expect(isoInstant(bad as never)).toBeUndefined();
    expect(dateInstant('2026-03-01', '13:30:00')).toBe('2026-03-01T13:30:00.000Z');
    expect(dateInstant('2026-03-01', '13:30')).toBe('2026-03-01T13:30:00.000Z');
    expect(dateInstant('2026-03-01', null)).toBe('2026-03-01T00:00:00.000Z');
    expect(dateInstant('2026-03-01', 'soon')).toBe('2026-03-01T00:00:00.000Z');
    expect(dateInstant('03/01/2026')).toBeUndefined();
    expect(dateInstant(5 as never)).toBeUndefined();
  });

  it('a column value is a JSON STRING: junk, arrays and empties are "no value", never a throw', () => {
    expect(parseValue(v('a', 't', '', { x: 1 }))).toEqual({ x: 1 });
    for (const bad of [{ id: 'a', value: '{not json' }, { id: 'a', value: '[1]' }, { id: 'a', value: '"str"' }, { id: 'a', value: '' }, { id: 'a', value: null }, undefined]) expect(parseValue(bad as never)).toBeNull();
  });

  it('status index, people (persons only, numeric ids), timeline, dependency links', () => {
    expect(statusIndex(v('s', 'status', 'x', { index: 2 }))).toBe('2');
    expect(statusIndex(v('s', 'status', 'x', { index: '2' }))).toBeNull();
    expect(statusIndex(v('s', 'status', 'x', null))).toBeNull();
    expect(personIds(v('p', 'people', '', { personsAndTeams: [{ id: 5, kind: 'person' }, { id: 7, kind: 'team' }, { id: 5, kind: 'person' }, { id: 'x', kind: 'person' }] }))).toEqual(['5']);
    expect(personIds(v('p', 'people', '', null))).toEqual([]);
    expect(timelineOf(v('t', 'timeline', '', { from: '2026-01-01', to: '2026-01-09' }))).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-09T00:00:00.000Z' });
    expect(timelineOf(v('t', 'timeline', '', { from: 'x', to: '2026-01-09' }))).toEqual({ to: '2026-01-09T00:00:00.000Z' });
    expect(dateOf(v('d', 'date', '', { date: '2026-02-02', time: '08:00:00' }))).toBe('2026-02-02T08:00:00.000Z');
    expect(linkedItemIds(v('l', 'dependency', '', { linkedPulseIds: [{ linkedPulseId: 5 }, { linkedPulseId: '6' }, { linkedPulseId: 5 }, { linkedPulseId: 'x' }, {}] }))).toEqual(['5', '6']);
  });

  it('a user falls back from name to e-mail to id', () => {
    expect(toUser({ id: 1, name: 'A', email: 'a@x.y' })).toEqual({ externalId: '1', name: 'A', email: 'a@x.y' });
    expect(toUser({ id: 2, email: 'b@x.y' }).name).toBe('b@x.y');
    expect(toUser({ id: 3 }).name).toBe('3');
  });
});

describe('monday normalizers: fields and statuses', () => {
  it('fields offered to the picker: right roles by type, a timeline split in two, the group LAST, archived and other types absent', () => {
    const f = fieldsOfBoard(BOARDS.b1);
    expect(f.map((x) => [x.id, x.roles])).toEqual([
      ['status', ['status', 'priority']], ['priority', ['status', 'priority']], ['owner', ['assignee']], ['due', ['due', 'start']],
      ['tl:from', ['start']], ['tl:to', ['due']], ['labels', ['priority']], [GROUP_FIELD_ID, ['status']],
    ]);
    expect(f.find((x) => x.id === 'tl:from')!.name).toBe('Timeline (start)');
    expect(fieldsOfBoard({ id: 1, columns: [], groups: [] })).toEqual([]);
    expect(splitTimelineId('tl:to')).toEqual({ col: 'tl', half: 'to' });
    expect(splitTimelineId('status')).toBeNull();
  });

  it('the suggestions for the real sprint board are the sensible ones (and a group is the workflow when there is no status column)', () => {
    const r = rolesOf(BOARDS.b1);
    expect(Object.fromEntries(Object.entries(r.byRole).map(([k, x]) => [k, x.id]))).toEqual({ status: 'status', priority: 'priority', assignee: 'owner', due: 'due', start: 'tl:from' });
    const g = rolesOf(BOARDS.b3);
    expect(Object.fromEntries(Object.entries(g.byRole).map(([k, x]) => [k, x.id]))).toEqual({ status: GROUP_FIELD_ID, assignee: 'who', due: 'when' });
  });

  it('status labels: blanks are not choices, ordered by position then index; bad settings -> none', () => {
    expect(statusLabels(BOARDS.b1.columns![1]).map((l) => [l.index, l.name])).toEqual([['0', 'Working on it'], ['2', 'Stuck'], ['1', 'Done']]);
    for (const bad of [undefined, '', '{bad', '[]', '{"labels":[1]}']) expect(statusLabels({ id: 's', type: 'status', settings_str: bad as never })).toEqual([]);
  });

  it('labels become statuses of UNKNOWN category (the mapping step judges the names) + a certain "No status"', () => {
    const b = buildBoard(BOARDS.b1, rolesOf(BOARDS.b1));
    expect(b.project.statuses!.map((s) => [s.externalId, s.name, s.category])).toEqual([
      ['1001000:s:0', 'Working on it', 'UNKNOWN'], ['1001000:s:2', 'Stuck', 'UNKNOWN'], ['1001000:s:1', 'Done', 'UNKNOWN'], ['1001000:__none', 'No status', 'TODO'],
    ]);
    const rows = b.project.statuses!.map((s) => { const g = suggestStatus('p', s); return [s.name, g.category, g.confidence]; });
    expect(rows).toEqual([['Working on it', 'IN_PROGRESS', 'MEDIUM'], ['Stuck', 'BLOCKED', 'LOW'], ['Done', 'DONE', 'MEDIUM'], ['No status', 'TODO', 'HIGH']]);
    expect(b.plan).toMatchObject({ kind: 'column', roles: { status: 'status', priority: 'priority', assignee: 'owner', due: 'due', start: 'tl:from' } });
    expect(b.plan.lbl).toEqual({ 'working on it': '1001000:s:0', stuck: '1001000:s:2', done: '1001000:s:1' });
  });

  it('groups as the workflow: one status per group, no "No status" (every item has a group)', () => {
    const b = buildBoard(BOARDS.b3, rolesOf(BOARDS.b3));
    expect(b.plan.kind).toBe('group');
    expect(b.project.statuses!.map((s) => [s.externalId, s.name, s.category])).toEqual([['1003000:g:todo', 'Todo', 'UNKNOWN'], ['1003000:g:doing', 'Doing', 'UNKNOWN'], ['1003000:g:done', 'Done', 'UNKNOWN']]);
  });

  it('no status mapped -> one certain "To do"', () => {
    const b = buildBoard(BOARDS.b1, rolesOf(BOARDS.b1, { status: null }));
    expect(b.plan.kind).toBe('none');
    expect(b.project.statuses!.map((s) => [s.name, s.category])).toEqual([['To do', 'TODO']]);
  });

  it('custom columns become fields (shared by title + type across boards); role columns do not; formula / mirror are reported, structural ones are silent', () => {
    const b = buildBoard(BOARDS.b1, rolesOf(BOARDS.b1));
    expect(b.customFields.map((f) => [f.name, f.dataType]).sort()).toEqual([
      ['Budget', 'NUMBER'], ['Labels', 'MULTI_SELECT'], ['Notes', 'TEXT'], ['Reviewed', 'CHECKBOX'], ['Spec', 'URL'], ['Timeline (end)', 'DATE'],
    ]);
    expect(b.customFields.find((f) => f.name === 'Labels')!.options).toEqual([{ label: 'ui' }, { label: 'api' }]);
    expect(b.skipped.map((s) => s.type).sort()).toEqual(['formula', 'mirror']);
    const again = buildBoard({ ...BOARDS.b1, id: '999', columns: [{ id: 'x', title: 'Budget', type: 'numbers' }] }, rolesOf({ ...BOARDS.b1, id: '999', columns: [{ id: 'x', title: 'Budget', type: 'numbers' }], groups: [] }));
    expect(again.customFields[0].externalId).toBe(b.customFields.find((f) => f.name === 'Budget')!.externalId); // same title + type = the same field
  });

  it('only the timeline half that plays a role is spent: the other half is a date field, never lost', () => {
    const none = buildBoard(BOARDS.b1, rolesOf(BOARDS.b1, { start: null, due: null }));
    expect(none.customFields.map((f) => f.name)).toEqual(expect.arrayContaining(['Timeline (start)', 'Timeline (end)', 'Due date']));
    const both = buildBoard(BOARDS.b1, rolesOf(BOARDS.b1, { start: 'tl:from', due: 'tl:to' }));
    expect(both.customFields.map((f) => f.name)).not.toEqual(expect.arrayContaining(['Timeline (start)']));
    expect(both.customFields.map((f) => f.name)).toContain('Due date');
  });

  it('a status column that is NOT the workflow becomes a select field (a status used as Priority is not also a field)', () => {
    const b = buildBoard(BOARDS.b1, rolesOf(BOARDS.b1, { status: GROUP_FIELD_ID }));
    expect(b.plan.kind).toBe('group');
    expect(b.customFields.find((f) => f.name === 'Status')).toMatchObject({ dataType: 'SELECT', options: [{ label: 'Working on it' }, { label: 'Stuck' }, { label: 'Done' }] });
    expect(b.customFields.some((f) => f.name === 'Priority')).toBe(false); // it still plays the priority role
  });

  it('a project carries its name, url, description and archived flag', () => {
    expect(buildBoard(BOARDS.b1, rolesOf(BOARDS.b1)).project).toMatchObject({ externalId: '1001000', name: 'Sprint', url: 'https://acme.monday.com/boards/1001000', description: 'Q3 board' });
    expect(buildBoard(board({ state: 'archived', name: '  ' }), rolesOf(BOARDS.b1)).project).toMatchObject({ archived: true, name: 'Board 1001000' });
  });
});

describe('monday normalizers: tasks', () => {
  const item = (over: Partial<MnItem> = {}, cols: MnColumnValue[] = []): MnItem => ({ id: 1, name: 'T', group: { id: 'g1', title: 'Backlog' }, column_values: cols, subitems: [], ...over });

  it('the status comes from the label INDEX; a deleted label or no value falls back to No status; the label text is the second chance', () => {
    const plan = planOf(BOARDS.b1);
    expect(toTask(item({}, [v('status', 'status', 'Done', { index: 1 })]), plan, true).statusExternalId).toBe('1001000:s:1');
    expect(toTask(item({}, [v('status', 'status', 'Gone', { index: 9 })]), plan, true).statusExternalId).toBe('1001000:__none');
    expect(toTask(item({}, [v('status', 'status', 'Stuck', null)]), plan, true).statusExternalId).toBe('1001000:s:2');
    expect(toTask(item({}, []), plan, true).statusExternalId).toBe('1001000:__none');
  });

  it('group kind: the group is the status; an unknown group falls back to the first; no tag for the group then', () => {
    const plan = planOf(BOARDS.b3);
    expect(toTask(item({ group: { id: 'doing', title: 'Doing' } }), plan, true)).toMatchObject({ statusExternalId: '1003000:g:doing' });
    expect(toTask(item({ group: { id: 'doing', title: 'Doing' } }), plan, true).tags).toBeUndefined();
    expect(toTask(item({ group: { id: 'nope' } }), plan, true).statusExternalId).toBe('1003000:g:todo');
    expect(toTask(item({ group: null }), plan, true).statusExternalId).toBe('1003000:g:todo');
  });

  it('other kinds keep the group as a tag (the board structure is not lost); never an empty one', () => {
    const plan = planOf(BOARDS.b1);
    expect(toTask(item({}), plan, true).tags).toEqual(['Group: Backlog']);
    expect(toTask(item({ group: { id: 'g', title: '  ' } }), plan, true).tags).toBeUndefined();
    expect(toTask(item({}), plan, false).tags).toBeUndefined();
  });

  it('priority is the first label; the assignee is a PERSON (teams are not people); dates keep their time; a timeline gives start and a custom end', () => {
    const plan = planOf(BOARDS.b1);
    const t = toTask(item({}, [
      v('priority', 'status', 'High, Urgent', { index: 2 }), v('owner', 'people', '', { personsAndTeams: [{ id: 2, kind: 'person' }, { id: 9, kind: 'team' }] }),
      v('due', 'date', '', { date: '2026-03-01', time: '13:30:00' }), v('tl', 'timeline', '', { from: '2026-02-01', to: '2026-02-20' }),
    ]), plan, true);
    expect(t).toMatchObject({ priority: 'High', assigneeExternalIds: ['2'], dueDate: '2026-03-01T13:30:00.000Z', startDate: '2026-02-01T00:00:00.000Z' });
    expect(t.customValues).toEqual([{ fieldExternalId: plan.cm['tl:to'], value: '2026-02-20T00:00:00.000Z' }]);
  });

  it('with the timeline as both start and end, due and start come from its two halves', () => {
    const plan = planOf(BOARDS.b1, { start: 'tl:from', due: 'tl:to' });
    const t = toTask(item({}, [v('tl', 'timeline', '', { from: '2026-02-01', to: '2026-02-20' })]), plan, true);
    expect(t).toMatchObject({ startDate: '2026-02-01T00:00:00.000Z', dueDate: '2026-02-20T00:00:00.000Z' });
  });

  it('custom values per type: numbers with separators, link url (http(s) only), checkbox only when checked, multi-select labels', () => {
    const f = (type: string, t: FieldType) => `cf:abc:${t}`;
    expect(customValueOf(v('b', 'numbers', '1,250.5', '1250.5'), f('numbers', FieldType.NUMBER))).toEqual({ fieldExternalId: 'cf:abc:NUMBER', value: 1250.5 });
    expect(customValueOf(v('b', 'numbers', '', null), 'cf:abc:NUMBER')).toBeNull();
    expect(customValueOf(v('b', 'numbers', 'abc', null), 'cf:abc:NUMBER')).toBeNull();
    expect(customValueOf(v('l', 'link', '', { url: 'https://x.test/a' }), 'cf:abc:URL')).toEqual({ fieldExternalId: 'cf:abc:URL', value: 'https://x.test/a' });
    expect(customValueOf(v('l', 'link', '', { url: 'javascript:alert(1)' }), 'cf:abc:URL')).toBeNull();
    expect(customValueOf(v('c', 'checkbox', '', { checked: 'true' }), 'cf:abc:CHECKBOX')).toEqual({ fieldExternalId: 'cf:abc:CHECKBOX', value: true });
    expect(customValueOf(v('c', 'checkbox', '', { checked: 'false' }), 'cf:abc:CHECKBOX')).toBeNull();
    expect(customValueOf(v('d', 'dropdown', 'ui, , api', null), 'cf:abc:MULTI_SELECT')).toEqual({ fieldExternalId: 'cf:abc:MULTI_SELECT', value: ['ui', 'api'] });
    expect(customValueOf(v('x', 'text', 'hi', null), 'not-a-field-id')).toBeNull();
  });

  it('subitems are read by TYPE: status by label, first people, date or timeline; parent set', () => {
    const plan = planOf(BOARDS.b1);
    const s = toSubitem({ id: 5, name: 'S', creator: { id: 1 }, column_values: [v('a', 'status', 'DONE', { index: 1 }), v('b', 'people', '', { personsAndTeams: [{ id: 1, kind: 'person' }] }), v('c', 'date', '', { date: '2026-02-10' })] }, '77', plan);
    expect(s).toMatchObject({ externalId: '5', parentExternalId: '77', statusExternalId: '1001000:s:1', assigneeExternalIds: ['1'], dueDate: '2026-02-10T00:00:00.000Z', creatorExternalId: '1' });
    const t = toSubitem({ id: 6, name: 'S', column_values: [v('a', 'status', 'Unknown label', null), v('t', 'timeline', '', { from: '2026-02-11', to: '2026-02-12' })] }, '77', plan);
    expect(t).toMatchObject({ statusExternalId: '1001000:__none', dueDate: '2026-02-12T00:00:00.000Z', startDate: '2026-02-11T00:00:00.000Z' });
    expect(toSubitem({ id: 7, name: 'S' }, '77', planOf(BOARDS.b3)).statusExternalId).toBe('1003000:g:todo');
  });

  it('dependency columns: the linked items are BLOCKERS of this one (blocker -> this), one id per edge, no self edges', () => {
    const plan = planOf(BOARDS.b1);
    const d = toDependencies(item({ id: 9 }, [v('blocked', 'dependency', '', { linkedPulseIds: [{ linkedPulseId: 5 }, { linkedPulseId: 9 }, { linkedPulseId: 5 }] })]), plan);
    expect(d).toEqual([{ externalId: 'dep:5>9', fromExternalId: '5', toExternalId: '9', type: 'BLOCKS' }]);
    expect(toDependencies(item({ id: 9 }, [v('blocked', 'dependency', '', { linkedPulseIds: [{ linkedPulseId: 5 }] })]), planOf(BOARDS.b3))).toEqual([]); // no dependency column on that board
  });
});

describe('monday normalizers: comments and files', () => {
  it('updates are comments, replies hang under their update (one level), oldest first, html -> markdown, empty ones dropped, duplicates ignored', () => {
    const out = toComments([
      { id: 2, text_body: 'second', created_at: '2026-01-06T00:00:00Z' },
      { id: 1, body: '<p>Hello <strong>team</strong></p>', created_at: '2026-01-05T00:00:00Z', creator: { id: 7, name: 'Ben' }, replies: [{ id: 12, text_body: 'late', created_at: '2026-01-05T12:00:00Z', creator_id: 9 }, { id: 11, body: '<p>early</p>', created_at: '2026-01-05T06:00:00Z' }, { id: 13, body: '', text_body: '' }] },
      { id: 3, body: '', text_body: '' }, { id: 2, text_body: 'dup', created_at: '2026-01-06T00:00:00Z' },
    ]);
    expect(out.map((c) => [c.externalId, c.body, c.parentExternalId])).toEqual([['1', 'Hello **team**', undefined], ['11', 'early', '1'], ['12', 'late', '1'], ['2', 'second', undefined]]);
    expect(out[0]).toMatchObject({ authorExternalId: '7', authorName: 'Ben' });
    expect(out[2]).toMatchObject({ authorExternalId: '9' });
  });

  it('files: the ref is opaque (never an address), duplicates collapse, names get their extension and cannot carry a path', () => {
    const out = toAttachments('1001', [
      { id: 7001, name: 'design.png', file_extension: '.png', file_size: 2048 }, { id: 7002, name: 'spec', file_extension: 'pdf' }, { id: 7001, name: 'dup' },
      { id: 7009, name: '../../etc/passwd', file_extension: '' }, { id: 'x/../y', name: 'bad' } as never, { id: 7010, name: '', file_extension: 'txt' },
    ]);
    expect(out.map((a) => [a.externalId, a.fileName, a.providerRef])).toEqual([
      ['1001:7001', 'design.png', 'monday-asset:7001'], ['1001:7002', 'spec.pdf', 'monday-asset:7002'], ['1001:7009', 'passwd', 'monday-asset:7009'], ['1001:7010', 'file-7010.txt', 'monday-asset:7010'],
    ]);
    expect(out[0].sizeBytes).toBe(2048);
    expect(safeFileName('a\u0000b\\c.txt', null, 'x')).toBe('c.txt');
    expect(assetRef(5)).toBe('monday-asset:5');
  });

  it.each([['monday-asset:123', '123'], ['monday-asset:', null], ['monday-asset:12a', null], ['monday-asset:1/../2', null], ['https://files.monday.com/x', null], ['', null], [undefined as never, null]])('asset ref %j -> %j', (ref, id) => expect(parseAssetRef(ref)).toBe(id));

  it.each([
    ['https://files.monday.com/a/1.png', true], ['https://monday.com/x', true], ['https://a.b.monday.com/x', true], ['https://monday-files.s3.amazonaws.com/x?s=1', true], ['https://files-monday-com.s3.eu-west-1.amazonaws.com/x', true],
    ['http://files.monday.com/x', false], ['https://files.monday.com:8443/x', false], ['https://u:p@files.monday.com/x', false], ['https://files.monday.com.evil.example/x', false],
    ['https://evilmonday.com/x', false], ['https://169.254.169.254/x', false], ['https://[::1]/x', false], ['https://evil-bucket.s3.amazonaws.com/x', false], ['https://cdn.example-files.test/x', false], ['not a url', false],
  ])('download host %s -> %s', (url, allowed) => expect(isAllowedDownloadUrl(url)).toBe(allowed));

  it('an operator can add a host (exact or .suffix) after seeing a refusal; a lookalike still fails', () => {
    expect(isAllowedDownloadUrl(DL_EXTRA, ['.example-files.test'])).toBe(true);
    expect(isAllowedDownloadUrl('https://example-files.test/x', ['.example-files.test'])).toBe(false);
    expect(isAllowedDownloadUrl('https://cdn.example-files.test/x', ['cdn.example-files.test'])).toBe(true);
    expect(isAllowedDownloadUrl('https://cdn.example-files.test.evil.example/x', ['.example-files.test'])).toBe(false);
  });
});

describe('MondayAdapter OAuth', () => {
  it('2.1 (the default): PKCE S256, scopes, no secret in the URL; legacy: no PKCE', () => {
    const { adapter } = make(fakeMonday());
    expect(adapter.usesPkce).toBe(true);
    const u = new URL(adapter.authorizeUrl({ state: 'st', redirectUri: 'https://app/cb', pkceChallenge: 'chal' }));
    expect(u.origin + u.pathname).toBe('https://auth.monday.com/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'cid', redirect_uri: 'https://app/cb', state: 'st', code_challenge: 'chal', code_challenge_method: 'S256' });
    expect(u.searchParams.get('scope')).toContain('boards:read');
    expect(u.toString()).not.toContain('sec');
    const legacy = make(fakeMonday(), { MONDAY_OAUTH_FLOW: 'legacy' }).adapter;
    expect(legacy.usesPkce).toBe(false);
    expect(new URL(legacy.authorizeUrl({ state: 's', redirectUri: 'r', pkceChallenge: 'chal' })).searchParams.has('code_challenge')).toBe(false);
    expect(make(fakeMonday(), { MONDAY_OAUTH_FLOW: 'nonsense' }).adapter.usesPkce).toBe(true);
  });

  it('MONDAY_SCOPES overrides; empty omits the scope parameter', () => {
    expect(new URL(make(fakeMonday(), { MONDAY_SCOPES: 'boards:read' }).adapter.authorizeUrl({ state: 's', redirectUri: 'r' })).searchParams.get('scope')).toBe('boards:read');
    expect(new URL(make(fakeMonday(), { MONDAY_SCOPES: '' }).adapter.authorizeUrl({ state: 's', redirectUri: 'r' })).searchParams.has('scope')).toBe(false);
  });

  it('isConfigured needs both id and secret', () => {
    expect(make(fakeMonday()).adapter.isConfigured()).toBe(true);
    expect(make(fakeMonday(), { MONDAY_CLIENT_SECRET: '' }).adapter.isConfigured()).toBe(false);
  });

  it('2.1 exchange: form body with the PKCE verifier to the 2.1 endpoint; expiry from the JWT; the account is the monday ACCOUNT', async () => {
    const fake = fakeMonday();
    const { tokens, account } = await make(fake).adapter.exchangeCode({ code: 'c0de' }, { redirectUri: 'https://app/cb', pkceVerifier: 'ver' });
    const sent = (fake.fetch as any).lastAuthBody;
    expect(sent).toMatchObject({ asJson: false, path: '/oauth_ms/oauth/token' });
    expect(sent.body).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://app/cb', code_verifier: 'ver', client_id: 'cid', client_secret: 'sec' });
    expect(account).toEqual({ id: '555', name: 'Acme' });
    expect(tokens).toMatchObject({ refreshToken: 'rt-1', scopes: ['me:read', 'boards:read'] });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000);
  });

  it('legacy exchange: JSON body, the legacy endpoint, NO expiry and no refresh token, comma-separated scopes', async () => {
    const fake = fakeMonday();
    const { tokens } = await make(fake, { MONDAY_OAUTH_FLOW: 'legacy' }).adapter.exchangeCode({ code: 'c0de' }, { redirectUri: 'r', pkceVerifier: 'ignored' });
    const sent = (fake.fetch as any).lastAuthBody;
    expect(sent).toMatchObject({ asJson: true, path: '/oauth2/token' });
    expect(sent.body.code_verifier).toBeUndefined();
    expect(tokens).toMatchObject({ accessToken: 'legacy-token', scopes: ['boards:write', 'boards:read'] });
    expect(tokens.expiresAt).toBeUndefined();
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('exchange refuses a missing code, a rejected code, and an answer that does not say which account', async () => {
    await expect(make(fakeMonday()).adapter.exchangeCode({}, { redirectUri: 'r' })).rejects.toThrow('without code');
    const bad = fakeMonday();
    (bad.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(make(bad).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).rejects.toThrow('HTTP 400 invalid_grant');
    const noAccount = fakeMonday(DATASET, { intercept: (q) => (/\bme \{/.test(q) ? bad.ok({ me: { id: 1, account: null } }) : undefined) });
    await expect(make(noAccount).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).rejects.toThrow('which account');
  });

  it('expires_in may be a string; an unreadable token has no expiry rather than a wrong one', async () => {
    const fake = fakeMonday();
    (fake.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'tok', expires_in: '3600', scope: 'a b' }), { status: 200 }));
    const { tokens } = await make(fake).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(tokens.scopes).toEqual(['a', 'b']);
    const f2 = fakeMonday();
    (f2.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
    expect((await make(f2).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).tokens.expiresAt).toBeUndefined();
  });

  it('refresh ROTATES the refresh token (the new one is kept); a dead grant or no refresh token -> ProviderAuthRejectedError', async () => {
    const { adapter } = make(fakeMonday());
    const t = await adapter.refresh({ accessToken: 'old', refreshToken: 'rt-ok', scopes: ['x'] });
    expect(t).toMatchObject({ accessToken: 'new-access', refreshToken: 'rt-rotated', scopes: ['boards:read', 'users:read'] });
    await expect(adapter.refresh({ accessToken: 'old', refreshToken: 'rt-dead', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(adapter.refresh({ accessToken: 'old', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('revoke (2.1) sends the refresh token; the legacy flow has nothing to revoke', async () => {
    const fake = fakeMonday();
    await make(fake).adapter.revoke({ accessToken: 'a', refreshToken: 'rt-1', scopes: [] }, { id: '1', name: 'x' });
    expect((fake.fetch as any).lastAuthBody).toMatchObject({ path: '/oauth_ms/oauth/revoke', body: { token: 'rt-1', token_type_hint: 'refresh_token' } });
    const legacy = fakeMonday();
    await make(legacy, { MONDAY_OAUTH_FLOW: 'legacy' }).adapter.revoke({ accessToken: 'a', scopes: [] }, { id: '1', name: 'x' });
    expect(legacy.fetch).not.toHaveBeenCalled();
  });
});

describe('MondayAdapter discover / estimate', () => {
  it('the tree is workspace (not selectable) -> board; the main workspace has a node; subitem boards and docs are not offered; boards carry their fields with suggestions', async () => {
    const { nodes } = await make(fakeMonday()).adapter.discover(ctx);
    expect(nodes.find((n) => n.id === 'w1')).toMatchObject({ type: 'workspace', name: 'Product', selectable: false, parentId: null });
    expect(nodes.find((n) => n.id === 'main')).toMatchObject({ type: 'workspace', name: 'Main workspace', selectable: false });
    expect(nodes.filter((n) => n.type === 'board').map((n) => [n.id, n.parentId])).toEqual([[BID.sprint, 'w1'], [BID.big, 'main'], [BID.groups, 'w1'], [BID.heavy, 'main']]);
    const sprint = nodes.find((n) => n.id === BID.sprint)!;
    expect(sprint.fields!.find((f) => f.id === 'status')!.suggested).toEqual(['status']);
    expect(sprint.fields!.find((f) => f.id === 'tl:from')!.suggested).toEqual(['start']);
    expect(nodes.find((n) => n.id === BID.groups)!.fields!.find((f) => f.id === GROUP_FIELD_ID)!.suggested).toEqual(['status']);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it('estimate: counts, a structure page that validates, honest warnings (guessed fields, skipped columns, history)', async () => {
    const e = await make(fakeMonday()).adapter.estimate(ctx, sel(['board', BID.sprint], ['board', BID.groups]), OPTS);
    expect(e.projects).toEqual([{ sourceId: BID.sprint, name: 'Sprint', tasks: 4 }, { sourceId: BID.groups, name: 'Groups only', tasks: 3 }]);
    expect(e.users).toBe(3);
    const codes = e.warnings!.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['FIELD_ROLES_GUESSED', 'COLUMNS_SKIPPED', 'HISTORY_NOT_AVAILABLE']));
    expect(e.warnings!.find((w) => w.code === 'FIELD_ROLES_GUESSED')!.message).toContain('status: "Status"');
    expect(e.warnings!.find((w) => w.code === 'COLUMNS_SKIPPED')!.message).toMatch(/formula/);
    expect(codes).not.toContain('DAILY_LIMIT');
  });

  it('a person who chose every field is not told it was guessed; a chosen field that vanished is reported, not replaced by the guess', async () => {
    const all = { status: 'status', priority: 'priority', assignee: 'owner', due: 'due', start: 'tl:from' };
    const e = await make(fakeMonday()).adapter.estimate(ctx, sel(['board', BID.sprint, all]), QUIET);
    expect(e.warnings!.map((w) => w.code)).not.toContain('FIELD_ROLES_GUESSED');
    const gone = await make(fakeMonday()).adapter.estimate(ctx, sel(['board', BID.sprint, { ...all, due: 'deleted-column' }]), QUIET);
    expect(gone.warnings!.map((w) => w.code)).toContain('FIELD_ROLES_MISSING');
  });

  it.each([['free', true, 'it will pause'], ['pro', false, ''], ['enterprise', false, ''], [null, false, ''], ['mystery', false, '']] as Array<[string | null, boolean, string]>)('daily limit, plan %s -> warned: %s', async (tier, warned, text) => {
    const data = { ...DATASET, tier: tier as string | null };
    const fake = fakeMonday(data, { intercept: (q) => (/boards\(ids: \$ids/.test(q) ? fake.ok({ boards: [{ ...BOARDS.b2, items_count: 50_000 }] }) : undefined) });
    const e = await make(fake).adapter.estimate(ctx, sel(['board', BID.big]), OPTS);
    const w = e.warnings!.find((x) => x.code === 'DAILY_LIMIT');
    expect(!!w).toBe(warned);
    if (w) expect(w.message).toContain(text);
  });

  it('a plan lookup that fails never fails the preview', async () => {
    const fake = fakeMonday(DATASET, { intercept: (q) => (/account \{ plan/.test(q) ? fake.err('nope', { status_code: 403 }) : undefined) });
    const e = await make(fake).adapter.estimate(ctx, sel(['board', BID.groups]), OPTS);
    expect(e.projects).toHaveLength(1);
  });

  it('a selection that is not a board, an id that is not an id, a board that is gone or is not a board are refused', async () => {
    const { adapter } = make(fakeMonday());
    await expect(adapter.estimate(ctx, sel(['workspace', 'w1']), OPTS)).rejects.toThrow('can import boards');
    await expect(adapter.estimate(ctx, sel(['board', 'abc']), OPTS)).rejects.toThrow('not valid');
    await expect(adapter.estimate(ctx, sel(['board', '999']), OPTS)).rejects.toMatchObject({ status: 404 });
    await expect(adapter.estimate(ctx, sel(['board', BID.sub]), OPTS)).rejects.toMatchObject({ status: 404 });
  });
});

describe('MondayAdapter fetchBundle', () => {
  it('the first page is the structure: people, every board as a project with its statuses, the shared custom fields; no tasks yet', async () => {
    const r = await make(fakeMonday()).adapter.fetchBundle({ ctx, selection: sel(['board', BID.sprint], ['board', BID.groups]), options: OPTS, cursor: null });
    const page = r.bundle as CanonicalBundle;
    expect(page.source).toEqual({ system: 'monday', displayName: 'monday.com' });
    expect(page.tasks).toBeUndefined();
    expect(page.projects!.map((p) => p.externalId)).toEqual([BID.sprint, BID.groups]);
    expect(page.users!.map((u) => u.externalId)).toEqual(['1', '2', '3']);
    expect(page.customFields!.map((f) => f.name).sort()).toEqual(['Budget', 'Labels', 'Notes', 'Reviewed', 'Spec', 'Timeline (end)']);
    expect(r.next).toMatchObject({ v: 1, i: 0, cur: null, pos: 0, skip: 0 });
    expect((r.next as any).plans.map((p: BoardPlan) => p.kind)).toEqual(['column', 'group']);
    expect(validateBundle(page)).not.toHaveProperty('fatal');
  });

  it('an empty selection ends at the structure page', async () => {
    const r = await make(fakeMonday()).adapter.fetchBundle({ ctx, selection: sel(), options: OPTS, cursor: null });
    expect(r.next).toBeNull();
  });

  it('reads everything: every page validates, ends, and the cursors are plain JSON that survive a round trip', async () => {
    const { pages, cursors } = await runAll(make(fakeMonday()).adapter);
    for (const p of pages) {
      const checked = validateBundle(p);
      expect(checked).not.toHaveProperty('fatal');
      expect((checked as { issues?: Array<{ severity: string }> }).issues?.filter((i) => i.severity === 'ERROR') ?? []).toEqual([]);
    }
    for (const c of cursors) expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it('statuses, priorities, people, dates, tags and custom values land on the right task', async () => {
    const t = byId((await runAll(make(fakeMonday()).adapter)).pages);
    const a = t.get('1001')!;
    expect(a).toMatchObject({ projectExternalId: BID.sprint, title: 'Design the login page', statusExternalId: `${BID.sprint}:s:0`, priority: 'High', assigneeExternalIds: ['2'], creatorExternalId: '1', dueDate: '2026-03-01T13:30:00.000Z', startDate: '2026-02-01T00:00:00.000Z', tags: ['Group: This sprint'], url: 'https://acme.monday.com/boards/1001000/pulses/1001' });
    expect(a.customValues!.map((c) => c.value)).toEqual(expect.arrayContaining([['ui', 'api'], 1250.5, 'Remember SSO', 'https://example.com/spec', true, '2026-02-20T00:00:00.000Z']));
    expect(a.customValues).toHaveLength(6);
    expect(t.get('1002')!.statusExternalId).toBe(`${BID.sprint}:s:1`);
    expect(t.get('1003')!.statusExternalId).toBe(`${BID.sprint}:__none`);
    expect(t.get('1004')!.statusExternalId).toBe(`${BID.sprint}:s:2`);
    expect(t.get('3002')).toMatchObject({ projectExternalId: BID.groups, statusExternalId: `${BID.groups}:g:doing` });
    expect(t.get('3001')).toMatchObject({ assigneeExternalIds: ['1'], dueDate: '2026-04-01T00:00:00.000Z' });
  });

  it('every task points at a status that exists on the structure page (no dangling status)', async () => {
    const { pages } = await runAll(make(fakeMonday()).adapter);
    const known = new Set(pages[0].projects!.flatMap((p) => p.statuses!.map((s) => s.externalId)));
    for (const x of tasksOf(pages)) expect(known.has(x.statusExternalId!)).toBe(true);
  });

  it('subitems arrive with their parent, by type; dependencies blocker -> blocked (an unknown blocker is a pending edge)', async () => {
    const { pages } = await runAll(make(fakeMonday()).adapter, sel(['board', BID.sprint]));
    const t = byId(pages);
    expect(t.get('2001')).toMatchObject({ parentExternalId: '1001', statusExternalId: `${BID.sprint}:s:1`, assigneeExternalIds: ['1'], dueDate: '2026-02-10T00:00:00.000Z' });
    expect(t.get('2002')).toMatchObject({ parentExternalId: '1001', statusExternalId: `${BID.sprint}:s:0`, dueDate: '2026-02-12T00:00:00.000Z' });
    const deps = pages.flatMap((p) => p.dependencies ?? []);
    expect(deps).toEqual(expect.arrayContaining([{ externalId: 'dep:1002>1001', fromExternalId: '1002', toExternalId: '1001', type: 'BLOCKS' }, { externalId: 'dep:5555>1001', fromExternalId: '5555', toExternalId: '1001', type: 'BLOCKS' }]));
    const ids = tasksOf(pages).map((x) => x.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('comments (replies one level deep, oldest first) and files (item + update files, deduplicated, ONE call per 100 items)', async () => {
    const fake = fakeMonday();
    const { pages } = await runAll(make(fake).adapter, sel(['board', BID.sprint]));
    const t = byId(pages).get('1001')!;
    expect(t.comments!.map((c) => [c.externalId, c.body, c.parentExternalId])).toEqual([['9001', 'Hello **team**', undefined], ['9101', 'First reply', '9001'], ['9102', 'Later reply', '9001'], ['9002', 'Second update', undefined]]);
    expect(t.attachments!.map((a) => [a.externalId, a.fileName, a.providerRef])).toEqual([['1001:7001', 'design.png', 'monday-asset:7001'], ['1001:7002', 'spec.pdf', 'monday-asset:7002'], ['1001:7009', 'passwd', 'monday-asset:7009']]);
    expect(fake.calls.filter((c) => /items\(ids: \$ids/.test(c.query))).toHaveLength(1); // 4 items, one call
    const quiet = fakeMonday();
    const q = byId((await runAll(make(quiet).adapter, sel(['board', BID.sprint]), QUIET)).pages).get('1001')!;
    expect(q.comments).toBeUndefined();
    expect(q.attachments).toBeUndefined();
    expect(quiet.calls.some((c) => /items\(ids: \$ids/.test(c.query))).toBe(false);
  });

  it('comments only / files only ask for only that', async () => {
    const fake = fakeMonday();
    await runAll(make(fake).adapter, sel(['board', BID.sprint]), { ...OPTS, attachments: false });
    const q = fake.calls.find((c) => /items\(ids: \$ids/.test(c.query))!.query;
    expect(q).toContain('replies');
    expect(q).not.toContain('file_extension');
    const f2 = fakeMonday();
    await runAll(make(f2).adapter, sel(['board', BID.sprint]), { ...OPTS, comments: false });
    const q2 = f2.calls.find((c) => /items\(ids: \$ids/.test(c.query))!.query;
    expect(q2).toContain('file_extension');
    expect(q2).not.toContain('replies');
  });

  it('a big board is read 100 at a time through the cursor (230 items = 3 pages) and ends', async () => {
    const fake = fakeMonday();
    const { pages } = await runAll(make(fake).adapter, sel(['board', BID.big]), QUIET);
    expect(pages.filter((p) => p.tasks).map((p) => p.tasks!.length)).toEqual([100, 100, 30]);
    expect(fake.calls.filter((c) => /items_page\(|next_items_page\(/.test(c.query))).toHaveLength(3);
    expect(fake.calls.find((c) => /next_items_page/.test(c.query))!.variables).toMatchObject({ limit: 100, cursor: expect.stringMatching(/^cur:1002000:100:/) });
  });

  it('a page that would exceed the task limit (parents + subitems) is SPLIT, nothing lost or repeated, no page above 1000', async () => {
    const { pages } = await runAll(make(fakeMonday()).adapter, sel(['board', BID.heavy]), QUIET);
    const sizes = pages.filter((p) => p.tasks).map((p) => p.tasks!.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    const ids = tasksOf(pages).map((x) => x.externalId);
    expect(ids).toHaveLength(12 + 12 * 150);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of pages) expect(validateBundle(p)).not.toHaveProperty('fatal');
  });

  it('re-fetching a page with a cursor already used gives the same page (at-least-once)', async () => {
    const adapter = make(fakeMonday()).adapter;
    const { cursors } = await runAll(adapter, sel(['board', BID.big]), QUIET);
    const mid = cursors[2];
    const a = await adapter.fetchBundle({ ctx, selection: sel(['board', BID.big]), options: QUIET, cursor: mid });
    const b = await adapter.fetchBundle({ ctx, selection: sel(['board', BID.big]), options: QUIET, cursor: mid });
    expect(a).toEqual(b);
  });

  it('the chosen fields drive the import: status = the Priority column, priority then unmapped; group as the workflow; none', async () => {
    const asPrio = byId((await runAll(make(fakeMonday()).adapter, sel(['board', BID.sprint, { status: 'priority' }]), QUIET)).pages);
    expect(asPrio.get('1001')).toMatchObject({ statusExternalId: `${BID.sprint}:s:2` });
    expect(asPrio.get('1001')!.priority).toBeUndefined(); // that column was spent on the status
    const grp = await runAll(make(fakeMonday()).adapter, sel(['board', BID.sprint, { status: GROUP_FIELD_ID }]), QUIET);
    expect(byId(grp.pages).get('1001')).toMatchObject({ statusExternalId: `${BID.sprint}:g:g2` });
    expect(byId(grp.pages).get('1001')!.tags).toBeUndefined();
    const none = byId((await runAll(make(fakeMonday()).adapter, sel(['board', BID.sprint, { status: null, due: null }]), QUIET)).pages);
    expect(none.get('1001')).toMatchObject({ statusExternalId: `${BID.sprint}:__none` });
    expect(none.get('1001')!.dueDate).toBeUndefined();
  });

  it('a board that was removed mid-way is a 404 for the job, not an empty success', async () => {
    const { adapter } = make(fakeMonday());
    const first = await adapter.fetchBundle({ ctx, selection: sel(['board', BID.groups]), options: OPTS, cursor: null });
    const missing = { ...(first.next as any), plans: [{ ...(first.next as any).plans[0], id: '777' }] };
    await expect(adapter.fetchBundle({ ctx, selection: sel(['board', BID.groups]), options: OPTS, cursor: missing })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a cursor that is not ours', async () => {
    const { adapter } = make(fakeMonday());
    const good = (await adapter.fetchBundle({ ctx, selection: sel(['board', BID.groups]), options: OPTS, cursor: null })).next as any;
    const bads = [{}, { ...good, v: 2 }, { ...good, i: 5 }, { ...good, cur: 7 }, { ...good, pos: -1 }, { ...good, skip: 1.5 }, { ...good, plans: [{ ...good.plans[0], kind: 'x' }] }, { ...good, plans: [{ ...good.plans[0], sv: [1] }] }, { ...good, plans: [{ ...good.plans[0], cm: { a: 1 } }] }, 'x'];
    for (const bad of bads) await expect(adapter.fetchBundle({ ctx, selection: sel(['board', BID.groups]), options: OPTS, cursor: bad })).rejects.toThrow('cursor is not valid');
  });
});

describe('MondayAdapter: a dead cursor (monday keeps them 60 minutes)', () => {
  it('is rebuilt with a cheap id-only walk and the import completes without loss or repeats', async () => {
    const fake = fakeMonday();
    const adapter = make(fake).adapter;
    // call 0 = structure, 1 = items 0-99 (epoch 1), 2 = items 100-199 -> kill epoch 1 before call 3 (items 200-229)
    const { pages } = await runAll(adapter, sel(['board', BID.big]), QUIET, (n) => { if (n === 3) fake.expireEpoch(1); });
    const ids = tasksOf(pages).map((x) => x.externalId);
    expect(ids).toHaveLength(230);
    expect(new Set(ids).size).toBe(230);
    expect(ids).toEqual(Array.from({ length: 230 }, (_, i) => String(20000 + i)));
    const walks = fake.calls.filter((c) => /items_page|next_items_page/.test(c.query) && !/column_values/.test(c.query));
    expect(walks.length).toBeGreaterThanOrEqual(2); // id-only pages to get back to item 200
    expect(fake.epochs).toBeGreaterThanOrEqual(2); // a new first-page request = a new cursor life
  });

  it('a first page can never be "expired": the error surfaces', async () => {
    const fake = fakeMonday(DATASET, { intercept: (q) => (/items_page\(/.test(q) && !/next_items_page/.test(q) ? fake.err('The cursor is expired or invalid', { code: 'CursorExpiredError' }) : undefined) });
    await expect(runAll(make(fake).adapter, sel(['board', BID.big]), QUIET)).rejects.toThrow(/cursor/i);
  });

  it('a board that shrank below the saved position ends cleanly', async () => {
    const fake = fakeMonday();
    const adapter = make(fake).adapter;
    const first = await adapter.fetchBundle({ ctx, selection: sel(['board', BID.groups]), options: QUIET, cursor: null });
    fake.expireEpoch(1);
    const stale = { ...(first.next as any), cur: 'cur:1003000:100:1', pos: 5000 };
    const r = await adapter.fetchBundle({ ctx, selection: sel(['board', BID.groups]), options: QUIET, cursor: stale });
    expect((r.bundle as CanonicalBundle).tasks).toBeUndefined();
    expect(r.next).toBeNull();
  });
});

describe('MondayClient: errors, pacing, version', () => {
  it('HTTP 401 and an application-level "not authenticated" (HTTP 200!) both pause the job', async () => {
    await expect(make(fakeMonday()).adapter.discover({ ...ctx, accessToken: 'old' })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    const f = fakeMonday(DATASET, { intercept: () => f.err('Not Authenticated') });
    await expect(make(f).adapter.discover(ctx)).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('the DAILY limit waits until 00:00 UTC; the complexity budget and concurrency use retry_in_seconds', async () => {
    const daily = fakeMonday(DATASET, { intercept: () => daily.err('Daily limit exceeded', { code: 'DAILY_LIMIT_EXCEEDED' }) });
    const e = await make(daily).adapter.discover(ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderRateLimitedError);
    expect(e.retryAfterMs).toBeGreaterThan(0);
    expect(e.retryAfterMs).toBeLessThanOrEqual(86_400_000);
    for (const [code, secs] of [['COMPLEXITY_BUDGET_EXHAUSTED', 17], ['maxConcurrencyExceeded', 5], ['IP_RATE_LIMIT_EXCEEDED', 9]] as const) {
      const f = fakeMonday(DATASET, { intercept: () => f.err('limit', { code, retry_in_seconds: secs }) });
      const err = await make(f).adapter.discover(ctx).catch((x) => x);
      expect(err).toBeInstanceOf(ProviderRateLimitedError);
      expect(err.retryAfterMs).toBe(secs * 1000);
    }
    const noHint = fakeMonday(DATASET, { intercept: () => noHint.err('Complexity budget exhausted') });
    expect((await make(noHint).adapter.discover(ctx).catch((x) => x)).retryAfterMs).toBe(60_000);
  });

  it('midnight UTC arithmetic', () => {
    expect(msUntilMidnightUtc(Date.UTC(2026, 10, 1, 23, 0, 0))).toBe(3_600_000);
    expect(msUntilMidnightUtc(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(1000);
    expect(msUntilMidnightUtc(Date.UTC(2026, 10, 1, 0, 0, 0))).toBe(86_400_000);
  });

  it('an HTTP 429 with Retry-After -> ProviderRateLimitedError', async () => {
    const f = fakeMonday(DATASET, { intercept: () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) });
    expect(await make(f, {}, { maxInlineWaitMs: 1 }).adapter.discover(ctx).catch((x) => x)).toBeInstanceOf(ProviderRateLimitedError);
  });

  it('403 / 404 about one object keep their status; anything else is a 400; a 5xx is a ProviderHttpError; junk and empty answers are 502', async () => {
    const status = async (resp: () => Response) => (await make(fakeMonday(DATASET, { intercept: resp })).adapter.discover(ctx).catch((x) => x)) as ProviderHttpError;
    expect((await status(() => new Response(JSON.stringify({ errors: [{ message: 'x', extensions: { status_code: 404 } }] })))).status).toBe(404);
    expect((await status(() => new Response(JSON.stringify({ errors: [{ message: 'x', extensions: { code: 'USER_UNAUTHORIZED', status_code: 403 } }] })))).status).toBe(403);
    expect((await status(() => new Response(JSON.stringify({ errors: [{ message: 'Parse error on "x"' }] })))).status).toBe(400);
    expect((await status(() => new Response('boom', { status: 500 }))).status).toBe(500);
    expect((await status(() => new Response('<html>', { status: 200 }))).status).toBe(502);
    expect((await status(() => new Response(JSON.stringify({ data: null })))).status).toBe(502);
  });

  it('every call carries the PINNED API version (a missing header floats to Current); it is configurable, and a malformed value is ignored', async () => {
    const f = fakeMonday();
    await make(f).adapter.discover(ctx);
    expect(f.calls.every((c) => c.headers['api-version'] === '2026-07')).toBe(true);
    const f2 = fakeMonday();
    await make(f2, { MONDAY_API_VERSION: '2026-10' }).adapter.discover(ctx);
    expect(f2.calls.every((c) => c.headers['api-version'] === '2026-10')).toBe(true);
    const f3 = fakeMonday();
    await make(f3, { MONDAY_API_VERSION: 'latest' }).adapter.discover(ctx);
    expect(f3.calls.every((c) => c.headers['api-version'] === '2026-07')).toBe(true);
  });

  it('the token goes in Authorization as monday documents it (bare, no "Bearer")', async () => {
    const f = fakeMonday();
    await make(f).adapter.discover(ctx);
    expect(f.calls[0].headers.authorization).toBe('tok');
  });

  it('every query also asks for the complexity bookkeeping (free) and the typed data does not carry it', async () => {
    const f = fakeMonday();
    const { nodes } = await make(f).adapter.discover(ctx);
    expect(f.calls.every((c) => c.query.includes('complexity { query before after reset_in_x_seconds }'))).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
    const off = fakeMonday();
    await make(off, { MONDAY_COMPLEXITY_PACING: 'false' }).adapter.discover(ctx);
    expect(off.calls.some((c) => c.query.includes('complexity {'))).toBe(false);
  });

  it('when the remaining complexity is low the NEXT call waits for the reset (capped), instead of provoking an exhausted-budget error', async () => {
    const low = fakeMonday({ ...DATASET, complexityAfter: 100_000 });
    const { adapter, sleep } = make(low);
    await adapter.discover(ctx);
    expect(sleep).toHaveBeenCalled();
    const waited = sleep.mock.calls[0][0];
    expect(waited).toBeGreaterThan(41_000);
    expect(waited).toBeLessThanOrEqual(42_000);
    const high = make(fakeMonday());
    await high.adapter.discover(ctx);
    expect(high.sleep).not.toHaveBeenCalled();
    const off = make(fakeMonday({ ...DATASET, complexityAfter: 10 }), { MONDAY_COMPLEXITY_PACING: 'false' });
    await off.adapter.discover(ctx);
    expect(off.sleep).not.toHaveBeenCalled();
  });

  it('pacing settings are bounded', () => {
    const rpm = (v?: string) => new MondayClient({} as never, cfgOf(v === undefined ? {} : { MONDAY_REQUESTS_PER_MINUTE: v })).requestsPerMinute;
    expect([rpm(), rpm('1000'), rpm('5'), rpm('x'), rpm('99999')]).toEqual([600, 1000, 600, 600, 600]);
  });

  it('users that cannot be read degrade to a warning (people matched by name), not a failure', async () => {
    const e = await make(fakeMonday({ ...DATASET, failUsers: true })).adapter.estimate(ctx, sel(['board', BID.groups]), OPTS);
    expect(e.warnings!.map((w) => w.code)).toContain('USERS_UNAVAILABLE');
    expect(e.users).toBe(0);
  });
});

describe('MondayAdapter fetchAttachment', () => {
  const ref = (id: string) => ({ ctx, providerRef: assetRef(id) });

  it('asks for a fresh public_url NOW and streams it WITHOUT the access token (a public URL is public; the token must not travel to storage)', async () => {
    const fake = fakeMonday();
    const f = await make(fake).adapter.fetchAttachment(ref('7001'));
    expect(await read(f.stream)).toBe('PNGDATA');
    expect(f).toMatchObject({ sizeBytes: 7, mimeType: 'image/png' });
    expect(fake.calls.find((c) => /assets\(ids/.test(c.query))!.variables).toEqual({ ids: ['7001'] });
    expect(fake.fileCalls).toEqual([{ url: DL_OK, auth: null }]);
    const s3 = fakeMonday();
    expect(await read((await make(s3).adapter.fetchAttachment(ref('7002'))).stream)).toBe('PDFDATA');
    expect(s3.fileCalls).toEqual([{ url: DL_S3, auth: null }]);
  });

  it.each([['an unknown host', '7003'], ['plain http', '7004'], ['an IP address', '7005'], ['a look-alike host', '7006']])('refuses %s with a 400 and makes NO file request', async (_n, id) => {
    const fake = fakeMonday();
    await expect(make(fake).adapter.fetchAttachment(ref(id))).rejects.toMatchObject({ status: 400 });
    expect(fake.fileCalls).toEqual([]);
  });

  it('a host the operator allowed (MONDAY_FILE_HOSTS) is fetched; the allow-list does not widen beyond it', async () => {
    const fake = fakeMonday();
    expect(await read((await make(fake, { MONDAY_FILE_HOSTS: '.example-files.test, bad host!' }).adapter.fetchAttachment(ref('7008'))).stream)).toBe('EXTRA');
    const strict = fakeMonday();
    await expect(make(strict).adapter.fetchAttachment(ref('7008'))).rejects.toMatchObject({ status: 400 });
  });

  it('no address -> 422, a gone file -> 404 (for THAT file only)', async () => {
    await expect(make(fakeMonday()).adapter.fetchAttachment(ref('7007'))).rejects.toMatchObject({ status: 422 });
    await expect(make(fakeMonday()).adapter.fetchAttachment(ref('777'))).rejects.toMatchObject({ status: 404 });
  });

  it.each(['https://files.monday.com/a/1.png', 'monday-asset:1/../2', 'monday-asset:', '', 'asana-attachment:1'])('refuses the ref %j before any request', async (providerRef) => {
    const fake = fakeMonday();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef })).rejects.toMatchObject({ status: 400 });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('an expired token is ProviderAuthRejectedError', async () => {
    await expect(make(fakeMonday()).adapter.fetchAttachment({ ctx: { ...ctx, accessToken: 'old' }, providerRef: assetRef('7001') })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('guards the fixtures themselves', () => {
    expect(Object.keys(FILES)).toEqual(expect.arrayContaining([DL_OK, DL_S3]));
    expect(ME).toBe('1');
  });
});
