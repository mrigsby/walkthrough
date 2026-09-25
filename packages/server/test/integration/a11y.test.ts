import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { serveFolder } from '../helpers/static-server.js';
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
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - http://localhost:*\n  - http://127.0.0.1:*\n`,
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

let runId: string;

describe('a11y_scan', () => {
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

describe('a11y_report', () => {
  const dir = () => join(project, '.walkthrough', 'runs', runId);
  let digest: string;
  let ids: Record<string, string>;

  it('refuses text without the right digest, or with an unknown ID', async () => {
    const first = await mcp.call('a11y_report', { runId });
    digest = /Digest: ([0-9a-f]{12})/.exec(first.text)?.[1] as string;
    ids = Object.fromEntries(
      [...first.text.matchAll(/(A11Y-\d{3}) \[\w+\] ([\w-]+):/g)].map((m) => [m[2], m[1]]),
    );
    const item = { id: ids['button-name'], explain: 'x', fix: 'y' };
    const wrong = await mcp.call('a11y_report', { runId, digest: 'abc', items: [item] });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('The findings changed after the first call');
    expect(wrong.text).toContain(`Digest: ${digest}`);
    const bad = await mcp.call('a11y_report', {
      runId,
      digest,
      items: [{ id: 'A11Y-999', explain: 'x', fix: 'y' }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('There is no issue A11Y-999 in this run.');
  });

  it('writes accessibility.html, .md, and .json next to report.html', async () => {
    const reply = await mcp.call('a11y_report', {
      runId,
      digest,
      summary: 'The shop has buttons with no name and a keyboard trap. Fix those first.',
      items: [
        {
          id: ids['button-name'],
          explain: 'The heart buttons have an icon but no name. Screen readers say only "button".',
          fix: 'Add `aria-label="Add to wishlist"` to each heart button.',
          code: '<button class="wish" aria-label="Add to wishlist">',
          where: [{ file: '.walkthrough/config.yaml', line: 1 }, { file: '../outside.js' }],
        },
        {
          id: ids['keyboard-trap'],
          explain: 'Tab cannot leave the Get deals email field.',
          fix: 'Remove the keydown handler that blocks the Tab key.',
        },
      ],
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain(`- .walkthrough/runs/${runId}/accessibility.html`);
    expect(reply.text).toContain('left out "../outside.js"');
    expect(reply.text).toMatch(/No text for A11Y-\d{3}/);
    expect(reply.text).toContain(`Read .walkthrough/runs/${runId}/accessibility.md.`);
    expect(reply.text).toContain('run /walkthrough:a11y / /login /help.html /cart again.');

    const html = readFileSync(join(dir(), 'accessibility.html'), 'utf8');
    expect(html).toContain(
      'Add <code>aria-label=&#34;Add to wishlist&#34;</code> to each heart button.',
    );
    expect(html).toContain('<code>.walkthrough/config.yaml:1</code>');
    expect(html).toContain('This text comes from axe-core.');
    expect(html).toContain("script-src 'nonce-");
    const md = readFileSync(join(dir(), 'accessibility.md'), 'utf8');
    expect(md).toContain('## How to use this file');
    expect(md).toMatch(/```page-data\nselector: /);
    expect(md).toContain('**Where to fix:** `.walkthrough/config.yaml:1`');
    const json = JSON.parse(readFileSync(join(dir(), 'accessibility.json'), 'utf8'));
    expect(json.findings.find((f: { rule: string }) => f.rule === 'button-name').where).toEqual([
      { file: '.walkthrough/config.yaml', line: 1 },
    ]);
    expect(readFileSync(join(dir(), 'report.html'), 'utf8')).toContain(
      '<a href="accessibility.html">Accessibility report</a>',
    );
    expect((await mcp.call('runs')).text).toContain('accessibility report written');
  });

  it('keeps the IDs in the next report, and marks what is still there', async () => {
    const scan = await mcp.call(
      'a11y_scan',
      { urls: ['/', '/login', '/help.html', '/cart'], checks: ['keyboard', 'reflow'] },
      { timeoutMs: 120_000 },
    );
    const next = /runId "([^"]+)"/.exec(scan.text)?.[1] as string;
    const again = await mcp.call('a11y_report', { runId: next });
    expect(again.text).toContain(`Compared with the report of run ${runId}`);
    expect(again.text).toContain('Fixed since then: 0 issue(s).');
    for (const [rule, id] of Object.entries(ids)) {
      expect(again.text, rule).toContain(`${id} [`);
      expect(again.text).toMatch(new RegExp(`${id} \\[\\w+\\] ${rule}:`));
    }
  }, 150_000);

  it('makes reports that pass axe themselves, in light and dark mode', async () => {
    const files = await serveFolder(dir());
    try {
      for (const page of ['accessibility.html', 'report.html']) {
        await mcp.call('navigate', { url: `${files.base}/${page}` });
        const audit = await mcp.call('a11y_audit', { checks: ['darkMode'] });
        expect(audit.text, page).toMatch(/: 0 problem type\(s\), 0 element\(s\)\./);
        expect(audit.text, page).toContain('Dark mode: no contrast problems');
      }
    } finally {
      files.stop();
    }
  }, 60_000);
});

describe('plans with accessibility checks', () => {
  it('checks the plan steps and asks for the report at the end', async () => {
    writeFileSync(
      join(project, '.walkthrough', 'plans', 'a11y.yaml'),
      [
        'name: A11y plan',
        'mode: autonomous',
        'accessibility:',
        '  report: true',
        '  checks: { keyboard: false, darkMode: false, reflow: false, screenshots: false }',
        'steps:',
        '  - id: add-mug',
        '    do: Add the mug',
        '    action: { click: { selector: \'[data-add="mug"]\' } }',
        '  - id: checkout',
        '    do: Open the checkout page',
        '    action: { navigate: /checkout }',
        '    a11y: true',
        '  - id: login',
        '    do: Open the login page',
        '    action: { navigate: /login }',
        '    a11y: { checks: [keyboard] }',
        '',
      ].join('\n'),
    );
    await mcp.call('navigate', { url: '/' });
    const start = await mcp.call('run_start', { plan: 'a11y' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('(agent checks, accessibility check) Open the checkout page');
    expect(start.text).toContain('(agent checks, accessibility check (checks: keyboard))');
    expect(start.text).toContain('call a11y_audit with stepId set to the step id');

    await mcp.call('navigate', { url: '/' });
    await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
    await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
    await mcp.call('navigate', { url: '/checkout' });
    await mcp.call('wait_for', { text: 'Card details' }).catch(() => undefined);
    // The plan turns frames on (the default) and the other checks off.
    const checkout = await mcp.call('a11y_audit', { stepId: 'checkout' });
    expect(checkout.text).toContain('in frame iframe: input[name="holder"]');
    expect(checkout.text).not.toContain('Keyboard:');
    await mcp.call('run_step', { stepId: 'checkout', status: 'fail' });
    await mcp.call('navigate', { url: '/login' });
    const login = await mcp.call('a11y_audit', { stepId: 'login' });
    expect(login.text).toContain('Keyboard: ');
    await mcp.call('run_step', { stepId: 'login', status: 'fail' });
    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('This plan asks for an accessibility report.');

    const first = await mcp.call('a11y_report');
    expect(first.text).toMatch(/A11Y-\d{3} \[critical\] label:/);
    const digest = /Digest: ([0-9a-f]{12})/.exec(first.text)?.[1] as string;
    const done = await mcp.call('a11y_report', { digest, summary: 'Two pages.', items: [] });
    expect(done.isError, done.text).toBe(false);
    // A plan run: the prompt checks the plan again.
    expect(done.text).toContain('run /walkthrough:a11y a11y again.');
  }, 120_000);
});

describe('comparing reports', () => {
  it('lists an issue as fixed after the fix', async () => {
    // A copy of the demo site, with the heart buttons fixed.
    const site = tempDir('fixed-site');
    cpSync(join(repoRoot, 'examples/demo-app/site'), site, { recursive: true });
    const app = join(site, 'app.js');
    writeFileSync(
      app,
      readFileSync(app, 'utf8').replace(
        'class="wish" data-wish=',
        'class="wish" aria-label="Add to wishlist" data-wish=',
      ),
    );
    const fixedDemo = await startDemoServer(site);
    const dir = makeProject('a11y-compare');
    const client = await startClient({ UIWALK_PROJECT_DIR: dir, TMPDIR: tempDir('compare-tmp') });
    try {
      const writeReport = async (url: string) => {
        const scan = await client.call('a11y_scan', { urls: [url], checks: [] });
        expect(scan.isError, scan.text).toBe(false);
        const first = await client.call('a11y_report');
        const digest = /Digest: ([0-9a-f]{12})/.exec(first.text)?.[1] as string;
        await client.call('a11y_report', { digest, summary: 'Shop.', items: [] });
        return first.text;
      };
      const before = await writeReport(`${demo.base}/`);
      const buttonId = /(A11Y-\d{3}) \[critical\] button-name:/.exec(before)?.[1] as string;
      const imageId = /(A11Y-\d{3}) \[critical\] image-alt:/.exec(before)?.[1] as string;

      const after = await writeReport(`${fixedDemo.base}/`);
      expect(after).toContain('Fixed since then: 1 issue(s).');
      expect(after).not.toContain('button-name:');
      expect(after).toContain(`${imageId} [critical] image-alt:`);

      const runs = readdirSync(join(dir, '.walkthrough', 'runs')).sort();
      const html = readFileSync(
        join(dir, '.walkthrough', 'runs', runs.at(-1) as string, 'accessibility.html'),
        'utf8',
      );
      expect(html).toContain('Fixed since the last report');
      expect(html).toContain(`<strong>${buttonId}</strong> Buttons must have discernible text`);
      expect(html).toContain('Still there');
    } finally {
      await client.close();
      fixedDemo.stop();
    }
  }, 120_000);
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
