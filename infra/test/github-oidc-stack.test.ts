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

  type Statement = Record<string, unknown>;
  const roles = template.findResources('AWS::IAM::Role');
  const policies = template.findResources('AWS::IAM::Policy');
  const prefix = 'repo:maxaakre@36918283/loan-flow@1401563715';
  const oidc = 'token.actions.githubusercontent.com';

  const roleEntry = (name: string) => {
    const entry = Object.entries(roles).find(([, r]) => r.Properties.RoleName === name);
    if (!entry) throw new Error(`role ${name} not found`);
    return { id: entry[0], trust: entry[1].Properties.AssumeRolePolicyDocument.Statement as Statement[] };
  };
  /** Resources of every statement in the inline policies attached to the role. */
  const policyResources = (roleId: string) =>
    Object.values(policies)
      .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[])
      .flatMap((st) => {
        expect(st.Action).toBe('sts:AssumeRole');
        expect(st.Effect).toBe('Allow');
        return st.Resource as string[] | string;
      });
  const bootstrap = (name: string) => `arn:aws:iam::123456789012:role/cdk-hnb659fds-${name}-123456789012-eu-north-1`;

  it('deploy role trusts only the main branch via web identity from the imported provider', () => {
    const { trust } = roleEntry('loanflow-github-deploy');
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Effect).toBe('Allow');
    expect(trust[0]!.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(JSON.stringify(trust[0]!.Principal)).toContain(`oidc-provider/${oidc}`);
    expect(Object.keys(trust[0]!.Principal as object)).toEqual(['Federated']);
    expect(trust[0]!.Condition).toEqual({
      StringEquals: {
        [`${oidc}:aud`]: 'sts.amazonaws.com',
        [`${oidc}:sub`]: `${prefix}:ref:refs/heads/main`,
      },
    });
  });

  it('deploy role can only assume the four CDK bootstrap roles', () => {
    const resources = policyResources(roleEntry('loanflow-github-deploy').id);
    expect([resources].flat().sort()).toEqual(
      ['deploy-role', 'file-publishing-role', 'image-publishing-role', 'lookup-role'].map(bootstrap).sort(),
    );
    expect(JSON.stringify(policies)).not.toMatch(/"Action":"\*"/);
  });

  it('diff role trusts only pull requests and can only assume the lookup role', () => {
    const { id, trust } = roleEntry('loanflow-github-diff');
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(JSON.stringify(trust[0]!.Principal)).toContain(`oidc-provider/${oidc}`);
    expect(trust[0]!.Condition).toEqual({
      StringEquals: {
        [`${oidc}:aud`]: 'sts.amazonaws.com',
        [`${oidc}:sub`]: `${prefix}:pull_request`,
      },
    });
    const resources = policyResources(id);
    expect([resources].flat()).toEqual([bootstrap('lookup-role')]);
    expect(JSON.stringify(resources)).not.toContain('deploy-role');
  });
});
