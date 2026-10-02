import { makeEvent } from '@loanflow/core';
import { eventMeta, updateApplication } from '../db/applications';
import { outboxPut } from '../db/outbox';
import { lookupCompany } from '../fakes/registry';
import { commitOrCheck, loadApplication, nowIso, type StepInput } from './common';

export const handler = async ({ applicationId }: StepInput): Promise<StepInput> => {
  const app = await loadApplication(applicationId);
  if (app.status !== 'SUBMITTED') return { applicationId }; // already done on an earlier attempt

  // Throws RegistryUnavailableError → Step Functions retries with backoff, then manual review
  const company = await lookupCompany(app.orgNr);

  const now = nowIso();
  const { item, next } = updateApplication(app, { status: 'ASSESSING', company }, now);
  const fetched = makeEvent('CompanyDataFetched', eventMeta(next, now), { orgNr: app.orgNr, ageMonths: company.ageMonths });
  await commitOrCheck([item, outboxPut(fetched)], applicationId, (fresh) => fresh.status !== 'SUBMITTED');
  return { applicationId };
};
