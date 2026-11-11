import { describe, it, expect } from 'bun:test';
import {
  coerceObservationId,
  coerceObservationIds,
  parseObservationIds,
} from '../../src/shared/observation-ids.js';

describe('coerceObservationId', () => {
  it('turns a numeric string into a number', () => {
    expect(coerceObservationId('123')).toBe(123);
    expect(coerceObservationId(' 45 ')).toBe(45);
  });

  it('leaves numbers alone', () => {
    expect(coerceObservationId(123)).toBe(123);
  });

  it('leaves non-numeric strings alone so the validator can reject them', () => {
    expect(coerceObservationId('abc')).toBe('abc');
    expect(coerceObservationId('12.5')).toBe('12.5');
    expect(coerceObservationId('')).toBe('');
  });
});

describe('coerceObservationIds', () => {
  it('coerces each element of an array', () => {
    expect(coerceObservationIds(['123', 456])).toEqual([123, 456]);
  });

  it('splits a comma list and a JSON array string', () => {
    expect(coerceObservationIds('1,2,3')).toEqual([1, 2, 3]);
    expect(coerceObservationIds('["1","2"]')).toEqual([1, 2]);
  });

  it('returns non-list input unchanged', () => {
    expect(coerceObservationIds(undefined)).toBeUndefined();
    expect(coerceObservationIds(42)).toBe(42);
  });
});

describe('parseObservationIds', () => {
  it('accepts the string "123" and returns the integer 123', () => {
    expect(parseObservationIds(['123'])).toEqual({ ok: true, ids: [123] });
  });

  it('accepts the number 123', () => {
    expect(parseObservationIds([123])).toEqual({ ok: true, ids: [123] });
  });

  it('accepts a mix of strings and numbers', () => {
    expect(parseObservationIds(['7', 8])).toEqual({ ok: true, ids: [7, 8] });
  });

  it('rejects "abc" and names the value', () => {
    const result = parseObservationIds(['abc']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('ids must be integers');
      expect(result.message).toContain('"abc"');
    }
  });

  it('rejects a mixed list when one element is not numeric', () => {
    expect(parseObservationIds(['1', 'abc', 3]).ok).toBe(false);
  });

  it('rejects a decimal, an empty string and an unsafe integer', () => {
    expect(parseObservationIds([1.5]).ok).toBe(false);
    expect(parseObservationIds(['12.5']).ok).toBe(false);
    expect(parseObservationIds(['']).ok).toBe(false);
    expect(parseObservationIds(['99999999999999999999']).ok).toBe(false);
  });

  it('rejects null, boolean and object elements', () => {
    expect(parseObservationIds([null]).ok).toBe(false);
    expect(parseObservationIds([true]).ok).toBe(false);
    expect(parseObservationIds([{ id: 1 }]).ok).toBe(false);
  });

  it('rejects a missing or non-list value', () => {
    expect(parseObservationIds(undefined).ok).toBe(false);
    expect(parseObservationIds(123).ok).toBe(false);
  });

  it('passes an empty array through', () => {
    expect(parseObservationIds([])).toEqual({ ok: true, ids: [] });
  });
});
