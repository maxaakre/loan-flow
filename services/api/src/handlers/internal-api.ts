import { APPLICATION_STATUSES, receivableBalance, toPublicApplication } from '@loanflow/core';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { getApplication, listApplicationsByStatus, listTimeline } from '../db/applications';
import { getLoan, listLedger } from '../db/loans';
import { HttpError, httpHandler, pathId, type HttpResult } from '../http';

// Read-only by design: nothing here can decide, sign or pay
const StatusQuery = z.enum(APPLICATION_STATUSES);
const notFound = (what: string) => new HttpError(404, 'Not found', `${what} not found`);

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
  if (!app) throw notFound('Application');
  return { status: 200, body: toPublicApplication(app) };
}

async function decision(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const app = await getApplication(pathId(event));
  if (!app) throw notFound('Application');
  if (!app.decision && !app.manualReviewReason) throw notFound('Decision');
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

async function events(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  return { status: 200, body: await listTimeline(pathId(event)) };
}

async function ledger(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const id = pathId(event);
  const loan = await getLoan(id);
  if (!loan) throw notFound('Loan');
  const entries = await listLedger(id);
  return { status: 200, body: { loan, entries, balanceFromLedger: receivableBalance(entries) } };
}

const routes: Record<string, (event: APIGatewayProxyEventV2) => Promise<HttpResult>> = {
  'GET /internal/applications': list,
  'GET /internal/applications/{id}': get,
  'GET /internal/applications/{id}/decision': decision,
  'GET /internal/applications/{id}/events': events,
  'GET /internal/loans/{id}/ledger': ledger,
};

export const handler = httpHandler((event) => {
  const route = routes[event.routeKey];
  if (!route) throw new HttpError(404, 'Not found', 'Not found');
  return route(event);
});
