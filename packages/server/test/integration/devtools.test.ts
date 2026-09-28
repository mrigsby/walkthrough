import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { serveFolder } from '../helpers/static-server.js';
import { tempDir } from '../helpers/temp.js';

// Cookies, storage, and Chrome's Issues panel.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let site: Awaited<ReturnType<typeof serveFolder>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let debugPort: number;

// A page with problems that Chrome's Issues panel reports.
const ISSUES_PAGE = `<!doctype html><html lang="en"><head><title>Issues</title></head><body>
<form><label for="missing">Name</label><input type="text" id="real"></form>
<script>document.cookie = 'tracker=1; SameSite=None';</script>
</body></html>`;

beforeAll(async () => {
  demo = await startDemoServer();
  const pages = tempDir('issues-site');
  writeFileSync(join(pages, 'issues.html'), ISSUES_PAGE);
  site = await serveFolder(pages);
  project = tempDir('devtools');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n  - ${site.base}\n`,
  );
  writeFileSync(join(project, '.walkthrough', '.env'), 'DEMO_PASSWORD=demo123\n');
  writeFileSync(
    join(project, '.walkthrough', 'plans', 'logout.yaml'),
    `name: Log out\nmode: autonomous\nsteps:\n  - id: logged-in\n    do: Check the login cookie\n    cookies:\n      - { name: session, httpOnly: true, sameSite: Lax }\n  - id: logged-out\n    do: Log out\n    cookies:\n      - { name: session, exists: false }\n`,
  );
  debugPort = await freePort();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('devtools-tmp'),
    UIWALK_DEBUG_PORT: String(debugPort),
  });
  expect((await mcp.call('browser_open')).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
  site?.stop();
});

async function withChrome<T>(fn: (chrome: Browser) => Promise<T>): Promise<T> {
  const chrome = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
  try {
    return await fn(chrome);
  } finally {
    await chrome.disconnect();
  }
}

async function mainPage(chrome: Browser): Promise<Page> {
  return (await chrome.defaultBrowserContext().pages()).find((p) =>
    p.url().startsWith(demo.base),
  ) as Page;
}

async function snap(): Promise<string> {
  return (await mcp.call('snapshot')).text;
}

async function logIn(): Promise<void> {
  await mcp.call('navigate', { url: '/login' });
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

describe('cookies', () => {
  it('lists cookies with their flags, and hides the values', async () => {
    await logIn();
    const list = await mcp.call('storage', { action: 'list' });
    expect(list.isError, list.text).toBe(false);
    expect(list.text).toMatch(/- session: \*\*\*\* \(36 characters, id [0-9a-f]{4}\)\./);
    expect(list.text).toContain('HttpOnly');
    expect(list.text).toContain('SameSite Lax');
    const value = await withChrome(
      async (chrome) =>
        (await (await mainPage(chrome)).browserContext().cookies()).find(
          (c) => c.name === 'session',
        )?.value,
    );
    expect(value).toBeDefined();
    expect(list.text).not.toContain(value as string);
  });

  it('checks cookies, and explains what failed', async () => {
    const reply = await mcp.call('storage', {
      action: 'check',
      checks: [{ name: 'session', httpOnly: true, secure: true }],
    });
    expect(reply.text).toContain('result: fail');
    expect(reply.text).toContain('HttpOnly is true, Secure is false, not true');
  });

  it('sets, reads, and deletes a cookie of the site', async () => {
    const set = await mcp.call('storage', { action: 'set', name: 'theme', value: 'dark' });
    expect(set.isError, set.text).toBe(false);
    const get = await mcp.call('storage', { action: 'get', name: 'theme' });
    expect(get.text).toMatch(/- theme: \*\*\*\* \(4 characters/);
    const other = await mcp.call('storage', {
      action: 'set',
      name: 'x',
      value: '1',
      domain: 'example.com',
    });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/only sets cookies for the sites under test/);
    await mcp.call('storage', { action: 'delete', name: 'theme' });
    expect((await mcp.call('storage', { action: 'get', name: 'theme' })).text).toMatch(
      /There is no cookie named "theme"/,
    );
  });

  it('clears only the cookies of the sites under test', async () => {
    // A cookie of another site in the same browser.
    await withChrome(async (chrome) =>
      (await mainPage(chrome))
        .browserContext()
        .setCookie({ name: 'elsewhere', value: '1', domain: 'example.org', path: '/' }),
    );
    const list = await mcp.call('storage', { action: 'list' });
    expect(list.text).not.toContain('elsewhere');
    const cleared = await mcp.call('storage', { action: 'clear' });
    expect(cleared.text).toMatch(/Deleted 1 cookie\(s\)/);
    const left = await withChrome(async (chrome) =>
      (await (await mainPage(chrome)).browserContext().cookies()).map((c) => c.name),
    );
    expect(left).toContain('elsewhere');
    expect(left).not.toContain('session');
  });

  it('shows values when config.local.yaml allows it', async () => {
    const local = join(project, '.walkthrough', 'config.local.yaml');
    writeFileSync(local, 'allowSecretValues: true\n');
    await mcp.call('doctor');
    await mcp.call('storage', { action: 'set', name: 'theme', value: 'dark' });
    expect((await mcp.call('storage', { action: 'get', name: 'theme' })).text).toContain(
      '- theme: "dark".',
    );
    rmSync(local);
    await mcp.call('doctor');
    expect((await mcp.call('storage', { action: 'get', name: 'theme' })).text).toContain('****');
  });
});

describe('local and session storage', () => {
  it('lists, sets, and clears localStorage', async () => {
    await mcp.call('navigate', { url: '/' });
    const outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    const list = await mcp.call('storage', { action: 'list', kind: 'local' });
    expect(list.text).toMatch(/- cart: \*\*\*\*/);
    await mcp.call('storage', { action: 'set', kind: 'local', name: 'note', value: 'hi' });
    expect((await mcp.call('storage', { action: 'list', kind: 'local' })).text).toContain(
      '- note:',
    );
    await mcp.call('storage', { action: 'clear', kind: 'local' });
    expect((await mcp.call('storage', { action: 'list', kind: 'local' })).text).toContain(
      'is empty',
    );
  });

  it('clears the site data of one login only', async () => {
    await mcp.call('navigate', { url: '/?tab=main' });
    let outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('tabs', { action: 'new', url: '/?tab=guest', name: 'guest', isolated: true });
    outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    const cleared = await mcp.call('storage', { action: 'clearSiteData' });
    expect(cleared.isError, cleared.text).toBe(false);
    expect((await mcp.call('storage', { action: 'list', kind: 'local' })).text).toContain(
      'is empty',
    );
    await mcp.call('tabs', { action: 'close', id: 'guest' });
    expect((await mcp.call('storage', { action: 'list', kind: 'local' })).text).toMatch(/- cart:/);
  });
});

describe('cookie checks in a plan', () => {
  it('checks the plan step with its stepId', async () => {
    await logIn();
    const start = await mcp.call('run_start', { plan: 'logout' });
    expect(start.text).toContain('(agent checks, cookie check)');
    expect(start.text).toContain('Cookies: session is set, HttpOnly true, SameSite Lax');
    const first = await mcp.call('storage', { action: 'check', stepId: 'logged-in' });
    expect(first.text).toContain('result: pass');
    await mcp.call('run_step', { stepId: 'logged-in', status: 'pass' });
    const outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Log out') });
    await mcp.call('wait_for', { ms: 500 });
    const second = await mcp.call('storage', { action: 'check', stepId: 'logged-out' });
    expect(second.text).toContain('result: pass');
    expect(second.text).toContain('"session" is not set');
    await mcp.call('run_step', { stepId: 'logged-out', status: 'pass' });
    expect((await mcp.call('run_finish')).isError).toBe(false);
  });
});

describe('Chrome issues', () => {
  it('shows blocked cookies and form problems in the logs, once per step', async () => {
    await mcp.call('run_start', { name: 'Issues' });
    await mcp.call('navigate', { url: `${site.base}/issues.html` });
    await mcp.call('navigate', { action: 'reload' });
    await mcp.call('wait_for', { ms: 500 });
    const logs = await mcp.call('logs', { kinds: ['issue'] });
    expect(logs.text).toContain('Chrome blocked the cookie "tracker" when the page set it for');
    expect(logs.text).toContain('A label "for" attribute points to an id that does not exist');
    expect(logs.text.match(/points to an id that does not exist/g)).toHaveLength(1);
    const consoleOnly = await mcp.call('logs', { kinds: ['console'] });
    expect(consoleOnly.text).not.toContain('tracker');
    await mcp.call('run_finish');
  });
});
