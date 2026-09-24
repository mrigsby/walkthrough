import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Context } from './context.js';
import { registerBrowserTools } from './tools/browser-tools.js';
import { registerPageTools } from './tools/page-tools.js';
import { VERSION } from './version.js';

// Builds the MCP server and adds its tools.
export function createServer(): { server: McpServer; ctx: Context } {
  const server = new McpServer({ name: 'uiwalk', version: VERSION });

  // Ask the client for its project folder ("roots"), if it supports that.
  const roots = async (): Promise<string[]> => {
    if (!server.server.getClientCapabilities()?.roots) return [];
    const { roots: list } = await server.server.listRoots();
    return list.map((root) => (root.uri.startsWith('file:') ? fileURLToPath(root.uri) : root.uri));
  };

  const ctx = new Context(roots);
  registerBrowserTools(server, ctx);
  registerPageTools(server, ctx);
  return { server, ctx };
}
