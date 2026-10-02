import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { parseEvent } from '@loanflow/core';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { logger, tracer } from '../http';

const eventBridge = tracer.captureAWSv3Client(new EventBridgeClient({}));

/**
 * The only code that publishes events. It reads committed outbox rows from the stream,
 * so an event exists only if its state change was saved. Delivery is at-least-once.
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  for (const record of event.Records) {
    const sequenceNumber = record.dynamodb?.SequenceNumber ?? '';
    try {
      const image = unmarshall(record.dynamodb?.NewImage as unknown as Record<string, AttributeValue>);
      const domainEvent = parseEvent(image.event);
      const res = await eventBridge.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: process.env.EVENT_BUS_NAME,
              Source: 'loanflow',
              DetailType: domainEvent.type,
              Detail: JSON.stringify(domainEvent),
            },
          ],
        }),
      );
      if (res.FailedEntryCount) throw new Error(`PutEvents failed: ${res.Entries?.[0]?.ErrorCode}`);
      logger.info('Event published', { type: domainEvent.type, eventId: domainEvent.eventId });
    } catch (err) {
      logger.error('Relay failed', { sequenceNumber, error: err as Error });
      // Streams keep order per shard: stop here and let Lambda retry from this record
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
    }
  }
  return { batchItemFailures: [] };
};
