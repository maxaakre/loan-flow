import { Duration, Stack } from 'aws-cdk-lib';
import { CfnRoute, CfnStage, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
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

/** New applications per UTC day across all users. */
const DAILY_APPLICATION_LIMIT = 200;

export class ApiConstruct extends Construct {
  readonly api: HttpApi;
  readonly functions: Record<string, NodejsFunction>;
  readonly mcpReaderRole: iam.Role;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { makeFn, table } = props;

    const companies = makeFn(this, 'CompaniesApi', 'handlers/companies-api');
    const applications = makeFn(this, 'ApplicationsApi', 'handlers/applications-api', {
      environment: { DAILY_APPLICATION_LIMIT: String(DAILY_APPLICATION_LIMIT) },
    });
    const loans = makeFn(this, 'LoansApi', 'handlers/loans-api');
    const internal = makeFn(this, 'InternalApi', 'handlers/internal-api');
    this.functions = { companies, applications, loans, internal };

    // Least privilege per function. TransactWriteItems needs the per-item actions.
    // UpdateItem: only for the daily application counter
    table.grant(applications, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    props.stateMachine.grantTaskResponse(applications);
    table.grant(loans, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    table.grant(internal, 'dynamodb:GetItem', 'dynamodb:Query');

    this.api = new HttpApi(this, 'HttpApi', { apiName: 'loanflow' });
    const integration = (fn: NodejsFunction) => new HttpLambdaIntegration(`${fn.node.id}Integration`, fn);
    const add = (method: HttpMethod, path: string, fn: NodejsFunction, authorizer?: HttpIamAuthorizer) =>
      this.api.addRoutes({ path, methods: [method], integration: integration(fn), authorizer });

    add(HttpMethod.GET, '/api/companies', companies);
    const [createRoute] = add(HttpMethod.POST, '/api/applications', applications);
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

    // Cost guard for a public demo, on top of the daily cap in applications-api.
    // Each application starts a process and several Lambdas, so creating one is throttled hardest.
    const stage = this.api.defaultStage!.node.defaultChild as CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 5, throttlingBurstLimit: 10 };
    // routeSettings is raw JSON, so it takes CloudFormation's PascalCase keys
    stage.routeSettings = { 'POST /api/applications': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 } };
    stage.addDependency(createRoute!.node.defaultChild as CfnRoute); // route settings need the route to exist

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
