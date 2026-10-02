import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { signedFetcher } from './client';
import { registerTools } from './tools';

const apiUrl = process.env.LOANFLOW_API_URL;
if (!apiUrl) {
  // stdout is the MCP channel, so errors go to stderr
  console.error('Set LOANFLOW_API_URL to the ApiUrl stack output');
  process.exit(1);
}

const server = new McpServer({ name: 'loanflow', version: '0.1.0' });
registerTools(server, signedFetcher(apiUrl));
await server.connect(new StdioServerTransport());
