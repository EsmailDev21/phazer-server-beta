import { BadRequestException } from '@nestjs/common';
import {
  IMPORT_LIMITS,
  assertSelectionInTree,
  parseOptions,
  parseSelection,
} from './imports.validation';
import { DEFAULT_IMPORT_OPTIONS } from './imports.types';

describe('imports validation (step 4.1)', () => {
  describe('parseOptions', () => {
    it('absent = all defaults (everything on)', () => {
      expect(parseOptions(undefined)).toEqual(DEFAULT_IMPORT_OPTIONS);
      expect(parseOptions(null)).toEqual(DEFAULT_IMPORT_OPTIONS);
      expect(DEFAULT_IMPORT_OPTIONS).toEqual({ comments: true, attachments: true, history: true, keepDates: true });
    });
    it('overrides only what is given', () => {
      expect(parseOptions({ attachments: false })).toEqual({ ...DEFAULT_IMPORT_OPTIONS, attachments: false });
    });
    it('an unknown key is a 400 (a typo must not silently import less)', () => {
      expect(() => parseOptions({ attachement: false })).toThrow(BadRequestException);
    });
    it('non-boolean values and non-objects are a 400', () => {
      expect(() => parseOptions({ comments: 'no' })).toThrow('must be true or false');
      expect(() => parseOptions([])).toThrow(BadRequestException);
      expect(() => parseOptions('x')).toThrow(BadRequestException);
    });
  });

  describe('parseSelection', () => {
    it('accepts and de-duplicates', () => {
      expect(
        parseSelection({ sources: [{ id: 'a', type: 'project' }, { id: 'a', type: 'project' }, { id: 'a', type: 'team' }] }),
      ).toEqual({ sources: [{ id: 'a', type: 'project' }, { id: 'a', type: 'team' }] });
    });
    it('rejects empty, wrong shape, bad lengths and too many', () => {
      expect(() => parseSelection({ sources: [] })).toThrow('at least one');
      expect(() => parseSelection({})).toThrow(BadRequestException);
      expect(() => parseSelection(null)).toThrow(BadRequestException);
      expect(() => parseSelection({ sources: [{ id: 1, type: 'x' }] })).toThrow(BadRequestException);
      expect(() => parseSelection({ sources: [{ id: '', type: 'x' }] })).toThrow('invalid length');
      expect(() => parseSelection({ sources: [{ id: 'x'.repeat(IMPORT_LIMITS.maxIdLength + 1), type: 'p' }] })).toThrow('invalid length');
      const many = Array.from({ length: IMPORT_LIMITS.maxSelectedSources + 1 }, (_, i) => ({ id: `i${i}`, type: 'p' }));
      expect(() => parseSelection({ sources: many })).toThrow('At most');
    });
  });

  describe('assertSelectionInTree', () => {
    const tree = {
      nodes: [
        { id: 't1', type: 'team', name: 'Team', selectable: false },
        { id: 'p1', type: 'project', name: 'P1', parentId: 't1', selectable: true },
      ],
    };
    it('passes for selectable nodes of the tree', () => {
      expect(() => assertSelectionInTree({ sources: [{ id: 'p1', type: 'project' }] }, tree)).not.toThrow();
    });
    it('rejects ids the provider did not report, wrong types, and non-selectable groups', () => {
      expect(() => assertSelectionInTree({ sources: [{ id: 'zz', type: 'project' }] }, tree)).toThrow('Not selectable');
      expect(() => assertSelectionInTree({ sources: [{ id: 'p1', type: 'team' }] }, tree)).toThrow('Not selectable');
      expect(() => assertSelectionInTree({ sources: [{ id: 't1', type: 'team' }] }, tree)).toThrow('Not selectable');
    });
  });
});
