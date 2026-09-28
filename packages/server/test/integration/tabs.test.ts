import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// New tabs, separate logins, and settings for each tab.
const run = promisify(execFile);
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let chromeFile: string;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('tabs');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  writeFileSync(join(project, '.walkthrough', '.env'), 'DEMO_PASSWORD=demo123\n');
  // The exported script imports puppeteer-core from the project.
  symlinkSync(join(repoRoot, 'node_modules'), join(project, 'node_modules'));
  chromeFile = endpointFile();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('tabs-tmp'),
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
  });
  expect((await mcp.call('browser_open', { url: '/?tab=main' })).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

// Runs code in the tab whose address has this text, then disconnects.
async function inTab<T>(part: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const chrome: Browser = await connectChrome(chromeFile, { defaultViewport: null });
  try {
    const pages = (await Promise.all(chrome.browserContexts().map((c) => c.pages()))).flat();
    const page = pages.find((p) => p.url().includes(part));
    if (!page) throw new Error(`No tab at ${part}: ${pages.map((p) => p.url()).join(', ')}`);
    return await fn(page);
  } finally {
    await chrome.disconnect();
  }
}

async function snap(): Promise<string> {
  return (await mcp.call('snapshot')).text;
}

async function logIn(): Promise<void> {
  const outline = await snap();
  await mcp.call('act', {
    action: 'fill',
    ref: refFor(outline, 'textbox', 'Username'),
    value: 'demo',
  });
  await mcp.call('act', {
    action: 'fill',
    ref: refFor(outline, 'textbox', 'Password'),
    value: '{{secret:DEMO_PASSWORD}}',
  });
  await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Log in') });
  await mcp.call('wait_for', { url: '/account' });
}

describe('tabs and logins', () => {
  it('opens a tab with a login of its own', async () => {
    const outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    const opened = await mcp.call('tabs', {
      action: 'new',
      url: '/cart?tab=guest',
      name: 'guest',
      isolated: true,
    });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toMatch(/Its login is "iso-[0-9a-f]{4}"/);
    expect(opened.text).toContain('isolated: "iso-');
    expect(await snap()).toContain('Your cart is empty.');
    const list = await mcp.call('tabs');
    expect(list.text).toMatch(/t2 "guest" \(active, login iso-[0-9a-f]{4}\)/);
    await mcp.call('tabs', { action: 'switch', id: 'main' });
    await mcp.call('navigate', { url: '/cart?tab=main' });
    expect(await snap()).toContain('Coffee Mug');
  });

  it('shares a named login between tabs, and keeps it apart from the main login', async () => {
    await mcp.call('tabs', {
      action: 'new',
      url: '/login?tab=c1',
      name: 'customer',
      isolated: 'shop-user',
    });
    await logIn();
    const second = await mcp.call('tabs', {
      action: 'new',
      url: '/account?tab=c2',
      name: 'customer-2',
      isolated: 'shop-user',
    });
    expect(second.text).toContain('Its login is "shop-user"');
    expect(await snap()).toContain('Logged in as');
    await mcp.call('tabs', { action: 'switch', id: 'main' });
    await mcp.call('navigate', { url: '/account?tab=main' });
    expect(await snap()).toContain('to see your account');
  });

  it('refuses a tab name that is taken or looks like an id', async () => {
    const taken = await mcp.call('tabs', { action: 'new', name: 'guest' });
    expect(taken.isError).toBe(true);
    expect(taken.text).toMatch(/already open/);
    const id = await mcp.call('tabs', { action: 'new', name: 't9' });
    expect(id.isError).toBe(true);
    expect(id.text).toMatch(/tab ids/);
  });

  it('gives a popup the login of the tab that opened it, and names it on switch', async () => {
    await mcp.call('tabs', { action: 'switch', id: 'customer' });
    await mcp.call('navigate', { url: '/?tab=c1' });
    const outline = await snap();
    const click = await mcp.call('act', { action: 'click', ref: refFor(outline, 'link', 'Help') });
    expect(click.text).toMatch(/A new tab opened: t\d+/);
    const list = await mcp.call('tabs');
    expect(list.text).toMatch(/t\d+ \(login shop-user, opened by t\d+\): "[^"]*" .*help\.html/);
    const switched = await mcp.call('tabs', { action: 'switch', id: 'newest', name: 'help' });
    expect(switched.isError, switched.text).toBe(false);
    expect((await mcp.call('tabs')).text).toMatch(/"help" \(active, login shop-user/);
    await mcp.call('tabs', { action: 'close', id: 'help' });
  });
});

describe('settings for each tab', () => {
  it('emulates a phone in one tab only', async () => {
    await mcp.call('tabs', { action: 'switch', id: 'guest' });
    const reply = await mcp.call('emulate', { device: 'mobile' });
    expect(reply.text).toContain('Tab t2 now: device: mobile');
    expect(await inTab('tab=guest', (p) => p.evaluate(() => innerWidth))).toBe(393);
    expect(await inTab('tab=main', (p) => p.evaluate(() => innerWidth))).toBe(1280);
  });

  it('sets the time zone, locale, color, motion, and print media', async () => {
    await mcp.call('tabs', { action: 'switch', id: 'main' });
    const reply = await mcp.call('emulate', {
      timezone: 'Asia/Tokyo',
      locale: 'de-DE',
      colorScheme: 'dark',
      cpu: 4,
    });
    expect(reply.text).toContain('CPU: 4x slower');
    expect(reply.text).toContain('time zone: Asia/Tokyo');
    await mcp.call('emulate', { reducedMotion: 'reduce', media: 'print' });
    const main = await inTab('tab=main', (p) =>
      p.evaluate(() => ({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        number: new Intl.NumberFormat().format(1234.5),
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        print: matchMedia('print').matches,
      })),
    );
    expect(main).toEqual({
      zone: 'Asia/Tokyo',
      number: '1.234,5',
      dark: true,
      motion: true,
      print: true,
    });
    const guest = await inTab('tab=guest', (p) =>
      p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
    expect(guest).not.toBe('Asia/Tokyo');
    await mcp.call('emulate', {
      timezone: 'system',
      locale: 'system',
      colorScheme: 'system',
      reducedMotion: 'system',
      media: 'screen',
      cpu: 1,
    });
  });

  it('refuses a time zone that does not exist', async () => {
    const reply = await mcp.call('emulate', { timezone: 'Mars/Olympus' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/not a time zone/);
  });

  it('sets permissions and a place for the whole login', async () => {
    await mcp.call('tabs', { action: 'switch', id: 'customer' });
    const reply = await mcp.call('emulate', {
      permissions: { notifications: 'grant' },
      geolocation: { latitude: 52.52, longitude: 13.4 },
    });
    expect(reply.text).toContain('Permissions apply to every tab of the login "shop-user".');
    const notice = (p: Page) => p.evaluate(() => Notification.permission);
    expect(await inTab('tab=c2', notice)).toBe('granted');
    expect(await inTab('tab=main', notice)).toBe('default');
    const place = await inTab('tab=c1', (p) =>
      p.evaluate(
        () =>
          new Promise<number[]>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(
              (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
              reject,
            ),
          ),
      ),
    );
    expect(place).toEqual([52.52, 13.4]);
  });

  it('applies allTabs settings to every tab and to new tabs', async () => {
    await mcp.call('emulate', { colorScheme: 'dark', allTabs: true });
    await mcp.call('tabs', { action: 'new', url: '/?tab=late', name: 'late' });
    const dark = (p: Page) => p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
    expect(await inTab('tab=late', dark)).toBe(true);
    expect(await inTab('tab=guest', dark)).toBe(true);
    await mcp.call('emulate', { colorScheme: 'system', allTabs: true });
    await mcp.call('tabs', { action: 'close', id: 'late' });
  });
});

describe('export with tabs', () => {
  it('writes a script that repeats tabs, logins, and settings', async () => {
    await mcp.call('tabs', { action: 'switch', id: 'main' });
    await mcp.call('navigate', { url: '/' });
    const start = await mcp.call('run_start', { name: 'Two tabs' });
    expect(start.isError, start.text).toBe(false);
    let outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('tabs', { action: 'new', url: '/cart', name: 'buyer', isolated: 'buyer' });
    await mcp.call('emulate', { device: 'mobile', timezone: 'Europe/Berlin' });
    await mcp.call('wait_for', { text: 'Your cart is empty.' });
    await mcp.call('tabs', { action: 'switch', id: 'main' });
    await mcp.call('navigate', { url: '/cart' });
    outline = await snap();
    expect(outline).toContain('Coffee Mug');
    await mcp.call('run_step', { title: 'Carts stay apart', status: 'pass' });
    const finish = await mcp.call('run_finish');
    const runId = /Run folder: \S*runs\/(\S+)/.exec(start.text)?.[1] as string;
    expect(finish.isError, finish.text).toBe(false);

    const exported = await mcp.call('export_script', { runId, installedChrome: true });
    expect(exported.isError, exported.text).toBe(false);
    const script = /\.walkthrough\/exports\/\S+\.mjs/.exec(exported.text)?.[0] as string;
    const code = readFileSync(join(project, script), 'utf8');
    expect(code).toContain('page = await openTab("buyer", "buyer");');
    expect(code).toContain('"timezone":"Europe/Berlin"');
    expect(code).toContain('page = tabs["main"];');
    expect(code).not.toContain('Fix by hand');
    const result = await run(process.execPath, [join(project, script)], {
      env: { ...process.env, BASE_URL: demo.base },
      timeout: 60_000,
    });
    expect(result.stdout).toContain('Passed: every step and check.');
  }, 120_000);
});

describe('no tabs left', () => {
  // Like a developer who closes every window while Chrome keeps running.
  async function closeEveryTab(): Promise<void> {
    const chrome: Browser = await connectChrome(chromeFile);
    try {
      for (const context of chrome.browserContexts())
        for (const page of await context.pages()) await page.close();
    } finally {
      await chrome.disconnect();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  it('opens a new tab with navigate or browser_open', async () => {
    await closeEveryTab();
    const list = await mcp.call('tabs');
    expect(list.text).toContain('No tab is open.');
    const snapshot = await mcp.call('snapshot');
    expect(snapshot.isError).toBe(true);
    expect(snapshot.text).toMatch(/Call browser_open, or navigate with a url/);

    const go = await mcp.call('navigate', { url: '/cart' });
    expect(go.isError, go.text).toBe(false);
    expect(go.text).toContain('No tab was open, so Walkthrough opened a new one.');
    expect((await mcp.call('tabs')).text).toMatch(/"main" \(active[^)]*\): "Demo Shop"/);

    await closeEveryTab();
    const open = await mcp.call('browser_open');
    expect(open.isError, open.text).toBe(false);
    expect(open.text).toContain('No tab was open, so Walkthrough opened a new one.');
    expect(open.text).toContain('Demo Shop');
  });
});
