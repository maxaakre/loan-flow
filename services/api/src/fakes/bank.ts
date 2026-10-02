import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Ore } from '@loanflow/core';
import { ulid } from 'ulid';
import { doc, isConditionalFailure, tableName } from '../db/client';
import { bankPayoutKey } from '../db/keys';

/** Pretend bank. Like a real payment API, a repeated idempotency key returns the first payout. */
export async function payout(key: string, amount: Ore): Promise<{ payoutId: string }> {
  const payoutId = ulid();
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...bankPayoutKey(key), payoutId, amount },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return { payoutId };
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    const res = await doc.send(new GetCommand({ TableName: tableName(), Key: bankPayoutKey(key), ConsistentRead: true }));
    return { payoutId: String(res.Item?.payoutId) };
  }
}
