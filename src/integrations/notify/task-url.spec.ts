import { RichMessageBuilder } from './rich-message.builder';

const builder = (cfg: Record<string, string>) => new RichMessageBuilder({} as never, { get: (k: string) => cfg[k] } as never);

describe('RichMessageBuilder.parseTaskKey (inverse of taskUrl; Slack unfurl only handles OUR links)', () => {
  it('default: {FRONTEND_URL}/tasks/{KEY-N}; case-normalised; trailing slash ok', () => {
    const b = builder({ FRONTEND_URL: 'https://app.test/' });
    expect(b.parseTaskKey('https://app.test/tasks/eng-12')).toBe('ENG-12');
    expect(b.parseTaskKey('https://app.test/tasks/ENG-12/')).toBe('ENG-12');
    expect(b.taskUrl('ENG-12', 'x')).toBe('https://app.test/tasks/ENG-12');
  });

  it.each([
    'https://app.test/tasks/ENG-12?x=1', 'https://app.test/tasks/ENG-12#c', 'https://app.test.evil.test/tasks/ENG-12', 'http://app.test/tasks/ENG-12',
    'https://app.test/tasks/ENG-12/comments', 'https://app.test/tasks/ENG', 'https://app.test/tasks/ENG-12abc', 'https://evil.test/https://app.test/tasks/ENG-1', 'https://app.test/other/ENG-1', '',
  ])('rejects %s', (u) => expect(builder({ FRONTEND_URL: 'https://app.test' }).parseTaskKey(u)).toBeNull());

  it('TASK_URL_TEMPLATE with {key} (and {id}); an {id}-only template cannot be inverted; no base configured -> null', () => {
    const b = builder({ TASK_URL_TEMPLATE: 'https://x.test/t/{id}?k={key}' });
    expect(b.parseTaskKey('https://x.test/t/ckabc123?k=ENG-3')).toBe('ENG-3');
    expect(b.parseTaskKey('https://x.test/t/ckabc123?k=ENG-3&evil=1')).toBeNull();
    expect(builder({ TASK_URL_TEMPLATE: 'https://x.test/t/{id}' }).parseTaskKey('https://x.test/t/ckabc123')).toBeNull();
    expect(builder({}).parseTaskKey('https://app.test/tasks/ENG-1')).toBeNull();
  });

  it('regex metacharacters in the configured base are literal', () => {
    const b = builder({ FRONTEND_URL: 'https://app.test' });
    expect(b.parseTaskKey('https://appXtest/tasks/ENG-1')).toBeNull();
  });
});
