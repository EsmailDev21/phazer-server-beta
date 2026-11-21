import { Priority, TaskStatus } from '@prisma/client';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { buildInventory } from '../../../imports/mapping/mapping.inventory';
import { applyMapping, mappedTaskHash } from '../../../imports/mapping/mapping.apply';
import { resolve } from '../../../imports/mapping/mapping.resolve';
import { MappedPage } from '../../../imports/mapping/mapping.types';
import { ANA, BEN, CLEO, CONTEXT, IMPORTER } from '../../../imports/mapping/fixtures/provider-fixtures';
import { LinearAdapter } from './linear.adapter';
import { LinearClient } from './linear.client';
import { fakeLinear } from './fixtures/linear-responses';

/**
 * Contract: what the Linear adapter emits is what the validator, the mapping engine (4.3) and - through MappedPage - the
 * executor (4.4) accept, for a realistic dataset. The adapter's pages are run through the same pipeline the executor uses
 * (validateBundle -> applyMapping) with the inventory the estimate builds. Fixtures are SYNTHETIC (see linear-responses.ts).
 */
const noRedis = { configured: false, isReady: () => false } as never;
const ctx = { connectionId: 'conn-1', externalAccountId: 'org-1', accessToken: 'tok' };
const selection = { sources: [{ id: 'team-eng', type: 'team' }, { id: 'team-ops', type: 'team' }] };

async function pipeline(config: Parameters<typeof resolve>[2] = { version: 1 }, context: typeof CONTEXT = CONTEXT) {
  const fake = fakeLinear();
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
  const adapter = new LinearAdapter({ get: () => undefined } as never, http, new LinearClient(http));
  const est = await adapter.estimate(ctx, selection, { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false, history: false });
  const resolution = resolve(est.inventory!, context, config);

  const validated: CanonicalBundle[] = [];
  let cursor: unknown = null;
  do {
    const r = await adapter.fetchBundle({ ctx, selection, options: DEFAULT_IMPORT_OPTIONS, cursor });
    const v = validateBundle(r.bundle);
    if ('fatal' in v) throw new Error(JSON.stringify(v.fatal));
    validated.push(v.bundle);
    cursor = r.next;
  } while (cursor !== null);
  const mapped: MappedPage[] = validated.map((b) => applyMapping(b, resolution.resolved));
  return { est, resolution, validated, mapped, tasks: mapped.flatMap((m) => m.tasks), page0: mapped[0] };
}

describe('Linear adapter -> validator -> mapping engine (step 4.5 contract)', () => {
  it('the estimate\'s inventory is accepted as-is and, with the people known, needs little attention', async () => {
    const { resolution } = await pipeline();
    expect(resolution.attention.filter((a) => a.kind === 'STATUS' || a.kind === 'PRIORITY')).toEqual([]);
  });

  it('workflow: Linear state types become our categories, per team, with the same names kept apart by team', async () => {
    const { page0 } = await pipeline();
    const [eng, ops] = page0.projects;
    expect(eng.statuses.map((s) => [s.name, s.category, s.excludeFromProgress])).toEqual([
      ['Triage', TaskStatus.TODO, false], ['Backlog', TaskStatus.TODO, false], ['Todo', TaskStatus.TODO, false],
      ['In Progress', TaskStatus.IN_PROGRESS, false], ['In Review', TaskStatus.IN_PROGRESS, false],
      ['Done', TaskStatus.DONE, false], ['Canceled', TaskStatus.DONE, true], ['Duplicate', TaskStatus.DONE, true],
    ]);
    expect(ops.statuses.map((s) => s.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done']);
    // ids are unique across teams even though the names repeat
    const ids = [...eng.statuses, ...ops.statuses].map((s) => s.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(eng.initialStatusExternalId).toBe('team-eng:s-eng-triage');
  });

  it('every task points at a status that exists in ITS project', async () => {
    const { page0, tasks } = await pipeline();
    const byProject = new Map(page0.projects.map((p) => [p.externalId, new Set(p.statuses.map((s) => s.externalId))]));
    for (const t of tasks) {
      expect(t.projectExternalId).toBeDefined();
      if (t.workflowStatusExternalId) expect(byProject.get(t.projectExternalId!)!.has(t.workflowStatusExternalId)).toBe(true);
    }
  });

  it('priorities: Urgent / High / Medium / Low map; "No priority" is no value', async () => {
    const { tasks } = await pipeline();
    const prio = Object.fromEntries(tasks.map((t) => [t.externalId, t.priority]));
    expect(prio).toMatchObject({ 'i-eng-1': Priority.URGENT, 'i-eng-2': Priority.HIGH, 'i-eng-3': Priority.LOW, 'i-eng-5': Priority.MEDIUM, 'i-eng-4': null, 'i-ops-1': Priority.HIGH });
  });

  it('task status category follows the Linear state type', async () => {
    const { tasks } = await pipeline();
    const st = Object.fromEntries(tasks.map((t) => [t.externalId, t.status]));
    expect(st).toMatchObject({ 'i-eng-1': TaskStatus.IN_PROGRESS, 'i-eng-2': TaskStatus.IN_PROGRESS, 'i-eng-3': TaskStatus.DONE, 'i-eng-4': TaskStatus.DONE, 'i-eng-5': TaskStatus.TODO, 'i-ops-2': TaskStatus.DONE });
  });

  it('people: a verified e-mail match is assigned; an unverified one, a hidden e-mail and a bot are not guessed', async () => {
    const lin = { ...CONTEXT, members: [{ ...ANA, email: 'ana@example.com' }, { ...BEN }, CLEO, { userId: IMPORTER, name: 'Importer', email: 'importer@example.com', emailVerified: true }] };
    const { tasks } = await pipeline({ version: 1 }, lin);
    const byId = Object.fromEntries(tasks.map((t) => [t.externalId, t]));
    expect(byId['i-eng-1'].assigneeUserIds).toEqual([ANA.userId]); // Ana: verified match
    expect(byId['i-eng-2'].assigneeUserIds).toEqual([]); // Ben: his member e-mail is NOT verified
    expect(byId['i-eng-6'].assigneeUserIds).toEqual([]); // the bot
    expect(byId['i-ops-1'].assigneeUserIds).toEqual([]); // no e-mail visible: not guessed
  });

  it('structure rides along: cycles -> iterations, the project select field, labels -> tags, sub-issue -> parent', async () => {
    const { mapped, tasks } = await pipeline();
    const iterations = mapped.flatMap((m) => m.iterations);
    expect(iterations.map((i) => [i.externalId, i.kind, i.name, i.projectExternalId])).toEqual([
      ['c-1', 'CYCLE', 'Spring push', 'team-eng'], ['c-2', 'CYCLE', 'Cycle 2', 'team-eng'],
    ]);
    expect(mapped[0].customFields).toEqual([expect.objectContaining({ externalId: 'linear-project', name: 'Linear project', dataType: 'SELECT', options: ['Web app', 'Public API'] })]);
    const byId = Object.fromEntries(tasks.map((t) => [t.externalId, t]));
    expect(byId['i-eng-1']).toMatchObject({ tags: ['Bug', 'Frontend'], iterationExternalId: 'c-1', estimate: 3, key: 'ENG-1' });
    expect(byId['i-eng-1'].customValues).toEqual([{ fieldExternalId: 'linear-project', target: { kind: 'create' }, value: 'Web app' }]);
    expect(byId['i-eng-2'].parentExternalId).toBe('i-eng-1');
    expect(byId['i-eng-3'].archived).toBe(true);
    expect(byId['i-ops-1'].customValues[0].value).toBe('web APP'); // OPS's own spelling is a value; the option list has the first spelling
  });

  it('dependencies reach the executor in the shape it writes', async () => {
    const { mapped } = await pipeline();
    expect(mapped.flatMap((m) => m.dependencies).map((d) => [d.fromExternalId, d.toExternalId, d.type])).toEqual([['i-eng-1', 'i-eng-2', 'BLOCKS'], ['i-eng-1', 'i-eng-3', 'RELATES_TO'], ['i-eng-1', 'i-eng-4', 'RELATES_TO'], ['i-ops-2', 'i-ops-1', 'BLOCKS']]);
  });

  it('the one blank title is repaired by the validator, not by the adapter', async () => {
    const { tasks } = await pipeline();
    expect(tasks.find((t) => t.externalId === 'i-eng-7')!.title.trim().length).toBeGreaterThan(0);
  });

  it('a second run over the same data maps to byte-identical tasks (what makes a re-run a no-op)', async () => {
    const a = await pipeline();
    const b = await pipeline();
    expect(b.tasks.map(mappedTaskHash)).toEqual(a.tasks.map(mappedTaskHash));
  });
});
