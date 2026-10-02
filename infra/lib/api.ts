import { Duration, Stack } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import type { FnFactory } from './functions';

export interface ApiProps {
  table: ITable;
  makeFn: FnFactory;
  stateMachine: IStateMachine;
}

export class ApiConstruct extends Construct {
  readonly api: HttpApi;
  readonly functions: Record<string, NodejsFunction>;
  readonly mcpReaderRole: iam.Role;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { makeFn, table } = props;

    const companies = makeFn(this, 'CompaniesApi', 'handlers/companies-api');
    const applications = makeFn(this, 'ApplicationsApi', 'handlers/applications-api');
    const loans = makeFn(this, 'LoansApi', 'handlers/loans-api');
    const internal = makeFn(this, 'InternalApi', 'handlers/internal-api');
    this.functions = { companies, applications, loans, internal };

    // Least privilege per function. TransactWriteItems needs the per-item actions.
    table.grant(applications, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query');
    props.stateMachine.grantTaskResponse(applications);
    table.grant(loans, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    table.grant(internal, 'dynamodb:GetItem', 'dynamodb:Query');

    this.api = new HttpApi(this, 'HttpApi', { apiName: 'loanflow' });
    const integration = (fn: NodejsFunction) => new HttpLambdaIntegration(`${fn.node.id}Integration`, fn);
    const add = (method: HttpMethod, path: string, fn: NodejsFunction, authorizer?: HttpIamAuthorizer) =>
      this.api.addRoutes({ path, methods: [method], integration: integration(fn), authorizer });

    add(HttpMethod.GET, '/api/companies', companies);
    add(HttpMethod.POST, '/api/applications', applications);
    add(HttpMethod.GET, '/api/applications/{id}', applications);
    add(HttpMethod.GET, '/api/applications/{id}/events', applications);
    add(HttpMethod.POST, '/api/applications/{id}/sign', applications);
    add(HttpMethod.GET, '/api/loans/{id}', loans);
    add(HttpMethod.POST, '/api/loans/{id}/payments', loans);

    // Internal routes: SigV4 only, never routed through CloudFront
    const iamAuth = new HttpIamAuthorizer();
    for (const path of [
      '/internal/applications',
      '/internal/applications/{id}',
      '/internal/applications/{id}/decision',
      '/internal/applications/{id}/events',
      '/internal/loans/{id}/ledger',
    ]) {
      add(HttpMethod.GET, path, internal, iamAuth);
    }

    const stage = this.api.defaultStage!.node.defaultChild as CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };

    // The local MCP server assumes this role. It can read internal routes and nothing else.
    const { region, account } = Stack.of(this);
    this.mcpReaderRole = new iam.Role(this, 'McpReaderRole', {
      roleName: 'loanflow-mcp-reader',
      assumedBy: new iam.AccountRootPrincipal(),
      maxSessionDuration: Duration.hours(1),
    });
    this.mcpReaderRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [`arn:aws:execute-api:${region}:${account}:${this.api.apiId}/*/GET/internal/*`],
      }),
    );
  }
}
