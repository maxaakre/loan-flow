import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { tracer } from '../http';

export const doc = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

export function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
}

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export class ConditionFailedError extends Error {
  override name = 'ConditionFailedError';
  constructor(readonly failedIndexes: number[]) {
    super(`Condition failed for transaction items ${failedIndexes.join(', ')}`);
  }
}

/** DynamoDB aborted the transaction because another write touched the same item. Safe to retry. */
export class TransactionConflictError extends Error {
  override name = 'TransactionConflictError';
  constructor() {
    super('Transaction conflicted with a concurrent write');
  }
}

export const isConditionalFailure = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ConditionalCheckFailedException';

/** All-or-nothing write. Throws ConditionFailedError naming the items whose condition failed. */
export async function transact(items: TransactItem[]): Promise<void> {
  try {
    await doc.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
      const failed = reasons.flatMap((r, i) => (r.Code === 'ConditionalCheckFailed' ? [i] : []));
      if (failed.length > 0) throw new ConditionFailedError(failed);
      if (reasons.some((r) => r.Code === 'TransactionConflict')) throw new TransactionConflictError();
    }
    throw err;
  }
}
