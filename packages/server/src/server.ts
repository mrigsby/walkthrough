import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Context, type Elicit } from './context.js';
import { onShutdown } from './lifecycle.js';
import { log } from './log.js';
import { registerA11yTools } from './tools/a11y-tools.js';
import { registerBrowserTools } from './tools/browser-tools.js';
import { registerDeveloperTools } from './tools/developer-tools.js';
import { registerDevtoolsTools } from './tools/devtools-tools.js';
import { registerEnvironmentTools } from './tools/environment-tools.js';
import { registerLighthouseTools } from './tools/lighthouse-tools.js';
import { registerPageTools } from './tools/page-tools.js';
import { registerPresentTools } from './tools/present-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerQualityTools } from './tools/quality-tools.js';
import { registerRunTools, writeReports } from './tools/run-tools.js';
import { registerShareTools } from './tools/share-tools.js';
import { registerVideoTools } from './tools/video-tools.js';
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

  // A yes-or-no question in the client, for when the browser panel is not there.
  const elicit = (): Elicit | undefined => {
    if (!server.server.getClientCapabilities()?.elicitation?.form) return undefined;
    return async (message, { timeoutMs, signal, relatedRequestId }) => {
      try {
        const result = await server.server.elicitInput(
          {
            message,
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean', title: 'Confirm', description: message } },
              required: ['confirm'],
            },
          },
          { timeout: timeoutMs, signal, relatedRequestId },
        );
        return result.action === 'accept' && result.content?.confirm === true ? 'yes' : 'no';
      } catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return 'timeout';
        if (signal?.aborted) return 'no';
        throw error;
      }
    };
  };

  const ctx = new Context(roots, () => server.server.getClientVersion()?.name, elicit);
  registerBrowserTools(server, ctx);
  registerEnvironmentTools(server, ctx);
  registerPageTools(server, ctx);
  registerDeveloperTools(server, ctx);
  registerRunTools(server, ctx);
  registerProjectTools(server, ctx);
  registerQualityTools(server, ctx);
  registerA11yTools(server, ctx);
  registerDevtoolsTools(server, ctx);
  registerLighthouseTools(server, ctx);
  registerShareTools(server, ctx);
  registerVideoTools(server, ctx);
  registerPresentTools(server, ctx);

  // If the server stops during a run, keep what we have and write the reports.
  onShutdown(async () => {
    if (ctx.run?.run.status !== 'running') return;
    try {
      ctx.run.markIncomplete();
      writeReports(ctx.run, await ctx.secrets().catch(() => undefined));
    } catch (error) {
      log.warn('could not write the reports for the unfinished run', error);
    }
  });
  return { server, ctx };
}
