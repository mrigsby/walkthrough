import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLighthouse } from '../../src/downloads/lighthouse.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
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

  it('checks pages in a tab of the same login, and keeps the login', async () => {
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
    for (const f of before.findings as Array<{ id: string; audit: string }>)
      expect(first).toContain(`${f.id} [`);
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
