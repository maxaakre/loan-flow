import { describe, expect, it } from 'vitest';
import { toPublicApplication, type Application } from '../src/domain';
import { makeEvent, parseEvent, summarize } from '../src/events';
import { kr } from '../src/money';

const meta = {
  eventId: '01J0000000000000000000000A',
  occurredAt: '2026-10-02T10:00:00.000Z',
  aggregateId: 'APP1',
  sequence: 10,
  correlationId: 'corr-1',
};

describe('events', () => {
  it('makeEvent builds a valid envelope', () => {
    const e = makeEvent('LoanDisbursed', meta, { loanId: 'APP1', amount: kr(100_000), payoutId: 'P1' });
    expect(e).toMatchObject({ ...meta, type: 'LoanDisbursed', version: 1 });
  });

  it('makeEvent rejects bad data', () => {
    // @ts-expect-error amount must be an integer
    expect(() => makeEvent('LoanDisbursed', meta, { loanId: 'A', amount: 1.5, payoutId: 'P' })).toThrow();
  });

  it('parseEvent round-trips through JSON', () => {
    const e = makeEvent('OfferSigned', meta, { signedAt: meta.occurredAt });
    expect(parseEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it('parseEvent rejects unknown types', () => {
    expect(() => parseEvent({ ...meta, version: 1, type: 'Nope', data: {} })).toThrow();
  });

  it('summarize writes plain Swedish', () => {
    const e = makeEvent('CreditDecided', meta, {
      outcome: 'APPROVED_WITH_CHANGES',
      reasons: ['LOW_CASHFLOW'],
      rulesVersion: '2026-10-01',
      approvedAmount: kr(88_000),
    });
    expect(summarize(e).replace(/\s/g, ' ')).toBe('Beviljad med ändring: 88 000 kr');
  });
});

describe('toPublicApplication', () => {
  it('never exposes the task token (Review Focus 3)', () => {
    const app = { id: 'A', taskToken: 'secret' } as Application;
    expect(toPublicApplication(app)).not.toHaveProperty('taskToken');
  });
});
