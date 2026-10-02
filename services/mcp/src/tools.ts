import { APPLICATION_STATUSES, IdSchema } from '@loanflow/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Fetcher } from './client';

const id = IdSchema;
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const MONEY_NOTE = 'All amounts are integer öre (1 kr = 100 öre).';

/** Read-only by design: the model explains, the backend decides. */
export function registerTools(server: McpServer, get: Fetcher): void {
  server.registerTool(
    'list_applications',
    {
      title: 'List applications',
      description: `List loan applications by status. Defaults to MANUAL_REVIEW, the case handler queue. ${MONEY_NOTE}`,
      inputSchema: { status: z.enum(APPLICATION_STATUSES).optional() },
    },
    async ({ status }) => json(await get(`/internal/applications${status ? `?status=${status}` : ''}`)),
  );

  server.registerTool(
    'get_application',
    { title: 'Get application', description: `One application with company data, decision and offer. ${MONEY_NOTE}`, inputSchema: { id } },
    async (args) => json(await get(`/internal/applications/${args.id}`)),
  );

  server.registerTool(
    'explain_decision',
    {
      title: 'Explain decision',
      description:
        'The credit decision: outcome, reason codes, the exact inputs the rules used, and rulesVersion. ' +
        `Explain from these facts only. Do not recompute or invent amounts. ${MONEY_NOTE}`,
      inputSchema: { id },
    },
    async (args) => json(await get(`/internal/applications/${args.id}/decision`)),
  );

  server.registerTool(
    'list_events',
    { title: 'List events', description: 'The timeline of domain events for one application.', inputSchema: { id } },
    async (args) => json(await get(`/internal/applications/${args.id}/events`)),
  );

  server.registerTool(
    'get_ledger',
    {
      title: 'Get ledger',
      description: `Double-entry ledger for a loan (loan id = application id) and the balance recomputed from it. ${MONEY_NOTE}`,
      inputSchema: { id },
    },
    async (args) => json(await get(`/internal/loans/${args.id}/ledger`)),
  );
}
