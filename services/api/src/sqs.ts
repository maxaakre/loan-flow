import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { logger, metrics } from './http';

/**
 * Runs `fn` for each SQS record. EventBridge → SQS puts the domain event in `detail`.
 * A failing record is reported alone, so one poison message does not block the batch.
 */
export function sqsBatch(fn: (detail: unknown, record: SQSRecord) => Promise<void>) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    try {
      for (const record of event.Records) {
        try {
          const body = JSON.parse(record.body) as { detail?: { correlationId?: string } };
          if (body.detail === undefined || body.detail === null) throw new Error('SQS record has no detail');
          // The correlation id follows the application through every service's logs
          logger.appendKeys({ correlationId: body.detail.correlationId });
          await fn(body.detail, record);
        } catch (err) {
          logger.error('Record failed', { messageId: record.messageId, error: err as Error });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        } finally {
          logger.removeKeys(['correlationId']);
        }
      }
    } finally {
      if (metrics.hasStoredMetrics()) metrics.publishStoredMetrics();
    }
    return { batchItemFailures };
  };
}
