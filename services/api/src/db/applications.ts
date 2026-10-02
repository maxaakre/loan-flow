import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { assertTransition, type Application, type ApplicationStatus, type EventMeta } from '@loanflow/core';
import { ulid } from 'ulid';
import { doc, tableName, type TransactItem } from './client';
import { appKey } from './keys';

const KEY_FIELDS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'ttl'];

export function strip<T>(item: Record<string, unknown>): T {
  const copy = { ...item };
  for (const k of KEY_FIELDS) delete copy[k];
  return copy as T;
}

export async function getApplication(id: string): Promise<Application | undefined> {
  const res = await doc.send(new GetCommand({ TableName: tableName(), Key: appKey(id), ConsistentRead: true }));
  return res.Item ? strip<Application>(res.Item) : undefined;
}

const statusIndex = (status: ApplicationStatus) => `STATUS#${status}`;

export const putApplication = (app: Application): TransactItem => ({
  Put: {
    TableName: tableName(),
    Item: { ...appKey(app.id), GSI1PK: statusIndex(app.status), GSI1SK: app.createdAt, ...app },
    ConditionExpression: 'attribute_not_exists(PK)',
  },
});

export type ApplicationChanges = Partial<
  Omit<Application, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'correlationId'>
>;

/**
 * Builds an optimistic-concurrency update: it only succeeds if nobody else changed the
 * application since we read it. A key set to `undefined` is removed.
 */
export function updateApplication(
  app: Application,
  changes: ApplicationChanges,
  now: string,
): { item: TransactItem; next: Application } {
  if ('status' in changes && changes.status === undefined) throw new Error('status cannot be removed');
  if (changes.status && changes.status !== app.status) assertTransition(app.status, changes.status);

  const fields: Record<string, unknown> = { ...changes, version: app.version + 1, updatedAt: now };
  if (changes.status) fields.GSI1PK = statusIndex(changes.status);

  const names: Record<string, string> = { '#ver': 'version' };
  const values: Record<string, unknown> = { ':expected': app.version };
  const set: string[] = [];
  const remove: string[] = [];
  Object.entries(fields).forEach(([field, value], i) => {
    names[`#f${i}`] = field;
    if (value === undefined) {
      remove.push(`#f${i}`);
    } else {
      values[`:v${i}`] = value;
      set.push(`#f${i} = :v${i}`);
    }
  });

  const next = { ...app, ...changes, version: app.version + 1, updatedAt: now } as Application;
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) delete (next as Record<string, unknown>)[field];
  }

  return {
    next,
    item: {
      Update: {
        TableName: tableName(),
        Key: appKey(app.id),
        UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
        ConditionExpression: '#ver = :expected',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
  };
}

/** Event metadata for a write that produced aggregate version `aggregate.version`. */
export const eventMeta = (
  aggregate: { id: string; version: number; correlationId: string },
  now: string,
  index = 0,
): EventMeta => ({
  eventId: ulid(),
  occurredAt: now,
  aggregateId: aggregate.id,
  sequence: aggregate.version * 10 + index,
  correlationId: aggregate.correlationId,
});

export async function listApplicationsByStatus(status: ApplicationStatus, limit = 50): Promise<Application[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': statusIndex(status) },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map((i) => strip<Application>(i));
}

export type TimelineItem = { eventId: string; type: string; occurredAt: string; sequence: number; summary: string };

export async function listTimeline(applicationId: string): Promise<TimelineItem[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :evt)',
      ExpressionAttributeValues: { ':pk': appKey(applicationId).PK, ':evt': 'EVT#' },
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? [])
    .map((i) => strip<TimelineItem>(i))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence);
}
