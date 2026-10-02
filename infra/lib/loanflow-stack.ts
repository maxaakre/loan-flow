import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { createTable } from './data';
import { EventsConstruct } from './events';
import { functionFactory } from './functions';
import { ProcessConstruct } from './process';

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
    new EventsConstruct(this, 'Events', { table, makeFn, stateMachine: process.stateMachine });

    new CfnOutput(this, 'StateMachineArn', { value: process.stateMachine.stateMachineArn });
  }
}
