import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../../services/api/src/', import.meta.url));

export const METRICS_NAMESPACE = 'LoanFlow';
/** Powertools service name, and so the `service` metric dimension: the file name of the entry. */
export const serviceName = (entry: string): string => entry.split('/').pop()!;

export type FnOptions = { timeout?: Duration; environment?: Record<string, string> };
export type FnFactory = (scope: Construct, id: string, entry: string, opts?: FnOptions) => NodejsFunction;

/** Every Lambda gets the same safe defaults: Node 22, ARM, tracing, no VPC, 1-month logs. */
export const functionFactory =
  (table: ITable): FnFactory =>
  (scope, id, entry, opts = {}) =>
    new NodejsFunction(scope, id, {
      entry: `${srcDir}${entry}.ts`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: opts.timeout ?? Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(scope, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE_NAME: table.tableName,
        POWERTOOLS_SERVICE_NAME: serviceName(entry),
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        NODE_OPTIONS: '--enable-source-maps',
        ...opts.environment,
      },
      bundling: { minify: true, sourceMap: true },
    });
