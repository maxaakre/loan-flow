import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { assess, makeEvent, type DecisionOutcome, type DomainEvent } from '@loanflow/core';
import { eventMeta, updateApplication, type ApplicationChanges } from '../db/applications';
import { outboxPut } from '../db/outbox';
import { metrics } from '../http';
import { commitOrCheck, loadApplication, nowIso, type StepInput } from './common';

export const handler = async ({ applicationId }: StepInput): Promise<StepInput & { outcome: DecisionOutcome }> => {
  const app = await loadApplication(applicationId);
  if (app.decision) return { applicationId, outcome: app.decision.outcome }; // decided on an earlier attempt
  if (!app.company) throw new Error(`Application ${applicationId} has no company data`);

  const decision = assess(app.company, { amount: app.amount, termMonths: app.termMonths });
  const changes: ApplicationChanges = { decision };
  if (decision.outcome === 'DECLINED') changes.status = 'DECLINED';
  if (decision.outcome === 'MANUAL_REVIEW') {
    changes.status = 'MANUAL_REVIEW';
    changes.manualReviewReason = decision.reasons[0];
  }

  const now = nowIso();
  const { item, next } = updateApplication(app, changes, now);
  const events: DomainEvent[] = [
    makeEvent('CreditDecided', eventMeta(next, now, 0), {
      outcome: decision.outcome,
      reasons: decision.reasons,
      rulesVersion: decision.rulesVersion,
      approvedAmount: decision.approvedAmount,
    }),
  ];
  if (changes.manualReviewReason) {
    events.push(makeEvent('ApplicationSentToManualReview', eventMeta(next, now, 1), { reason: changes.manualReviewReason }));
  }
  await commitOrCheck([item, ...events.map(outboxPut)], applicationId, (fresh) => fresh.decision !== undefined);

  metrics.addMetric('TimeToDecision', MetricUnit.Seconds, (Date.parse(now) - Date.parse(app.createdAt)) / 1000);
  metrics.addDimension('outcome', decision.outcome);
  metrics.addMetric('CreditDecisions', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  return { applicationId, outcome: decision.outcome };
};
