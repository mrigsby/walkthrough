import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import {
  clickPanel,
  fakeClickPanel,
  panelText,
  typeNotes,
  waitForPanel,
} from '../helpers/panel.js';
import { tempDir } from '../helpers/temp.js';

// Tests the developer panel: questions, answers, evidence, and safety.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let chrome: Browser;
let page: Page;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('panel');
  mkdirSync(join(project, '.walkthrough'));
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\naskTimeoutSec: 10\nhighlightMs: 50\n`,
  );
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('panel-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_PORT: String(debugPort),
  });
  const open = await mcp.call('browser_open');
  expect(open.isError, open.text).toBe(false);
  // The test connects to the same Chrome, to click the panel like a person.
  chrome = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
  const pages = await chrome.pages();
  page = pages.find((p) => p.url().startsWith(demo.base)) as Page;
  expect(page).toBeDefined();
}, 60_000);

afterAll(async () => {
  await chrome?.disconnect();
  await mcp?.close();
  demo?.stop();
});

async function snap(): Promise<string> {
  return (await mcp.call('snapshot')).text;
}

function ask(args: Record<string, unknown>) {
  return mcp.call('ask_developer', {
    title: 'Check',
    didWhat: 'Did a thing.',
    expected: 'A result.',
    ...args,
  });
}

describe('developer panel', () => {
  it('is on the page but hidden from the page and the agent', async () => {
    await waitForPanel(page, 'Walkthrough');
    // No binding or panel object in the page's own scripts.
    const globals = await page.evaluate(() =>
      Object.keys(window).filter((k) => k.toLowerCase().includes('uiwalk')),
    );
    expect(globals).toEqual([]);
    expect(await page.$eval('uiwalk-panel', (el) => el.getAttribute('aria-hidden'))).toBe('true');
    expect(await page.$eval('uiwalk-panel', (el) => el.shadowRoot)).toBeNull();
    // The snapshot does not show the panel buttons.
    const outline = await snap();
    expect(outline).not.toMatch(/button "Pass"/);
    expect(outline).not.toContain('What you should see');
  });

  it('asks a question and returns Pass', async () => {
    const reply = ask({
      title: 'Open the shop',
      didWhat: 'I opened the shop.',
      expected: 'You see three products.',
      step: 1,
      total: 3,
    });
    const shown = await waitForPanel(page, 'You see three products.');
    expect(shown).toMatch(/^ASKING/);
    expect(shown).toContain('Step 1 of 3');
    await clickPanel(page, 'pass');
    const result = await reply;
    expect(result.text).toMatch(/^status: pass/);
    expect(result.text).toContain('Developer notes: (none)');
    expect(await waitForPanel(page, 'Sent: Pass')).not.toMatch(/^ASKING/);
  });

  it('needs notes for a bug, then saves a screenshot and the step errors', async () => {
    let outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('navigate', { url: '/cart' });
    outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Apply coupon') });

    const reply = ask({
      title: 'Apply coupon',
      didWhat: 'I clicked Apply coupon.',
      expected: 'A message says the coupon is applied.',
      stepId: 'coupon',
    });
    await waitForPanel(page, 'Apply coupon');
    await clickPanel(page, 'bug');
    await waitForPanel(page, 'Describe the bug in the notes');
    await typeNotes(page, 'Nothing happens when I click it.');
    await clickPanel(page, 'bug');

    const result = await reply;
    expect(result.text).toMatch(/^status: bug/);
    expect(result.text).toContain('Developer notes: Nothing happens when I click it.');
    expect(result.text).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(result.text).toContain('step "coupon"');
    expect(result.images).toBe(1);
    const shot = /Screenshot: (\S+)/.exec(result.text)?.[1] as string;
    expect(existsSync(join(project, shot))).toBe(true);
  });

  it('shows failed requests in logs', async () => {
    await mcp.call('navigate', { url: '/' });
    const outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Check stock') });
    const logs = await mcp.call('logs');
    expect(logs.text).toMatch(/GET http:\/\/localhost:\d+\/api\/stock\?id=\w+ returned HTTP 500/);
    expect(logs.text).toMatch(/Latest marker: \d+/);
  });

  it('ignores fake clicks from page scripts', async () => {
    const reply = ask({ title: 'Fake click', expected: 'Nothing yet.' });
    await waitForPanel(page, 'Fake click');
    await fakeClickPanel(page, 'pass');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await panelText(page)).toMatch(/^ASKING/);
    await clickPanel(page, 'skip');
    expect((await reply).text).toMatch(/^status: skip/);
  });

  it('keeps the question after a timeout and after a page load', async () => {
    const first = await ask({ title: 'Slow answer', expected: 'Wait for it.' });
    expect(first.text).toMatch(/^status: waiting/);
    expect(await panelText(page)).toContain('Slow answer');

    // The page loads again. The question must come back.
    await page.goto(`${demo.base}/cart`);
    await waitForPanel(page, 'Slow answer');

    const resumed = mcp.call('ask_developer', { resume: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clickPanel(page, 'pass');
    expect((await resumed).text).toMatch(/^status: pass/);
  }, 30_000);

  it('puts the panel back if the app removes it', async () => {
    await page.evaluate(() => document.querySelector('uiwalk-panel')?.remove());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await page.$('uiwalk-panel')).not.toBeNull();
  });

  it('clears the question when the agent cancels', async () => {
    const controller = new AbortController();
    const call = mcp.client.callTool(
      { name: 'ask_developer', arguments: { title: 'Cancel me', didWhat: 'x', expected: 'y' } },
      undefined,
      { signal: controller.signal },
    );
    await waitForPanel(page, 'Cancel me');
    controller.abort();
    await expect(call).rejects.toThrow();
    await waitForPanel(page, 'The agent stopped waiting');
    expect(await panelText(page)).not.toMatch(/^ASKING/);
  });

  it('does not let the agent act on the panel', async () => {
    const reply = await mcp.call('act', { action: 'click', selector: 'uiwalk-panel' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/part of the Walkthrough panel/);
  });

  it('marks an element in a screenshot', async () => {
    await mcp.call('navigate', { url: '/' });
    const outline = await snap();
    const reply = await mcp.call('screenshot', {
      ref: refFor(outline, 'link', 'Help'),
      annotate: true,
      label: 'help link',
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toMatch(/the visible page, with link "Help" \[e\d+\] marked/);
    expect(reply.images).toBe(1);
  });
});

describe('ask_developer without a panel', () => {
  it('asks the agent to use chat when the browser is hidden', async () => {
    const quiet = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir('nopanel-tmp'),
    });
    try {
      await quiet.call('browser_open');
      const reply = await quiet.call('ask_developer', {
        title: 'Check',
        didWhat: 'x',
        expected: 'y',
      });
      expect(reply.text).toMatch(/^status: use_chat/);
      expect(reply.text).toContain('headless');
    } finally {
      await quiet.close();
    }
  });
});
