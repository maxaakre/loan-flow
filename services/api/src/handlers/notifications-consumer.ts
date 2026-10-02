import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { parseEvent, summarize, type EventType } from '@loanflow/core';
import { doc, isConditionalFailure, tableName } from '../db/client';
import { notifKey, ONE_DAY, ttlIn } from '../db/keys';
import { logger } from '../http';
import { sqsBatch } from '../sqs';

const SUBJECTS: Partial<Record<EventType, string>> = {
  OfferCreated: 'Ditt låneerbjudande är klart',
  OfferExpired: 'Ditt erbjudande har gått ut',
  ApplicationSentToManualReview: 'Vi tittar närmare på din ansökan',
  LoanDisbursed: 'Pengarna är på väg',
  LoanRepaid: 'Lånet är återbetalt',
};
export const NOTIFY_TYPES = Object.keys(SUBJECTS) as EventType[];

export const handler = sqsBatch(async (detail) => {
  const event = parseEvent(detail);
  const subject = SUBJECTS[event.type];
  if (!subject) return;

  // Claim first, then send. Trade-off: a crash after the claim loses one email (at-most-once),
  // which beats sending the same email twice. A real system would use the provider's idempotency key.
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...notifKey(event.eventId), ttl: ttlIn(7 * ONE_DAY) },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) return;
    throw err;
  }
  logger.info('Fake email sent', { applicationId: event.aggregateId, subject, summary: summarize(event) });
});
