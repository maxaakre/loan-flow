import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { parseEvent, summarize } from '@loanflow/core';
import { doc, isConditionalFailure, tableName } from '../db/client';
import { timelineKey } from '../db/keys';
import { logger } from '../http';
import { sqsBatch } from '../sqs';

export const handler = sqsBatch(async (detail) => {
  const event = parseEvent(detail);
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          ...timelineKey(event.aggregateId, event.eventId),
          eventId: event.eventId,
          type: event.type,
          occurredAt: event.occurredAt,
          sequence: event.sequence,
          summary: summarize(event),
        },
        // The event id is the key: a duplicate delivery cannot add a second row
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    logger.info('Duplicate event ignored', { eventId: event.eventId });
  }
});
