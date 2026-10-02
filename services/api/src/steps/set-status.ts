import { isFinal, makeEvent, type Application, type ReasonCode } from '@loanflow/core';
import { eventMeta, updateApplication, type ApplicationChanges } from '../db/applications';
import { outboxPut } from '../db/outbox';
import { commitOrCheck, loadApplication, nowIso, type StepInput } from './common';

export type SetStatusInput = StepInput &
  ({ status: 'SIGNED'; signedAt: string } | { status: 'EXPIRED' } | { status: 'MANUAL_REVIEW'; reason: ReasonCode });

export const handler = async (input: SetStatusInput): Promise<StepInput> => {
  const { applicationId } = input;
  const app = await loadApplication(applicationId);
  if (app.status === input.status) return { applicationId };
  // The process's catch-all must never fail the execution: a finished application stays as it is
  if (input.status === 'MANUAL_REVIEW' && isFinal(app.status)) return { applicationId };

  const changes: ApplicationChanges = { status: input.status, taskToken: undefined };
  if (input.status === 'MANUAL_REVIEW') changes.manualReviewReason = input.reason;

  const now = nowIso();
  const { item, next } = updateApplication(app, changes, now);
  const meta = eventMeta(next, now);
  const event =
    input.status === 'SIGNED'
      ? makeEvent('OfferSigned', meta, { signedAt: input.signedAt })
      : input.status === 'EXPIRED'
        ? makeEvent('OfferExpired', meta, {})
        : makeEvent('ApplicationSentToManualReview', meta, { reason: input.reason });

  const isDone = (fresh: Application) =>
    fresh.status === input.status || (input.status === 'MANUAL_REVIEW' && isFinal(fresh.status));
  await commitOrCheck([item, outboxPut(event)], applicationId, isDone);
  return { applicationId };
};
