import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Devices, saved logins, visual checks, and accessibility audits.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let debugPort: number;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('quality');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  writeFileSync(join(project, '.walkthrough', '.env'), 'DEMO_PASSWORD=demo123\n');
  debugPort = await freePort();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('quality-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_PORT: String(debugPort),
  });
  expect((await mcp.call('browser_open')).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

// Runs code on the demo tab with the test's own Puppeteer, then disconnects.
// A connection that stays open can reset the server's network settings.
async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const chrome: Browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${debugPort}`,
    defaultViewport: null,
  });
  try {
    const pages = await chrome.pages();
    return await fn(pages.find((p) => p.url().startsWith(demo.base)) as Page);
  } finally {
    await chrome.disconnect();
  }
}

async function snap(): Promise<string> {
  return (await mcp.call('snapshot')).text;
}

describe('devices', () => {
  it('emulates a phone in dark mode, then goes back', async () => {
    const reply = await mcp.call('emulate', { device: 'mobile', colorScheme: 'dark' });
    expect(reply.text).toContain('Now: device: mobile, color scheme: dark, network: normal.');
    expect(reply.text).toMatch(/Reloaded t1/);
    const phone = await withPage((p) =>
      p.evaluate(() => ({
        width: window.innerWidth,
        agent: navigator.userAgent,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      })),
    );
    expect(phone).toEqual({ width: 393, agent: expect.stringContaining('iPhone'), dark: true });

    await mcp.call('emulate', { device: 'default', colorScheme: 'system' });
    const desktop = await withPage((p) =>
      p.evaluate(() => ({ width: window.innerWidth, agent: navigator.userAgent })),
    );
    expect(desktop.width).toBe(1280);
    expect(desktop.agent).not.toContain('iPhone');
  });

  it('can go offline and back', async () => {
    await mcp.call('emulate', { network: 'offline' });
    const offline = await mcp.call('navigate', { url: '/cart' });
    expect(offline.isError).toBe(true);
    await mcp.call('emulate', { network: 'normal' });
    expect((await mcp.call('navigate', { url: '/cart' })).isError).toBe(false);
  });
});

describe('saved logins', () => {
  it('saves a login and starts logged in next time', async () => {
    await mcp.call('navigate', { url: '/' });
    let outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('navigate', { url: '/login' });
    outline = await snap();
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

    const saved = await mcp.call('session', { action: 'save', name: 'demo-user' });
    expect(saved.text).toMatch(
      /Saved the login "demo-user" for http:\/\/localhost:\d+: 1 cookie\(s\) and 1 storage value\(s\)/,
    );
    const file = join(project, '.walkthrough', 'sessions', 'demo-user.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('"name": "session"');
    // The agent never sees the cookie value.
    const cookie = JSON.parse(readFileSync(file, 'utf8')).cookies[0].value;
    expect(saved.text).not.toContain(cookie);
    expect((await mcp.call('session', { action: 'list' })).text).toContain('- demo-user: saved');

    await mcp.call('browser_close');
    const open = await mcp.call('browser_open', { url: '/account', session: 'demo-user' });
    expect(open.text).toContain('Loaded the saved login "demo-user".');
    outline = await snap();
    expect(outline).toContain('Logged in as');
    expect(outline).toContain('Cart (1)');
  });
});

describe('visual checks', () => {
  it('creates a baseline, matches it, and finds a change', async () => {
    await mcp.call('navigate', { url: '/' });
    const first = await mcp.call('visual_check', { name: 'shop' });
    expect(first.text).toMatch(/^result: created/);
    expect(
      existsSync(
        join(project, `.walkthrough/baselines/adhoc/shop@default-${process.platform}.png`),
      ),
    ).toBe(true);
    expect((await mcp.call('visual_check', { name: 'shop' })).text).toMatch(/^result: match/);

    await withPage((p) =>
      p.evaluate(() => {
        const h1 = document.querySelector('h1');
        if (h1) h1.style.color = 'rgb(220, 0, 0)';
      }),
    );
    const changed = await mcp.call('visual_check', { name: 'shop' });
    expect(changed.text).toMatch(/^result: mismatch/);
    expect(changed.text).toMatch(/Diff image \(changed pixels in red\): \S+-diff\.png/);
    expect(changed.images).toBe(1);

    // Masked parts do not count.
    expect((await mcp.call('visual_check', { name: 'shop', mask: ['h1'] })).text).toMatch(
      /^result: match/,
    );
    expect((await mcp.call('visual_check', { name: 'shop', updateBaseline: true })).text).toMatch(
      /^result: updated/,
    );
  });
});

describe('accessibility', () => {
  it('finds the planted problems and skips the panel', async () => {
    await mcp.call('navigate', { url: '/' });
    const shop = await mcp.call('a11y_audit');
    expect(shop.text).toMatch(/- image-alt: Images must have alternative text \(1 element\)/);
    expect(shop.text).not.toContain('uiwalk-panel');

    await mcp.call('navigate', { url: '/cart' });
    const cart = await mcp.call('a11y_audit', { selector: '.coupon' });
    expect(cart.text).toContain('Checked: ".coupon" at');
    expect(cart.text).toMatch(/label: Form elements must have labels/);
  });

  it('checks one element from a ref, even with a Puppeteer-only selector', async () => {
    await mcp.call('navigate', { url: '/' });
    const snap = await mcp.call('snapshot');
    const ref = refFor(snap.text, 'link', 'Account');
    const part = await mcp.call('a11y_audit', { ref });
    expect(part.isError, part.text).toBe(false);
    expect(part.text).toContain('Checked: "::-p-aria(');
    expect(await withPage((p) => p.$$eval('[data-uiwalk-a11y]', (els) => els.length))).toBe(0);
  });

  it('shows elements inside a shadow root with >>>', async () => {
    await mcp.call('navigate', { url: '/help.html' });
    const help = await mcp.call('a11y_audit');
    expect(help.text).toContain('help-feedback >>> input: ');
  });

  it('refuses a stepId when no run is going', async () => {
    const result = await mcp.call('a11y_audit', { stepId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No run is going');
  });
});

describe('plans with Phase 5 keys', () => {
  it('runs a plan with a device, a color scheme, and a saved login', async () => {
    writeFileSync(
      join(project, '.walkthrough', 'plans', 'phone.yaml'),
      'name: Phone account\ndevice: mobile\ncolorScheme: dark\nsession: demo-user\nsteps:\n  - id: account\n    do: Open the account page\n    visual: true\n',
    );
    const start = await mcp.call('run_start', { plan: 'phone' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('(agent checks, visual check) Open the account page');
    expect(start.text).toContain('Loaded the saved login "demo-user".');
    await mcp.call('navigate', { url: '/account' });
    expect(await withPage(async (p) => p.url())).toContain('/account');
    const wrong = await mcp.call('a11y_audit', { stepId: 'not-a-step' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('The plan has no step "not-a-step"');
    await mcp.call('a11y_audit', { stepId: 'account' });
    await mcp.call('run_step', { stepId: 'account', status: 'pass' });
    const finish = await mcp.call('run_finish');
    const report = /Reports: (\S+) and/.exec(finish.text)?.[1] as string;
    const md = readFileSync(join(project, report), 'utf8');
    expect(md).toContain(
      '- **Setup:** device: mobile, color scheme: dark, network: normal, saved login: demo-user',
    );
    expect(md).toContain('## Accessibility');
    expect(md).toMatch(/- \*\*Accessibility:\*\* /);
  });
});
