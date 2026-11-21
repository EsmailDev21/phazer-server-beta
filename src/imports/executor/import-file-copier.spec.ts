import { ImportFileCopier } from './import-file-copier';

const make = (prefix?: string) => new ImportFileCopier({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, prefix === undefined ? undefined : ({ get: () => prefix } as never));

describe('ImportFileCopier.contentLink (step 4.7b)', () => {
  it('is /files/<id>/content by default', () => expect(make().contentLink('abc')).toBe('/files/abc/content'));
  it('takes the deployment\'s prefix (FILES_CONTENT_URL_PREFIX), without doubling slashes', () => {
    expect(make('/api').contentLink('abc')).toBe('/api/files/abc/content');
    expect(make('/api///').contentLink('abc')).toBe('/api/files/abc/content');
    expect(make('https://app.example.com').contentLink('abc')).toBe('https://app.example.com/files/abc/content');
    expect(make('').contentLink('abc')).toBe('/files/abc/content');
  });
});
