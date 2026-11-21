import { bumpSemver, compareSemver, parseSemver } from './templates.semver';

describe('template semver', () => {
  it('first version is 1.0.0; bumps move the right part and reset the lower ones', () => {
    expect(bumpSemver(null)).toBe('1.0.0');
    expect(bumpSemver('1.4.7', 'patch')).toBe('1.4.8');
    expect(bumpSemver('1.4.7')).toBe('1.5.0');
    expect(bumpSemver('1.4.7', 'minor')).toBe('1.5.0');
    expect(bumpSemver('1.4.7', 'major')).toBe('2.0.0');
    expect(bumpSemver('0.9.9', 'major')).toBe('1.0.0');
  });
  it('parses only canonical versions', () => {
    for (const bad of ['1.0', '1.0.0.0', 'v1.0.0', '01.0.0', '1.0.-1', '', '1.0.0-beta', ' 1.0.0']) expect(parseSemver(bad)).toBeNull();
    expect(parseSemver('10.20.30')).toEqual([10, 20, 30]);
    expect(() => bumpSemver('nope')).toThrow();
  });
  it('compares numerically, not as text', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });
  it('every bump is strictly greater than what it came from', () => {
    for (const v of ['0.0.0', '1.2.3', '9.9.9']) for (const b of ['major', 'minor', 'patch'] as const) expect(compareSemver(bumpSemver(v, b), v)).toBe(1);
  });
});
