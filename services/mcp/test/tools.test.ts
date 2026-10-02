import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools';

const get = vi.fn(async (path: string) => ({ path }));
let client: Client;

beforeEach(async () => {
  get.mockClear();
  const server = new McpServer({ name: 'loanflow-test', version: '0.0.0' });
  registerTools(server, get);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
});

describe('MCP tools', () => {
  it('exposes exactly five read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'explain_decision',
      'get_application',
      'get_ledger',
      'list_applications',
      'list_events',
    ]);
  });

  it('list_applications passes the status filter', async () => {
    await client.callTool({ name: 'list_applications', arguments: { status: 'DECLINED' } });
    expect(get).toHaveBeenCalledWith('/internal/applications?status=DECLINED');
  });

  it('explain_decision reads the decision route and returns JSON text', async () => {
    const res = await client.callTool({ name: 'explain_decision', arguments: { id: 'ABC123' } });
    expect(get).toHaveBeenCalledWith('/internal/applications/ABC123/decision');
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ path: '/internal/applications/ABC123/decision' });
  });

  it('rejects ids that could change the path', async () => {
    const res = await client.callTool({ name: 'get_application', arguments: { id: '../loans/x' } });
    expect(res.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
