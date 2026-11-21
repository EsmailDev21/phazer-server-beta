import { sha256Hex } from '../assets/asset.policy';
import { SEED_DEFINITIONS } from './definitions';
import { evaluateRuleItem, evaluateViewItem } from '../portable';
import { modelFromBlueprint } from '../portable/portable.from-blueprint';
import { prepareSeed } from './seed.prepare';
import { SeedDefinition } from './seed.types';

const base = (): SeedDefinition =>
  JSON.parse(
    JSON.stringify(SEED_DEFINITIONS.find((d) => d.seedKey === 'sprint-board')),
  );
const withFile = (): SeedDefinition => ({
  ...base(),
  files: [
    { key: 'f', fileName: 'notes.md', mimeType: 'text/markdown', text: '# hi' },
  ],
});

describe('first-party seed definitions (step 3.9)', () => {
  it('has the three starting templates with unique, well-formed keys', () => {
    const keys = SEED_DEFINITIONS.map((d) => d.seedKey);
    expect(keys).toEqual([
      'student-workspace',
      'sprint-board',
      'content-calendar',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(SEED_DEFINITIONS.map((d) => [d.seedKey, d] as const))(
    '%s prepares: valid blueprint, files hashed from their bytes',
    (_k, def) => {
      const p = prepareSeed(def);
      expect(p.ok).toBe(true);
      if (p.ok === false) return;
      expect(p.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      const declared = p.blueprint.assets ?? [];
      expect(declared.map((a) => a.key)).toEqual(p.files.map((f) => f.key));
      for (const f of p.files) {
        const a = declared.find((x) => x.key === f.key)!;
        expect(a.sha256).toBe(sha256Hex(f.bytes));
        expect(a.sizeBytes).toBe(f.bytes.length);
      }
    },
  );

  it('is deterministic: preparing twice gives the same checksum (so re-seeding writes nothing)', () => {
    for (const d of SEED_DEFINITIONS) {
      const a = prepareSeed(d);
      const b = prepareSeed(d);
      expect(a.ok && b.ok && a.checksum === b.checksum).toBe(true);
    }
  });

  it('student-workspace ships a real, readable rubric (not a stand-in hash)', () => {
    const p = prepareSeed(SEED_DEFINITIONS[0]);
    if (p.ok === false) throw new Error('expected ok');
    expect(p.files).toHaveLength(1);
    expect(p.files[0].bytes.toString('utf8')).toContain('# Essay rubric');
    expect(p.files[0].sha256).not.toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });

  it('does not mutate the definition it is given', () => {
    const d = withFile();
    const before = JSON.stringify(d);
    prepareSeed(d);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('changing the content changes the checksum; the same content with another changelog does not', () => {
    const a = prepareSeed(base());
    const edited = base();
    (edited.blueprint.meta as { description: string }).description =
      'Something else entirely.';
    const b = prepareSeed(edited);
    const c = prepareSeed({ ...base(), changelog: 'different words' });
    if (a.ok === false || b.ok === false || c.ok === false)
      throw new Error('expected ok');
    expect(b.checksum).not.toBe(a.checksum);
    expect(c.checksum).toBe(a.checksum);
  });

  describe('refuses what must never be published', () => {
    const problems = (d: SeedDefinition) => {
      const p = prepareSeed(d);
      return p.ok === false ? p.problems.join(' | ') : '';
    };
    it('a malformed seed key', () => {
      expect(problems({ ...base(), seedKey: 'Bad Key' })).toContain(
        'not a valid key',
      );
      expect(problems({ ...base(), seedKey: '1abc' })).toContain(
        'not a valid key',
      );
    });
    it('a blueprint that declares its own assets', () => {
      const d = base();
      d.blueprint.assets = [];
      expect(problems(d)).toContain('must not declare `assets`');
    });
    it('a file the asset policy refuses (by extension, by content, empty)', () => {
      expect(
        problems({
          ...withFile(),
          files: [
            {
              key: 'f',
              fileName: 'run.exe',
              mimeType: 'text/plain',
              text: 'x',
            },
          ],
        }),
      ).toContain('BLOCKED_TYPE');
      expect(
        problems({
          ...withFile(),
          files: [
            {
              key: 'f',
              fileName: 'a.txt',
              mimeType: 'text/plain',
              text: '#!/bin/sh\necho hi',
            },
          ],
        }),
      ).toContain('BLOCKED_CONTENT');
      expect(
        problems({
          ...withFile(),
          files: [
            { key: 'f', fileName: 'a.txt', mimeType: 'text/plain', text: '' },
          ],
        }),
      ).toContain('EMPTY');
    });
    it('a file key used twice', () => {
      const f = {
        key: 'f',
        fileName: 'a.md',
        mimeType: 'text/markdown',
        text: 'a',
      };
      expect(
        problems({
          ...withFile(),
          files: [f, { ...f, fileName: 'b.md', text: 'b' }],
        }),
      ).toContain('used twice');
    });
    it('a blueprint the validator rejects', () => {
      const d = base();
      (d.blueprint as { schemaVersion: number }).schemaVersion = 99;
      expect(problems(d)).not.toBe('');
    });
    it('a task that attaches a file nobody shipped', () => {
      const d = JSON.parse(
        JSON.stringify(SEED_DEFINITIONS[0]),
      ) as SeedDefinition;
      d.files = [];
      expect(problems(d)).not.toBe('');
    });
  });
});

describe('first-party automations and views (step 5.7)', () => {
  const prepared = (key: string) => {
    const p = prepareSeed(SEED_DEFINITIONS.find((d) => d.seedKey === key)!);
    if (p.ok === false) throw new Error(JSON.stringify(p.problems));
    return p.blueprint;
  };
  type Found = {
    project: string;
    item: Record<string, unknown>;
    kind: 'automation' | 'view';
  };
  const items = (key: string): Found[] =>
    prepared(key).projects.flatMap((p) => [
      ...(p.automations ?? []).map((a): Found => ({
        project: p.nodeKey,
        item: a as Record<string, unknown>,
        kind: 'automation',
      })),
      ...(p.views ?? []).map((v): Found => ({
        project: p.nodeKey,
        item: v as Record<string, unknown>,
        kind: 'view',
      })),
    ]);

  it.each([
    ['student-workspace', 4, 5],
    ['sprint-board', 5, 5],
    ['content-calendar', 4, 4],
  ])('%s ships %i automations and %i views', (key, automations, views) => {
    const all = items(key);
    expect(all.filter((i) => i.kind === 'automation')).toHaveLength(
      automations,
    );
    expect(all.filter((i) => i.kind === 'view')).toHaveLength(views);
  });

  it('every item is in the portable form (no leftover opaque ones), with unique names per project', () => {
    for (const key of SEED_DEFINITIONS.map((d) => d.seedKey)) {
      const all = items(key);
      for (const { item, kind } of all)
        expect(item.kind).toBe(kind === 'automation' ? 'rule.v1' : 'view.v1');
      for (const kind of ['automation', 'view'] as const) {
        const names = all
          .filter((i) => i.kind === kind)
          .map((i) => `${i.project}|${String(i.item.name).toLowerCase()}`);
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });

  it('every shipped rule is RUNNABLE once switched on: nothing it uses is unsupported', () => {
    for (const key of SEED_DEFINITIONS.map((d) => d.seedKey)) {
      const bp = prepared(key);
      const model = modelFromBlueprint(bp);
      for (const p of bp.projects) {
        for (const a of p.automations ?? []) {
          const r = evaluateRuleItem(a, model, p.nodeKey);
          expect(r.ok).toBe(true);
          if (r.ok && r.kind === 'rule')
            expect([
              key,
              (a as { name: string }).name,
              r.unsupported.map((u) => u.construct),
            ]).toEqual([key, (a as { name: string }).name, []]);
        }
        for (const v of p.views ?? [])
          expect(evaluateViewItem(v, model, p.nodeKey).ok).toBe(true);
      }
    }
  });

  it('they use the new triggers and actions, so the whole range is exercised by something real', () => {
    const triggers = new Set<string>();
    const actions = new Set<string>();
    for (const key of SEED_DEFINITIONS.map((d) => d.seedKey)) {
      for (const { item, kind } of items(key)) {
        if (kind !== 'automation') continue;
        triggers.add((item.trigger as { type: string }).type);
        for (const a of item.actions as Array<{ type: string }>)
          actions.add(a.type);
      }
    }
    for (const t of [
      'STATUS_CHANGED',
      'ALL_SUBTASKS_DONE',
      'TASK_OVERDUE',
      'SCHEDULE',
      'COMMENT_ADDED',
      'DUE_APPROACHING',
    ])
      expect(triggers).toContain(t);
    for (const a of [
      'CREATE_TASK',
      'CHANGE_PRIORITY',
      'ARCHIVE_TASK',
      'SET_STATUS',
      'ASSIGN',
      'COMMENT',
      'SET_CUSTOM_FIELD',
      'SET_PRIORITY',
    ])
      expect(actions).toContain(a);
  });

  it('shared views are the team\'s boards and calendars; personal ones are "mine"', () => {
    for (const key of SEED_DEFINITIONS.map((d) => d.seedKey)) {
      const views = items(key).filter((i) => i.kind === 'view');
      for (const v of views)
        if (/^My /.test(String(v.item.name))) expect(v.item.shared).toBe(false);
      expect(views.some((v) => v.item.shared === true)).toBe(true);
    }
  });

  it('a broken item stops the seed from being prepared, with where', () => {
    const def = JSON.parse(
      JSON.stringify(
        SEED_DEFINITIONS.find((d) => d.seedKey === 'sprint-board'),
      ),
    ) as SeedDefinition;
    ((def.blueprint.projects as any[])[0].automations[0].actions as any[]).push(
      { type: 'ADD_TAG', tagId: 'no-such-tag' },
    );
    const p = prepareSeed(def);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.problems.join(' ')).toMatch(
      /AUTOMATION_INVALID/,
    );
  });

  it('a seed that changes gets a "what is new" note, and a fresh one starts with "First release."', () => {
    for (const d of SEED_DEFINITIONS) {
      expect(d.initialChangelog).toBe('First release.');
      expect(d.changelog).toMatch(/automations/);
    }
  });
});
