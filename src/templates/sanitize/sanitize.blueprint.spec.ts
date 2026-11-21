import { validateBlueprint } from '../blueprint';
import { buildRawBlueprint } from '../extract/extract.builder';
import { snapshotFixture } from '../extract/extract.fixtures';
import {
  RawBlueprint,
  RawTask,
  WorkspaceSnapshot,
} from '../extract/extract.types';
import { resolveBlueprint } from '../resolve';
import { sanitize } from './sanitize.blueprint';

// built from pieces: this file must not contain a string a secret scanner would flag
const TOKEN = 'gh' + 'p_' + 'aB3dE5'.repeat(7);
const AWS = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
const EMAIL = 'dana.kowalski' + '@' + 'acme-corp.com';

const raw = (
  o: Parameters<typeof buildRawBlueprint>[1] = {},
  mutate?: (s: WorkspaceSnapshot) => void,
): RawBlueprint => {
  const s = snapshotFixture();
  mutate?.(s);
  return buildRawBlueprint(s, o).raw;
};
const flat = (tasks: RawTask[]): RawTask[] =>
  tasks.flatMap((t) => [t, ...flat(t.children)]);
const ok = (r: ReturnType<typeof sanitize>) => {
  if (r.ok === false)
    throw new Error(
      `${r.reason}: ${JSON.stringify('issues' in r ? r.issues : r.report.findings)}`,
    );
  return r;
};
const HASH = new Map([['a1', 'ab'.repeat(32)]]);

describe('sanitize: the happy path', () => {
  const full = () => raw({ includeComments: true, includeAttachments: true });

  it('produces a valid blueprint with no people, ids, source or real dates in it', () => {
    const r = ok(sanitize(full(), { assetHashes: HASH }));
    const json = JSON.stringify(r.blueprint);
    expect(validateBlueprint(r.blueprint).ok).toBe(true);
    for (const id of [
      'u1',
      'u2',
      'u9',
      'ws1',
      '"source"',
      'authorUserId',
      'sourceAttachmentId',
      'createdAt',
    ])
      expect(json).not.toContain(id);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(r.blueprint.projects[0].tasks[0]).not.toHaveProperty(
      'assigneeUserIds',
    );
  });

  it('users become roles, in order of first appearance; comments become anonymous', () => {
    const r = ok(sanitize(full(), { assetHashes: HASH }));
    expect(r.blueprint.roles).toEqual([
      { key: 'person-1', label: 'Person 1', suggestedAccess: 'MEMBER' },
      { key: 'person-2', label: 'Person 2', suggestedAccess: 'MEMBER' },
    ]);
    expect(r.blueprint.projects[0].tasks[0].assigneeRoles).toEqual([
      'person-1',
      'person-2',
    ]);
    const mid = r.blueprint.projects[0].tasks[1];
    expect(mid.comments).toEqual([
      { body: 'Covers chapter 7 too' },
      { body: 'Noted' },
    ]);
    expect(r.report.roles.created).toBe(2);
  });

  it('dates become offsets from the earliest date; a required startDate variable is added', () => {
    const r = ok(sanitize(full(), { assetHashes: HASH }));
    expect(r.report.anchor).toEqual({
      date: '2026-09-01',
      source: 'earliest',
      weekday: 'Tuesday',
    });
    expect(r.blueprint.dateAnchor).toEqual({ variable: 'startDate' });
    expect(r.blueprint.variables).toEqual([
      { key: 'startDate', label: 'Start date', type: 'DATE', required: true },
    ]);
    const [read, mid] = r.blueprint.projects[0].tasks;
    expect(read).toMatchObject({ startOffsetDays: 0, dueOffsetDays: 6 });
    expect(mid.dueOffsetDays).toBe(49);
    expect(
      r.blueprint.workspace!.iterations!.find((i) => i.nodeKey === 'i-midterm'),
    ).toMatchObject({ startOffsetDays: 0, endOffsetDays: 49 });
  });

  it('an explicit anchor overrides the earliest date', () => {
    const r = ok(
      sanitize(full(), { anchorDate: '2026-08-31', assetHashes: HASH }),
    );
    expect(r.report.anchor).toMatchObject({
      date: '2026-08-31',
      source: 'override',
      weekday: 'Monday',
    });
    expect(r.blueprint.projects[0].tasks[0].startOffsetDays).toBe(1);
  });

  it('with no dates at all there is no anchor and no variable', () => {
    const none = raw({}, (s) => {
      s.tasks.forEach((t) => {
        t.startDate = null;
        t.dueDate = null;
      });
      s.iterations.forEach((i) => {
        i.startDate = null;
        i.endDate = null;
      });
    });
    const r = ok(sanitize(none));
    expect(r.blueprint.dateAnchor).toBeUndefined();
    expect(r.blueprint.variables).toBeUndefined();
    expect(r.report.anchor).toBeNull();
  });

  it('USER custom field values are dropped, the field definition stays', () => {
    const r = ok(sanitize(full(), { assetHashes: HASH }));
    expect(
      r.blueprint.workspace!.customFields!.some((f) => f.dataType === 'USER'),
    ).toBe(true);
    const mid = r.blueprint.projects[0].tasks[1];
    expect(mid.customValues).toEqual({ weight: 30, 'prof-review': 'pending' });
    expect(r.report.summary['user-dropped']).toBe(1);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(sanitize(full(), { assetHashes: HASH }));
    expect(JSON.stringify(sanitize(full(), { assetHashes: HASH }))).toBe(a);
  });

  it('a project extraction sanitizes to a PROJECT blueprint with no workspace identity', () => {
    const r = ok(sanitize(raw({ projectId: 'p1' })));
    expect(r.blueprint.meta.kind).toBe('PROJECT');
    expect(r.blueprint.workspace).not.toHaveProperty('name');
    expect(r.blueprint.workspace).not.toHaveProperty('key');
  });
});

describe('ROUND TRIP: extract -> sanitize -> resolve gives back the original dates', () => {
  const original = () => raw({ includeComments: true });
  const datesOf = (tasks: RawTask[]) =>
    Object.fromEntries(
      flat(tasks).map((t) => [t.nodeKey, [t.startDate, t.dueDate]]),
    );

  it('with the same start date, every task and iteration date is exactly what it was', () => {
    const s = ok(sanitize(original()));
    const r = resolveBlueprint(s.blueprint, {
      variables: { startDate: '2026-09-01' },
      today: '2026-10-09',
    });
    if (r.ok === false) throw new Error(JSON.stringify(r.issues));
    const resolved = Object.fromEntries(
      r.resolved.projects
        .flatMap((p) => p.tasks)
        .flatMap(function f(t): any[] {
          return [
            [t.nodeKey, [t.startDate, t.dueDate]],
            ...t.children.flatMap(f),
          ];
        }),
    );
    const raws = datesOf(original().projects.flatMap((p) => p.tasks));
    for (const [k, [a, b]] of Object.entries(raws))
      expect(resolved[k]).toEqual([a, b]);
    expect(
      r.resolved.workspace.iterations.map((i) => [
        i.nodeKey,
        i.startDate,
        i.endDate,
      ]),
    ).toEqual(
      original().workspace.iterations.map((i) => [
        i.nodeKey,
        i.startDate,
        i.endDate,
      ]),
    );
  });

  it('with a different start date everything shifts by the same number of days', () => {
    const s = ok(sanitize(original()));
    const r = resolveBlueprint(s.blueprint, {
      variables: { startDate: '2027-01-11' },
      today: '2026-10-09',
    });
    if (r.ok === false) throw new Error(JSON.stringify(r.issues));
    const t = (k: string) =>
      r.resolved.projects[0].tasks.find((x) => x.nodeKey === k)!;
    expect(t('t1')).toMatchObject({
      startDate: '2027-01-11',
      dueDate: '2027-01-17',
    });
    expect(t('t2').dueDate).toBe('2027-03-01'); // +49
  });

  it('text, structure and counts survive: tasks, tags, fields, workflow, dependencies', () => {
    const s = ok(sanitize(original()));
    const o = original();
    expect(s.stats.tasks).toBe(flat(o.projects.flatMap((p) => p.tasks)).length);
    expect(s.blueprint.projects.map((p) => p.name)).toEqual(
      o.projects.map((p) => p.name),
    );
    expect(s.blueprint.projects[0].workflow).toEqual(o.projects[0].workflow);
    expect(s.blueprint.projects[0].dependencies).toEqual(
      o.projects[0].dependencies,
    );
    expect(s.blueprint.workspace!.tags).toEqual(o.workspace.tags);
  });
});

describe('adversarial: what a real workspace might contain', () => {
  const withText = (mutate: (s: WorkspaceSnapshot) => void) =>
    raw({ includeComments: true, includeAttachments: true }, mutate);
  const hasLiteral = (value: unknown, needle: string) =>
    JSON.stringify(value).includes(needle);

  it('a leaked token in a task description BLOCKS the export and appears nowhere in the result', () => {
    const r = sanitize(
      withText((s) => {
        s.tasks[0].description = `deploy with ${TOKEN} then restart`;
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok === true) return;
    expect(r.reason).toBe('SECRETS_FOUND');
    expect(r.report.blocked).toBe(true);
    expect(r.report.findings).toContainEqual(
      expect.objectContaining({
        kind: 'secret',
        severity: 'blocked',
        path: '/projects/0/tasks/0/description',
        detail: 'GitHub token',
      }),
    );
    expect(
      r.report.findings.filter((f) => f.severity === 'blocked'),
    ).toHaveLength(1);
    expect(hasLiteral(r, TOKEN)).toBe(false);
    expect(hasLiteral(r, TOKEN.slice(4, 24))).toBe(false);
    expect('blueprint' in r).toBe(false);
  });

  it("with onSecret 'redact' the export continues and the secret is gone", () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].description = `key ${AWS}`;
        }),
        { onSecret: 'redact' },
      ),
    );
    expect(r.blueprint.projects[0].tasks[0].description).toBe(
      'key [secret removed]',
    );
    expect(hasLiteral(r, AWS)).toBe(false);
    expect(r.report.findings.find((f) => f.kind === 'secret')).toMatchObject({
      severity: 'redacted',
    });
  });

  it('secrets are found in EVERY kind of text: titles, comments, names, goals, options, file names', () => {
    const places: Array<[string, (s: WorkspaceSnapshot) => void]> = [
      [
        'title',
        (s) => {
          s.tasks[0].title = `t ${TOKEN}`;
        },
      ],
      [
        'comment',
        (s) => {
          s.comments![0].content = TOKEN;
        },
      ],
      [
        'project name',
        (s) => {
          s.projects[0].name = TOKEN;
        },
      ],
      [
        'project description',
        (s) => {
          s.projects[0].description = TOKEN;
        },
      ],
      [
        'tag',
        (s) => {
          s.tags[0].name = TOKEN;
        },
      ],
      [
        'status',
        (s) => {
          s.statuses[0].name = TOKEN;
        },
      ],
      [
        'iteration goal',
        (s) => {
          s.iterations[1].goal = TOKEN;
        },
      ],
      [
        'issue type',
        (s) => {
          s.issueTypes[0].name = TOKEN;
        },
      ],
      [
        'custom field name',
        (s) => {
          s.customFields[0].name = TOKEN;
        },
      ],
      [
        'custom field option',
        (s) => {
          s.customFields[0].options = [TOKEN, 'ok'];
        },
      ],
      [
        'workspace name',
        (s) => {
          s.workspace.name = TOKEN;
        },
      ],
      [
        'workspace description',
        (s) => {
          s.workspace.description = TOKEN;
        },
      ],
      [
        'custom text value',
        (s) => {
          s.customFields.push({
            id: 'cf9',
            key: 'note',
            name: 'Note',
            dataType: 'TEXT',
            options: null,
            order: 9,
          });
          s.tasks[1].customValues.push({ fieldId: 'cf9', value: TOKEN });
        },
      ],
      [
        'file name',
        (s) => {
          s.attachments![0].filename = `${TOKEN}.pdf`;
        },
      ],
    ];
    for (const [label, mutate] of places) {
      const r = sanitize(withText(mutate), { assetHashes: HASH });
      if (r.ok === true) throw new Error(`${label}: secret not found`);
      expect(r.reason).toBe('SECRETS_FOUND');
      expect(hasLiteral(r, TOKEN)).toBe(false);
    }
  });

  it('emails and phone numbers in titles/descriptions/comments are redacted, with a count in the report', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].title = `Call ${EMAIL} about ch 1`;
          s.tasks[1].description = 'Phone +1 (555) 123-4567 or 555-987-6543';
          s.comments![1].content = `cc ${EMAIL}`;
        }),
      ),
    );
    const [read, mid] = r.blueprint.projects[0].tasks;
    expect(read.title).toBe('Call [email removed] about ch 1');
    expect(mid.description).toBe('Phone [phone removed] or [phone removed]');
    expect(mid.comments![1].body).toBe('cc [email removed]');
    expect(r.report.summary.email).toBe(2);
    expect(r.report.summary.phone).toBe(2);
    expect(hasLiteral(r, EMAIL)).toBe(false);
    expect(hasLiteral(r, '555')).toBe(false);
  });

  it('a tag whose name had an email keeps working: tasks still point at it', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tags[1].name = `reading ${EMAIL}`;
        }),
      ),
    );
    expect(r.blueprint.workspace!.tags!.map((t) => t.name)).toContain(
      'reading [email removed]',
    );
    expect(r.blueprint.projects[0].tasks[0].tags).toEqual([
      'reading [email removed]',
    ]);
  });

  it('dangerous, internal and private-tracker links are removed; ordinary https links stay (and are listed)', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].description = [
            '[x](javascript:alert(1))',
            'http://example.com/a',
            'https://localhost:3000/admin',
            'https://acme.atlassian.net/browse/ENG-9',
            'https://github.com/acme/app/issues/1',
            'https://developer.mozilla.org/en-US/',
          ].join('\n');
        }),
      ),
    );
    const d = r.blueprint.projects[0].tasks[0].description!;
    expect(d).toBe(
      [
        '[x]([unsafe link removed])',
        '[unsafe link removed]',
        '[internal link removed]',
        '[link removed]',
        '[link removed]',
        'https://developer.mozilla.org/en-US/',
      ].join('\n'),
    );
    expect(r.report.findings.find((f) => f.kind === 'url-kept')).toMatchObject({
      detail: 'link kept: developer.mozilla.org',
      severity: 'review',
    });
  });

  it('a pasted database id and a private IP are removed', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].description = 'row cmgx8d0a30000qz1ghv7k2x9p on 10.1.2.3';
        }),
      ),
    );
    expect(r.blueprint.projects[0].tasks[0].description).toBe(
      'row [id removed] on [ip removed]',
    );
  });

  it('"{{" in real text cannot become a live placeholder; it survives resolution as literal text', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].title = 'Fix {{startDate}} parsing';
          s.tasks[0].description =
            'Use {{ addDays(startDate, 1) }} or \\{{literal}}';
          s.tags.find((t) => t.id === 'tg3')!.name = 'x{{y}}';
        }),
      ),
    );
    const resolved = resolveBlueprint(r.blueprint, {
      variables: { startDate: '2026-09-01' },
      today: '2026-10-09',
    });
    if (resolved.ok === false) throw new Error(JSON.stringify(resolved.issues));
    const t = resolved.resolved.projects[0].tasks[0];
    expect(t.title).toBe('Fix {{startDate}} parsing');
    expect(t.description).toBe(
      'Use {{ addDays(startDate, 1) }} or \\{{literal}}',
    );
    expect(r.blueprint.workspace!.tags!.map((t) => t.name)).toContain(
      'x{ {y}}',
    );
  });

  it('a control character in a title is removed; a line break in a title becomes a space', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].title = 'a\u0000b\nc';
        }),
      ),
    );
    expect(r.blueprint.projects[0].tasks[0].title).toBe('ab c');
  });

  it('custom values that do not fit their field are dropped and reported, never stored', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[1].customValues = [
            { fieldId: 'cf1', value: 'not-an-option' },
            { fieldId: 'cf2', value: 'thirty' },
            { fieldId: 'cf3', value: 'u9' },
          ];
        }),
      ),
    );
    expect(r.blueprint.projects[0].tasks[1].customValues).toBeUndefined();
    expect(r.report.summary['value-dropped']).toBe(2);
  });

  it('URL custom values: https kept; credentials, internal hosts and tracker links dropped', () => {
    const mk = (value: string) =>
      ok(
        sanitize(
          withText((s) => {
            s.customFields.push({
              id: 'cf8',
              key: 'brief',
              name: 'Brief',
              dataType: 'URL',
              options: null,
              order: 8,
            });
            s.tasks[0].customValues = [{ fieldId: 'cf8', value }];
          }),
        ),
      ).blueprint.projects[0].tasks[0].customValues;
    expect(mk('https://example.com/brief')).toEqual({
      brief: 'https://example.com/brief',
    });
    for (const bad of [
      'https://u:p@example.com/x',
      'https://localhost/x',
      'https://acme.atlassian.net/browse/X-1',
      'http://example.com',
    ])
      expect(mk(bad)).toBeUndefined();
  });

  it('a DATE custom value becomes an offset; one far from the anchor is dropped', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.customFields.push({
            id: 'cf7',
            key: 'go-live',
            name: 'Go live',
            dataType: 'DATE',
            options: null,
            order: 7,
          });
          s.tasks[0].customValues = [
            { fieldId: 'cf7', value: '2026-09-15T10:00:00.000Z' },
          ];
          s.tasks[1].customValues = [{ fieldId: 'cf7', value: '2096-01-01' }];
        }),
      ),
    );
    expect(r.blueprint.projects[0].tasks[0].customValues).toEqual({
      'go-live': { offsetDays: 14 },
    });
    expect(r.blueprint.projects[0].tasks[1].customValues).toBeUndefined();
    expect(r.report.summary['date-dropped']).toBe(1);
  });

  it('more than 30 distinct people: the rest are left unassigned, with a note', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          s.tasks[0].assigneeIds = Array.from(
            { length: 35 },
            (_, i) => `u${String(i).padStart(2, '0')}`,
          );
        }),
      ),
    );
    // one task can carry 10 people; the 25 others on it are dropped, and no role is made for them
    expect(r.blueprint.roles).toHaveLength(10); // no role is created for the 25 who did not fit
    expect(r.blueprint.projects[0].tasks[0].assigneeRoles).toHaveLength(10);
    expect(r.report.summary['user-dropped']).toBeGreaterThan(0);
  });

  it('more than 30 people across the template: later ones are left unassigned', () => {
    const r = ok(
      sanitize(
        withText((s) => {
          const base = s.tasks[0];
          s.tasks = Array.from({ length: 8 }, (_, i) => ({
            ...base,
            id: `m${i}`,
            number: 100 + i,
            assigneeIds: Array.from(
              { length: 5 },
              (_, j) => `v${String(i * 5 + j).padStart(3, '0')}`,
            ),
            customValues: [],
            tagIds: [],
          }));
        }),
      ),
    );
    expect(r.blueprint.roles).toHaveLength(30);
    expect(r.report.summary['user-dropped']).toBeGreaterThan(0);
  });

  it('assets: only hashed, non-executable, size-capped files are kept', () => {
    const base = raw({ includeAttachments: true }, (s) => {
      s.attachments!.push(
        {
          id: 'a3',
          taskId: 'k2',
          filename: 'setup.exe',
          mimeType: 'application/octet-stream',
          sizeBytes: 5,
          confirmed: true,
          createdAt: new Date(Date.UTC(2026, 0, 3)),
        },
        {
          id: 'a4',
          taskId: 'k2',
          filename: 'big.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 11 * 1024 * 1024,
          confirmed: true,
          createdAt: new Date(Date.UTC(2026, 0, 4)),
        },
        {
          id: 'a5',
          taskId: 'k2',
          filename: '../../etc/passwd.txt',
          mimeType: 'text/plain',
          sizeBytes: 5,
          confirmed: true,
          createdAt: new Date(Date.UTC(2026, 0, 5)),
        },
      );
    });
    const hashes = new Map([
      ['a1', 'ab'.repeat(32)],
      ['a3', 'cd'.repeat(32)],
      ['a4', 'ef'.repeat(32)],
      ['a5', '01'.repeat(32)],
    ]);
    const r = ok(sanitize(base, { assetHashes: hashes }));
    expect(r.blueprint.assets!.map((a) => a.fileName)).toEqual([
      'syllabus.pdf',
      'passwd.txt',
    ]);
    expect(r.report.assets).toEqual({ kept: 2, dropped: 2 });
    expect(r.blueprint.projects[0].tasks[1].attachments).toEqual(['a1', 'a2']);
    // no hashes yet (the asset step has not run): nothing is kept, and the tasks do not reference them
    const none = ok(sanitize(base));
    expect(none.blueprint.assets).toBeUndefined();
    expect(none.blueprint.projects[0].tasks[1].attachments).toBeUndefined();
  });

  it('refuses (never "repairs") a document that would be invalid, e.g. two tags that sanitise to the same name', () => {
    const r = sanitize(
      withText((s) => {
        s.tags[0].name = `a ${EMAIL}`;
        s.tags[1].name = `a ${EMAIL.replace('dana', 'omar')}`;
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('INVALID');
  });

  it('the report never contains anything it matched (every sensitive literal, every place)', () => {
    const sensitive = [
      TOKEN,
      AWS,
      EMAIL,
      '4242 4242 4242 4242',
      'S3cr3tPassw0rd',
      '10.1.2.3',
    ];
    const r = sanitize(
      withText((s) => {
        s.tasks[0].description = `${AWS} ${EMAIL} 4242 4242 4242 4242 10.1.2.3`;
        s.tasks[1].description = `postgres://app:S3cr3tPassw0rd@db/x ${TOKEN}`;
      }),
      { onSecret: 'redact' },
    );
    const reportJson = JSON.stringify('report' in r ? r.report : {});
    for (const s of sensitive) expect(reportJson).not.toContain(s);
    if (r.ok === true)
      for (const s of sensitive)
        expect(JSON.stringify(r.blueprint)).not.toContain(s);
  });
});

describe('fuzz: whatever the text is, the result is blocked or valid, never broken', () => {
  it('600 random texts across every text field', () => {
    let seed = 2026;
    const next = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const bits = [
      TOKEN,
      AWS,
      EMAIL,
      '10.0.0.1',
      'https://x.io/a',
      'http://x.io',
      ' ',
      '\n',
      '{{',
      '}}',
      '{{startDate}}',
      '\\{{',
      '\\',
      'javascript:x',
      '+1 555 123 4567',
      'word',
      '2026-09-01',
      '@dana',
      'ENG-12',
      '\u0000',
      'é',
      '😀',
      'x'.repeat(40),
      '"',
      '`',
    ];
    const gen = () =>
      'x' +
      Array.from({ length: next(10) }, () => bits[next(bits.length)]).join(
        next(2) ? ' ' : '',
      );
    for (let i = 0; i < 600; i++) {
      const r = sanitize(
        raw({ includeComments: true }, (s) => {
          s.workspace.name = gen();
          s.workspace.description = gen();
          s.projects[0].name = gen();
          s.projects[0].description = gen();
          s.tasks[0].title = gen();
          s.tasks[0].description = gen();
          s.tasks[1].description = gen();
          s.comments![0].content = gen();
          s.iterations[0].name = gen();
          s.iterations[0].goal = gen();
          s.statuses[0].name = `s${i} ${gen()}`.slice(0, 40);
        }),
        { onSecret: next(2) ? 'block' : 'redact' },
      );
      if (r.ok === false) {
        // only blocked secrets or a name collision/length from the fuzz itself; never a placeholder or text-hygiene failure
        if (r.reason === 'INVALID') {
          expect(
            r.issues.every(
              (x) =>
                ![
                  'PLACEHOLDER_SYNTAX',
                  'PLACEHOLDER_INVALID',
                  'PLACEHOLDER_NOT_ALLOWED',
                  'BAD_TEXT',
                  'NAME_INVALID',
                ].includes(x.code) || x.code === 'NAME_INVALID',
            ),
          ).toBe(true);
        }
        continue;
      }
      expect(validateBlueprint(r.blueprint).ok).toBe(true);
      expect(JSON.stringify(r.blueprint)).not.toContain(TOKEN);
      expect(JSON.stringify(r.blueprint)).not.toContain(AWS);
      expect(JSON.stringify(r.blueprint)).not.toContain(EMAIL);
    }
  });
});
