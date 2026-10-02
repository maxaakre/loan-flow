import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';

export const logger = new Logger();
export const metrics = new Metrics();
export const tracer = new Tracer();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export type HttpResult = { status: number; body: unknown };
export type RequestContext = { correlationId: string; now: Date };

export function parseBody<T>(event: APIGatewayProxyEventV2, schema: ZodType<T>): T {
  const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let json: unknown;
  try {
    json = JSON.parse(raw ?? '');
  } catch {
    throw new HttpError(400, 'Invalid request', 'Request body must be valid JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HttpError(400, 'Invalid request', detail);
  }
  return result.data;
}

export function pathId(event: APIGatewayProxyEventV2): string {
  const id = event.pathParameters?.id;
  if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(404, 'Not found', 'Hittades inte.');
  return id;
}

/** Required on every request that moves money or changes state. */
export function idempotencyKey(event: APIGatewayProxyEventV2): string {
  const key = event.headers['idempotency-key']; // HTTP API lower-cases header names
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw new HttpError(400, 'Missing Idempotency-Key', 'Idempotency-Key header (8–128 chars) is required');
  }
  return key;
}

export const requestHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

const respond = (statusCode: number, body: unknown, contentType = 'application/json'): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export function httpHandler(fn: (event: APIGatewayProxyEventV2, ctx: RequestContext) => Promise<HttpResult>) {
  return async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    const correlationId = event.headers['x-correlation-id'] ?? event.requestContext.requestId;
    logger.addContext(context);
    logger.appendKeys({ correlationId, route: event.routeKey });
    const problem = (status: number, title: string, detail: string) =>
      respond(status, { type: 'about:blank', title, status, detail, correlationId }, 'application/problem+json');
    try {
      const result = await fn(event, { correlationId, now: new Date() });
      return respond(result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        logger.warn('Request failed', { status: err.status, title: err.title });
        return problem(err.status, err.title, err.detail);
      }
      logger.error('Unexpected error', err as Error);
      return problem(500, 'Internal error', 'Något gick fel. Försök igen.');
    } finally {
      metrics.publishStoredMetrics();
      logger.resetKeys();
    }
  };
}
