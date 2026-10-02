import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import puppeteer from 'puppeteer-core';
import { findChrome, installChrome, NO_CHROME_MESSAGE } from './browser/chrome.js';
import { loadConfig, resolveProjectDir } from './config.js';
import { doctorReport } from './doctor.js';
import { findFfmpeg, installFfmpeg } from './downloads/ffmpeg.js';
import { findLighthouse, installLighthouse, LIGHTHOUSE_VERSION } from './downloads/lighthouse.js';
import { secretScope } from './environments.js';
import { SecretStore } from './guards/secrets.js';
import { initProject } from './init.js';
import { installShutdownHandlers } from './lifecycle.js';
import { log } from './log.js';
import { planJsonSchema } from './run/plan-schema.js';
import { createServer } from './server.js';
import { MIN_NODE, nodeVersionOk, VERSION } from './version.js';
import { chromeCanMakeMp4 } from './video/probe.js';

const HELP = `uiwalk ${VERSION}: step-by-step visual UI testing for AI agents.

Commands:
  serve     Start the MCP server (default).
  setup     Download Chrome for Testing, if Chrome is not installed.
            setup lighthouse: download Lighthouse, for performance reports.
            setup ffmpeg: download ffmpeg, for exported videos and the MP4 fallback.
            Add --force to download again.
  doctor    Check Node, Chrome, and the project settings.
  schema    Print the JSON Schema for test plans.
  init      Make the .walkthrough folder here. Option: --base-url URL
  version   Show the version.
`;

// Starts the MCP server over stdio.
async function serve(): Promise<void> {
  const { server } = createServer();
  installShutdownHandlers();
  await server.connect(new StdioServerTransport());
  log.info(`server ${VERSION} is ready`);
}

const force = () => process.argv.includes('--force');

async function setup(what = 'chrome'): Promise<void> {
  if (what === 'lighthouse') return setupLighthouse();
  if (what === 'ffmpeg') return setupFfmpeg();
  if (what !== 'chrome') {
    log.error(`Unknown setup "${what}". Use: setup, setup lighthouse, or setup ffmpeg.`);
    process.exit(1);
  }
  const found = await findChrome();
  if (found && !force()) {
    process.stdout.write(
      `Chrome is ready (${found.source}): ${found.path}\nNo download is needed.\n`,
    );
    return;
  }
  process.stdout.write('Walkthrough now downloads Chrome for Testing.\n');
  const path = await installChrome((percent) => process.stdout.write(`  ${percent}%\n`));
  process.stdout.write(`Chrome for Testing is ready: ${path}\n`);
}

async function setupLighthouse(): Promise<void> {
  const found = findLighthouse();
  if (found && !force()) {
    process.stdout.write(
      `Lighthouse ${found.version} is ready: ${found.dir}\nNo download is needed.\n`,
    );
    return;
  }
  process.stdout.write(
    `Walkthrough now installs Lighthouse ${LIGHTHOUSE_VERSION} with npm (about 170 MB). It runs no install scripts.\n`,
  );
  const dir = await installLighthouse();
  process.stdout.write(`Lighthouse ${LIGHTHOUSE_VERSION} is ready: ${dir}\n`);
}

async function setupFfmpeg(): Promise<void> {
  const found = findFfmpeg();
  if (found && !force()) {
    process.stdout.write(
      `ffmpeg is ready (${found.source}): ${found.path}\nNo download is needed.\n`,
    );
    return;
  }
  process.stdout.write('Walkthrough now downloads ffmpeg and checks its SHA-256 hash.\n');
  const result = await installFfmpeg({
    onProgress: (percent) => process.stdout.write(`  ${percent}%\n`),
  });
  process.stdout.write(
    [
      `ffmpeg is ready: ${result.path}`,
      `Source: ${result.build.source}`,
      `License: ${result.license}. The text is in ${join(dirname(result.path), 'LICENSE.txt')}.`,
      '',
    ].join('\n'),
  );
}

async function doctor(): Promise<void> {
  const { dir, source } = resolveProjectDir();
  const config = loadConfig(dir, source, process.env.UIWALK_ENV?.trim() || undefined);
  const secrets = SecretStore.forProject(dir, secretScope(config.environment));
  process.stdout.write(`${await doctorReport(config, secrets)}\n`);

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
    const mp4 = await chromeCanMakeMp4(browser);
    await browser.close();
    process.stdout.write(`\nOK    Chrome starts: ${version}\n`);
    process.stdout.write(
      mp4
        ? 'OK    Chrome can make MP4 videos.\n'
        : 'INFO  This Chrome cannot make MP4 videos. Walkthrough uses ffmpeg for MP4, or saves WebM.\n',
    );
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
      await setup(process.argv[3]?.startsWith('--') ? undefined : process.argv[3]);
      break;
    case 'doctor':
      await doctor();
      break;
    case 'init': {
      const flag = process.argv.indexOf('--base-url');
      const result = initProject(process.cwd(), flag > -1 ? process.argv[flag + 1] : undefined);
      for (const file of result.created) process.stdout.write(`Created ${file}\n`);
      for (const file of result.kept) process.stdout.write(`Kept ${file} (already there)\n`);
      break;
    }
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
