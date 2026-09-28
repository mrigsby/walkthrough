import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLighthouse } from '../../src/downloads/lighthouse.js';
import { freePort, repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { panelHidden } from '../helpers/panel.js';
import { serveFolder } from '../helpers/static-server.js';
import { tempDir } from '../helpers/temp.js';

// Lighthouse reports. These tests need "uiwalk setup lighthouse". Without it they skip.
const installed = Boolean(findLighthouse());
if (!installed) console.warn('Lighthouse is not installed, so the Lighthouse tests skip.');

let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('lighthouse');
  mkdirSync(join(project, '.walkthrough'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n  - http://127.0.0.1:*\n`,
  );
  writeFileSync(join(project, '.walkthrough', '.env'), 'DEMO_PASSWORD=demo123\n');
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('lighthouse-tmp') });
  expect((await mcp.call('browser_open')).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

const runDir = (id: string) => join(project, '.walkthrough', 'runs', id);

async function reportFor(runId: string): Promise<string> {
  const first = await mcp.call('lighthouse_report', { runId }, { timeoutMs: 60_000 });
  const digest = /Digest: (\w+)/.exec(first.text)?.[1];
  const ids = [...first.text.matchAll(/^(LH-\d{3}) /gm)].map((m) => m[1] as string);
  const second = await mcp.call(
    'lighthouse_report',
    {
      runId,
      digest,
      summary: 'The pages are fast. Some images need alt text.',
      items: ids.map((id) => ({ id, explain: 'It is not right yet.', fix: 'Change the page.' })),
    },
    { timeoutMs: 60_000 },
  );
  expect(second.isError, second.text).toBe(false);
  return first.text;
}

describe.skipIf(!installed)('lighthouse', () => {
  let runId: string;

  it('checks each page in its own Chrome, with a copy of the login', async () => {
    await mcp.call('navigate', { url: '/login' });
    const outline = (await mcp.call('snapshot')).text;
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

    const reply = await mcp.call(
      'lighthouse',
      { urls: ['/', '/help.html'] },
      { timeoutMs: 120_000 },
    );
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toMatch(/- \/: Performance \d+, Best Practices \d+, SEO \d+/);
    runId = /runId "([^"]+)"/.exec(reply.text)?.[1] as string;
    expect(existsSync(join(runDir(runId), 'lighthouse', '01-home.report.html'))).toBe(true);
    expect(existsSync(join(runDir(runId), 'lighthouse', '02-help-html.report.json'))).toBe(true);
    // The home page asks /api/me. A logged-in answer has the user's name.
    const lhr = JSON.parse(
      readFileSync(join(runDir(runId), 'lighthouse', '01-home.report.json'), 'utf8'),
    );
    const me = lhr.audits['network-requests'].details.items.find((i: { url: string }) =>
      i.url.endsWith('/api/me'),
    );
    expect(me.resourceSize).toBeGreaterThan(10);
    const stillIn = await mcp.call('storage', { action: 'check', checks: [{ name: 'session' }] });
    expect(stillIn.text).toContain('result: pass');
    expect((await mcp.call('tabs')).text).not.toContain('t2');
  }, 150_000);

  it('writes the report in two calls, and refuses a wrong digest', async () => {
    const wrong = await mcp.call('lighthouse_report', {
      runId,
      digest: 'nope',
      items: [{ id: 'LH-001', explain: 'x', fix: 'y' }],
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/findings changed after the first call/);
    const first = await reportFor(runId);
    expect(first).toMatch(/LH-001 \[/);
    // Each page has its own Chrome, so each one finds the missing favicon.
    expect(first).toMatch(/errors-in-console: .* on 2 page\(s\)/);
    for (const file of ['lighthouse.html', 'lighthouse.md', 'lighthouse.json'])
      expect(existsSync(join(runDir(runId), file)), file).toBe(true);
    expect(readFileSync(join(runDir(runId), 'report.html'), 'utf8')).toContain(
      'href="lighthouse.html"',
    );
    expect(readFileSync(join(runDir(runId), 'lighthouse.md'), 'utf8')).toContain(
      '/walkthrough:lighthouse / /help.html',
    );
  }, 120_000);

  it('keeps the issue IDs in the next report', async () => {
    const before = JSON.parse(readFileSync(join(runDir(runId), 'lighthouse.json'), 'utf8'));
    const reply = await mcp.call(
      'lighthouse',
      { urls: ['/', '/help.html'] },
      { timeoutMs: 120_000 },
    );
    const next = /runId "([^"]+)"/.exec(reply.text)?.[1] as string;
    const first = await reportFor(next);
    expect(first).toContain(`Compared with the report of run ${runId}`);
    type Finding = { id: string; audit: string };
    const after = JSON.parse(readFileSync(join(runDir(next), 'lighthouse.json'), 'utf8'));
    // Timing audits can pass in one run and fail in the next. An issue in both keeps its ID.
    for (const f of after.findings as Finding[]) {
      const old = (before.findings as Finding[]).find((b) => b.audit === f.audit);
      if (old) expect(f.id, f.audit).toBe(old.id);
    }
    // Issues that do not depend on timing are in both reports.
    for (const audit of ['image-alt', 'errors-in-console'])
      expect((after.findings as Finding[]).map((f) => f.audit)).toContain(audit);
  }, 150_000);

  it('makes a report page that passes axe in light and dark mode', async () => {
    const files = await serveFolder(runDir(runId));
    try {
      await mcp.call('navigate', { url: `${files.base}/lighthouse.html` });
      const audit = await mcp.call('a11y_audit', { checks: ['darkMode'] });
      expect(audit.text).toMatch(/: 0 problem type\(s\), 0 element\(s\)\./);
      expect(audit.text).toContain('Dark mode: no contrast problems');
    } finally {
      files.stop();
    }
  }, 60_000);
});

describe.skipIf(!installed)('lighthouse flows in a run', () => {
  let flowMcp: Awaited<ReturnType<typeof startClient>>;
  let chrome: Browser;
  let page: Page;
  let runId: string;
  let debugPort: number;

  // The test connects to the same Chrome, to see the panel.
  async function connect(): Promise<void> {
    await chrome?.disconnect();
    chrome = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debugPort}`,
      defaultViewport: null,
    });
    page = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
  }

  beforeAll(async () => {
    mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'examples/demo-app/.walkthrough/plans/performance.yaml'),
      join(project, '.walkthrough', 'plans', 'performance.yaml'),
    );
    debugPort = await freePort();
    flowMcp = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir('lighthouse-flow-tmp'),
      UIWALK_FORCE_PANEL: '1',
      UIWALK_DEBUG_PORT: String(debugPort),
    });
    expect((await flowMcp.call('browser_open')).isError).toBe(false);
  }, 60_000);

  afterAll(async () => {
    await chrome?.disconnect();
    await flowMcp?.close();
  });

  it('works only in a run, and a timespan needs its categories', async () => {
    const none = await flowMcp.call('lighthouse', { action: 'snapshot' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('work only during a run');
    await flowMcp.call('run_start', { name: 'Ad hoc flow', mode: 'autonomous' });
    const span = await flowMcp.call('lighthouse', { action: 'start', categories: ['seo'] });
    expect(span.isError).toBe(true);
    expect(span.text).toMatch(/A timespan step measures only Performance and Best Practices/);
    await flowMcp.call('run_finish');
  }, 60_000);

  it('runs the demo plan with a navigation, a timespan, and a snapshot', async () => {
    const start = await flowMcp.call('run_start', { plan: 'performance' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('(agent checks, Lighthouse navigation) Open the shop page');
    expect(start.text).toContain(
      'Lighthouse loads this page: call lighthouse with action navigate',
    );
    runId = /Run folder: \S+runs[/\\](\S+)/.exec(start.text)?.[1] as string;
    // Earlier pages must not change the results, so the run has a new browser.
    expect(start.text).toContain('Closed the open browser, to start from an empty profile.');
    expect(start.text).toContain('The run started in a new browser');
    await connect();

    const nav = await flowMcp.call(
      'lighthouse',
      { action: 'navigate', stepId: 'open-shop' },
      { timeoutMs: 90_000 },
    );
    expect(nav.isError, nav.text).toBe(false);
    expect(nav.text).toMatch(/measured the step open-shop \(navigation\) on \//);
    expect(nav.text).toMatch(/Performance \d+, Best Practices \d+, SEO \d+/);
    expect(await panelHidden(page)).toBe(false);
    await flowMcp.call('run_step', { stepId: 'open-shop', status: 'pass' });

    const begin = await flowMcp.call('lighthouse', { action: 'start', stepId: 'add-mug' });
    expect(begin.isError, begin.text).toBe(false);
    expect(await panelHidden(page)).toBe(true);
    await flowMcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
    await flowMcp.call('navigate', { url: '/cart' });
    // A new page in the tab starts with the panel hidden.
    expect(await panelHidden(page)).toBe(true);
    const busy = await flowMcp.call('lighthouse', { action: 'snapshot' });
    expect(busy.text).toContain('Call lighthouse with action end first');
    const end = await flowMcp.call('lighthouse', { action: 'end' }, { timeoutMs: 90_000 });
    expect(end.isError, end.text).toBe(false);
    expect(end.text).toMatch(/measured the step add-mug \(timespan\) on \/cart/);
    expect(end.text).toMatch(/Performance \d+ of \d+ audits passed/);
    expect(await panelHidden(page)).toBe(false);
    await flowMcp.call('run_step', { stepId: 'add-mug', status: 'pass' });

    await flowMcp.call('act', { action: 'click', selector: '#checkout-button' });
    await flowMcp.call('wait_for', { url: '/checkout' });
    const snap = await flowMcp.call(
      'lighthouse',
      { action: 'snapshot', stepId: 'open-checkout' },
      { timeoutMs: 60_000 },
    );
    expect(snap.isError, snap.text).toBe(false);
    await flowMcp.call('run_step', { stepId: 'open-checkout', status: 'pass' });

    const finish = await flowMcp.call('run_finish');
    expect(finish.text).toContain('This plan asks for a Lighthouse report');
    expect(finish.text).toContain('lighthouse/flow.report.html');
    const flowHtml = readFileSync(join(runDir(runId), 'lighthouse', 'flow.report.html'), 'utf8');
    for (const name of ['Open the shop page', 'Click \\"Checkout\\"'])
      expect(flowHtml).toContain(name);
    const run = JSON.parse(readFileSync(join(runDir(runId), 'run.json'), 'utf8'));
    // Lighthouse loaded the first page, so the step keeps a navigate action for exports.
    expect(run.steps[0].actions[0]).toMatchObject({ action: 'navigate' });
    expect(run.lighthouse.map((c: { mode: string }) => c.mode)).toEqual([
      'navigation',
      'timespan',
      'snapshot',
    ]);
    const report = readFileSync(join(runDir(runId), 'report.html'), 'utf8');
    expect(report).toContain('href="lighthouse/flow.report.html"');
    expect(report).toMatch(/<dt>Lighthouse<\/dt><dd>timespan: Performance \d+\/\d+ audits passed/);
  }, 240_000);

  it('finds the same issues when the plan runs again', async () => {
    const start = await flowMcp.call('run_start', { plan: 'performance' });
    const again = /Run folder: \S+runs[/\\](\S+)/.exec(start.text)?.[1] as string;
    await flowMcp.call(
      'lighthouse',
      { action: 'navigate', stepId: 'open-shop' },
      { timeoutMs: 90_000 },
    );
    await flowMcp.call('run_finish');
    const audits = (id: string) =>
      JSON.parse(readFileSync(join(runDir(id), 'run.json'), 'utf8')).lighthouse[0].audits.map(
        (a: { id: string }) => a.id,
      );
    // Before, Chrome remembered the missing favicon, so the second run missed its error.
    expect(audits(runId)).toContain('errors-in-console');
    expect(audits(again)).toContain('errors-in-console');
  }, 120_000);

  it('writes the flow report, which asks to run the plan again', async () => {
    const first = await flowMcp.call('lighthouse_report', { runId }, { timeoutMs: 60_000 });
    expect(first.text).toMatch(/- add-mug: timespan \/cart: Performance \d+ of \d+ audits passed/);
    const digest = /Digest: (\w+)/.exec(first.text)?.[1];
    const second = await flowMcp.call('lighthouse_report', { runId, digest, items: [] });
    expect(second.isError, second.text).toBe(false);
    const md = readFileSync(join(runDir(runId), 'lighthouse.md'), 'utf8');
    expect(md).toContain('/walkthrough:lighthouse performance again');
    expect(md).toContain('Flow steps ran in the test tab');
    expect(md).toMatch(/\| open-checkout: snapshot \/checkout \| \d+\/\d+ \|/);
  }, 120_000);

  it('makes a flow report page that passes axe in light and dark mode', async () => {
    const files = await serveFolder(runDir(runId));
    try {
      await flowMcp.call('navigate', { url: `${files.base}/lighthouse.html` });
      const audit = await flowMcp.call('a11y_audit', { checks: ['darkMode'] });
      expect(audit.text).toMatch(/: 0 problem type\(s\), 0 element\(s\)\./);
      expect(audit.text).toContain('Dark mode: no contrast problems');
    } finally {
      files.stop();
    }
  }, 60_000);
});

describe('without Lighthouse', () => {
  it('explains how to install it', async () => {
    const other = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir('lighthouse-none-tmp'),
      UIWALK_CACHE_DIR: tempDir('empty-cache'),
    });
    try {
      const status = await other.call('lighthouse', { action: 'status' });
      expect(status.text).toMatch(
        /Lighthouse is not installed\. To install it \(about 170 MB\), run: .* setup lighthouse/,
      );
      const audit = await other.call('lighthouse', { urls: ['/'] });
      expect(audit.isError).toBe(true);
      expect(audit.text).toContain('setup lighthouse');
    } finally {
      await other.close();
    }
  }, 60_000);
});
