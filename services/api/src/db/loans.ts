import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { LedgerEntry, Loan } from '@loanflow/core';
import { strip } from './applications';
import { doc, tableName, type TransactItem } from './client';
import { entryKey, loanKey } from './keys';

export async function getLoan(id: string): Promise<Loan | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(), Key: loanKey(id), ConsistentRead: true }));
  return res.Item ? strip<Loan>(res.Item) : undefined;
}

export const putLoan = (loan: Loan): TransactItem => ({
  Put: { TableName: tableName(), Item: { ...loanKey(loan.id), ...loan }, ConditionExpression: 'attribute_not_exists(PK)' },
});

export type LoanChanges = Pick<Loan, 'paidInstalments' | 'balance' | 'status'>;

/** Optimistic concurrency: fails if someone else paid on this loan since we read it. */
export function updateLoan(loan: Loan, changes: LoanChanges): { item: TransactItem; next: Loan } {
  const next: Loan = { ...loan, ...changes, version: loan.version + 1 };
  return {
    next,
    item: {
      Update: {
        TableName: tableName(),
        Key: loanKey(loan.id),
        UpdateExpression: 'SET paidInstalments = :paid, balance = :balance, #status = :status, #ver = :next',
        ConditionExpression: '#ver = :expected',
        ExpressionAttributeNames: { '#status': 'status', '#ver': 'version' },
        ExpressionAttributeValues: {
          ':paid': next.paidInstalments,
          ':balance': next.balance,
          ':status': next.status,
          ':next': next.version,
          ':expected': loan.version,
        },
      },
    },
  };
}

/** Ledger entries are append-only: the condition stops any overwrite. */
export const putLedgerEntry = (entry: LedgerEntry): TransactItem => ({
  Put: {
    TableName: tableName(),
    Item: { ...entryKey(entry.loanId, entry.occurredAt, entry.entryId), ...entry },
    ConditionExpression: 'attribute_not_exists(PK)',
  },
});

export async function listLedger(loanId: string): Promise<LedgerEntry[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :entry)',
      ExpressionAttributeValues: { ':pk': loanKey(loanId).PK, ':entry': 'ENTRY#' },
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? []).map((i) => strip<LedgerEntry>(i));
}
