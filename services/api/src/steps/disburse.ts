import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { makeEvent, payoutEntry, type Loan } from '@loanflow/core';
import { ulid } from 'ulid';
import { eventMeta, updateApplication } from '../db/applications';
import { putLedgerEntry, putLoan } from '../db/loans';
import { outboxPut } from '../db/outbox';
import { payout } from '../fakes/bank';
import { metrics } from '../http';
import { commitOrCheck, loadApplication, nowIso, type StepInput } from './common';

export const handler = async ({ applicationId }: StepInput): Promise<StepInput> => {
  const app = await loadApplication(applicationId);
  if (app.status === 'DISBURSED') return { applicationId };
  if (app.status !== 'SIGNED' || !app.offer) throw new Error(`Cannot disburse in status ${app.status}`);

  // 1. Money leaves the bank. The application id is the idempotency key, so a retry gets the same payout.
  const { payoutId } = await payout(app.id, app.offer.amount);

  // 2. Record it. If the Lambda dies before this, Step Functions retries and step 1 returns the same payout.
  const now = nowIso();
  const { item, next } = updateApplication(app, { status: 'DISBURSED' }, now);
  const loan: Loan = {
    id: app.id,
    applicationId: app.id,
    correlationId: app.correlationId,
    principal: app.offer.amount,
    schedule: app.offer.schedule,
    paidInstalments: 0,
    balance: app.offer.amount,
    status: 'ACTIVE',
    payoutId,
    version: 1,
    disbursedAt: now,
  };
  const entry = payoutEntry({ entryId: ulid(), loanId: loan.id, occurredAt: now, amount: loan.principal });
  const disbursed = makeEvent('LoanDisbursed', eventMeta(next, now), { loanId: loan.id, amount: loan.principal, payoutId });

  await commitOrCheck(
    [item, putLoan(loan), putLedgerEntry(entry), outboxPut(disbursed)],
    applicationId,
    (fresh) => fresh.status === 'DISBURSED',
  );
  metrics.addMetric('Payouts', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  return { applicationId };
};
