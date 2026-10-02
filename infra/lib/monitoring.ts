import { DECISION_OUTCOMES } from '@loanflow/core';
import { Duration } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface MonitoringProps {
  api: HttpApi;
  functions: Record<string, IFunction>;
  dlqs: sqs.Queue[];
  stateMachine: StateMachine;
  alertEmail: string;
}

const NAMESPACE = 'LoanFlow';
const period = Duration.minutes(5);
const appMetric = (metricName: string, service: string, extra: Record<string, string> = {}, label?: string) =>
  new cw.Metric({ namespace: NAMESPACE, metricName, dimensionsMap: { service, ...extra }, statistic: 'Sum', period, label });

export class MonitoringConstruct extends Construct {
  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    const topic = new sns.Topic(this, 'Alerts');
    topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const notify = new actions.SnsAction(topic);
    const alarm = (metric: cw.IMetric, name: string, threshold: number, description: string) =>
      new cw.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(notify);

    // Something in a DLQ means an event was not handled: always worth a look
    for (const dlq of props.dlqs) {
      alarm(dlq.metricApproximateNumberOfMessagesVisible({ period }), `${dlq.node.id}Alarm`, 1, `Messages in ${dlq.node.id}`);
    }
    alarm(props.stateMachine.metricFailed({ period }), 'ProcessFailed', 1, 'A loan process execution failed');
    alarm(props.api.metricServerError({ period }), 'Api5xx', 5, 'API is returning 5xx errors');
    // No per-Lambda error alarms: fetch-company throws by design while the registry is down (handled by the process)

    // The $5 spend guard lives in scripts/create-budget.sh: CloudFormation only
    // supports AWS::Budgets::Budget in us-east-1, and this stack is in eu-north-1.

    const dashboard = new cw.Dashboard(this, 'Dashboard', { dashboardName: 'LoanFlow' });
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'API requests and errors',
        left: [props.api.metricCount({ period })],
        right: [props.api.metricClientError({ period }), props.api.metricServerError({ period })],
      }),
      new cw.GraphWidget({
        title: 'Loan process',
        left: [
          props.stateMachine.metricStarted({ period }),
          props.stateMachine.metricSucceeded({ period }),
          props.stateMachine.metricFailed({ period }),
        ],
      }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Credit decisions',
        left: DECISION_OUTCOMES.map((o) =>
          appMetric('CreditDecisions', 'assess-credit', { outcome: o }, o),
        ),
      }),
      new cw.GraphWidget({
        title: 'Money',
        left: [
          appMetric('ApplicationsSubmitted', 'applications-api'),
          appMetric('Payouts', 'disburse'),
          appMetric('PaymentsReceived', 'loans-api'),
        ],
      }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'DLQ depth',
        left: props.dlqs.map((q) => q.metricApproximateNumberOfMessagesVisible({ period, label: q.node.id })),
      }),
      new cw.GraphWidget({
        title: 'Lambda errors',
        left: Object.entries(props.functions).map(([name, fn]) => fn.metricErrors({ period, label: name })),
      }),
      new cw.GraphWidget({
        title: 'Lambda duration p95',
        left: Object.values(props.functions).map((fn) => fn.metricDuration({ period, statistic: 'p95' })),
      }),
    );
  }
}
