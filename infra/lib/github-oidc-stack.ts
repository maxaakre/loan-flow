import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  /** "owner/repo" */
  githubRepo: string;
  /** OIDC `sub` prefix. With GitHub's immutable subject claims it is `repo:<owner>@<id>/<repo>@<id>`. */
  githubSubjectPrefix?: string;
}

/** Lets GitHub Actions get short-lived AWS credentials. No access keys are stored in GitHub. */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    const { account, region } = this;
    const subjectPrefix = props.githubSubjectPrefix ?? `repo:${props.githubRepo}`;

    // An account can only have one provider per URL; the earlier demo already created it
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubProvider',
      `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const trust = (sub: string) =>
      new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': sub,
        },
      });
    const bootstrapRoleArn = (name: string) => `arn:aws:iam::${account}:role/cdk-hnb659fds-${name}-${account}-${region}`;

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'loanflow-github-deploy',
      assumedBy: trust(`${subjectPrefix}:ref:refs/heads/main`),
      maxSessionDuration: Duration.hours(1),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy-role', 'file-publishing-role', 'image-publishing-role', 'lookup-role'].map(bootstrapRoleArn),
      }),
    );

    const diffRole = new iam.Role(this, 'GithubDiffRole', {
      roleName: 'loanflow-github-diff',
      assumedBy: trust(`${subjectPrefix}:pull_request`),
      maxSessionDuration: Duration.hours(1),
    });
    diffRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [bootstrapRoleArn('lookup-role')] }));
  }
}
