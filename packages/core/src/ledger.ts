import { ore, type Ore } from './money';
import type { Instalment } from './pricing';

export const ACCOUNTS = ['LOAN_RECEIVABLE', 'BANK_PAYOUT', 'BANK_INCOMING', 'FEE_INCOME'] as const;
export type Account = (typeof ACCOUNTS)[number];

/** One side is always zero. */
export type LedgerLine = { readonly account: Account; readonly debit: Ore; readonly credit: Ore };

export type LedgerEntry = {
  readonly entryId: string;
  readonly loanId: string;
  readonly occurredAt: string;
  readonly reason: 'PAYOUT' | 'INSTALMENT';
  readonly lines: readonly LedgerLine[];
};

export class UnbalancedEntryError extends Error {
  override name = 'UnbalancedEntryError';
}

const zero = ore(0);
const debit = (account: Account, amount: Ore): LedgerLine => ({ account, debit: amount, credit: zero });
const credit = (account: Account, amount: Ore): LedgerLine => ({ account, debit: zero, credit: amount });

/** Entries are append-only. A mistake is fixed with a new reversing entry, never by editing. */
function entry(base: Omit<LedgerEntry, 'lines'>, lines: readonly LedgerLine[]): LedgerEntry {
  const invalid = lines.some((l) => l.debit < 0 || l.credit < 0 || (l.debit !== 0 && l.credit !== 0));
  if (invalid) throw new UnbalancedEntryError(`Entry ${base.entryId} has a negative amount or a line with both debit and credit`);
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  if (debits !== credits || debits <= 0) {
    throw new UnbalancedEntryError(`Entry ${base.entryId} does not balance: debit ${debits}, credit ${credits}`);
  }
  return { ...base, lines };
}

type EntryMeta = { entryId: string; loanId: string; occurredAt: string };

export const payoutEntry = ({ amount, ...meta }: EntryMeta & { amount: Ore }): LedgerEntry =>
  entry({ ...meta, reason: 'PAYOUT' }, [debit('LOAN_RECEIVABLE', amount), credit('BANK_PAYOUT', amount)]);

export const instalmentEntry = ({ instalment, ...meta }: EntryMeta & { instalment: Instalment }): LedgerEntry =>
  entry({ ...meta, reason: 'INSTALMENT' }, [
    debit('BANK_INCOMING', instalment.total),
    credit('LOAN_RECEIVABLE', instalment.principal),
    credit('FEE_INCOME', instalment.fee),
  ]);

/** What the customer still owes: debits minus credits on the receivable account. */
export const receivableBalance = (entries: readonly LedgerEntry[]): Ore =>
  ore(
    entries
      .flatMap((e) => e.lines)
      .filter((l) => l.account === 'LOAN_RECEIVABLE')
      .reduce((s, l) => s + l.debit - l.credit, 0),
  );
