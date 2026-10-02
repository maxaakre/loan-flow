import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { kr, makeEvent } from '@loanflow/core';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler as notifications } from '../src/handlers/notifications-consumer';
import { handler as relay } from '../src/handlers/outbox-relay';
import { handler as timeline } from '../src/handlers/timeline-consumer';
import { APP_ID, NOW } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
const eb = mockClient(EventBridgeClient);
beforeEach(() => {
  ddb.reset();
  eb.reset();
});

const meta = { eventId: 'E1', occurredAt: NOW, aggregateId: APP_ID, sequence: 10, correlationId: 'c' };
const disbursed = makeEvent('LoanDisbursed', meta, { loanId: APP_ID, amount: kr(100_000), payoutId: 'P1' });
const signed = makeEvent('OfferSigned', { ...meta, eventId: 'E2' }, { signedAt: NOW });

const streamOf = (...events: unknown[]): DynamoDBStreamEvent =>
  ({
    Records: events.map((event, i) => ({
      eventName: 'INSERT',
      dynamodb: { SequenceNumber: `seq-${i}`, NewImage: marshall({ PK: `OUTBOX#${i}`, SK: 'META', event }) },
    })),
  }) as unknown as DynamoDBStreamEvent;

const sqsOf = (detail: unknown): SQSEvent =>
  ({ Records: [{ messageId: 'm1', body: JSON.stringify({ 'detail-type': 'x', detail }) }] }) as unknown as SQSEvent;
const conditionalFailure = () => Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });

describe('outbox-relay', () => {
  it('publishes each outbox row to the bus with the event type as detail-type', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'x' }] });
    const res = await relay(streamOf(disbursed, signed));
    expect(res.batchItemFailures).toEqual([]);
    const entries = eb.commandCalls(PutEventsCommand).map((c) => c.args[0].input.Entries![0]!);
    expect(entries.map((e) => e.DetailType)).toEqual(['LoanDisbursed', 'OfferSigned']);
    expect(entries[0]).toMatchObject({ Source: 'loanflow', EventBusName: 'test-bus' });
    expect(JSON.parse(entries[0]!.Detail!)).toEqual(disbursed);
  });

  it('stops at the first failure and asks the stream to retry from there', async () => {
    eb.on(PutEventsCommand)
      .resolvesOnce({ FailedEntryCount: 0, Entries: [{}] })
      .resolvesOnce({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
    const res = await relay(streamOf(disbursed, signed));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'seq-1' }]);
  });
});

describe('timeline-consumer', () => {
  it('writes one timeline row with a Swedish summary', async () => {
    ddb.on(PutCommand).resolves({});
    await timeline(sqsOf(disbursed));
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ PK: `APP#${APP_ID}`, SK: 'EVT#E1', type: 'LoanDisbursed', sequence: 10 });
    expect(String(item.summary)).toMatch(/^Utbetalt: 100\s000\skr$/);
  });

  it('duplicate event is ignored (Review Focus 4)', async () => {
    ddb.on(PutCommand).rejects(conditionalFailure());
    expect((await timeline(sqsOf(disbursed))).batchItemFailures).toEqual([]);
  });

  it('reports an invalid event as a failure so it ends up in the DLQ', async () => {
    expect((await timeline(sqsOf({ type: 'Nope' }))).batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});

describe('notifications-consumer', () => {
  it('claims the event id before "sending"', async () => {
    ddb.on(PutCommand).resolves({});
    await notifications(sqsOf(disbursed));
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ PK: 'NOTIF#E1' });
  });

  it('does not send twice for a duplicate', async () => {
    ddb.on(PutCommand).rejects(conditionalFailure());
    expect((await notifications(sqsOf(disbursed))).batchItemFailures).toEqual([]);
  });

  it('ignores events without a notification', async () => {
    await notifications(sqsOf(signed));
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});
