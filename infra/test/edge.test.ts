import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { policiesWith, synth } from './helpers';

let template: Template;
beforeAll(() => {
  template = synth();
});

const routes = () =>
  Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties as { RouteKey: string; AuthorizationType?: string });

describe('API', () => {
  it('protects every /internal route with IAM and leaves /api public', () => {
    const all = routes();
    const internal = all.filter((r) => r.RouteKey.includes(' /internal/'));
    expect(internal).toHaveLength(5);
    for (const r of internal) expect(r.AuthorizationType).toBe('AWS_IAM');
    for (const r of all.filter((x) => x.RouteKey.includes(' /api/'))) expect(r.AuthorizationType ?? 'NONE').toBe('NONE');
  });

  it('only applications-api can resume the process', () => {
    const ids = policiesWith(template, 'states:SendTaskSuccess');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^ApiApplicationsApi/);
  });

  it('companies-api has no database access', () => {
    // Its role still has an X-Ray policy, so check the content, not the existence
    const docs = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('ApiCompaniesApi'))
      .map(([, r]) => JSON.stringify(r.Properties.PolicyDocument));
    for (const doc of docs) expect(doc).not.toContain('dynamodb:');
  });

  it('internal-api can only read', () => {
    const doc = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('ApiInternalApi'))![1].Properties
        .PolicyDocument,
    );
    expect(doc).not.toMatch(/PutItem|UpdateItem|DeleteItem/);
  });
});

describe('MCP reader role', () => {
  it('may only invoke GET /internal/*', () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'loanflow-mcp-reader' });
    const ids = policiesWith(template, 'execute-api:Invoke');
    expect(ids).toHaveLength(1);
    const doc = JSON.stringify(template.findResources('AWS::IAM::Policy')[ids[0]!]!.Properties.PolicyDocument);
    expect(doc).toContain('/GET/internal/*');
  });
});

describe('monitoring', () => {
  it('alarms on every DLQ and on failed executions', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties);
    expect(alarms.filter((a) => a.MetricName === 'ApproximateNumberOfMessagesVisible')).toHaveLength(4);
    expect(alarms.some((a) => a.MetricName === 'ExecutionsFailed')).toBe(true);
    expect(alarms.some((a) => a.MetricName === '5xx')).toBe(true);
  });

  it('stays at 6 alarms (free tier is 10) and every alarm notifies', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties);
    expect(alarms).toHaveLength(6); // 4 DLQ + ProcessFailed + Api5xx
    for (const a of alarms) expect(a.AlarmActions).toHaveLength(1);
  });

  it('has no budget resource (CloudFormation only supports it in us-east-1; see scripts/create-budget.sh)', () => {
    expect(Object.keys(template.findResources('AWS::Budgets::Budget'))).toHaveLength(0);
  });
});
