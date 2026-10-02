import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { doc, isConditionalFailure, tableName } from './client';
import { appCountKey, ONE_DAY, ttlIn } from './keys';

export const dailyApplicationLimit = () => Number(process.env.DAILY_APPLICATION_LIMIT ?? 200);

/**
 * Counts one new application for today (UTC). Returns false, and counts nothing, once the
 * cap is reached. Atomic, so parallel requests cannot push the count past `max`.
 */
export async function countApplication(now: Date, max = dailyApplicationLimit()): Promise<boolean> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: appCountKey(now.toISOString().slice(0, 10)),
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': ttlIn(2 * ONE_DAY, now.getTime()) },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}
