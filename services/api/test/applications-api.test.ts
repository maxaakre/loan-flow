import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { assess, findCompany, kr } from '@loanflow/core';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/applications-api';
import { handler as companies } from '../src/handlers/companies-api';
import { anApplication, apiEvent, APP_ID, lambdaContext, lastTransaction, outboxEvents, parse } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
const sfn = mockClient(SFNClient);
beforeEach(() => {
  ddb.reset();
  sfn.reset();
});

const companyInput = (orgNr: string) => {
  const { ageMonths, avgMonthlyInflow, paymentRemarks, bankrupt } = findCompany(orgNr)!;
  return { ageMonths, avgMonthlyInflow, paymentRemarks, bankrupt };
};

const KEY = { 'idempotency-key': 'key-0000000001' };
const create = (body: unknown, headers: Record<string, string> = KEY) =>
  handler(apiEvent({ routeKey: 'POST /api/applications', body, headers }), lambdaContext).then(parse);
const sign = () =>
  handler(apiEvent({ routeKey: 'POST /api/applications/{id}/sign', pathParameters: { id: APP_ID }, headers: KEY }), lambdaContext).then(parse);
const get = () =>
  handler(apiEvent({ routeKey: 'GET /api/applications/{id}', pathParameters: { id: APP_ID } }), lambdaContext).then(parse);
const validBody = { orgNr: '559900-0001', amount: kr(200_000), termMonths: 12 };

describe('GET /api/companies', () => {
  it('lists the four test companies without credit data', async () => {
    const res = parse(await companies(apiEvent({ routeKey: 'GET /api/companies' }), lambdaContext));
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toEqual({ orgNr: '559900-0001', name: 'Kafé Solsidan AB' });
  });
});

describe('POST /api/applications', () => {
  it('saves the application, an ApplicationSubmitted outbox row and the idempotent answer in one transaction', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const res = await create(validBody);
    expect(res.status).toBe(201);
    const items = lastTransaction(ddb);
    expect(items).toHaveLength(3);
    expect(items[0]!.Put?.Item).toMatchObject({ status: 'SUBMITTED', version: 1, GSI1PK: 'STATUS#SUBMITTED' });
    expect(outboxEvents(items).map((e) => e.type)).toEqual(['ApplicationSubmitted']);
    expect(items[2]!.Put?.Item?.PK).toBe('IDEMP#key-0000000001');
  });

  it('replays the first answer for a retried request without writing again', async () => {
    const stored = { status: 201, body: { id: 'FIRST' } };
    ddb.on(GetCommand).callsFake(async (input) => {
      const hash = (await import('../src/http')).requestHash({ route: 'POST /api/applications', body: validBody });
      return input.Key.PK.startsWith('IDEMP#') ? { Item: { requestHash: hash, result: stored } } : {};
    });
    const res = await create(validBody);
    expect(res).toMatchObject({ status: 201, body: { id: 'FIRST' } });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await create(validBody, {});
    expect(res.status).toBe(400);
    expect(res.contentType).toBe('application/problem+json');
    expect(res.body).toMatchObject({ status: 400, correlationId: 'req-1' });
  });

  it('rejects unknown companies', async () => {
    ddb.on(GetCommand).resolves({});
    expect((await create({ ...validBody, orgNr: '556000-0000' })).status).toBe(422);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects amounts outside 10 000 – 2 000 000 kr and decimals', async () => {
    expect((await create({ ...validBody, amount: kr(9_999) })).status).toBe(400);
    expect((await create({ ...validBody, amount: kr(2_000_001) })).status).toBe(400);
    expect((await create({ ...validBody, amount: 1_000_000.5 })).status).toBe(400);
  });

  it('rejects terms other than 6, 12 and 24', async () => {
    expect((await create({ ...validBody, termMonths: 18 })).status).toBe(400);
  });
});

describe('GET /api/applications/{id}', () => {
  it('returns 404 for unknown ids', async () => {
    ddb.on(GetCommand).resolves({});
    expect((await get()).status).toBe(404);
  });

  it('never returns taskToken (Review Focus 3)', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'APP#x', SK: 'META', ...anApplication({ status: 'OFFERED', taskToken: 'secret' }) } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('taskToken');
    expect(res.body).not.toHaveProperty('PK');
  });

  it('does not expose company credit data or decision inputs', async () => {
    const company = companyInput('559900-0002');
    const decision = assess(company, { amount: kr(200_000), termMonths: 12 });
    ddb.on(GetCommand).resolves({ Item: { PK: 'APP#x', SK: 'META', ...anApplication({ status: 'OFFERED', company, decision }) } });
    const res = await get();
    expect(res.body).not.toHaveProperty('company');
    expect(res.body).toHaveProperty('decision.outcome');
    expect(res.body.decision).not.toHaveProperty('inputs');
  });
});

describe('GET /api/applications/{id}/events', () => {
  it('returns the timeline sorted by time, then sequence', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { eventId: 'b', type: 'CreditDecided', occurredAt: '2026-10-02T10:00:02Z', sequence: 30, summary: 'x' },
        { eventId: 'a', type: 'ApplicationSubmitted', occurredAt: '2026-10-02T10:00:00Z', sequence: 10, summary: 'y' },
      ],
    });
    const res = parse(
      await handler(apiEvent({ routeKey: 'GET /api/applications/{id}/events', pathParameters: { id: APP_ID } }), lambdaContext),
    );
    expect(res.body.map((e: { eventId: string }) => e.eventId)).toEqual(['a', 'b']);
  });
});

describe('POST /api/applications/{id}/sign', () => {
  const FUTURE = '2999-01-01T00:00:00.000Z';
  const PAST = '2000-01-01T00:00:00.000Z';
  const offered = (offerExpiresAt: string = FUTURE) => ({
    Item: anApplication({ status: 'OFFERED', taskToken: 'tok-1', offerExpiresAt }),
  });
  const withApp = (item: unknown) =>
    ddb.on(GetCommand).callsFake(async (input) => (input.Key.PK.startsWith('IDEMP#') ? {} : item));
  const timedOut = () => sfn.on(SendTaskSuccessCommand).rejects(Object.assign(new Error('x'), { name: 'TaskTimedOut' }));

  it('hands the signature to Step Functions and answers 202', async () => {
    ddb.on(GetCommand).callsFake(async (input) => (input.Key.PK.startsWith('IDEMP#') ? {} : offered()));
    ddb.on(PutCommand).resolves({});
    sfn.on(SendTaskSuccessCommand).resolves({});
    const res = await sign();
    expect(res).toMatchObject({ status: 202, body: { id: APP_ID, status: 'SIGNING' } });
    expect(sfn.commandCalls(SendTaskSuccessCommand)[0]!.args[0].input.taskToken).toBe('tok-1');
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0); // the API never writes status itself
  });

  it('returns 409 when Step Functions says TaskTimedOut (Review Focus 2)', async () => {
    withApp(offered(PAST));
    timedOut();
    const res = await sign();
    expect(res).toMatchObject({ status: 409, body: { detail: 'Erbjudandet har gått ut' } });
  });

  it('returns 409 for an already expired application', async () => {
    ddb.on(GetCommand).callsFake(async (input) =>
      input.Key.PK.startsWith('IDEMP#') ? {} : { Item: anApplication({ status: 'EXPIRED' }) },
    );
    const res = await sign();
    expect(res).toMatchObject({ status: 409, body: { detail: 'Erbjudandet har gått ut' } });
    expect(sfn.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
  });

  it('replays the stored answer without calling Step Functions', async () => {
    const hash = (await import('../src/http')).requestHash({ route: 'POST /api/applications/{id}/sign', id: APP_ID });
    const stored = { status: 202, body: { id: APP_ID, status: 'SIGNING' } };
    ddb.on(GetCommand).resolves({ Item: { requestHash: hash, result: stored } });
    expect(await sign()).toMatchObject(stored);
    expect(sfn.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
  });

  it('requires an Idempotency-Key', async () => {
    const res = parse(
      await handler(apiEvent({ routeKey: 'POST /api/applications/{id}/sign', pathParameters: { id: APP_ID } }), lambdaContext),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a key reused for a different application', async () => {
    ddb.on(GetCommand).resolves({ Item: { requestHash: 'other-hash', result: { status: 202, body: {} } } });
    expect((await sign()).status).toBe(422);
  });

  it('answers 202 without calling Step Functions when already signed', async () => {
    withApp({ Item: anApplication({ status: 'SIGNED' }) });
    ddb.on(PutCommand).resolves({});
    expect(await sign()).toMatchObject({ status: 202, body: { id: APP_ID, status: 'SIGNING' } });
    expect(sfn.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
  });

  it('treats TaskTimedOut before offerExpiresAt as an earlier sign still being processed', async () => {
    withApp(offered(FUTURE));
    ddb.on(PutCommand).resolves({});
    timedOut();
    expect(await sign()).toMatchObject({ status: 202, body: { id: APP_ID, status: 'SIGNING' } });
  });

  it('returns 409 for TaskTimedOut after offerExpiresAt', async () => {
    withApp(offered(PAST));
    timedOut();
    expect(await sign()).toMatchObject({ status: 409, body: { detail: 'Erbjudandet har gått ut' } });
  });

  describe('when the token is gone, re-reads the application', () => {
    /** First read returns `first`, every later read `then`. */
    const readsAs = (first: unknown, then: unknown) => {
      let reads = 0;
      ddb.on(GetCommand).callsFake(async (input) => (input.Key.PK.startsWith('IDEMP#') ? {} : reads++ === 0 ? first : then));
      ddb.on(PutCommand).resolves({});
    };
    const gone = Object.assign(new Error('x'), { name: 'TaskTimedOut' });

    it('retries once with the new token when create-offer swapped it', async () => {
      readsAs(offered(), { Item: anApplication({ status: 'OFFERED', taskToken: 'tok-2', offerExpiresAt: FUTURE }) });
      sfn.on(SendTaskSuccessCommand, { taskToken: 'tok-1' }).rejects(gone);
      sfn.on(SendTaskSuccessCommand, { taskToken: 'tok-2' }).resolves({});
      expect(await sign()).toMatchObject({ status: 202, body: { id: APP_ID, status: 'SIGNING' } });
      expect(sfn.commandCalls(SendTaskSuccessCommand).map((c) => c.args[0].input.taskToken)).toEqual(['tok-1', 'tok-2']);
    });

    it('answers 202 when the application is now SIGNED, even after offerExpiresAt', async () => {
      readsAs(offered(PAST), { Item: anApplication({ status: 'SIGNED' }) });
      sfn.on(SendTaskSuccessCommand).rejects(gone);
      expect(await sign()).toMatchObject({ status: 202, body: { id: APP_ID, status: 'SIGNING' } });
      expect(sfn.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    });

    it('answers 409 when the application is now EXPIRED, even before offerExpiresAt', async () => {
      readsAs(offered(FUTURE), { Item: anApplication({ status: 'EXPIRED', offerExpiresAt: FUTURE }) });
      sfn.on(SendTaskSuccessCommand).rejects(gone);
      expect(await sign()).toMatchObject({ status: 409, body: { detail: 'Erbjudandet har gått ut' } });
      expect(ddb.commandCalls(PutCommand)).toHaveLength(0); // no 202 remembered
    });

    it('answers 409 when the swapped token is gone too and the offer has expired', async () => {
      readsAs(offered(), { Item: anApplication({ status: 'OFFERED', taskToken: 'tok-2', offerExpiresAt: PAST }) });
      sfn.on(SendTaskSuccessCommand).rejects(gone);
      expect(await sign()).toMatchObject({ status: 409, body: { detail: 'Erbjudandet har gått ut' } });
      expect(sfn.commandCalls(SendTaskSuccessCommand)).toHaveLength(2);
    });
  });

  it('returns 500 for other Step Functions errors', async () => {
    withApp(offered());
    sfn.on(SendTaskSuccessCommand).rejects(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
    expect((await sign()).status).toBe(500);
  });
});
