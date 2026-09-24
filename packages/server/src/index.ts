import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { checkBrowser } from './check-browser.js';
import { log } from './log.js';
import { createServer } from './server.js';
import { MIN_NODE, nodeVersionOk, VERSION } from './version.js';

// Starts the MCP server over stdio.
async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log.info(`server ${VERSION} is ready`);
}

async function main(): Promise<void> {
  if (!nodeVersionOk()) {
    log.error(
      `Walkthrough needs Node ${MIN_NODE.join('.')} or later. You have ${process.versions.node}. Install a newer Node from https://nodejs.org and try again.`,
    );
    process.exit(1);
  }

  const command = process.argv[2] ?? 'serve';
  switch (command) {
    case 'serve':
      await serve();
      break;
    case 'check-browser':
      process.stdout.write(`${await checkBrowser()}\n`);
      break;
    case 'version':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      break;
    default:
      log.error(`Unknown command "${command}". Use: serve, check-browser, version.`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  log.error('server stopped because of an error', error);
  process.exit(1);
});
