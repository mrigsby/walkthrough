import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Accessibility scans and reports on the demo app.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;

function makeProject(name: string): string {
  const dir = tempDir(name);
  mkdirSync(join(dir, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(dir, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  return dir;
}

function runCount(dir: string): number {
  const runs = join(dir, '.walkthrough', 'runs');
  return existsSync(runs) ? readdirSync(runs).filter((d) => !d.startsWith('adhoc')).length : 0;
}

beforeAll(async () => {
  demo = await startDemoServer();
  project = makeProject('a11y');
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('a11y-tmp') });
  expect((await mcp.call('browser_open')).isError).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

describe('a11y_scan', () => {
  let runId: string;

  it('checks a list of pages and makes a run with a step for each', async () => {
    const scan = await mcp.call(
      'a11y_scan',
      { urls: ['/', '/login', '/help.html', '/cart'], checks: ['keyboard', 'reflow'] },
      { timeoutMs: 120_000 },
    );
    expect(scan.isError, scan.text).toBe(false);
    expect(scan.text).toContain('Checked 4 page(s) (WCAG 2.2 AA, extra checks: keyboard, reflow).');
    expect(scan.text).toMatch(/- \/: \d+ critical/);
    expect(scan.text).toMatch(/- \/cart: no problems, score 100/);
    expect(scan.text).toMatch(/Score: \d+ of 100 \((Good|Needs work|Poor)\)/);
    runId = /runId "([^"]+)"/.exec(scan.text)?.[1] as string;
    const run = JSON.parse(
      readFileSync(join(project, '.walkthrough', 'runs', runId, 'run.json'), 'utf8'),
    );
    expect(run.status).toBe('finished');
    expect(run.a11yScan).toBeUndefined();
    expect(run.steps.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([
      ['a11y-page', 'fail'],
      ['a11y-login', 'fail'],
      ['a11y-help-html', 'fail'],
      ['a11y-cart', 'pass'],
    ]);
    expect(existsSync(join(project, '.walkthrough', 'runs', runId, 'report.html'))).toBe(true);
  }, 150_000);

  it('returns the findings with IDs, scores, and a digest', async () => {
    const report = await mcp.call('a11y_report', { runId });
    expect(report.isError, report.text).toBe(false);
    expect(report.text).toMatch(/Accessibility findings for the run "Accessibility check"/);
    expect(report.text).toMatch(/Digest: [0-9a-f]{12}/);
    expect(report.text).toMatch(/A11Y-001 \[critical\] /);
    for (const rule of ['button-name', 'image-alt', 'keyboard-trap', 'focus-visible', 'reflow']) {
      expect(report.text, rule).toMatch(new RegExp(`A11Y-\\d{3} \\[\\w+\\] ${rule}:`));
    }
    expect(report.text).toContain('<page-content untrusted="true">');
    expect(report.text).toContain(
      'Then call a11y_report again with runId, digest, summary, and items.',
    );
    // The newest run is the default.
    expect((await mcp.call('a11y_report')).text).toContain(`(${runId})`);
  });

  it('refuses a page on a site that is not allowed, before it opens anything', async () => {
    const before = runCount(project);
    const blocked = await mcp.call('a11y_scan', { urls: ['/', 'https://example.com/'] });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('example.com');
    expect(runCount(project)).toBe(before);
  });

  it('adds steps to a run that is going, then goes back', async () => {
    await mcp.call('run_start', { name: 'Checkout check', mode: 'autonomous' });
    await mcp.call('navigate', { url: '/login' });
    const scan = await mcp.call('a11y_scan', { urls: ['/help.html'], checks: [] });
    expect(scan.isError, scan.text).toBe(false);
    expect(scan.text).not.toContain('Reports:');
    const snap = await mcp.call('snapshot');
    expect(snap.text).toMatch(/URL: \S+\/login/);
    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('Result: 1 failed');
  });

  it('refuses a saved login while a run is going', async () => {
    await mcp.call('run_start', { name: 'Busy', mode: 'autonomous' });
    const scan = await mcp.call('a11y_scan', { urls: ['/'], session: 'demo-user' });
    expect(scan.isError).toBe(true);
    expect(scan.text).toContain('A run is going');
    await mcp.call('run_finish');
  });
});

describe('a11y_scan time limit', () => {
  it('stops at the limit, and goes on with runId', async () => {
    const dir = makeProject('a11y-limit');
    const quick = await startClient({
      UIWALK_PROJECT_DIR: dir,
      TMPDIR: tempDir('a11y-limit-tmp'),
      UIWALK_SCAN_LIMIT_MS: '1',
    });
    try {
      const first = await quick.call('a11y_scan', { urls: ['/login', '/cart'], checks: [] });
      expect(first.isError, first.text).toBe(false);
      expect(first.text).toContain('Checked 1 of 2 pages.');
      const runId = /runId "([^"]+)"/.exec(first.text)?.[1] as string;
      const file = join(dir, '.walkthrough', 'runs', runId, 'run.json');
      expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('incomplete');

      const second = await quick.call('a11y_scan', { runId });
      expect(second.isError, second.text).toBe(false);
      expect(second.text).toContain('Next, call a11y_report');
      const run = JSON.parse(readFileSync(file, 'utf8'));
      expect(run.status).toBe('finished');
      expect(run.steps).toHaveLength(2);
      expect((await quick.call('a11y_scan', { runId })).text).toContain('no pages left');
    } finally {
      await quick.close();
    }
  }, 90_000);
});
