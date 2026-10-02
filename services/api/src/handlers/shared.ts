import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { listTimeline } from '../db/applications';
import { pathId, type HttpResult } from '../http';

/** An application's timeline. The same for customers and case handlers. */
export async function timelineEvents(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  return { status: 200, body: await listTimeline(pathId(event)) };
}
