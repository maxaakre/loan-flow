import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { ApiConstruct } from './api';
import { createTable } from './data';
import { EventsConstruct } from './events';
import { functionFactory } from './functions';
import { MonitoringConstruct } from './monitoring';
import { ProcessConstruct } from './process';
import { WebConstruct } from './web';

export interface LoanFlowStackProps extends StackProps {
  alertEmail: string;
  webAssetPath: string;
  offerTimeoutSeconds: number;
}

export class LoanFlowStack extends Stack {
  constructor(scope: Construct, id: string, props: LoanFlowStackProps) {
    super(scope, id, props);

    const table = createTable(this);
    const makeFn = functionFactory(table);
    const process = new ProcessConstruct(this, 'Process', {
      table,
      makeFn,
      offerTimeout: Duration.seconds(props.offerTimeoutSeconds),
    });
    const events = new EventsConstruct(this, 'Events', { table, makeFn, stateMachine: process.stateMachine });
    const api = new ApiConstruct(this, 'Api', { table, makeFn, stateMachine: process.stateMachine });
    const web = new WebConstruct(this, 'Web', { api: api.api, webAssetPath: props.webAssetPath });
    new MonitoringConstruct(this, 'Monitoring', {
      api: api.api,
      functions: { ...process.functions, ...events.functions, ...api.functions },
      dlqs: events.dlqs,
      stateMachine: process.stateMachine,
      alertEmail: props.alertEmail,
    });

    new CfnOutput(this, 'SiteUrl', { value: `https://${web.distribution.distributionDomainName}` });
    new CfnOutput(this, 'ApiUrl', { value: api.api.apiEndpoint });
    new CfnOutput(this, 'McpReaderRoleArn', { value: api.mcpReaderRole.roleArn });
    new CfnOutput(this, 'StateMachineArn', { value: process.stateMachine.stateMachineArn });
  }
}
