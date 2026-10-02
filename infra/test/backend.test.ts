import { Match, type Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { policiesWith, synth } from './helpers';

let template: Template;
beforeAll(() => {
  template = synth();
});

describe('table', () => {
  it('has a stream for the outbox, a TTL and the status index', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'GSI1' })],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });
});

describe('lambdas', () => {
  it('all run Node 22 on ARM with tracing and outside any VPC', () => {
    // Our functions all set the LoanFlow metrics namespace; CDK's own helper functions do not
    const fns = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (f) => f.Properties.Environment?.Variables?.POWERTOOLS_METRICS_NAMESPACE === 'LoanFlow',
    );
    expect(fns.length).toBeGreaterThanOrEqual(9);
    for (const f of fns) {
      expect(f.Properties.Runtime).toBe('nodejs22.x');
      expect(f.Properties.Architectures).toEqual(['arm64']);
      expect(f.Properties.TracingConfig).toEqual({ Mode: 'Active' });
      expect(f.Properties.VpcConfig).toBeUndefined();
    }
  });
});

describe('outbox relay', () => {
  it('reads only new OUTBOX# rows, reports partial failures and has a DLQ', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 10,
      MaximumRecordAgeInSeconds: 86_400,
      DestinationConfig: { OnFailure: Match.objectLike({}) },
      FilterCriteria: {
        Filters: [{ Pattern: Match.serializedJson({ eventName: ['INSERT'], dynamodb: { Keys: { PK: { S: [{ prefix: 'OUTBOX#' }] } } } }) }],
      },
    });
  });

  it('is the only function allowed to publish events', () => {
    const ids = policiesWith(template, 'events:PutEvents');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^EventsOutboxRelay/);
  });
});

describe('consumers', () => {
  it('every work queue has a DLQ after 3 receives', () => {
    const queues = Object.values(template.findResources('AWS::SQS::Queue')).filter((q) => q.Properties?.RedrivePolicy);
    expect(queues).toHaveLength(3);
    for (const q of queues) expect(q.Properties.RedrivePolicy.maxReceiveCount).toBe(3);
  });

  it('only start-process may start executions', () => {
    const ids = policiesWith(template, 'states:StartExecution');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^EventsStartProcess/);
  });
});

describe('loan process', () => {
  type State = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The definition is an Fn::Join of strings and tokens; tokens (ARNs) become a placeholder. */
  const states = (): Record<string, State> => {
    const sm = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0]!;
    const parts: unknown[] = sm.Properties.DefinitionString['Fn::Join'][1];
    const json = parts.map((p) => (typeof p === 'string' ? p : 'ARN')).join('');
    return JSON.parse(json).States;
  };

  it('retries the registry with jitter, then falls back to manual review', () => {
    const fetch = states()['Fetch company']!;
    expect(fetch.Retry).toContainEqual(
      expect.objectContaining({
        ErrorEquals: ['RegistryUnavailableError'],
        JitterStrategy: 'FULL',
        BackoffRate: 2,
        MaxAttempts: 3,
      }),
    );
    expect(fetch.Catch).toContainEqual(
      expect.objectContaining({ ErrorEquals: ['RegistryUnavailableError'], Next: 'Mark manual review' }),
    );
  });

  it('waits for a task token and expires on timeout', () => {
    const wait = states()['Create offer and wait for signature']!;
    expect(wait.TimeoutSeconds).toBe(300);
    expect(wait.Resource).toMatch(/\.waitForTaskToken$/);
    expect(wait.Parameters.Payload).toHaveProperty(['taskToken.$']);
    expect(wait.Parameters.Payload).toHaveProperty(['applicationId.$']);
    expect(wait.Parameters.Payload['enteredAt.$']).toBe('$$.State.EnteredTime');
    expect(wait.Catch).toContainEqual(expect.objectContaining({ ErrorEquals: ['States.Timeout'], Next: 'Mark expired' }));
  });

  it.each(['Fetch company', 'Assess credit', 'Create offer and wait for signature', 'Mark signed', 'Disburse loan'])(
    '%s sends any unhandled failure to manual review',
    (name) => {
      const catches: State[] = states()[name]!.Catch;
      expect(catches.at(-1)).toMatchObject({ ErrorEquals: ['States.ALL'], Next: 'Mark process failed', ResultPath: '$.error' });
    },
  );

  it('checks the offer timeout before the catch-all', () => {
    const catches: State[] = states()['Create offer and wait for signature']!.Catch;
    expect(catches[0]!.ErrorEquals).toEqual(['States.Timeout']);
  });

  it('marks a failed process as MANUAL_REVIEW with PROCESS_FAILED and ends there', () => {
    const failed = states()['Mark process failed']!;
    expect(failed.Parameters).toMatchObject({ status: 'MANUAL_REVIEW', reason: 'PROCESS_FAILED' });
    expect(failed.Catch).toBeUndefined();
    expect(states()[failed.Next]!.Type).toBe('Succeed');
  });

  it('passes the signing time on to the status update', () => {
    expect(states()['Mark signed']!.Parameters['signedAt.$']).toBe('$.signature.signedAt');
  });

  it('is a Standard workflow with tracing', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
    });
  });
});
