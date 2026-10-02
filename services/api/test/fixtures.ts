import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildOffer, findCompany, kr, type Application, type DomainEvent, type Loan } from '@loanflow/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import type { AwsClientStub } from 'aws-sdk-client-mock';
import type { TransactItem } from '../src/db/client';

export const NOW = '2026-10-02T10:00:00.000Z';
export const APP_ID = '01JAPP0000000000000000000A';

export function anApplication(overrides: Partial<Application> = {}): Application {
  const company = findCompany('559900-0001')!;
  return {
    id: APP_ID,
    correlationId: 'corr-1',
    orgNr: company.orgNr,
    companyName: company.name,
    amount: kr(200_000),
    termMonths: 12,
    status: 'SUBMITTED',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function aLoan(overrides: Partial<Loan> = {}): Loan {
  const offer = buildOffer(kr(120_000), 6, 'A');
  return {
    id: APP_ID,
    applicationId: APP_ID,
    correlationId: 'corr-1',
    principal: offer.amount,
    schedule: offer.schedule,
    paidInstalments: 0,
    balance: offer.amount,
    status: 'ACTIVE',
    payoutId: 'PAY1',
    version: 1,
    disbursedAt: NOW,
    ...overrides,
  };
}

/** Items of the last TransactWriteCommand sent to the mock. */
export function lastTransaction(ddb: AwsClientStub<DynamoDBDocumentClient>): TransactItem[] {
  const calls = ddb.commandCalls(TransactWriteCommand);
  return calls.at(-1)?.args[0].input.TransactItems ?? [];
}

export const outboxEvents = (items: TransactItem[]): DomainEvent[] =>
  items.flatMap((i) => (String(i.Put?.Item?.PK ?? '').startsWith('OUTBOX#') ? [i.Put!.Item!.event as DomainEvent] : []));

export function apiEvent(opts: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: opts.routeKey,
    rawPath: opts.routeKey.split(' ')[1] ?? '/',
    rawQueryString: '',
    headers: opts.headers ?? {},
    pathParameters: opts.pathParameters,
    queryStringParameters: opts.queryStringParameters,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: { requestId: 'req-1' } as APIGatewayProxyEventV2['requestContext'],
  };
}

export const lambdaContext = {} as Context;

export const parse = (res: APIGatewayProxyStructuredResultV2) => ({
  status: res.statusCode,
  body: JSON.parse(res.body ?? 'null'),
  contentType: res.headers?.['content-type'],
});
