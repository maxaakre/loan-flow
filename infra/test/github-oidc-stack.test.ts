import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const template = Template.fromStack(
  new GithubOidcStack(new App(), 'Oidc', {
    env: { account: '123456789012', region: 'eu-north-1' },
    githubRepo: 'maxaakre/loan-flow',
    githubSubjectPrefix: 'repo:maxaakre@36918283/loan-flow@1401563715',
  }),
);

describe('GithubOidcStack', () => {
  it('reuses the existing GitHub OIDC provider instead of creating a second one', () => {
    expect(Object.keys(template.findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(0);
    expect(Object.keys(template.findResources('AWS::IAM::OIDCProvider'))).toHaveLength(0);
  });

  it('deploy role trusts only the main branch and can only hop into CDK bootstrap roles', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const deploy = Object.values(roles).find((r) => r.Properties.RoleName === 'loanflow-github-deploy')!;
    expect(JSON.stringify(deploy.Properties.AssumeRolePolicyDocument)).toContain(
      'repo:maxaakre@36918283/loan-flow@1401563715:ref:refs/heads/main',
    );
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('cdk-hnb659fds-deploy-role');
    expect(policies).not.toMatch(/"Action":"\*"/);
  });
});
