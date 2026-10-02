import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

export function createTable(scope: Construct): dynamodb.Table {
  const table = new dynamodb.Table(scope, 'Table', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    // The stream feeds the outbox relay
    stream: dynamodb.StreamViewType.NEW_IMAGE,
    timeToLiveAttribute: 'ttl',
    removalPolicy: RemovalPolicy.DESTROY, // demo data only
  });
  table.addGlobalSecondaryIndex({
    indexName: 'GSI1',
    partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
  });
  return table;
}
