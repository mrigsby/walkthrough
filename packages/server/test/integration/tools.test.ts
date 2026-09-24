import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Drives the bundled server over MCP against the demo shop, like an agent would.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let serverTmp: string;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('project');
  mkdirSync(join(project, '.walkthrough'));
  mkdirSync(join(project, 'fixtures'));
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  writeFileSync(join(project, '.walkthrough', '.env'), 'DEMO_PASSWORD=demo123\n');
  copyFileSync(
    join(repoRoot, 'examples/demo-app/fixtures/avatar.svg'),
    join(project, 'fixtures', 'avatar.svg'),
  );
  // Chrome profiles for this test go here, so the test only ever stops its own Chrome.
  serverTmp = tempDir('servertmp');
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: serverTmp });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

async function snap(): Promise<string> {
  const reply = await mcp.call('snapshot');
  expect(reply.isError, reply.text).toBe(false);
  return reply.text;
}

describe('uiwalk tools', () => {
  it('lists the tools', async () => {
    const { tools } = await mcp.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'a11y_audit',
        'act',
        'ask_developer',
        'browser_close',
        'browser_open',
        'dialog',
        'emulate',
        'export_script',
        'doctor',
        'evaluate',
        'init_project',
        'issue_draft',
        'logs',
        'navigate',
        'plan',
        'read',
        'record',
        'run_finish',
        'run_start',
        'run_step',
        'runs',
        'screenshot',
        'session',
        'snapshot',
        'tabs',
        'visual_check',
        'wait_for',
      ].sort(),
    );
  });

  it('reports setup with doctor', async () => {
    const reply = await mcp.call('doctor');
    expect(reply.text).toContain(project);
    expect(reply.text).toContain('UIWALK_PROJECT_DIR');
    expect(reply.text).toContain('DEMO_PASSWORD');
    expect(reply.text).not.toContain('demo123');
  });

  it('asks for browser_open first', async () => {
    const reply = await mcp.call('snapshot');
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/browser_open/);
  });

  it('opens the base URL and outlines the page', async () => {
    const open = await mcp.call('browser_open');
    expect(open.isError, open.text).toBe(false);
    expect(open.text).toMatch(/Opened Chrome/);
    expect(open.text).toContain('Demo Shop');
    const outline = await snap();
    expect(outline).toContain('<page-content untrusted="true">');
    expect(outline).toMatch(/\[e\d+\] link "Shop"/);
    expect(outline).toMatch(/\[e\d+\] button "Add to cart"/);
    // The cap image has no alt text. The outline must say it is there.
    expect(outline).toContain('1 visible image has no alt text');
  });

  it('logs in with a secret that the agent never sees', async () => {
    await mcp.call('navigate', { url: '/login' });
    const outline = await snap();
    const user = await mcp.call('act', {
      action: 'fill',
      ref: refFor(outline, 'textbox', 'Username'),
      value: 'demo',
    });
    expect(user.text).toMatch(/Filled textbox "Username"/);
    const pass = await mcp.call('act', {
      action: 'fill',
      ref: refFor(outline, 'textbox', 'Password'),
      value: '{{secret:DEMO_PASSWORD}}',
    });
    expect(pass.isError, pass.text).toBe(false);
    expect(pass.text).toContain('****');
    expect(pass.text).not.toContain('demo123');

    const click = await mcp.call('act', {
      action: 'click',
      ref: refFor(outline, 'button', 'Log in'),
    });
    expect(click.text).toMatch(/Selector: /);
    await mcp.call('wait_for', { url: '/account' });
    expect(await snap()).toContain('Demo User');

    // The old ref is from the login page, so it must not work now.
    const stale = await mcp.call('act', {
      action: 'click',
      ref: refFor(outline, 'button', 'Log in'),
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/new snapshot/);
  });

  it('keeps evaluate off', async () => {
    const reply = await mcp.call('evaluate', { script: 'document.title' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/off for safety/);
  });

  it('blocks sites that are not allowed', async () => {
    const reply = await mcp.call('navigate', { url: 'https://example.com' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/not in the allowed list/);

    const outline = await snap();
    const click = await mcp.call('act', {
      action: 'click',
      ref: refFor(outline, 'link', 'Visit example.com'),
    });
    // On a busy machine, the note can come with the next reply instead.
    const tabs = await mcp.call('tabs');
    expect(`${click.text}\n${tabs.text}`).toMatch(
      /blocked the tab from opening https:\/\/example\.com/,
    );
    expect(tabs.text).toContain(demo.base);
    expect(tabs.text).not.toContain('example.com');
  });

  it('follows a new tab', async () => {
    await mcp.call('navigate', { url: '/' });
    const outline = await snap();
    const click = await mcp.call('act', { action: 'click', ref: refFor(outline, 'link', 'Help') });
    // On a busy machine, the new tab can show up a moment later.
    let list = await mcp.call('tabs');
    for (let i = 0; i < 20 && !list.text.includes('t2 ('); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      list = await mcp.call('tabs');
    }
    try {
      expect(`${click.text}\n${list.text}`).toMatch(/new tab opened: t2|t2 \(opened by t1\)/);
      expect(list.text).toMatch(/t2 \(opened by t1\)/);
      await mcp.call('tabs', { action: 'switch', id: 't2' });
      await mcp.call('wait_for', { text: 'Demo login' });
      expect(await snap()).toContain('heading "Help"');
    } finally {
      // Always close the extra tab, so a failure here does not break the next test.
      await mcp.call('tabs', { action: 'switch', id: 't1' });
      const closed = await mcp.call('tabs', { action: 'close', id: 't2' });
      expect(closed.text).toMatch(/active tab is t1/);
    }
  });

  it('checks out through the iframe, a select, and a confirm dialog', async () => {
    await mcp.call('navigate', { url: '/' });
    let outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('navigate', { url: '/checkout' });
    outline = await snap();
    await mcp.call('act', {
      action: 'fill',
      ref: refFor(outline, 'textbox', 'Full name'),
      value: 'Test Person',
    });
    await mcp.call('act', {
      action: 'fill',
      ref: refFor(outline, 'textbox', 'Email'),
      value: 't@example.com',
    });
    await mcp.call('act', {
      action: 'fill',
      ref: refFor(outline, 'textbox', 'Address'),
      value: '1 Main St',
    });
    const select = await mcp.call('act', {
      action: 'select',
      ref: refFor(outline, 'combobox', 'Delivery'),
      value: 'Express ($5.00)',
    });
    expect(select.text).toMatch(/value "express"/);
    await mcp.call('act', { action: 'check', ref: refFor(outline, 'checkbox', 'This is a gift') });

    // The card form is inside an iframe.
    await mcp.call('act', {
      action: 'fill',
      ref: refFor(outline, 'textbox', 'Card number'),
      value: '4242424242424242',
    });
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Save card') });
    await mcp.call('wait_for', { text: 'Card ending in 4242 is ready' });

    outline = await snap();
    const place = await mcp.call('act', {
      action: 'click',
      ref: refFor(outline, 'button', 'Place order'),
    });
    expect(place.text).toMatch(/dialog_pending/);
    expect(place.text).toContain('Place this order?');

    const blocked = await mcp.call('snapshot');
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/confirm dialog is open/);

    const answer = await mcp.call('dialog', { action: 'accept' });
    expect(answer.isError, answer.text).toBe(false);
    await mcp.call('wait_for', { url: '/order/' });
    expect(await snap()).toContain('Thank you');
  });

  it('uploads a project file but not a secret file', async () => {
    await mcp.call('navigate', { url: '/account' });
    const ok = await mcp.call('act', {
      action: 'upload',
      selector: '#avatar-input',
      files: ['fixtures/avatar.svg'],
    });
    expect(ok.isError, ok.text).toBe(false);
    await mcp.call('wait_for', { text: 'Uploaded avatar.svg' });
    const read = await mcp.call('read', { selector: '#avatar-status' });
    expect(read.text).toMatch(/Uploaded avatar\.svg/);

    const denied = await mcp.call('act', {
      action: 'upload',
      selector: '#avatar-input',
      files: ['.walkthrough/.env'],
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/hidden or private/);
  });

  it('saves a screenshot with a preview', async () => {
    const reply = await mcp.call('screenshot', { label: 'account page' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.images).toBe(1);
    const path = /Saved a screenshot of the visible page: (\S+)/.exec(reply.text)?.[1];
    expect(path).toBeDefined();
    expect(existsSync(join(project, path as string))).toBe(true);
    expect(existsSync(join(project, '.walkthrough', '.gitignore'))).toBe(true);
  });

  it('explains when the developer closes the browser', async () => {
    // Stop only the Chrome that uses this test's temp folder.
    execSync(`pkill -KILL -f "${serverTmp}" || true`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const reply = await mcp.call('snapshot');
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/browser was closed.*browser_open/);

    const again = await mcp.call('browser_open');
    expect(again.isError, again.text).toBe(false);
    expect(again.text).toMatch(/Opened Chrome/);
  });

  it('closes the browser', async () => {
    const reply = await mcp.call('browser_close');
    expect(reply.text).toBe('Closed the browser.');
    const after = await mcp.call('snapshot');
    expect(after.isError).toBe(true);
  });
});
