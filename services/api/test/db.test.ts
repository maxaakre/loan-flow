import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { InvalidTransitionError, makeEvent } from '@loanflow/core';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateApplication } from '../src/db/applications';
import { ConditionFailedError, transact } from '../src/db/client';
import { checkIdempotency } from '../src/db/idempotency';
import { outboxPut } from '../src/db/outbox';
import { HttpError } from '../src/http';
import { anApplication, NOW } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

describe('transact', () => {
  it('reports which items failed their condition', async () => {
    const err = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    ddb.on(TransactWriteCommand).rejects(err);
    const result = transact([]);
    await expect(result).rejects.toBeInstanceOf(ConditionFailedError);
    await expect(result).rejects.toMatchObject({ failedIndexes: [1] });
  });
});

describe('updateApplication', () => {
  it('bumps the version, checks the old one and moves the status index', () => {
    const app = anApplication({ status: 'SUBMITTED', version: 3 });
    const { item, next } = updateApplication(app, { status: 'ASSESSING' }, NOW);
    expect(next.version).toBe(4);
    expect(item.Update?.ConditionExpression).toBe('#ver = :expected');
    expect(item.Update?.ExpressionAttributeValues?.[':expected']).toBe(3);
    expect(Object.values(item.Update?.ExpressionAttributeValues ?? {})).toContain('STATUS#ASSESSING');
  });

  it('removes fields set to undefined', () => {
    const app = anApplication({ status: 'OFFERED', taskToken: 'tok' });
    const { item, next } = updateApplication(app, { status: 'SIGNED', taskToken: undefined }, NOW);
    expect(item.Update?.UpdateExpression).toMatch(/ REMOVE #f\d+$/);
    expect(next).not.toHaveProperty('taskToken');
  });

  it('refuses an invalid status change', () => {
    expect(() => updateApplication(anApplication({ status: 'SUBMITTED' }), { status: 'DISBURSED' }, NOW)).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('idempotency', () => {
  it('is new when nothing is stored', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await checkIdempotency('key-12345', 'h1')).toEqual({ kind: 'new' });
  });

  it('replays the stored result for the same request', async () => {
    ddb.on(GetCommand).resolves({ Item: { requestHash: 'h1', result: { status: 201, body: { id: 'A' } } } });
    expect(await checkIdempotency('key-12345', 'h1')).toEqual({ kind: 'replay', result: { status: 201, body: { id: 'A' } } });
  });

  it('rejects a reused key with a different request', async () => {
    ddb.on(GetCommand).resolves({ Item: { requestHash: 'other', result: { status: 201, body: {} } } });
    await expect(checkIdempotency('key-12345', 'h1')).rejects.toMatchObject({ status: 422 } satisfies Partial<HttpError>);
  });
});

describe('outboxPut', () => {
  it('writes the event under OUTBOX# with a TTL and no-overwrite condition', () => {
    const event = makeEvent(
      'OfferSigned',
      { eventId: 'E1', occurredAt: NOW, aggregateId: 'A', sequence: 1, correlationId: 'c' },
      { signedAt: NOW },
    );
    const item = outboxPut(event);
    expect(item.Put?.Item).toMatchObject({ PK: 'OUTBOX#E1', SK: 'META', event });
    expect(typeof item.Put?.Item?.ttl).toBe('number');
    expect(item.Put?.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});
