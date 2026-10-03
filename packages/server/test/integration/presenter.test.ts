import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { waitForStage } from '../helpers/stage.js';
import { tempDir } from '../helpers/temp.js';

// The presenter window: its controls, the chat, and the protected environment check.
const PRESENTER = 'http://uiwalk-presenter.localhost';

const TOUR = `name: Presenter tour
presentation:
  timeBudget: 5m
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: The mug and the cart }
    notes: |
      Welcome to the **demo**.
      - Ask who uses the cart.
  - id: add-mug
    do: Add the mug
    action: { click: { selector: '[data-add="mug"]' } }
    notes: The count changes without a page load.
    timeBudget: 45s
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
`;

let demo: Awaited<ReturnType<typeof startDemoServer>>;

beforeAll(async () => {
  demo = await startDemoServer();
}, 30_000);

afterAll(() => demo?.stop());

// A project with the tour plan. Production is the same shop on another host name.
function makeProject(name: string): string {
  const project = tempDir(name);
  const folder = join(project, '.walkthrough');
  mkdirSync(join(folder, 'plans'), { recursive: true });
  const production = demo.base.replace('localhost', '127.0.0.1');
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins: [${demo.base}]\nenvironments:\n  production:\n    baseUrl: ${production}\n`,
  );
  writeFileSync(join(folder, 'plans', 'tour.yaml'), TOUR);
  return project;
}

async function start(name: string, env: Record<string, string> = {}) {
  const chromeFile = endpointFile();
  const mcp = await startClient({
    UIWALK_PROJECT_DIR: makeProject(name),
    TMPDIR: tempDir(`${name}-tmp`),
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
    ...env,
  });
  // The rehearsal, on development.
  await mcp.call('run_start', { plan: 'tour', mode: 'autonomous' });
  await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
  await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
  await mcp.call('navigate', { url: '/cart' });
  await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
  const finish = await mcp.call('run_finish', {});
  const runId = /runs\/([^/\s]+)\/report/.exec(finish.text)?.[1] as string;
  return { mcp, chromeFile, runId };
}

async function findPage(chrome: Browser, prefix: string): Promise<Page> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const found = (await chrome.pages()).find((p) => p.url().startsWith(prefix));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No page at ${prefix}`);
}

async function text(page: Page, part: string): Promise<string> {
  return page.$eval(`[data-part="${part}"]`, (el) => (el as HTMLElement).innerText);
}

async function waitText(page: Page, part: string, want: RegExp): Promise<string> {
  const end = Date.now() + 10_000;
  let last = '';
  while (Date.now() < end) {
    last = await text(page, part).catch(() => '');
    if (want.test(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`"${part}" never matched ${want}. Last: ${last}`);
}

describe('the presenter window', () => {
  let mcp: Awaited<ReturnType<typeof startClient>>;
  let chrome: Browser;
  let presenter: Page;
  let audience: Page;

  const until = async (want: RegExp) => {
    const end = Date.now() + 20_000;
    let last = '';
    while (Date.now() < end) {
      last = (await mcp.call('present', { action: 'status' })).text;
      if (want.test(last)) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`The status never matched ${want}. Last: ${last}`);
  };

  beforeAll(async () => {
    const started = await start('presenter');
    mcp = started.mcp;
    const reply = await mcp.call('present', { action: 'start', plan: 'tour' });
    expect(reply.isError, reply.text).toBe(false);
    chrome = await connectChrome(started.chromeFile, { defaultViewport: null });
    presenter = await findPage(chrome, PRESENTER);
    audience = await findPage(chrome, demo.base);
  }, 90_000);

  afterAll(async () => {
    await chrome?.disconnect();
    await mcp?.call('present', { action: 'stop' }).catch(() => undefined);
    await mcp?.close();
  });

  it('opens apart from the tools, with the notes of the first step', async () => {
    const tabs = await mcp.call('tabs', { action: 'list' });
    expect(tabs.isError, tabs.text).toBe(false);
    expect(tabs.text).not.toContain('uiwalk-presenter');
    expect(tabs.text.match(/^t\d+/gm)).toHaveLength(1);
    expect((await mcp.call('present', { action: 'status' })).text).toContain(
      'The presenter window is open.',
    );
    await waitText(presenter, 'notes', /Welcome to the demo/);
    // A "- " line is a list item.
    expect(await presenter.$eval('[data-part="notes"] li', (el) => el.textContent)).toBe(
      'Ask who uses the cart.',
    );
  });

  it('starts, and goes on with its buttons and keys', async () => {
    await presenter.click('[data-act="start"]');
    await until(/State: gate, at step 1 of 3/);
    await waitText(presenter, 'step-title', /^Show the agenda$/);
    await presenter.keyboard.press('ArrowRight');
    await until(/State: gate, at step 2 of 3/);
    await waitText(presenter, 'step-title', /^Add the mug$/);
    await waitText(presenter, 'step-time', /of 0:45/);
    expect(await presenter.$eval('[data-step="1"]', (el) => el.className)).toContain('done');
  }, 30_000);

  it('ignores clicks from a script, and cannot leave its page', async () => {
    await presenter.evaluate(() =>
      (document.querySelector('[data-act="continue"]') as HTMLElement).click(),
    );
    await presenter.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await new Promise((r) => setTimeout(r, 800));
    expect((await mcp.call('present', { action: 'status' })).text).toMatch(/at step 2 of 3/);
    expect(presenter.url()).toBe(`${PRESENTER}/`);
  });

  it('shows a live mirror of the audience screen', async () => {
    const end = Date.now() + 10_000;
    let src = '';
    while (Date.now() < end && !src.startsWith('data:image/jpeg')) {
      src = await presenter.$eval('[data-part="mirror"]', (el) => (el as HTMLImageElement).src);
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(src).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('sends a chat question to the agent, and shows the answer on the screen', async () => {
    await presenter.type('[data-part="chat-input"]', 'Where does the count come from?');
    await presenter.keyboard.press('Enter');
    await waitText(presenter, 'chat-status', /not listening now\. Your question waits/);
    const heard = await mcp.call('present', { action: 'listen' });
    expect(heard.text).toContain('status: question');
    expect(heard.text).toContain('Where does the count come from?');
    await waitText(presenter, 'chat-status', /Claude is thinking/);
    await mcp.call('present', {
      action: 'answer',
      id: 'q1',
      text: 'From the cart in the browser.',
    });
    await waitText(presenter, 'chat', /From the cart in the browser\./);
    await presenter.click('[data-act="show-q1"]');
    await waitForStage(audience, 'caption', (p) => p.text === 'From the cart in the browser.');
    await waitText(presenter, 'chat', /On the screen/);
  }, 30_000);

  it('blanks the screen and shows the title from its buttons', async () => {
    await presenter.click('[data-act="blank"]');
    await waitForStage(audience, 'cover', (p) => p.shown);
    await presenter.click('[data-act="blank"]');
    await waitForStage(audience, 'cover', (p) => !p.shown);
    await presenter.click('[data-act="title"]');
    await waitForStage(audience, 'slide', (p) => p.text.includes('Presenter tour'));
    await presenter.click('[data-act="title"]');
    await waitForStage(audience, 'slide', (p) => !p.shown);
  }, 30_000);

  it('opens again after the presenter closes it', async () => {
    await presenter.close();
    await until(/The presenter window is closed/);
    const again = await mcp.call('present', { action: 'control', command: 'presenter' });
    expect(again.text).toContain('The presenter window is open again.');
    presenter = await findPage(chrome, PRESENTER);
    await waitText(presenter, 'step-title', /^Add the mug$/);
  }, 30_000);

  it('ends when the audience window closes', async () => {
    await audience.close();
    const heard = await mcp.call('present', { action: 'listen' });
    expect(heard.text).toContain('status: ended');
  }, 30_000);
});

describe('a protected environment', () => {
  let mcp: Awaited<ReturnType<typeof startClient>>;
  let chrome: Browser;

  afterAll(async () => {
    await chrome?.disconnect();
    await mcp?.call('present', { action: 'stop' }).catch(() => undefined);
    await mcp?.close();
  });

  it('opens the app only after the presenter confirms it', async () => {
    const started = await start('presenter-prod');
    mcp = started.mcp;
    const production = demo.base.replace('localhost', '127.0.0.1');
    const reply = await mcp.call('present', {
      action: 'start',
      plan: 'tour',
      environment: 'production',
      runId: started.runId,
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('The presenter must confirm it in the presenter window');
    // The agent cannot confirm it.
    const agent = await mcp.call('present', { action: 'control', command: 'start' });
    expect(agent.isError).toBe(true);
    expect(agent.text).toContain('must first confirm the protected environment "production"');

    chrome = await connectChrome(started.chromeFile, { defaultViewport: null });
    const presenter = await findPage(chrome, PRESENTER);
    await presenter.waitForSelector('[data-part="confirm"]:not([hidden])');
    expect(await text(presenter, 'confirm')).toContain('Present on Production?');
    const before = (await chrome.pages()).map((p) => p.url());
    expect(before.some((url) => url.startsWith(production))).toBe(false);

    await presenter.click('[data-act="confirm"]');
    const audience = await findPage(chrome, production);
    expect(audience.url()).toContain('127.0.0.1');
    await presenter.waitForSelector('[data-part="confirm"][hidden]');
    const go = await mcp.call('present', { action: 'control', command: 'start' });
    expect(go.isError, go.text).toBe(false);
  }, 90_000);
});
