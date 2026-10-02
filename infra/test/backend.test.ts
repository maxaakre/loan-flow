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
  const definition = () => JSON.stringify(Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0]);

  it('retries the registry with jitter, then falls back to manual review', () => {
    expect(definition()).toContain('RegistryUnavailableError');
    expect(definition()).toContain('\\"JitterStrategy\\":\\"FULL\\"');
    expect(definition()).toContain('Mark manual review');
  });

  it('waits for a task token and expires on timeout', () => {
    expect(definition()).toContain('waitForTaskToken');
    expect(definition()).toContain('\\"TimeoutSeconds\\":300');
    expect(definition()).toContain('States.Timeout');
  });

  it('is a Standard workflow with tracing', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
    });
  });
});
