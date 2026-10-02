import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { fileURLToPath } from 'node:url';
import { LoanFlowStack } from '../lib/loanflow-stack';

export function synth(): Template {
  const app = new App();
  const stack = new LoanFlowStack(app, 'Test', {
    env: { account: '123456789012', region: 'eu-north-1' },
    alertEmail: 'test@example.com',
    webAssetPath: fileURLToPath(new URL('./fixtures/web', import.meta.url)),
    offerTimeoutSeconds: 300,
  });
  return Template.fromStack(stack);
}

/** Logical ids of IAM policies that grant `action`. */
export function policiesWith(template: Template, action: string): string[] {
  return Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([, r]) => JSON.stringify(r.Properties.PolicyDocument).includes(`"${action}"`))
    .map(([logicalId]) => logicalId);
}
