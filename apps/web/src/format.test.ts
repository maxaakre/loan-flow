import { kr } from '@loanflow/core';
import { toOre } from './format';

describe('toOre (Review Focus 5)', () => {
  it('accepts whole kronor with spaces', () => {
    expect(toOre('150 000')).toEqual({ ok: true, value: kr(150_000) });
  });

  it('rejects decimals and out-of-range', () => {
    expect(toOre('150000,50').ok).toBe(false);
    expect(toOre('9999').ok).toBe(false);
    expect(toOre('2000001').ok).toBe(false);
    expect(toOre('abc').ok).toBe(false);
  });

  it('rejects absurdly long input without throwing', () => {
    expect(() => toOre('99999999999999999999')).not.toThrow();
    expect(toOre('99999999999999999999').ok).toBe(false);
  });
});
