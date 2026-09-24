import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import puppeteer from 'puppeteer-core';
import { findChrome, installChrome, NO_CHROME_MESSAGE } from './browser/chrome.js';
import { loadConfig, resolveProjectDir } from './config.js';
import { doctorReport } from './doctor.js';
import { SecretStore } from './guards/secrets.js';
import { installShutdownHandlers } from './lifecycle.js';
import { log } from './log.js';
import { planJsonSchema } from './run/plan-schema.js';
import { createServer } from './server.js';
import { MIN_NODE, nodeVersionOk, VERSION } from './version.js';

const HELP = `uiwalk ${VERSION}: step-by-step visual UI testing for AI agents.

Commands:
  serve     Start the MCP server (default).
  setup     Download Chrome for Testing, if Chrome is not installed.
  doctor    Check Node, Chrome, and the project settings.
  schema    Print the JSON Schema for test plans.
  version   Show the version.
`;

// Starts the MCP server over stdio.
async function serve(): Promise<void> {
  const { server } = createServer();
  installShutdownHandlers();
  await server.connect(new StdioServerTransport());
  log.info(`server ${VERSION} is ready`);
}

async function setup(): Promise<void> {
  const found = await findChrome();
  if (found && !process.argv.includes('--force')) {
    process.stdout.write(
      `Chrome is ready (${found.source}): ${found.path}\nNo download is needed.\n`,
    );
    return;
  }
  process.stdout.write('Walkthrough now downloads Chrome for Testing.\n');
  const path = await installChrome((percent) => process.stdout.write(`  ${percent}%\n`));
  process.stdout.write(`Chrome for Testing is ready: ${path}\n`);
}

async function doctor(): Promise<void> {
  const { dir, source } = resolveProjectDir();
  const config = loadConfig(dir, source);
  process.stdout.write(`${await doctorReport(config, SecretStore.forProject(dir))}\n`);

  // Prove that Chrome starts.
  const chrome = await findChrome(config.browser.executablePath);
  if (!chrome) {
    process.stdout.write(`\n${NO_CHROME_MESSAGE}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const browser = await puppeteer.launch({ executablePath: chrome.path, headless: true });
    const version = await browser.version();
    await browser.close();
    process.stdout.write(`\nOK    Chrome starts: ${version}\n`);
  } catch (error) {
    process.stdout.write(`\nFIX   Chrome did not start: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
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
    case 'setup':
      await setup();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'schema':
      process.stdout.write(`${JSON.stringify(planJsonSchema(), null, 2)}\n`);
      break;
    case 'version':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      break;
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      break;
    default:
      log.error(`Unknown command "${command}".\n${HELP}`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  log.error('uiwalk stopped because of an error', error);
  process.exit(1);
});
