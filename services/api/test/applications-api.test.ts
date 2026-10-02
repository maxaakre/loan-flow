import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { kr } from '@loanflow/core';
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
  const offered = () => ({ Item: anApplication({ status: 'OFFERED', taskToken: 'tok-1' }) });

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
    ddb.on(GetCommand).callsFake(async (input) => (input.Key.PK.startsWith('IDEMP#') ? {} : offered()));
    sfn.on(SendTaskSuccessCommand).rejects(Object.assign(new Error('timed out'), { name: 'TaskTimedOut' }));
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
});
