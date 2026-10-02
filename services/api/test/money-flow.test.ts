import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildOffer, kr, type LedgerEntry } from '@loanflow/core';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError, TransactionConflictError } from '../src/db/client';
import { payout } from '../src/fakes/bank';
import { requestHash } from '../src/http';
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
    const line = (account: string) => entry.lines.find((l) => l.account === account)!;
    expect(line('LOAN_RECEIVABLE').debit).toBe(kr(120_000));
    expect(line('BANK_PAYOUT').credit).toBe(kr(120_000));
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ PK: `BANKPAYOUT#${APP_ID}` });
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
    const items = lastTransaction(ddb);
    expect(items[0]!.Update!.ConditionExpression).toBe('#ver = :expected');
    const entry = items[1]!.Put!.Item as LedgerEntry;
    const line = (account: string) => entry.lines.find((l) => l.account === account)!;
    expect(line('BANK_INCOMING').debit).toBe(line('LOAN_RECEIVABLE').credit + line('FEE_INCOME').credit);
    expect(line('BANK_INCOMING').debit).toBe(first.total);
  });

  it('replays a stored result without writing again', async () => {
    const stored = { status: 201, body: { loanId: APP_ID, instalmentNumber: 1 } };
    const hash = requestHash({ route: 'POST /api/loans/{id}/payments', id: APP_ID });
    ddb.on(GetCommand).callsFake(async (input) =>
      input.Key.PK.startsWith('IDEMP#') ? { Item: { requestHash: hash, result: stored } } : { Item: aLoan() },
    );
    expect(await pay()).toMatchObject(stored);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns the winner\'s answer when a parallel request with the same key committed first', async () => {
    const winner = { status: 201, body: { loanId: APP_ID, instalmentNumber: 1 } };
    const hash = requestHash({ route: 'POST /api/loans/{id}/payments', id: APP_ID });
    let idempReads = 0;
    ddb.on(GetCommand).callsFake(async (input) => {
      if (!input.Key.PK.startsWith('IDEMP#')) return { Item: aLoan() };
      return ++idempReads === 1 ? {} : { Item: { requestHash: hash, result: winner } };
    });
    // items: loan update, ledger entry, one event, idempotency record (last)
    ddb.on(TransactWriteCommand).rejects(new ConditionFailedError([0, 3]));
    expect(await pay()).toMatchObject(winner);
  });

  it('answers 409 when DynamoDB reports a transaction conflict', async () => {
    storedLoan(aLoan());
    ddb.on(TransactWriteCommand).rejects(new TransactionConflictError());
    expect(await pay()).toMatchObject({ status: 409, body: { detail: 'Lånet ändrades samtidigt. Försök igen.' } });
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
