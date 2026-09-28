import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Mocked, blocked, and slow requests.
const run = promisify(execFile);
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;

const STOCK_PLAN = `name: Stock with mocks
mode: autonomous
steps:
  - id: mocked-stock
    do: Check the stock of the mug with a mocked answer
    mock:
      - { url: /api/stock, status: 200, json: { inStock: true } }
    action: { click: { selector: '[data-stock="mug"]' } }
    expect: The status says "In stock"
  - id: real-stock
    do: Remove the mocks and check the stock again
    mock: off
    action: { click: { selector: '[data-stock="mug"]' } }
    expect: The status says "Could not check stock. Try again later."
`;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('intercept');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  writeFileSync(join(project, '.walkthrough', 'plans', 'stock.yaml'), STOCK_PLAN);
  // The exported script imports puppeteer-core from the project.
  symlinkSync(join(repoRoot, 'node_modules'), join(project, 'node_modules'));
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('intercept-tmp') });
  expect((await mcp.call('browser_open')).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

async function checkStock(): Promise<void> {
  await mcp.call('act', { action: 'click', selector: '[data-stock="mug"]' });
}

describe('intercept', () => {
  it('answers a request with a mock', async () => {
    const added = await mcp.call('intercept', {
      action: 'add',
      url: '/api/stock',
      status: 200,
      json: { inStock: true },
    });
    expect(added.text).toContain(
      'Added the mock rule m1: any method /api/stock -> 200 JSON, all tabs.',
    );
    await checkStock();
    expect((await mcp.call('wait_for', { text: 'In stock' })).isError).toBe(false);
    expect((await mcp.call('intercept')).text).toContain(
      'm1: any method /api/stock -> 200 JSON, all tabs. Used 1 time(s).',
    );
  });

  it('blocks requests', async () => {
    await mcp.call('intercept', { action: 'clear' });
    await mcp.call('intercept', { action: 'add', url: '/images/*', block: true });
    await mcp.call('navigate', { action: 'reload' });
    const images = await mcp.call('network', { all: true, urlContains: '/images/', since: 0 });
    expect(images.text).toMatch(/image \S+\/images\/mug\.svg/);
    expect(images.text).toMatch(
      /failed \(net::ERR_BLOCKED_BY_CLIENT[^)]*\) image \S+\/images\/mug\.svg/,
    );
  });

  it('slows a request down', async () => {
    await mcp.call('intercept', { action: 'clear' });
    await mcp.call('intercept', { action: 'add', url: '/api/stock', delayMs: 1500 });
    await checkStock();
    await mcp.call('wait_for', { text: 'Could not check stock' });
    const list = await mcp.call('network', { urlContains: '/api/stock' });
    const times = [...list.text.matchAll(/api\/stock\S* \((\d+) ms/g)].map((m) => Number(m[1]));
    const ms = times.at(-1) ?? 0;
    expect(ms).toBeGreaterThanOrEqual(1400);
  });

  it('limits a rule to one tab', async () => {
    await mcp.call('intercept', { action: 'clear' });
    await mcp.call('intercept', {
      action: 'add',
      url: '/api/stock',
      status: 200,
      json: {},
      tab: 'main',
    });
    await mcp.call('tabs', { action: 'new', url: '/', name: 'other' });
    await checkStock();
    expect((await mcp.call('wait_for', { text: 'Could not check stock' })).isError).toBe(false);
    await mcp.call('tabs', { action: 'close', id: 'other' });
    await mcp.call('navigate', { url: '/' });
    await checkStock();
    expect((await mcp.call('wait_for', { text: 'In stock' })).isError).toBe(false);
  });

  it('keeps the guard ahead of mocks, and can mock a page', async () => {
    await mcp.call('intercept', { action: 'clear' });
    await mcp.call('intercept', {
      action: 'add',
      url: '*',
      type: 'document',
      status: 200,
      body: '<h1>Mocked page</h1>',
      contentType: 'text/html',
    });
    const outline = (await mcp.call('snapshot')).text;
    const click = await mcp.call('act', {
      action: 'click',
      ref: refFor(outline, 'link', 'Visit example.com'),
    });
    const tabs = await mcp.call('tabs');
    expect(`${click.text}\n${tabs.text}`).toMatch(
      /blocked the tab from opening https:\/\/example\.com/,
    );
    await mcp.call('navigate', { url: '/help.html' });
    expect((await mcp.call('snapshot')).text).toContain('Mocked page');
    await mcp.call('intercept', { action: 'clear' });
  });
});

describe('mocks in plans and reports', () => {
  it('runs mock steps, marks them in the report, and exports them', async () => {
    await mcp.call('navigate', { url: '/' });
    const start = await mcp.call('run_start', { plan: 'stock' });
    expect(start.text).toContain('(agent checks, mock)');
    expect(start.text).toContain('Mock: any method /api/stock -> 200 JSON, all tabs');
    expect(start.text).toContain('Mock: off (remove all mocks)');

    await mcp.call('intercept', {
      action: 'add',
      url: '/api/stock',
      status: 200,
      json: { inStock: true },
    });
    await checkStock();
    await mcp.call('wait_for', { text: 'In stock' });
    await mcp.call('run_step', { stepId: 'mocked-stock', status: 'pass' });
    await mcp.call('intercept', { action: 'clear' });
    await checkStock();
    await mcp.call('wait_for', { text: 'Could not check stock' });
    await mcp.call('run_step', { stepId: 'real-stock', status: 'pass' });
    const finish = await mcp.call('run_finish');
    const runId = /runs\/([^/\s]+)\/report/.exec(finish.text)?.[1] as string;
    const runDir = join(project, '.walkthrough', 'runs', runId);

    const saved = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(saved.steps[0].mocked).toEqual([
      expect.stringMatching(/GET \S+\/api\/stock\?id=mug -> 200 \(mock m\d+\)/),
    ]);
    expect(saved.steps[1].mocked).toBeUndefined();
    const html = readFileSync(join(runDir, 'report.html'), 'utf8');
    expect(html).toContain('<span class="badge mocked">Mocked</span>');
    expect(html).toContain('Mocked requests');

    const exported = await mcp.call('export_script', { runId, installedChrome: true });
    const script = /\.walkthrough\/exports\/\S+\.mjs/.exec(exported.text)?.[0] as string;
    const result = await run(process.execPath, [join(project, script)], {
      env: { ...process.env, BASE_URL: demo.base },
      timeout: 60_000,
    });
    expect(result.stdout).toContain('Passed: every step and check.');
  }, 120_000);
});
