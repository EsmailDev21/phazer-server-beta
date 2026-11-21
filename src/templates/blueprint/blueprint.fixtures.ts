import * as fs from 'fs';
import * as path from 'path';

/** Test helper: the golden fixtures, read as text so tests exercise the real parse path. */
const DIR = path.join(__dirname, 'fixtures', 'valid');

export const GOLDEN_FIXTURES = [
  'student-workspace',
  'sprint-board',
  'content-calendar',
] as const;

export function fixtureText(name: (typeof GOLDEN_FIXTURES)[number]): string {
  return fs.readFileSync(path.join(DIR, `${name}.blueprint.json`), 'utf8');
}

export function fixtureJson(name: (typeof GOLDEN_FIXTURES)[number]): any {
  return JSON.parse(fixtureText(name));
}
