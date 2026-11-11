import { describe, it, expect } from 'bun:test';

import { inferTypeFromContent, resolveEmittedType } from '../../src/sdk/observation-type.js';

const CODE_TYPES = [
  'bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision',
  'security_alert', 'security_note', 'sensitive',
];

describe('resolveEmittedType', () => {
  it('matches a declared id ignoring case, brackets and quotes', () => {
    expect(resolveEmittedType('Discovery', CODE_TYPES)).toBe('discovery');
    expect(resolveEmittedType('[bugfix]', CODE_TYPES)).toBe('bugfix');
    expect(resolveEmittedType('"decision"', CODE_TYPES)).toBe('decision');
  });

  it('matches a multiword declared id written with spaces or hyphens', () => {
    expect(resolveEmittedType('security note', CODE_TYPES)).toBe('security_note');
    expect(resolveEmittedType('Security-Alert', CODE_TYPES)).toBe('security_alert');
  });

  it('maps the labels the live observer emits to their declared types', () => {
    expect(resolveEmittedType('gotcha', CODE_TYPES)).toBe('discovery');
    expect(resolveEmittedType('finding', CODE_TYPES)).toBe('discovery');
    expect(resolveEmittedType('critical-finding', CODE_TYPES)).toBe('discovery');
    expect(resolveEmittedType('milestone', CODE_TYPES)).toBe('change');
    expect(resolveEmittedType('what-changed', CODE_TYPES)).toBe('change');
    expect(resolveEmittedType('code-change', CODE_TYPES)).toBe('change');
    expect(resolveEmittedType('fix-applied', CODE_TYPES)).toBe('bugfix');
    expect(resolveEmittedType('bug', CODE_TYPES)).toBe('bugfix');
  });

  it('prefers a declared id found inside a compound label over an alias', () => {
    expect(resolveEmittedType('decision-finding', CODE_TYPES)).toBe('decision');
  });

  it('returns null for labels it cannot place', () => {
    expect(resolveEmittedType('code', CODE_TYPES)).toBeNull();
    expect(resolveEmittedType('sample-gate', CODE_TYPES)).toBeNull();
    expect(resolveEmittedType('test-result', CODE_TYPES)).toBeNull();
    expect(resolveEmittedType('   ', CODE_TYPES)).toBeNull();
  });

  it('never returns a type outside the declared set', () => {
    expect(resolveEmittedType('milestone', ['bugfix', 'discovery'])).toBeNull();
    expect(resolveEmittedType('gotcha', ['bugfix', 'refactor'])).toBeNull();
  });
});

describe('inferTypeFromContent', () => {
  it('uses the most specific concept first', () => {
    expect(inferTypeFromContent({ concepts: ['how-it-works', 'problem-solution'], title: null }, CODE_TYPES)).toBe('bugfix');
    expect(inferTypeFromContent({ concepts: ['what-changed', 'trade-off'], title: null }, CODE_TYPES)).toBe('decision');
    expect(inferTypeFromContent({ concepts: ['what-changed', 'how-it-works'], title: null }, CODE_TYPES)).toBe('change');
    expect(inferTypeFromContent({ concepts: ['gotcha'], title: null }, CODE_TYPES)).toBe('discovery');
  });

  it('falls back to a leading verb in the title', () => {
    expect(inferTypeFromContent({ concepts: [], title: 'Fixed the spool drain race' }, CODE_TYPES)).toBe('bugfix');
    expect(inferTypeFromContent({ concepts: [], title: 'Refactored the parser helpers' }, CODE_TYPES)).toBe('refactor');
    expect(inferTypeFromContent({ concepts: [], title: 'Decided to keep the fork patch' }, CODE_TYPES)).toBe('decision');
    expect(inferTypeFromContent({ concepts: [], title: 'Added a retry to the drain' }, CODE_TYPES)).toBe('feature');
  });

  it('does not read a verb out of the middle of a title', () => {
    expect(inferTypeFromContent({ concepts: [], title: 'Worker never fixed its port' }, CODE_TYPES)).toBeNull();
  });

  it('returns null when nothing indicates a type', () => {
    expect(inferTypeFromContent({ concepts: [], title: null }, CODE_TYPES)).toBeNull();
    expect(inferTypeFromContent({ concepts: ['unrelated'], title: 'Blob operations mapped' }, CODE_TYPES)).toBeNull();
  });

  it('skips a hint whose type the mode does not declare', () => {
    expect(inferTypeFromContent({ concepts: ['trade-off'], title: null }, ['bugfix', 'discovery'])).toBeNull();
    expect(inferTypeFromContent({ concepts: ['trade-off', 'gotcha'], title: null }, ['bugfix', 'discovery'])).toBe('discovery');
  });
});
