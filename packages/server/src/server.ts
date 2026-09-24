import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from './version.js';

// Builds the MCP server and adds its tools.
export function createServer(): McpServer {
  const server = new McpServer({ name: 'uiwalk', version: VERSION });

  // Temporary tool to prove the server works. Phase 1 removes it.
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Check that the Walkthrough server is running.',
      inputSchema: { message: z.string().optional().describe('Text to echo back.') },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `pong${message ? `: ${message}` : ''} (uiwalk ${VERSION})` }],
    }),
  );

  return server;
}
