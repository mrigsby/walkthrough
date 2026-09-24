import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Run } from '../../src/run/run-store.js';
import { freePort, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { clickPanel, typeNotes, waitForPanel } from '../helpers/panel.js';
import { tempDir } from '../helpers/temp.js';

// Runs a small plan from start to report, like an agent and a developer would.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let chrome: Browser;
let page: Page;
let runDir: string;

const PLAN = `# yaml-language-server: $schema=../plan.schema.json
name: Mini checkout
mode: checkpoints
steps:
  - id: add-mug
    do: Add the Coffee Mug
    expect: The cart count is 1.
  - id: add-shirt
    do: Add the T-Shirt
    expect: The cart count is 2.
  - id: check-total
    do: Open the cart and read the total
    action: { navigate: /cart }
    expect: The total is $30.00.
    checkpoint: true
  - id: apply-coupon
    do: Apply a coupon
    expect: A message says the coupon is applied.
  - id: pay
    do: Pay for the order
`;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('run');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  writeFileSync(join(project, '.walkthrough', 'plans', 'mini.yaml'), PLAN);
  const debugPort = await freePort();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('run-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_PORT: String(debugPort),
  });
  const open = await mcp.call('browser_open');
  expect(open.isError, open.text).toBe(false);
  chrome = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${debugPort}`,
    defaultViewport: null,
  });
  page = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
}, 60_000);

afterAll(async () => {
  await chrome?.disconnect();
  await mcp?.close().catch(() => undefined);
  demo?.stop();
});

async function click(role: string, name: string) {
  const outline = (await mcp.call('snapshot')).text;
  const reply = await mcp.call('act', { action: 'click', ref: refFor(outline, role, name) });
  expect(reply.isError, reply.text).toBe(false);
}

function readRun(): Run {
  return JSON.parse(readFileSync(join(project, runDir, 'run.json'), 'utf8')) as Run;
}

describe('test plans and runs', () => {
  it('lists and validates plans', async () => {
    const list = await mcp.call('plan', { action: 'list' });
    expect(list.text).toContain('mini (.walkthrough/plans/mini.yaml): "Mini checkout", 5 step(s)');
    const bad = await mcp.call('plan', {
      action: 'validate',
      content: 'name: X\nsteps:\n  - expect: y\n',
    });
    expect(bad.text).toMatch(/Line 3 \(steps\[0\]\.do\)/);
  });

  it('starts a run with the steps and what to confirm', async () => {
    const reply = await mcp.call('run_start', { plan: 'mini' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Started the run "Mini checkout" in checkpoints mode.');
    expect(reply.text).toContain('3. [check-total] (confirm) Open the cart and read the total');
    expect(reply.text).toContain('1. [add-mug] (agent checks) Add the Coffee Mug');
    expect(reply.text).toContain('Action: navigate "/cart"');
    runDir = /Run folder: (\S+)/.exec(reply.text)?.[1] as string;
    expect(existsSync(join(project, runDir, 'run.json'))).toBe(true);

    const again = await mcp.call('run_start', { plan: 'mini' });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/still going/);
  });

  it('records steps the agent checks', async () => {
    await click('button', 'Add to cart');
    const first = await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
    expect(first.text).toContain('Saved step 1 [add-mug] as pass.');
    expect(first.text).toContain('Next: step 2 [add-shirt]');
    const outline = (await mcp.call('snapshot')).text;
    const shirtButton = [...outline.matchAll(/\[(e\d+)\] button "Add to cart"/g)][1]?.[1];
    await mcp.call('act', { action: 'click', ref: shirtButton });
    await mcp.call('run_step', { stepId: 'add-shirt', status: 'pass' });
    expect(readRun().steps.map((s) => s.status)).toEqual([
      'pass',
      'pass',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('records the developer answer for a confirm step', async () => {
    await mcp.call('navigate', { url: '/cart' });
    const reply = mcp.call('ask_developer', {
      stepId: 'check-total',
      step: 3,
      total: 5,
      title: 'Read the cart total',
      didWhat: 'I opened the cart.',
      expected: 'The total is $30.00.',
    });
    await waitForPanel(page, 'The total is $30.00.');
    await typeNotes(page, 'The total says $40.00.');
    await clickPanel(page, 'bug');
    const result = await reply;
    expect(result.text).toMatch(/^status: bug/);
    expect(result.text).toContain('Saved as step 3 in the run. Next: step 4 [apply-coupon]');
    const step = readRun().steps[2];
    expect(step?.status).toBe('bug');
    expect(step?.checkedBy).toBe('developer');
    expect(step?.notes).toBe('The total says $40.00.');
    expect(step?.screenshots[0]).toMatch(/^screenshots\/.+\.png$/);
  });

  it('saves a screenshot and errors when the agent finds a failure', async () => {
    await click('button', 'Apply coupon');
    const reply = await mcp.call('run_step', {
      stepId: 'apply-coupon',
      status: 'fail',
      actual: 'Nothing happens. No message shows.',
    });
    expect(reply.text).toContain('Saved step 4 [apply-coupon] as fail.');
    expect(reply.text).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(reply.images).toBe(1);
    const step = readRun().steps[3];
    expect(step?.actual).toBe('Nothing happens. No message shows.');
    expect(step?.actions.map((a) => a.label)).toEqual([
      expect.stringMatching(/^button "Apply coupon"/),
    ]);
    expect(step?.errorCount).toBe(1);
  });

  it('finishes the run and writes both reports', async () => {
    const reply = await mcp.call('run_finish', { summary: 'The total and the coupon are broken.' });
    expect(reply.text).toContain('is finished. Result: 2 passed, 1 bug, 1 failed, 1 not run.');
    expect(reply.text).toContain(
      'Step 3: Open the cart and read the total. Notes: The total says $40.00.',
    );

    const md = readFileSync(join(project, runDir, 'report.md'), 'utf8');
    expect(md).toContain('## Bugs and failures');
    expect(md).toContain('### Step 4: Apply a coupon (Failed)');
    expect(md).toMatch(
      /1\. Open http:\/\/localhost:\d+\n2\. Add the Coffee Mug\n3\. Add the T-Shirt\n4\. Open the cart and read the total\n5\. Click button "Apply coupon"/,
    );
    const html = readFileSync(join(project, runDir, 'report.html'), 'utf8');
    expect(html.match(/data:image\/png;base64,/g)?.length).toBe(2);
    expect(readRun().status).toBe('finished');
    expect(readdirSync(join(project, runDir, 'screenshots'))).toHaveLength(2);
    const runs = await mcp.call('runs');
    expect(runs.text).toContain(`${runDir.split('/').pop()}: "Mini checkout", finished`);
    expect(runs.text).toContain('(report written)');
  });

  it('writes a report for a run that ends early', async () => {
    const start = await mcp.call('run_start', { name: 'Cut short' });
    const dir = /Run folder: (\S+)/.exec(start.text)?.[1] as string;
    await mcp.call('run_step', { title: 'Looked at the shop', status: 'pass' });
    // The client goes away in the middle of the run.
    await mcp.close();
    const report = join(project, dir, 'report.md');
    for (let i = 0; i < 50 && !existsSync(report); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(report, 'utf8')).toContain(
      '- **Status:** Incomplete (the run ended early)',
    );
  });
});
