import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { assess, findCompany, kr, makeEvent, type Application } from '@loanflow/core';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError } from '../src/db/client';
import { lookupCompany, RegistryUnavailableError } from '../src/fakes/registry';
import { handler as startProcess } from '../src/handlers/start-process';
import { handler as assessCredit } from '../src/steps/assess-credit';
import { handler as createOffer } from '../src/steps/create-offer';
import { handler as fetchCompany } from '../src/steps/fetch-company';
import { handler as setStatus } from '../src/steps/set-status';
import { anApplication, APP_ID, lastTransaction, NOW, outboxEvents } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
const sfn = mockClient(SFNClient);
beforeEach(() => {
  ddb.reset();
  sfn.reset();
});

const stored = (app: Application) => ddb.on(GetCommand).resolves({ Item: { PK: `APP#${app.id}`, SK: 'META', ...app } });
const companyInput = (orgNr: string) => {
  const { ageMonths, avgMonthlyInflow, paymentRemarks, bankrupt } = findCompany(orgNr)!;
  return { ageMonths, avgMonthlyInflow, paymentRemarks, bankrupt };
};

const sqsOf = (detail: unknown): SQSEvent =>
  ({ Records: [{ messageId: 'm1', body: JSON.stringify({ detail }) }] }) as unknown as SQSEvent;
const submitted = makeEvent(
  'ApplicationSubmitted',
  { eventId: 'E1', occurredAt: NOW, aggregateId: APP_ID, sequence: 10, correlationId: 'c' },
  { orgNr: '559900-0001', companyName: 'Kafé Solsidan AB', amount: kr(200_000), termMonths: 12 },
);

describe('start-process', () => {
  it('starts one execution named after the application', async () => {
    sfn.on(StartExecutionCommand).resolves({});
    const res = await startProcess(sqsOf(submitted));
    expect(res.batchItemFailures).toEqual([]);
    expect(sfn.commandCalls(StartExecutionCommand)[0]!.args[0].input).toMatchObject({
      name: APP_ID,
      input: JSON.stringify({ applicationId: APP_ID }),
    });
  });

  it('treats an existing execution as success (duplicate event)', async () => {
    sfn.on(StartExecutionCommand).rejects(Object.assign(new Error('exists'), { name: 'ExecutionAlreadyExists' }));
    expect((await startProcess(sqsOf(submitted))).batchItemFailures).toEqual([]);
  });

  it('reports a malformed message as a batch item failure', async () => {
    expect((await startProcess(sqsOf({ nope: true }))).batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});

describe('fake registry', () => {
  it('returns credit data for a normal company', async () => {
    expect(await lookupCompany('559900-0001')).toEqual(companyInput('559900-0001'));
  });

  it('fails for Långsam Data AB with an error Step Functions can match by name', async () => {
    const err = await lookupCompany('559900-0004').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryUnavailableError);
    expect((err as Error).name).toBe('RegistryUnavailableError');
  });
});

describe('fetch-company', () => {
  it('stores company data, moves to ASSESSING and emits CompanyDataFetched', async () => {
    stored(anApplication({ status: 'SUBMITTED' }));
    ddb.on(TransactWriteCommand).resolves({});
    expect(await fetchCompany({ applicationId: APP_ID })).toEqual({ applicationId: APP_ID });
    const items = lastTransaction(ddb);
    expect(Object.values(items[0]!.Update!.ExpressionAttributeValues!)).toContain('ASSESSING');
    expect(outboxEvents(items).map((e) => e.type)).toEqual(['CompanyDataFetched']);
  });

  it('does nothing when already past SUBMITTED (retry after commit)', async () => {
    stored(anApplication({ status: 'ASSESSING' }));
    await fetchCompany({ applicationId: APP_ID });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('assess-credit', () => {
  it('declines Skuldsatt AB and ends the application', async () => {
    stored(anApplication({ status: 'ASSESSING', orgNr: '559900-0003', company: companyInput('559900-0003') }));
    ddb.on(TransactWriteCommand).resolves({});
    expect(await assessCredit({ applicationId: APP_ID })).toEqual({ applicationId: APP_ID, outcome: 'DECLINED' });
    expect(outboxEvents(lastTransaction(ddb)).map((e) => e.type)).toEqual(['CreditDecided']);
  });

  it('sends large amounts to manual review with two events', async () => {
    stored(anApplication({ status: 'ASSESSING', amount: kr(1_500_000), company: companyInput('559900-0001') }));
    ddb.on(TransactWriteCommand).resolves({});
    expect((await assessCredit({ applicationId: APP_ID })).outcome).toBe('MANUAL_REVIEW');
    expect(outboxEvents(lastTransaction(ddb)).map((e) => e.type)).toEqual(['CreditDecided', 'ApplicationSentToManualReview']);
  });

  it('returns the stored outcome without deciding twice', async () => {
    const company = companyInput('559900-0001');
    const decision = assess(company, { amount: kr(200_000), termMonths: 12 });
    stored(anApplication({ status: 'ASSESSING', company, decision }));
    expect((await assessCredit({ applicationId: APP_ID })).outcome).toBe('APPROVED');
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('create-offer', () => {
  it('offers the approved amount, stores the task token and sets an expiry', async () => {
    const company = companyInput('559900-0002');
    const decision = assess(company, { amount: kr(200_000), termMonths: 12 });
    stored(anApplication({ status: 'ASSESSING', orgNr: '559900-0002', company, decision }));
    ddb.on(TransactWriteCommand).resolves({});
    await createOffer({ applicationId: APP_ID, taskToken: 'tok-1' });
    const items = lastTransaction(ddb);
    const values = Object.values(items[0]!.Update!.ExpressionAttributeValues!);
    expect(values).toContain('OFFERED');
    expect(values).toContain('tok-1');
    const offer = values.find((v) => typeof v === 'object' && v !== null && 'schedule' in v) as { amount: number };
    expect(offer.amount).toBe(kr(88_000));
    expect(outboxEvents(items).map((e) => e.type)).toEqual(['OfferCreated']);
  });

  it('only swaps the token when the offer already exists (retry with a new token)', async () => {
    stored(anApplication({ status: 'OFFERED', taskToken: 'old' }));
    ddb.on(TransactWriteCommand).resolves({});
    await createOffer({ applicationId: APP_ID, taskToken: 'new' });
    const items = lastTransaction(ddb);
    expect(items).toHaveLength(1);
    expect(Object.values(items[0]!.Update!.ExpressionAttributeValues!)).toContain('new');
  });
});

describe('set-status', () => {
  it('marks SIGNED, removes the token and emits OfferSigned', async () => {
    stored(anApplication({ status: 'OFFERED', taskToken: 'tok' }));
    ddb.on(TransactWriteCommand).resolves({});
    await setStatus({ applicationId: APP_ID, status: 'SIGNED', signedAt: NOW });
    const items = lastTransaction(ddb);
    expect(items[0]!.Update!.UpdateExpression).toContain('REMOVE');
    expect(outboxEvents(items)[0]).toMatchObject({ type: 'OfferSigned', data: { signedAt: NOW } });
  });

  it('marks MANUAL_REVIEW straight from SUBMITTED when the registry is down', async () => {
    stored(anApplication({ status: 'SUBMITTED' }));
    ddb.on(TransactWriteCommand).resolves({});
    await setStatus({ applicationId: APP_ID, status: 'MANUAL_REVIEW', reason: 'REGISTRY_UNAVAILABLE' });
    expect(outboxEvents(lastTransaction(ddb))[0]).toMatchObject({
      type: 'ApplicationSentToManualReview',
      data: { reason: 'REGISTRY_UNAVAILABLE' },
    });
  });

  it('is a no-op when the status is already set', async () => {
    stored(anApplication({ status: 'EXPIRED' }));
    await setStatus({ applicationId: APP_ID, status: 'EXPIRED' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('conflict handling (commitOrCheck)', () => {
  const cancelled = () =>
    Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
  const row = (app: Application) => ({ Item: { PK: `APP#${app.id}`, SK: 'META', ...app } });
  const getTwice = (first: Application, second: Application) =>
    ddb.on(GetCommand).resolvesOnce(row(first)).resolves(row(second));

  it('fetch-company succeeds when a conflicting run already moved the application on', async () => {
    getTwice(anApplication({ status: 'SUBMITTED' }), anApplication({ status: 'ASSESSING' }));
    ddb.on(TransactWriteCommand).rejects(cancelled());
    expect(await fetchCompany({ applicationId: APP_ID })).toEqual({ applicationId: APP_ID });
  });

  it('fetch-company rethrows the conflict when the work is still not done', async () => {
    getTwice(anApplication({ status: 'SUBMITTED' }), anApplication({ status: 'SUBMITTED' }));
    ddb.on(TransactWriteCommand).rejects(cancelled());
    const err = await fetchCompany({ applicationId: APP_ID }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConditionFailedError);
    expect((err as Error).name).toBe('ConditionFailedError');
  });

  it('assess-credit succeeds when a conflicting run already stored the decision', async () => {
    const company = companyInput('559900-0001');
    const decision = assess(company, { amount: kr(200_000), termMonths: 12 });
    getTwice(
      anApplication({ status: 'ASSESSING', company }),
      anApplication({ status: 'ASSESSING', company, decision }),
    );
    ddb.on(TransactWriteCommand).rejects(new ConditionFailedError([0]));
    expect(await assessCredit({ applicationId: APP_ID })).toEqual({ applicationId: APP_ID, outcome: 'APPROVED' });
  });

  it('set-status succeeds when a conflicting run already set the status', async () => {
    getTwice(anApplication({ status: 'OFFERED', taskToken: 'tok' }), anApplication({ status: 'SIGNED' }));
    ddb.on(TransactWriteCommand).rejects(cancelled());
    expect(await setStatus({ applicationId: APP_ID, status: 'SIGNED', signedAt: NOW })).toEqual({
      applicationId: APP_ID,
    });
  });

  it('create-offer propagates a conflict on the first path', async () => {
    const company = companyInput('559900-0002');
    const decision = assess(company, { amount: kr(200_000), termMonths: 12 });
    stored(anApplication({ status: 'ASSESSING', orgNr: '559900-0002', company, decision }));
    ddb.on(TransactWriteCommand).rejects(cancelled());
    await expect(createOffer({ applicationId: APP_ID, taskToken: 't' })).rejects.toBeInstanceOf(ConditionFailedError);
  });
});

describe('fetch-company with the registry down', () => {
  it('rejects with RegistryUnavailableError and writes nothing', async () => {
    stored(anApplication({ status: 'SUBMITTED', orgNr: '559900-0004' }));
    await expect(fetchCompany({ applicationId: APP_ID })).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
