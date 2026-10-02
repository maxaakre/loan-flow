import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { parseEvent } from '@loanflow/core';
import { logger, tracer } from '../http';
import { sqsBatch } from '../sqs';

const sfn = tracer.captureAWSv3Client(new SFNClient({}));

/** Starts the loan process from the ApplicationSubmitted event, so the API never does a dual write. */
export const handler = sqsBatch(async (detail) => {
  const event = parseEvent(detail);
  if (event.type !== 'ApplicationSubmitted') return;
  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        // Execution names are unique, so a duplicate event cannot start a second process
        name: event.aggregateId,
        input: JSON.stringify({ applicationId: event.aggregateId }),
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ExecutionAlreadyExists') {
      logger.info('Process already started', { applicationId: event.aggregateId });
      return;
    }
    throw err;
  }
});
