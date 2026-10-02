import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildOffer, kr, type LedgerEntry } from '@loanflow/core';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError } from '../src/db/client';
import { payout } from '../src/fakes/bank';
import { handler as loans } from '../src/handlers/loans-api';
import { handler as disburse } from '../src/steps/disburse';
import { aLoan, anApplication, apiEvent, APP_ID, lambdaContext, lastTransaction, outboxEvents, parse } from './fixtures';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

const conditionalFailure = () => Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
const signedApp = () => anApplication({ status: 'SIGNED', offer: buildOffer(kr(120_000), 6, 'A') });

describe('fake bank', () => {
  it('returns the first payout when the same key is used again', async () => {
    ddb.on(PutCommand).rejects(conditionalFailure());
    ddb.on(GetCommand).resolves({ Item: { payoutId: 'FIRST' } });
    expect(await payout('key-1', kr(100))).toEqual({ payoutId: 'FIRST' });
  });
});

describe('disburse', () => {
  it('records status, loan, balanced ledger entry and LoanDisbursed in one transaction', async () => {
    ddb.on(GetCommand).resolves({ Item: signedApp() });
    ddb.on(PutCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    await disburse({ applicationId: APP_ID });
    const items = lastTransaction(ddb);
    expect(items).toHaveLength(4);
    expect(items[1]!.Put!.Item).toMatchObject({ PK: `LOAN#${APP_ID}`, balance: kr(120_000), status: 'ACTIVE' });
    const entry = items[2]!.Put!.Item as LedgerEntry;
    expect(entry.reason).toBe('PAYOUT');
    expect(outboxEvents(items).map((e) => e.type)).toEqual(['LoanDisbursed']);
  });

  it('reuses the first payout after a crash between bank call and commit', async () => {
    ddb.on(GetCommand).callsFake(async (input) =>
      input.Key.PK.startsWith('BANKPAYOUT#') ? { Item: { payoutId: 'FIRST' } } : { Item: signedApp() },
    );
    ddb.on(PutCommand).rejects(conditionalFailure()); // the bank already has this key
    ddb.on(TransactWriteCommand).resolves({});
    await disburse({ applicationId: APP_ID });
    expect(lastTransaction(ddb)[1]!.Put!.Item).toMatchObject({ payoutId: 'FIRST' });
  });

  it('does nothing when already disbursed', async () => {
    ddb.on(GetCommand).resolves({ Item: anApplication({ status: 'DISBURSED' }) });
    await disburse({ applicationId: APP_ID });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('loans API', () => {
  const KEY = { 'idempotency-key': 'pay-000000001' };
  const pay = () =>
    loans(apiEvent({ routeKey: 'POST /api/loans/{id}/payments', pathParameters: { id: APP_ID }, headers: KEY }), lambdaContext).then(
      parse,
    );
  const storedLoan = (loan: ReturnType<typeof aLoan>) =>
    ddb.on(GetCommand).callsFake(async (input) => (input.Key.PK.startsWith('IDEMP#') ? {} : { Item: loan }));

  it('pays the next instalment with a balanced ledger entry', async () => {
    const loan = aLoan();
    storedLoan(loan);
    ddb.on(TransactWriteCommand).resolves({});
    const res = await pay();
    const first = loan.schedule[0]!;
    expect(res).toMatchObject({
      status: 201,
      body: { instalmentNumber: 1, amount: first.total, balance: loan.balance - first.principal, status: 'ACTIVE' },
    });
    expect(outboxEvents(lastTransaction(ddb)).map((e) => e.type)).toEqual(['PaymentReceived']);
  });

  it('closes the loan on the last instalment', async () => {
    const loan = aLoan({ paidInstalments: 5 });
    storedLoan({ ...loan, balance: loan.schedule[5]!.principal });
    ddb.on(TransactWriteCommand).resolves({});
    const res = await pay();
    expect(res.body).toMatchObject({ balance: 0, status: 'REPAID' });
    expect(outboxEvents(lastTransaction(ddb)).map((e) => e.type)).toEqual(['PaymentReceived', 'LoanRepaid']);
  });

  it('refuses to pay a repaid loan', async () => {
    storedLoan(aLoan({ paidInstalments: 6, status: 'REPAID' }));
    expect((await pay()).status).toBe(409);
  });

  it('answers 409 when another payment changed the loan at the same time', async () => {
    storedLoan(aLoan());
    ddb.on(TransactWriteCommand).rejects(new ConditionFailedError([0]));
    expect(await pay()).toMatchObject({ status: 409, body: { detail: 'Lånet ändrades samtidigt. Försök igen.' } });
  });

  it('returns loan and ledger', async () => {
    ddb.on(GetCommand).resolves({ Item: aLoan() });
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = parse(await loans(apiEvent({ routeKey: 'GET /api/loans/{id}', pathParameters: { id: APP_ID } }), lambdaContext));
    expect(res.body).toMatchObject({ loan: { id: APP_ID }, ledger: [] });
  });
});
