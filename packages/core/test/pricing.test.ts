import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { kr, ore } from '../src/money';
import { buildOffer, maxMonthlyCost, TERMS } from '../src/pricing';

describe('buildOffer', () => {
  it('builds a straight-amortisation plan with a fixed monthly fee', () => {
    const offer = buildOffer(kr(100_000), 12, 'A');
    expect(offer.monthlyFee).toBe(kr(1_200)); // 1.2 % of 100 000 kr
    expect(offer.schedule).toHaveLength(12);
    expect(offer.schedule[0]!.principal).toBe(833_333);
    expect(offer.schedule[11]!.principal).toBe(833_337); // last one absorbs rounding
    expect(offer.totalFees).toBe(kr(14_400));
    expect(offer.totalCost).toBe(kr(114_400));
  });

  it('maxMonthlyCost is the largest instalment', () => {
    const offer = buildOffer(kr(100_000), 12, 'A');
    expect(maxMonthlyCost(offer)).toBe(833_337 + kr(1_200));
  });

  it('rejects zero or negative amounts', () => {
    expect(() => buildOffer(ore(0), 12, 'A')).toThrow(RangeError);
  });

  it('principal parts always sum exactly to the amount (Review Focus 5)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: kr(10_000), max: kr(2_000_000) }),
        fc.constantFrom(...TERMS),
        fc.constantFrom('A' as const, 'B' as const, 'C' as const),
        (amount, term, band) => {
          const offer = buildOffer(ore(amount), term, band);
          const sum = offer.schedule.reduce((s, i) => s + i.principal, 0);
          expect(sum).toBe(amount);
          expect(offer.schedule.every((i) => i.principal > 0 && i.total === i.principal + i.fee)).toBe(true);
          expect(offer.totalCost).toBe(offer.schedule.reduce((s, i) => s + i.total, 0));
        },
      ),
    );
  });
});
