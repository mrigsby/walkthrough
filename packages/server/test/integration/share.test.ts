import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatePlanText } from '../../src/run/plans.js';
import { freePort, repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { clickPanel, waitForPanel } from '../helpers/panel.js';
import { tempDir } from '../helpers/temp.js';

// Record mode, script export, and issue drafts.
const run = promisify(execFile);
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let debugPort: number;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('share');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  // The exported script imports puppeteer-core from the project.
  symlinkSync(join(repoRoot, 'node_modules'), join(project, 'node_modules'));
  debugPort = await freePort();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('share-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_PORT: String(debugPort),
  });
  expect((await mcp.call('browser_open')).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const chrome: Browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${debugPort}`,
    defaultViewport: null,
  });
  try {
    const page = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
    return await fn(page);
  } finally {
    await chrome.disconnect();
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function yamlFrom(reply: string): string {
  return /<page-content untrusted="true">\n([\s\S]*)\n<\/page-content>/.exec(reply)?.[1] ?? '';
}

describe('record mode', () => {
  it("turns the developer's clicks and typing into a plan draft", async () => {
    const start = await mcp.call('record', { action: 'start', name: 'Log in flow' });
    expect(start.text).toContain('Recording is on.');
    const waiting = mcp.call('record', { action: 'wait' });

    await withPage(async (page) => {
      await waitForPanel(page, 'Recording');
      await page.click('[data-add="mug"]');
      // A pause, so the next page load counts as a typed address.
      await pause(1700);
      await page.goto(`${demo.base}/login`);
      await waitForPanel(page, 'Recording');
      await page.type('input[name="username"]', 'demo');
      await page.keyboard.press('Tab');
      await page.type('input[name="password"]', 'demo123');
      await page.keyboard.press('Tab');
      await clickPanel(page, 'rec-expect');
      await clickPanel(page, 'rec-notes');
      await page.keyboard.type('Both fields are filled in.');
      await clickPanel(page, 'rec-save');
      await page.click('#login-form button[type="submit"]');
      await pause(500);
      await waitForPanel(page, '5 steps so far');
      await clickPanel(page, 'rec-stop');
    });

    const reply = await waiting;
    expect(reply.text).toMatch(/^status: stopped/);
    expect(reply.text).toContain('Secrets in the draft: PASSWORD.');
    expect(reply.text).not.toContain('demo123');
    const yaml = yamlFrom(reply.text);
    expect(yaml).toMatch(/do: Click "Add to cart"\n\s+action: \{ click: \{ selector: /);
    expect(yaml).toContain('action: { navigate: /login }');
    expect(yaml).toContain('action: { fill: { role: textbox, name: Username, value: demo } }');
    expect(yaml).toContain('value: "{{secret:PASSWORD}}"');
    expect(yaml).toContain('expect: Both fields are filled in.');
    expect(yaml).toContain('action: { click: { role: button, name: Log in } }');
    const result = validatePlanText(yaml);
    expect(result.ok, JSON.stringify(result)).toBe(true);

    await withPage(async (page) => {
      await waitForPanel(page, 'The agent is working');
    });
  }, 40_000);
});

describe('script export', () => {
  async function runPlan(name: string, expectText: string, status: 'pass' | 'fail') {
    writeFileSync(
      join(project, '.walkthrough', 'plans', `${name}.yaml`),
      `name: ${name}\nmode: autonomous\nsteps:\n  - id: add-mug\n    do: Add the mug\n  - id: open-cart\n    do: Open the cart\n    expect: ${expectText}\n`,
    );
    expect((await mcp.call('run_start', { plan: name })).isError).toBe(false);
    const outline = (await mcp.call('snapshot')).text;
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
    await mcp.call('navigate', { url: '/cart' });
    await mcp.call('run_step', {
      stepId: 'open-cart',
      status,
      actual: status === 'fail' ? 'The total is $10.00.' : undefined,
    });
    await mcp.call('run_finish');
  }

  it('writes a script that passes when the app works', async () => {
    await runPlan('buy', 'The total is $10.00.', 'pass');
    const reply = await mcp.call('export_script', { installedChrome: true });
    expect(reply.text).toContain('Wrote .walkthrough/exports/buy.mjs');
    expect(reply.text).toContain('It has 2 action(s) and 1 text check(s).');
    const { stdout } = await run(
      process.execPath,
      [join(project, '.walkthrough/exports/buy.mjs')],
      {
        cwd: project,
        env: { ...process.env, BASE_URL: demo.base },
      },
    );
    expect(stdout).toContain('ok    2. Open the cart');
    expect(stdout).toContain('Passed: every step and check.');
  }, 60_000);

  it('writes a script that fails at the broken step, and drafts an issue', async () => {
    await runPlan('buy-wrong', 'The total is $99.00.', 'fail');
    const reply = await mcp.call('export_script', { installedChrome: true });
    expect(reply.text).toContain('the script fails there until the bug is fixed: 2. Open the cart');
    const failed = await run(
      process.execPath,
      [join(project, '.walkthrough/exports/buy-wrong.mjs')],
      {
        cwd: project,
        env: { ...process.env, BASE_URL: demo.base },
      },
    ).catch((error: { code: number; stderr: string }) => error);
    expect((failed as { code: number }).code).toBe(1);
    expect((failed as { stderr: string }).stderr).toContain(
      'Failed: Step 2. Open the cart: The page does not show "$99.00".',
    );

    const issue = await mcp.call('issue_draft');
    expect(issue.text).toContain('Title: Open the cart: The total is $10.00.');
    const bodyFile = /Body file: (\S+)/.exec(issue.text)?.[1] as string;
    expect(existsSync(join(project, bodyFile))).toBe(true);
    const body = readFileSync(join(project, bodyFile), 'utf8');
    expect(body).toContain('## Expected\n\nThe total is $99.00.');
    expect(body).toMatch(/3\. Go to http:\/\/localhost:\d+\/cart/);
    expect(issue.text).toMatch(/Screenshots to drag into the issue:\n- \/.+\.png/);
  }, 60_000);
});

describe('screenshots for docs', () => {
  const HELP = `name: Help shots
mode: autonomous
device: laptop
colorScheme: dark
screenshotDir: docs/images/help
steps:
  - id: add-mug
    do: Add the mug
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    screenshot: cart.png
  - id: total
    do: Show the total
    screenshot: { path: total.png, selector: "#cart-total" }
`;
  const shots = () => join(project, 'docs', 'images', 'help');
  // The width of a PNG, from its header.
  const pngWidth = (file: string) => readFileSync(file).readUInt32BE(16);

  it('saves screenshots to exact files during a run', async () => {
    writeFileSync(join(project, '.walkthrough', 'plans', 'help-shots.yaml'), HELP);
    const start = await mcp.call('run_start', { plan: 'help-shots' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain(`screenshot to ${join('docs', 'images', 'help', 'cart.png')}`);
    expect(start.text).toContain('(selector #cart-total)');

    const outline = (await mcp.call('snapshot')).text;
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
    await mcp.call('navigate', { url: '/cart' });

    const blocked = await mcp.call('screenshot', { path: '../outside.png' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('only in the project folder');

    const cart = await mcp.call('screenshot', {
      path: 'docs/images/help/cart.png',
      stepId: 'open-cart',
    });
    expect(cart.text).toContain(`: ${join('docs', 'images', 'help', 'cart.png')}`);
    await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
    await mcp.call('screenshot', {
      path: 'docs/images/help/total.png',
      selector: '#cart-total',
      stepId: 'total',
    });
    await mcp.call('run_step', { stepId: 'total', status: 'pass' });
    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('is finished');

    expect(pngWidth(join(shots(), 'cart.png'))).toBe(1280);
    expect(existsSync(join(shots(), 'total.png'))).toBe(true);
    const runDir = /Reports: (\S+)\/report\.md/.exec(finish.text)?.[1] as string;
    const saved = JSON.parse(readFileSync(join(project, runDir, 'run.json'), 'utf8'));
    expect(saved.emulation).toEqual({ device: 'laptop', colorScheme: 'dark' });
    expect(saved.steps[1].captures).toEqual([{ path: join('docs', 'images', 'help', 'cart.png') }]);
    expect(saved.steps[2].captures).toEqual([
      { path: join('docs', 'images', 'help', 'total.png'), selector: '#cart-total' },
    ]);
  }, 60_000);

  it('exports a script that saves all or some screenshots again', async () => {
    const reply = await mcp.call('export_script', { installedChrome: true });
    expect(reply.text).toContain('It saves 2 screenshot(s)');
    const script = join(project, '.walkthrough/exports/help-shots.mjs');
    const env = { ...process.env, BASE_URL: demo.base };

    rmSync(join(shots(), 'cart.png'));
    const before = statSync(join(shots(), 'total.png')).mtimeMs;
    const one = await run(process.execPath, [script], {
      cwd: project,
      env: { ...env, SHOT: 'cart' },
    });
    expect(one.stdout).toContain(`shot  ${join('docs', 'images', 'help', 'cart.png')}`);
    expect(one.stdout).toContain('Saved 1 screenshot(s).');
    expect(pngWidth(join(shots(), 'cart.png'))).toBe(1280);
    expect(statSync(join(shots(), 'total.png')).mtimeMs).toBe(before);

    const all = await run(process.execPath, [script], { cwd: project, env });
    expect(all.stdout).toContain('Saved 2 screenshot(s).');

    const none = await run(process.execPath, [script], {
      cwd: project,
      env: { ...env, SHOT: 'nothing' },
    }).catch((error: { code: number; stderr: string }) => error);
    expect((none as { code: number }).code).toBe(1);
    expect((none as { stderr: string }).stderr).toContain('SHOT matches no screenshot.');
  }, 60_000);

  it('stops a run when a plan has a screenshot path outside the project', async () => {
    writeFileSync(
      join(project, '.walkthrough', 'plans', 'bad-shots.yaml'),
      'name: Bad shots\nsteps:\n  - id: one\n    do: Open the shop\n    screenshot: ../../x.png\n',
    );
    const check = await mcp.call('plan', { action: 'validate', name: 'bad-shots' });
    expect(check.text).toContain('Step 1 [one]');
    const start = await mcp.call('run_start', { plan: 'bad-shots' });
    expect(start.isError).toBe(true);
    expect(start.text).toContain('only in the project folder');
  });
});
