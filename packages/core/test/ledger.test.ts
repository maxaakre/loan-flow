import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instalmentEntry, payoutEntry, receivableBalance, UnbalancedEntryError, type LedgerEntry } from '../src/ledger';
import { kr, ore } from '../src/money';
import { buildOffer, TERMS } from '../src/pricing';

const meta = { loanId: 'L1', occurredAt: '2026-10-02T10:00:00.000Z' };

describe('ledger', () => {
  it('books a payout as receivable against bank payout', () => {
    const e = payoutEntry({ ...meta, entryId: 'E1', amount: kr(100_000) });
    expect(e.lines).toEqual([
      { account: 'LOAN_RECEIVABLE', debit: kr(100_000), credit: 0 },
      { account: 'BANK_PAYOUT', debit: 0, credit: kr(100_000) },
    ]);
  });

  it('books an instalment as incoming money split into principal and fee', () => {
    const e = instalmentEntry({
      ...meta,
      entryId: 'E2',
      instalment: { number: 1, principal: kr(8_000), fee: kr(1_000), total: kr(9_000) },
    });
    expect(e.lines).toEqual([
      { account: 'BANK_INCOMING', debit: kr(9_000), credit: 0 },
      { account: 'LOAN_RECEIVABLE', debit: 0, credit: kr(8_000) },
      { account: 'FEE_INCOME', debit: 0, credit: kr(1_000) },
    ]);
  });

  it('refuses an unbalanced instalment', () => {
    expect(() =>
      instalmentEntry({
        ...meta,
        entryId: 'E3',
        instalment: { number: 1, principal: kr(8_000), fee: kr(1_000), total: kr(9_500) },
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it('every entry balances and a fully repaid loan ends at zero', () => {
    fc.assert(
      fc.property(fc.integer({ min: kr(10_000), max: kr(2_000_000) }), fc.constantFrom(...TERMS), (amount, term) => {
        const offer = buildOffer(ore(amount), term, 'B');
        const entries: LedgerEntry[] = [payoutEntry({ ...meta, entryId: 'P', amount: offer.amount })];
        for (const instalment of offer.schedule) {
          entries.push(instalmentEntry({ ...meta, entryId: `I${instalment.number}`, instalment }));
          expect(receivableBalance(entries)).toBeGreaterThanOrEqual(0);
        }
        for (const e of entries) {
          const debit = e.lines.reduce((s, l) => s + l.debit, 0);
          const credit = e.lines.reduce((s, l) => s + l.credit, 0);
          expect(debit).toBe(credit);
        }
        expect(receivableBalance(entries)).toBe(0);
      }),
    );
  });
});
