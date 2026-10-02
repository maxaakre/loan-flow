import { buildOffer, makeEvent } from '@loanflow/core';
import { eventMeta, updateApplication } from '../db/applications';
import { transact } from '../db/client';
import { outboxPut } from '../db/outbox';
import { loadApplication, nowIso, type StepInput } from './common';

const offerTimeoutMs = () => Number(process.env.OFFER_TIMEOUT_SECONDS ?? 604_800) * 1000;

/**
 * Invoked with .waitForTaskToken: the process pauses until someone signs or the offer times out.
 * `enteredAt` is when Step Functions started the wait, so the stored deadline matches the task timeout.
 */
export const handler = async ({ applicationId, taskToken, enteredAt }: StepInput & { taskToken: string; enteredAt?: string }): Promise<void> => {
  const app = await loadApplication(applicationId);
  const now = nowIso();

  // A retried invoke gets a new token. Keep the offer and only swap the token.
  if (app.status === 'OFFERED') {
    await transact([updateApplication(app, { taskToken }, now).item]);
    return;
  }
  const approvedAmount = app.decision?.approvedAmount;
  if (app.status !== 'ASSESSING' || !app.decision || !approvedAmount) {
    throw new Error(`Cannot create an offer in status ${app.status}`);
  }

  const offer = buildOffer(approvedAmount, app.termMonths, app.decision.riskBand);
  const offerExpiresAt = new Date(Date.parse(enteredAt ?? now) + offerTimeoutMs()).toISOString();
  const { item, next } = updateApplication(app, { status: 'OFFERED', offer, offerExpiresAt, taskToken }, now);
  const created = makeEvent('OfferCreated', eventMeta(next, now), {
    amount: offer.amount,
    termMonths: offer.termMonths,
    monthlyFee: offer.monthlyFee,
    totalCost: offer.totalCost,
    expiresAt: offerExpiresAt,
  });
  // A version conflict fails the Lambda; Step Functions retries with a new token
  await transact([item, outboxPut(created)]);
};
