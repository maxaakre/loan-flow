import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  findCompany,
  makeEvent,
  MAX_AMOUNT,
  MIN_AMOUNT,
  OreSchema,
  TERMS,
  toPublicApplication,
  type Application,
} from '@loanflow/core';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { z } from 'zod';
import { eventMeta, getApplication, listTimeline, putApplication } from '../db/applications';
import { transact } from '../db/client';
import { checkIdempotency, idempotencyPut, rememberResult, replayOrThrow } from '../db/idempotency';
import { outboxPut } from '../db/outbox';
import {
  HttpError,
  httpHandler,
  idempotencyKey,
  metrics,
  parseBody,
  pathId,
  requestHash,
  tracer,
  type HttpResult,
  type RequestContext,
} from '../http';

const sfn = tracer.captureAWSv3Client(new SFNClient({}));

const CreateApplication = z.object({
  orgNr: z.string().max(20),
  amount: OreSchema.refine((a) => a >= MIN_AMOUNT && a <= MAX_AMOUNT, 'must be between 10 000 and 2 000 000 kr'),
  termMonths: z.literal([...TERMS]),
});

const notFound = () => new HttpError(404, 'Not found', 'Ansökan hittades inte.');

async function create(event: APIGatewayProxyEventV2, ctx: RequestContext): Promise<HttpResult> {
  const body = parseBody(event, CreateApplication);
  const key = idempotencyKey(event);
  const hash = requestHash({ route: event.routeKey, body });
  const check = await checkIdempotency(key, hash);
  if (check.kind === 'replay') return check.result;

  const company = findCompany(body.orgNr);
  if (!company) throw new HttpError(422, 'Unknown company', 'Okänt testföretag.');

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
  if (!app) throw notFound();
  return { status: 200, body: toPublicApplication(app) };
}

async function events(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  return { status: 200, body: await listTimeline(pathId(event)) };
}

const EXPIRED = 'Erbjudandet har gått ut';
const TOKEN_GONE = new Set(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken']);

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

  const app = await getApplication(id);
  if (!app) throw notFound();
  if (app.status === 'EXPIRED') throw new HttpError(409, 'Offer expired', EXPIRED);
  if (app.status !== 'OFFERED' || !app.taskToken) {
    throw new HttpError(409, 'Offer not signable', 'Erbjudandet kan inte signeras.');
  }

  try {
    await sfn.send(
      new SendTaskSuccessCommand({ taskToken: app.taskToken, output: JSON.stringify({ signedAt: ctx.now.toISOString() }) }),
    );
  } catch (err) {
    if (err instanceof Error && TOKEN_GONE.has(err.name)) throw new HttpError(409, 'Offer expired', EXPIRED);
    throw err;
  }

  const result: HttpResult = { status: 202, body: { id, status: 'SIGNING' } };
  await rememberResult(key, hash, result);
  return result;
}

type Route = (event: APIGatewayProxyEventV2, ctx: RequestContext) => Promise<HttpResult>;
const routes: Record<string, Route> = {
  'POST /api/applications': create,
  'GET /api/applications/{id}': get,
  'GET /api/applications/{id}/events': events,
  'POST /api/applications/{id}/sign': sign,
};

export const handler = httpHandler((event, ctx) => {
  const route = routes[event.routeKey];
  if (!route) throw new HttpError(404, 'Not found', 'Hittades inte.');
  return route(event, ctx);
});
