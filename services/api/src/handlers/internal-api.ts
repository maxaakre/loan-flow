import { APPLICATION_STATUSES, receivableBalance, toPublicApplication } from '@loanflow/core';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { getApplication, listApplicationsByStatus } from '../db/applications';
import { getLoan, listLedger } from '../db/loans';
import { HttpError, notFound, pathId, routeHandler, type HttpResult } from '../http';
import { timelineEvents } from './shared';

// Read-only by design: nothing here can decide, sign or pay
const StatusQuery = z.enum(APPLICATION_STATUSES);

async function list(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const status = StatusQuery.safeParse(event.queryStringParameters?.status ?? 'MANUAL_REVIEW');
  if (!status.success) throw new HttpError(400, 'Invalid status', `status must be one of ${APPLICATION_STATUSES.join(', ')}`);
  const apps = await listApplicationsByStatus(status.data);
  return {
    status: 200,
    body: apps.map(({ id, companyName, amount, termMonths, status, createdAt }) => ({
      id,
      companyName,
      amount,
      termMonths,
      status,
      createdAt,
    })),
  };
}

async function get(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const app = await getApplication(pathId(event));
  if (!app) throw notFound('Application not found');
  return { status: 200, body: toPublicApplication(app) };
}

async function decision(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const app = await getApplication(pathId(event));
  if (!app) throw notFound('Application not found');
  if (!app.decision && !app.manualReviewReason) throw notFound('Decision not found');
  return {
    status: 200,
    body: {
      applicationId: app.id,
      status: app.status,
      decision: app.decision ?? null,
      manualReviewReason: app.manualReviewReason ?? null,
    },
  };
}

async function ledger(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const id = pathId(event);
  const loan = await getLoan(id);
  if (!loan) throw notFound('Loan not found');
  const entries = await listLedger(id);
  return { status: 200, body: { loan, entries, balanceFromLedger: receivableBalance(entries) } };
}

export const handler = routeHandler({
  'GET /internal/applications': list,
  'GET /internal/applications/{id}': get,
  'GET /internal/applications/{id}/decision': decision,
  'GET /internal/applications/{id}/events': timelineEvents,
  'GET /internal/loans/{id}/ledger': ledger,
});
