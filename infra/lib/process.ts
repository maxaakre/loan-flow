import { Duration } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import type { FnFactory } from './functions';

export interface ProcessProps {
  table: ITable;
  makeFn: FnFactory;
  offerTimeout: Duration;
}

const STEP_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'];

/** Orchestration inside the loan process: order, waiting and failure paths live here. */
export class ProcessConstruct extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly functions: Record<string, NodejsFunction>;

  constructor(scope: Construct, id: string, props: ProcessProps) {
    super(scope, id);
    const { makeFn, table } = props;

    const fetchCompanyFn = makeFn(this, 'FetchCompany', 'steps/fetch-company');
    const assessCreditFn = makeFn(this, 'AssessCredit', 'steps/assess-credit');
    const createOfferFn = makeFn(this, 'CreateOffer', 'steps/create-offer', {
      environment: { OFFER_TIMEOUT_SECONDS: String(props.offerTimeout.toSeconds()) },
    });
    const setStatusFn = makeFn(this, 'SetStatus', 'steps/set-status');
    const disburseFn = makeFn(this, 'Disburse', 'steps/disburse');
    this.functions = { fetchCompanyFn, assessCreditFn, createOfferFn, setStatusFn, disburseFn };
    for (const fn of Object.values(this.functions)) table.grant(fn, ...STEP_ACTIONS);

    const appId = sfn.JsonPath.stringAt('$.applicationId');
    const conflictRetry = { errors: ['ConditionFailedError', 'TransactionConflictError'], interval: Duration.seconds(1), maxAttempts: 3, backoffRate: 2 };
    const setStatus = (name: string, payload: Record<string, unknown>) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: setStatusFn,
        payload: sfn.TaskInput.fromObject({ applicationId: appId, ...payload }),
        payloadResponseOnly: true,
        resultPath: sfn.JsonPath.DISCARD,
      }).addRetry(conflictRetry);

    // 1. Company data. The registry can be down: retry with backoff + jitter, then a human looks at it.
    const fetchCompany = new tasks.LambdaInvoke(this, 'Fetch company', {
      lambdaFunction: fetchCompanyFn,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    })
      .addRetry({
        errors: ['RegistryUnavailableError'],
        interval: Duration.seconds(2),
        backoffRate: 2,
        maxAttempts: 3,
        jitterStrategy: sfn.JitterType.FULL,
      })
      .addRetry(conflictRetry);
    fetchCompany.addCatch(
      setStatus('Mark manual review', { status: 'MANUAL_REVIEW', reason: 'REGISTRY_UNAVAILABLE' }).next(
        new sfn.Succeed(this, 'In manual review'),
      ),
      { errors: ['RegistryUnavailableError'], resultPath: '$.error' },
    );

    // 2. Credit decision → { applicationId, outcome }
    const assessCredit = new tasks.LambdaInvoke(this, 'Assess credit', {
      lambdaFunction: assessCreditFn,
      payloadResponseOnly: true,
    }).addRetry(conflictRetry);

    // 3. Offer, then wait for the customer. The token completes once: signed OR timed out.
    const offerAndWait = new tasks.LambdaInvoke(this, 'Create offer and wait for signature', {
      lambdaFunction: createOfferFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        applicationId: appId,
        taskToken: sfn.JsonPath.taskToken,
        enteredAt: sfn.JsonPath.stringAt('$$.State.EnteredTime'),
      }),
      taskTimeout: sfn.Timeout.duration(props.offerTimeout),
      resultPath: '$.signature',
    }).addRetry(conflictRetry);
    offerAndWait.addCatch(setStatus('Mark expired', { status: 'EXPIRED' }).next(new sfn.Succeed(this, 'Offer expired')), {
      errors: ['States.Timeout'],
      resultPath: '$.error',
    });

    // 4. Payout. Safe to retry: the bank call is idempotent on the application id.
    const disburse = new tasks.LambdaInvoke(this, 'Disburse loan', {
      lambdaFunction: disburseFn,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    }).addRetry({ errors: ['States.ALL'], interval: Duration.seconds(2), backoffRate: 2, maxAttempts: 3, jitterStrategy: sfn.JitterType.FULL });

    const approved = sfn.Condition.or(
      sfn.Condition.stringEquals('$.outcome', 'APPROVED'),
      sfn.Condition.stringEquals('$.outcome', 'APPROVED_WITH_CHANGES'),
    );
    const definition = fetchCompany
      .next(assessCredit)
      .next(
        new sfn.Choice(this, 'Approved?')
          .when(
            approved,
            offerAndWait
              .next(setStatus('Mark signed', { status: 'SIGNED', signedAt: sfn.JsonPath.stringAt('$.signature.signedAt') }))
              .next(disburse)
              .next(new sfn.Succeed(this, 'Disbursed')),
          )
          .otherwise(new sfn.Succeed(this, 'Declined or manual review')),
      );

    this.stateMachine = new sfn.StateMachine(this, 'LoanApplication', {
      stateMachineName: 'loanflow-application',
      stateMachineType: sfn.StateMachineType.STANDARD, // Standard: can wait days, and waiting is free
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
      timeout: Duration.days(30),
    });
  }
}
