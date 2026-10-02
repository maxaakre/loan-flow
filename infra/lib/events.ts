import { NOTIFY_TYPES } from '@loanflow/core';
import { Duration } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import type { FnFactory } from './functions';

export interface EventsProps {
  table: dynamodb.Table;
  makeFn: FnFactory;
  stateMachine: IStateMachine;
}

const CONSUMER_TIMEOUT = Duration.seconds(10);

/** Choreography between parts: consumers subscribe to the bus without the process knowing. */
export class EventsConstruct extends Construct {
  readonly bus: events.EventBus;
  readonly dlqs: sqs.Queue[] = [];
  readonly functions: Record<string, NodejsFunction> = {};

  constructor(scope: Construct, id: string, props: EventsProps) {
    super(scope, id);
    const { makeFn, table } = props;
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: 'loanflow' });

    // Transactional outbox: only committed OUTBOX# rows reach the relay
    const relay = makeFn(this, 'OutboxRelay', 'handlers/outbox-relay', {
      environment: { EVENT_BUS_NAME: this.bus.eventBusName },
    });
    this.bus.grantPutEventsTo(relay);
    const relayDlq = this.dlq('OutboxRelay');
    relay.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 10,
        maxRecordAge: Duration.days(1),
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(relayDlq),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
            dynamodb: { Keys: { PK: { S: lambda.FilterRule.beginsWith('OUTBOX#') } } },
          }),
        ],
      }),
    );
    this.functions.relay = relay;

    const startProcess = this.consumer(props, 'StartProcess', 'handlers/start-process', ['ApplicationSubmitted'], {
      STATE_MACHINE_ARN: props.stateMachine.stateMachineArn,
    });
    props.stateMachine.grantStartExecution(startProcess);

    const timeline = this.consumer(props, 'Timeline', 'handlers/timeline-consumer');
    table.grant(timeline, 'dynamodb:PutItem');

    // The consumer ignores other types anyway, so this filter only saves invocations
    const notifications = this.consumer(props, 'Notifications', 'handlers/notifications-consumer', [...NOTIFY_TYPES]);
    table.grant(notifications, 'dynamodb:PutItem');
  }

  private dlq(id: string): sqs.Queue {
    const queue = new sqs.Queue(this, `${id}Dlq`, { retentionPeriod: Duration.days(14), enforceSSL: true });
    this.dlqs.push(queue);
    return queue;
  }

  /** Rule → SQS (with DLQ) → Lambda. Each consumer fails on its own without blocking the others. */
  private consumer(
    props: EventsProps,
    id: string,
    entry: string,
    detailTypes?: string[],
    environment: Record<string, string> = {},
  ): NodejsFunction {
    const fn = props.makeFn(this, id, entry, { timeout: CONSUMER_TIMEOUT, environment });
    const dlq = this.dlq(id);
    const queue = new sqs.Queue(this, `${id}Queue`, {
      visibilityTimeout: Duration.seconds(CONSUMER_TIMEOUT.toSeconds() * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });
    new events.Rule(this, `${id}Rule`, {
      eventBus: this.bus,
      eventPattern: { source: ['loanflow'], ...(detailTypes ? { detailType: detailTypes } : {}) },
      targets: [new targets.SqsQueue(queue, { deadLetterQueue: dlq })],
    });
    fn.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));
    this.functions[id] = fn;
    return fn;
  }
}
