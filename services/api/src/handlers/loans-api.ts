import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { instalmentEntry, makeEvent, nextInstalment, subOre, type DomainEvent, type LoanStatus } from '@loanflow/core';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { eventMeta } from '../db/applications';
import { ConditionFailedError, TransactionConflictError, transact } from '../db/client';
import { checkIdempotency, idempotencyPut, replayOrThrow } from '../db/idempotency';
import { getLoan, listLedger, putLedgerEntry, updateLoan } from '../db/loans';
import { outboxPut } from '../db/outbox';
import {
  HttpError,
  idempotencyKey,
  metrics,
  notFound,
  pathId,
  requestHash,
  routeHandler,
  type HttpResult,
  type RequestContext,
} from '../http';

const LOAN_NOT_FOUND = 'Lånet hittades inte.';

async function get(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const id = pathId(event);
  const loan = await getLoan(id);
  if (!loan) throw notFound(LOAN_NOT_FOUND);
  return { status: 200, body: { loan, ledger: await listLedger(id) } };
}

/** Always pays exactly the next instalment. There is no free amount. */
async function pay(event: APIGatewayProxyEventV2, ctx: RequestContext): Promise<HttpResult> {
  const id = pathId(event);
  const key = idempotencyKey(event);
  const hash = requestHash({ route: event.routeKey, id });
  const check = await checkIdempotency(key, hash);
  if (check.kind === 'replay') return check.result;

  const loan = await getLoan(id);
  if (!loan) throw notFound(LOAN_NOT_FOUND);
  const instalment = nextInstalment(loan);
  if (loan.status === 'REPAID' || !instalment) throw new HttpError(409, 'Loan repaid', 'Lånet är redan återbetalt.');

  const now = ctx.now.toISOString();
  const paidInstalments = loan.paidInstalments + 1;
  const balance = subOre(loan.balance, instalment.principal);
  const status: LoanStatus = paidInstalments === loan.schedule.length ? 'REPAID' : 'ACTIVE';
  const { item, next } = updateLoan(loan, { paidInstalments, balance, status });
  const entry = instalmentEntry({ entryId: ulid(), loanId: id, occurredAt: now, instalment });

  const events: DomainEvent[] = [
    makeEvent('PaymentReceived', eventMeta(next, now, 0), {
      loanId: id,
      instalmentNumber: instalment.number,
      amount: instalment.total,
      balance,
    }),
  ];
  if (status === 'REPAID') events.push(makeEvent('LoanRepaid', eventMeta(next, now, 1), { loanId: id }));

  const result: HttpResult = {
    status: 201,
    body: { loanId: id, instalmentNumber: instalment.number, amount: instalment.total, balance, status },
  };
  const items = [item, putLedgerEntry(entry), ...events.map(outboxPut), idempotencyPut(key, hash, result)];
  try {
    await transact(items);
  } catch (err) {
    const concurrent = () => new HttpError(409, 'Concurrent update', 'Lånet ändrades samtidigt. Försök igen.');
    if (err instanceof TransactionConflictError) throw concurrent();
    const idempotencyIndex = items.length - 1;
    if (err instanceof ConditionFailedError && !err.failedIndexes.includes(idempotencyIndex)) {
      throw concurrent();
    }
    return replayOrThrow(key, hash, err);
  }
  metrics.addMetric('PaymentsReceived', MetricUnit.Count, 1);
  return result;
}

export const handler = routeHandler({
  'GET /api/loans/{id}': get,
  'POST /api/loans/{id}/payments': pay,
});
