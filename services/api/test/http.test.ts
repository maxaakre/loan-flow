import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConditionFailedError } from '../src/db/client';
import { replayOrThrow } from '../src/db/idempotency';
import { HttpError, httpHandler, idempotencyKey, parseBody, requestHash } from '../src/http';
import { sqsBatch } from '../src/sqs';
import { apiEvent, lambdaContext, parse } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

const run = (handler: ReturnType<typeof httpHandler>, headers?: Record<string, string>) =>
  handler(apiEvent({ routeKey: 'GET /x', headers }), lambdaContext).then(parse);

describe('httpHandler', () => {
  it('returns the result as JSON', async () => {
    const res = await run(httpHandler(async () => ({ status: 201, body: { ok: true } })));
    expect(res).toMatchObject({ status: 201, body: { ok: true }, contentType: 'application/json' });
  });

  it('turns an HttpError into a problem+json response', async () => {
    const res = await run(
      httpHandler(async () => {
        throw new HttpError(409, 'Conflict', 'Already done');
      }),
    );
    expect(res.status).toBe(409);
    expect(res.contentType).toBe('application/problem+json');
    expect(res.body).toEqual({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Already done', correlationId: 'req-1' });
  });

  it('turns an unexpected error into a 500 with a Swedish detail', async () => {
    const res = await run(
      httpHandler(async () => {
        throw new Error('boom');
      }),
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ title: 'Internal error', detail: 'Något gick fel. Försök igen.' });
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it('uses a valid x-correlation-id', async () => {
    const res = await run(httpHandler(async (_e, ctx) => ({ status: 200, body: ctx.correlationId })), {
      'x-correlation-id': 'abc-123',
    });
    expect(res.body).toBe('abc-123');
  });

  it('falls back to the request id for an invalid x-correlation-id', async () => {
    const res = await run(httpHandler(async (_e, ctx) => ({ status: 200, body: ctx.correlationId })), {
      'x-correlation-id': 'bad id\n!',
    });
    expect(res.body).toBe('req-1');
  });
});

describe('parseBody', () => {
  const schema = z.object({ n: z.number() });

  it('returns parsed data', () => {
    expect(parseBody(apiEvent({ routeKey: 'POST /x', body: { n: 1 } }), schema)).toEqual({ n: 1 });
  });

  it('rejects invalid JSON with 400', () => {
    const event = { ...apiEvent({ routeKey: 'POST /x' }), body: '{nope' };
    expect(() => parseBody(event, schema)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('rejects a schema failure with 400 naming the field', () => {
    const event = apiEvent({ routeKey: 'POST /x', body: { n: 'x' } });
    expect(() => parseBody(event, schema)).toThrow(expect.objectContaining({ status: 400, detail: expect.stringContaining('n:') }));
  });
});

describe('idempotencyKey', () => {
  it('accepts a valid key', () => {
    expect(idempotencyKey(apiEvent({ routeKey: 'POST /x', headers: { 'idempotency-key': 'key-12345' } }))).toBe('key-12345');
  });

  it.each([undefined, 'short'])('rejects %s with 400', (key) => {
    const headers: Record<string, string> = key ? { 'idempotency-key': key } : {};
    expect(() => idempotencyKey(apiEvent({ routeKey: 'POST /x', headers }))).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('requestHash', () => {
  it('differs when the route differs', () => {
    expect(requestHash({ route: 'A', body: 1 })).not.toBe(requestHash({ route: 'B', body: 1 }));
  });
});

describe('sqsBatch', () => {
  const record = (id: string, body: unknown) => ({ messageId: id, body: JSON.stringify(body) });

  it('reports only the failing records', async () => {
    const seen: unknown[] = [];
    const handler = sqsBatch(async (detail) => {
      if ((detail as { fail?: boolean }).fail) throw new Error('bad');
      seen.push(detail);
    });
    const event = {
      Records: [
        record('m1', { detail: { id: 1 } }),
        record('m2', { detail: { fail: true } }),
        record('m3', { detail: { id: 3 } }),
      ],
    } as unknown as SQSEvent;
    expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(seen).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('fails a record that has no detail', async () => {
    const handler = sqsBatch(async () => {});
    const event = { Records: [record('m1', {})] } as unknown as SQSEvent;
    expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
  });
});

describe('replayOrThrow', () => {
  it('replays the stored result after a lost race', async () => {
    ddb.on(GetCommand).resolves({ Item: { requestHash: 'h', result: { status: 201, body: { id: 'A' } } } });
    expect(await replayOrThrow('key-12345', 'h', new ConditionFailedError([0]))).toEqual({ status: 201, body: { id: 'A' } });
  });

  it('rethrows when nothing is stored', async () => {
    ddb.on(GetCommand).resolves({});
    const err = new ConditionFailedError([0]);
    await expect(replayOrThrow('key-12345', 'h', err)).rejects.toBe(err);
  });

  it('rethrows other errors without reading', async () => {
    const err = new Error('other');
    await expect(replayOrThrow('key-12345', 'h', err)).rejects.toBe(err);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });
});
