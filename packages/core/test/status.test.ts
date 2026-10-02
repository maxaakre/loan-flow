import { describe, expect, it } from 'vitest';
import { assertTransition, InvalidTransitionError, isFinal } from '../src/status';

describe('application status machine', () => {
  it.each([
    ['SUBMITTED', 'ASSESSING'],
    ['SUBMITTED', 'MANUAL_REVIEW'],
    ['ASSESSING', 'OFFERED'],
    ['ASSESSING', 'DECLINED'],
    ['ASSESSING', 'MANUAL_REVIEW'],
    ['OFFERED', 'SIGNED'],
    ['OFFERED', 'EXPIRED'],
    ['OFFERED', 'MANUAL_REVIEW'],
    ['SIGNED', 'DISBURSED'],
    ['SIGNED', 'MANUAL_REVIEW'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['SUBMITTED', 'OFFERED'],
    ['OFFERED', 'DISBURSED'],
    ['EXPIRED', 'SIGNED'],
    ['DECLINED', 'OFFERED'],
    ['DISBURSED', 'MANUAL_REVIEW'],
    ['EXPIRED', 'MANUAL_REVIEW'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('knows final statuses', () => {
    expect(isFinal('DISBURSED')).toBe(true);
    expect(isFinal('OFFERED')).toBe(false);
  });
});
