import type { DomainEvent } from '@loanflow/core';
import { tableName, type TransactItem } from './client';
import { ONE_DAY, outboxKey, ttlIn } from './keys';

/** Add this to the same transaction as the state change. outbox-relay publishes it. */
export const outboxPut = (event: DomainEvent): TransactItem => ({
  Put: {
    TableName: tableName(),
    Item: { ...outboxKey(event.eventId), event, ttl: ttlIn(ONE_DAY) },
    ConditionExpression: 'attribute_not_exists(PK)',
  },
});
