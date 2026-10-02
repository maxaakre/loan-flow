import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  amountRangeMessage,
  findCompany,
  makeEvent,
  MAX_AMOUNT,
  MIN_AMOUNT,
  OreSchema,
  TERMS,
  toCustomerApplication,
  type Application,
} from '@loanflow/core';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { z } from 'zod';
import { eventMeta, getApplication, putApplication } from '../db/applications';
import { transact } from '../db/client';
import { countApplication } from '../db/daily-cap';
import { checkIdempotency, idempotencyPut, rememberResult, replayOrThrow } from '../db/idempotency';
import { outboxPut } from '../db/outbox';
import {
  HttpError,
  idempotencyKey,
  metrics,
  notFound,
  parseBody,
  pathId,
  requestHash,
  routeHandler,
  tracer,
  type HttpResult,
  type RequestContext,
} from '../http';
import { timelineEvents } from './shared';

const sfn = tracer.captureAWSv3Client(new SFNClient({}));

const CreateApplication = z.object({
  orgNr: z.string().max(20),
  amount: OreSchema.refine((a) => a >= MIN_AMOUNT && a <= MAX_AMOUNT, amountRangeMessage()),
  termMonths: z.literal([...TERMS]),
});

const APP_NOT_FOUND = 'Ansökan hittades inte.';

async function create(event: APIGatewayProxyEventV2, ctx: RequestContext): Promise<HttpResult> {
  const body = parseBody(event, CreateApplication);
  const key = idempotencyKey(event);
  const hash = requestHash({ route: event.routeKey, body });
  const check = await checkIdempotency(key, hash);
  if (check.kind === 'replay') return check.result;

  const company = findCompany(body.orgNr);
  if (!company) throw new HttpError(422, 'Unknown company', 'Okänt testföretag.');
  // Cost guard for a public demo. Checked after idempotency, so a replay never counts.
  if (!(await countApplication(ctx.now))) {
    throw new HttpError(429, 'Daily limit reached', 'Demon har nått dagens gräns för ansökningar. Försök igen i morgon.');
  }

  const now = ctx.now.toISOString();
  const app: Application = {
    id: ulid(),
    correlationId: ctx.correlationId,
    orgNr: company.orgNr,
    companyName: company.name,
    amount: body.amount,
    termMonths: body.termMonths,
    status: 'SUBMITTED',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const submitted = makeEvent('ApplicationSubmitted', eventMeta(app, now), {
    orgNr: app.orgNr,
    companyName: app.companyName,
    amount: app.amount,
    termMonths: app.termMonths,
  });
  const result: HttpResult = { status: 201, body: { id: app.id } };

  // State, event and idempotent answer commit together. start-process picks up the event.
  try {
    await transact([putApplication(app), outboxPut(submitted), idempotencyPut(key, hash, result)]);
  } catch (err) {
    return replayOrThrow(key, hash, err);
  }
  metrics.addMetric('ApplicationsSubmitted', MetricUnit.Count, 1);
  return result;
}

async function get(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const app = await getApplication(pathId(event));
  if (!app) throw notFound(APP_NOT_FOUND);
  return { status: 200, body: toCustomerApplication(app) };
}

const EXPIRED = 'Erbjudandet har gått ut';
const TOKEN_GONE = new Set(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken']);

/** Resumes the waiting process. Returns false when Step Functions no longer knows the token. */
async function resume(taskToken: string, ctx: RequestContext): Promise<boolean> {
  try {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify({ signedAt: ctx.now.toISOString() }) }));
    return true;
  } catch (err) {
    if (err instanceof Error && TOKEN_GONE.has(err.name)) return false;
    throw err;
  }
}

/** The token we tried is gone. Re-read the application to learn why; throws 409 unless it was signed. */
async function afterTokenGone(id: string, tried: string, ctx: RequestContext): Promise<void> {
  const app = await getApplication(id);
  if (!app) throw notFound(APP_NOT_FOUND);
  if (app.status === 'SIGNED' || app.status === 'DISBURSED') return;
  // create-offer was retried and stored a new token: the old one never reached the customer's offer
  if (app.status === 'OFFERED' && app.taskToken && app.taskToken !== tried) {
    if (await resume(app.taskToken, ctx)) return;
    tried = app.taskToken;
  }
  // Same token, still OFFERED, before the deadline: an earlier sign used the token and the SIGNED
  // write is still pending. We assume nothing else can use up a token before the offer expires.
  const pending =
    app.status === 'OFFERED' &&
    app.taskToken === tried &&
    app.offerExpiresAt !== undefined &&
    ctx.now.getTime() < Date.parse(app.offerExpiresAt);
  if (!pending) throw new HttpError(409, 'Offer expired', EXPIRED);
}

/**
 * Only resumes the state machine. Step Functions is the arbiter between signing and expiry:
 * a task token completes once, so the process writes SIGNED or EXPIRED, never both.
 */
async function sign(event: APIGatewayProxyEventV2, ctx: RequestContext): Promise<HttpResult> {
  const id = pathId(event);
  const key = idempotencyKey(event);
  const hash = requestHash({ route: event.routeKey, id });
  const check = await checkIdempotency(key, hash);
  if (check.kind === 'replay') return check.result;

  const accepted: HttpResult = { status: 202, body: { id, status: 'SIGNING' } };
  const app = await getApplication(id);
  if (!app) throw notFound(APP_NOT_FOUND);
  // A retry after a lost response must succeed: the earlier sign already went through.
  if (app.status === 'SIGNED' || app.status === 'DISBURSED') {
    await rememberResult(key, hash, accepted);
    return accepted;
  }
  if (app.status === 'EXPIRED') throw new HttpError(409, 'Offer expired', EXPIRED);
  if (app.status !== 'OFFERED' || !app.taskToken) {
    throw new HttpError(409, 'Offer not signable', 'Erbjudandet kan inte signeras.');
  }

  if (!(await resume(app.taskToken, ctx))) await afterTokenGone(id, app.taskToken, ctx);

  await rememberResult(key, hash, accepted);
  return accepted;
}

export const handler = routeHandler({
  'POST /api/applications': create,
  'GET /api/applications/{id}': get,
  'GET /api/applications/{id}/events': timelineEvents,
  'POST /api/applications/{id}/sign': sign,
});
