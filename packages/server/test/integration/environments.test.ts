import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { clickPanel, waitForPanel } from '../helpers/panel.js';
import { tempDir } from '../helpers/temp.js';

// Three copies of the demo shop: development, staging, and a protected production.
// Chrome sends *.localhost to this computer, and each host keeps its own cookies.
type Demo = Awaited<ReturnType<typeof startDemoServer>>;
let dev: Demo;
let staging: Demo;
let production: Demo;
let project: string;

const LOGIN_PLAN = `name: Log in
environments: [development, staging]
steps:
  - id: open-login
    do: Open the login page
    action: { navigate: /login }
  - id: check
    do: Look at the account page
    expect: The page says "Logged in as {{var:userName}}".
`;

beforeAll(async () => {
  dev = await startDemoServer();
  staging = await startDemoServer(undefined, [
    '--host',
    'staging.localhost',
    '--env-name',
    'staging',
    '--password',
    'stage123',
  ]);
  production = await startDemoServer(undefined, [
    '--host',
    'prod.localhost',
    '--env-name',
    'production',
    '--password',
    'prod123',
  ]);
  project = tempDir('envs');
  const folder = join(project, '.walkthrough');
  mkdirSync(join(folder, 'plans'), { recursive: true });
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${dev.base}
allowedOrigins: [${dev.base}]
askTimeoutSec: 10
highlightMs: 0
vars:
  userName: Demo User
environments:
  staging:
    baseUrl: ${staging.base}
    vars: { userName: Staging User }
  production:
    baseUrl: ${production.base}
`,
  );
  writeFileSync(join(folder, '.env'), 'DEMO_PASSWORD=demo123\n');
  writeFileSync(join(folder, '.env.staging'), 'DEMO_PASSWORD=stage123\n');
  writeFileSync(join(folder, '.env.production'), 'DEMO_PASSWORD=prod123\n');
  writeFileSync(join(folder, 'plans', 'login.yaml'), LOGIN_PLAN);
}, 60_000);

afterAll(() => {
  for (const demo of [dev, staging, production]) demo?.stop();
});

async function logIn(mcp: Awaited<ReturnType<typeof startClient>>): Promise<string> {
  for (const [selector, value] of [
    ['input[name=username]', 'demo'],
    ['input[name=password]', '{{secret:DEMO_PASSWORD}}'],
  ] as const) {
    const fill = await mcp.call('act', { action: 'fill', selector, value });
    expect(fill.isError, fill.text).toBe(false);
  }
  const click = await mcp.call('act', { action: 'click', selector: 'button[type=submit]' });
  expect(click.isError, click.text).toBe(false);
  const read = await mcp.call('wait_for', { text: 'Logged in as' });
  expect(read.isError, read.text).toBe(false);
  return (await mcp.call('read', { selector: 'main' })).text;
}

describe('environments with the panel', () => {
  let mcp: Awaited<ReturnType<typeof startClient>>;
  let chrome: Browser;

  beforeAll(async () => {
    const chromeFile = endpointFile();
    mcp = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir('envs-tmp'),
      UIWALK_FORCE_PANEL: '1',
      UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
    });
    const open = await mcp.call('browser_open', { url: '/login' });
    expect(open.isError, open.text).toBe(false);
    chrome = await connectChrome(chromeFile, { defaultViewport: null });
  }, 60_000);

  afterAll(async () => {
    await chrome?.disconnect();
    await mcp?.close();
  });

  async function appPage(): Promise<Page> {
    const pages = await chrome.pages();
    const page = pages.find((p) => /^http/.test(p.url()));
    if (!page) throw new Error('No app page');
    return page;
  }

  it('lists the environments', async () => {
    const list = await mcp.call('environment', { action: 'list' });
    expect(list.text).toContain('- development (current)');
    expect(list.text).toContain(`- staging: ${staging.base}`);
    expect(list.text).toContain('- production (protected)');
  });

  it('moves the tab to the same page on staging, with its own secrets and values', async () => {
    const use = await mcp.call('environment', { action: 'use', name: 'staging' });
    expect(use.isError, use.text).toBe(false);
    expect(use.text).toContain(`Tab t1 moved to ${staging.base}/login.`);
    expect((await appPage()).url()).toBe(`${staging.base}/login`);
    await waitForPanel(await appPage(), 'Staging');
    // .env.staging has the staging password, so the login works.
    expect(await logIn(mcp)).toContain('Logged in as Staging User');
    const show = await mcp.call('environment', { action: 'show' });
    expect(show.text).toContain('Values for {{var:NAME}}: userName = "Staging User"');
  });

  it('blocks the sites of the other environments', async () => {
    const go = await mcp.call('navigate', { url: `${dev.base}/` });
    expect(go.isError).toBe(true);
    expect(go.text).toContain('site of the "development" environment');
  });

  it('asks before production, and goes back on Cancel', async () => {
    const call = mcp.call('environment', { action: 'use', name: 'production' });
    const page = await appPage();
    expect(await waitForPanel(page, 'Use Production')).toContain('real data');
    await clickPanel(page, 'stop');
    const reply = await call;
    expect(reply.text).toContain('status: canceled');
    expect(reply.text).toContain('goes back to the "staging" environment');
    expect(page.url()).toContain(staging.base);
  });

  it('moves to production after the developer confirms', async () => {
    const call = mcp.call('environment', { action: 'use', name: 'production' });
    const page = await appPage();
    await waitForPanel(page, 'Use Production');
    await clickPanel(page, 'pass');
    const reply = await call;
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain(`moved to ${production.base}/account`);
    // Once for each browser: switching again does not ask.
    expect((await mcp.call('environment', { action: 'use', name: 'staging' })).isError).toBe(false);
    const again = await mcp.call('environment', { action: 'use', name: 'production' });
    expect(again.text).not.toContain('status:');
    expect((await mcp.call('navigate', { url: '/login' })).isError).toBe(false);
    expect(await logIn(mcp)).toContain('Logged in as Production User');
  });
});

describe('protected environments without the panel', () => {
  it('asks in the client when it can', async () => {
    const asked: string[] = [];
    const mcp = await startClient(
      { UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('envs-ask') },
      undefined,
      {
        elicit: (message) => {
          asked.push(message);
          return { action: 'accept', content: { confirm: true } };
        },
      },
    );
    try {
      const open = await mcp.call('browser_open', { environment: 'production' });
      expect(open.isError, open.text).toBe(false);
      expect(asked[0]).toMatch(/Use the "production" environment .* real data/);
      expect(open.text).toContain(`URL: ${production.base}/`);
      const doctor = await mcp.call('doctor');
      expect(doctor.text).toContain('It can ask the developer to confirm');
    } finally {
      await mcp.close();
    }
  }, 60_000);

  it('refuses when nobody can confirm, unless UIWALK_ALLOW_PROTECTED names it', async () => {
    const mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('envs-no') });
    try {
      const open = await mcp.call('browser_open', { environment: 'production' });
      expect(open.isError).toBe(true);
      expect(open.text).toContain('cannot ask the developer to confirm it');
    } finally {
      await mcp.close();
    }
    const allowed = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir('envs-allow'),
      UIWALK_ALLOW_PROTECTED: 'production',
    });
    try {
      const open = await allowed.call('browser_open', { environment: 'production' });
      expect(open.isError, open.text).toBe(false);
      expect(open.text).toContain(production.base);
    } finally {
      await allowed.close();
    }
  }, 60_000);
});

describe('runs in an environment', () => {
  it('runs a plan on staging with its values, and refuses an environment the plan does not list', async () => {
    const mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('envs-run') });
    try {
      const start = await mcp.call('run_start', { plan: 'login', environment: 'staging' });
      expect(start.isError, start.text).toBe(false);
      expect(start.text).toContain(`Environment: staging (${staging.base})`);
      expect(start.text).toContain('userName = "Staging User"');
      expect(start.text).toContain('Expect: The page says "Logged in as Staging User".');
      expect(start.text).toMatch(
        /Run folder: \.walkthrough\/runs\/[\d_-]+-log-in-staging-[0-9a-f]{4}/,
      );
      await mcp.call('run_finish', {});
      const prod = await mcp.call('run_start', { plan: 'login', environment: 'production' });
      expect(prod.isError).toBe(true);
      expect(prod.text).toContain('may run only in these environments: development, staging');
    } finally {
      await mcp.close();
    }
  }, 60_000);
});
