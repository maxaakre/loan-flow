import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { kr, payoutEntry } from '@loanflow/core';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/internal-api';
import { aLoan, anApplication, apiEvent, APP_ID, lambdaContext, NOW, parse } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());
const call = (routeKey: string, opts: { id?: string; status?: string } = {}) =>
  handler(
    apiEvent({
      routeKey,
      pathParameters: opts.id ? { id: opts.id } : undefined,
      queryStringParameters: opts.status ? { status: opts.status } : undefined,
    }),
    lambdaContext,
  ).then(parse);

describe('internal API', () => {
  it('lists manual-review cases by default via the status index', async () => {
    ddb.on(QueryCommand).resolves({ Items: [anApplication({ status: 'MANUAL_REVIEW' })] });
    const res = await call('GET /internal/applications');
    expect(res.body).toEqual([
      { id: APP_ID, companyName: 'Kafé Solsidan AB', amount: kr(200_000), termMonths: 12, status: 'MANUAL_REVIEW', createdAt: NOW },
    ]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      IndexName: 'GSI1',
      ExpressionAttributeValues: { ':pk': 'STATUS#MANUAL_REVIEW' },
    });
  });

  it('rejects an unknown status', async () => {
    expect((await call('GET /internal/applications', { status: 'NOPE' })).status).toBe(400);
  });

  it('never returns taskToken (Review Focus 3)', async () => {
    ddb.on(GetCommand).resolves({ Item: anApplication({ status: 'OFFERED', taskToken: 'secret' }) });
    expect((await call('GET /internal/applications/{id}', { id: APP_ID })).body).not.toHaveProperty('taskToken');
  });

  it('returns 404 for a decision that does not exist yet', async () => {
    ddb.on(GetCommand).resolves({ Item: anApplication({ status: 'SUBMITTED' }) });
    expect((await call('GET /internal/applications/{id}/decision', { id: APP_ID })).status).toBe(404);
  });

  it('explains a registry outage as a manual-review reason', async () => {
    ddb.on(GetCommand).resolves({ Item: anApplication({ status: 'MANUAL_REVIEW', manualReviewReason: 'REGISTRY_UNAVAILABLE' }) });
    const res = await call('GET /internal/applications/{id}/decision', { id: APP_ID });
    expect(res.body).toEqual({ applicationId: APP_ID, status: 'MANUAL_REVIEW', decision: null, manualReviewReason: 'REGISTRY_UNAVAILABLE' });
  });

  it('returns the ledger with a balance recomputed from the entries', async () => {
    ddb.on(GetCommand).resolves({ Item: aLoan() });
    ddb.on(QueryCommand).resolves({ Items: [payoutEntry({ entryId: 'E', loanId: APP_ID, occurredAt: NOW, amount: kr(120_000) })] });
    const res = await call('GET /internal/loans/{id}/ledger', { id: APP_ID });
    expect(res.body.balanceFromLedger).toBe(kr(120_000));
  });
});
