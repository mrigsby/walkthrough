import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Context } from './context.js';
import { onShutdown } from './lifecycle.js';
import { log } from './log.js';
import { registerBrowserTools } from './tools/browser-tools.js';
import { registerDeveloperTools } from './tools/developer-tools.js';
import { registerPageTools } from './tools/page-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerRunTools, writeReports } from './tools/run-tools.js';
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

  const ctx = new Context(roots, () => server.server.getClientVersion()?.name);
  registerBrowserTools(server, ctx);
  registerPageTools(server, ctx);
  registerDeveloperTools(server, ctx);
  registerRunTools(server, ctx);
  registerProjectTools(server, ctx);

  // If the server stops during a run, keep what we have and write the reports.
  onShutdown(() => {
    if (ctx.run?.run.status !== 'running') return;
    try {
      ctx.run.markIncomplete();
      writeReports(ctx.run);
    } catch (error) {
      log.warn('could not write the reports for the unfinished run', error);
    }
  });
  return { server, ctx };
}
