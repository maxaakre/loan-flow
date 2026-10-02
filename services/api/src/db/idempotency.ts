import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError, type HttpResult } from '../http';
import { ConditionFailedError, doc, isConditionalFailure, tableName, type TransactItem } from './client';
import { idempKey, ONE_DAY, ttlIn } from './keys';

export type IdempotencyCheck = { kind: 'new' } | { kind: 'replay'; result: HttpResult };

/**
 * Keys are global, so `hash` must cover the route, any path id and the body:
 * `requestHash({ route: event.routeKey, id, body })`.
 */
export async function checkIdempotency(key: string, hash: string): Promise<IdempotencyCheck> {
  const res = await doc.send(new GetCommand({ TableName: tableName(), Key: idempKey(key), ConsistentRead: true }));
  if (!res.Item) return { kind: 'new' };
  if (res.Item.requestHash !== hash) {
    throw new HttpError(422, 'Idempotency key reused', 'Idempotency-Key användes redan för en annan förfrågan.');
  }
  return { kind: 'replay', result: res.Item.result as HttpResult };
}

const item = (key: string, hash: string, result: HttpResult) => ({
  ...idempKey(key),
  requestHash: hash,
  result,
  ttl: ttlIn(ONE_DAY),
});

/** Use inside the effect's transaction, so the effect and the stored answer commit together. */
export const idempotencyPut = (key: string, hash: string, result: HttpResult): TransactItem => ({
  Put: { TableName: tableName(), Item: item(key, hash, result), ConditionExpression: 'attribute_not_exists(PK)' },
});

/** For effects outside DynamoDB (e.g. SendTaskSuccess): store the answer afterwards. */
export async function rememberResult(key: string, hash: string, result: HttpResult): Promise<void> {
  try {
    await doc.send(
      new PutCommand({ TableName: tableName(), Item: item(key, hash, result), ConditionExpression: 'attribute_not_exists(PK)' }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
  }
}

/** A parallel request with the same key won the race: return its answer. Otherwise rethrow. */
export async function replayOrThrow(key: string, hash: string, err: unknown): Promise<HttpResult> {
  if (err instanceof ConditionFailedError) {
    const again = await checkIdempotency(key, hash);
    if (again.kind === 'replay') return again.result;
  }
  throw err;
}
