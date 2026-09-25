import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore } from '../../src/guards/secrets.js';
import { safeHref } from '../../src/report/common.js';
import { htmlReport } from '../../src/report/html.js';
import { markdownReport } from '../../src/report/markdown.js';
import { type Run, RunStore } from '../../src/run/run-store.js';
import { writeReports } from '../../src/tools/run-tools.js';
import { tempDir } from '../helpers/temp.js';

const run: Run = {
  version: 1,
  id: 'r1',
  name: 'Checkout flow',
  planFile: '.walkthrough/plans/checkout.yaml',
  mode: 'checkpoints',
  status: 'finished',
  startedAt: '2026-09-24T10:00:00.000Z',
  endedAt: '2026-09-24T10:02:05.000Z',
  baseUrl: 'http://localhost:4321',
  chrome: 'Chrome/154',
  steps: [
    {
      id: 'add-mug',
      index: 1,
      title: 'Add the mug',
      confirm: false,
      status: 'pass',
      checkedBy: 'agent',
      screenshots: [],
      actions: [],
    },
    {
      id: 'check-total',
      index: 2,
      title: 'Read the cart total',
      expect: 'The total is $30.00.',
      confirm: true,
      status: 'bug',
      checkedBy: 'developer',
      notes: 'It says $40.00 <b>not</b> $30.00',
      screenshots: ['screenshots/missing.png'],
      logs: '#3 [error] page-error in t1: TypeError: x',
      actions: [{ action: 'click', label: 'link "Cart (2)" [e5]', url: 'http://localhost:4321/' }],
    },
    {
      id: 'pay',
      index: 3,
      title: 'Pay',
      confirm: false,
      status: 'pending',
      screenshots: [],
      actions: [],
    },
  ],
};

describe('reports', () => {
  it('writes a Markdown report with bugs first and repro steps', () => {
    const md = markdownReport(run);
    expect(md).toContain('# Walkthrough report: Checkout flow');
    expect(md).toContain('- **Result:** 1 passed, 1 bug, 1 not run');
    expect(md).toContain('- **Time:** 2 min 5 s');
    expect(md.indexOf('## Bugs and failures')).toBeLessThan(md.indexOf('## All steps'));
    expect(md).toContain(
      '1. Open http://localhost:4321\n2. Add the mug\n3. Click link "Cart (2)" [e5]',
    );
    expect(md).toContain('![Step 2 screenshot](screenshots/missing.png)');
    expect(md).toContain('TypeError: x');
    expect(md).toContain('| 3 | Pay | Not run |');
  });

  it('writes an HTML report that escapes page and note text', () => {
    const html = htmlReport(run, '/nowhere');
    expect(html).toContain('<title>Walkthrough report: Checkout flow</title>');
    expect(html).toContain('It says $40.00 &#60;b&#62;not&#60;/b&#62; $30.00');
    expect(html).not.toContain('<b>not</b>');
    expect(html).toContain('Screenshot missing: screenshots/missing.png');
    expect(html).toContain('<details class="step bug" open>');
  });

  it('shows accessibility problems safely in both reports', () => {
    const withA11y: Run = {
      ...run,
      accessibility: [
        {
          at: '2026-09-24T10:01:00.000Z',
          stepId: 'add-mug',
          url: 'http://localhost:4321/?q=a|b',
          scope: '#x',
          violations: [
            {
              id: 'image-alt',
              impact: 'critical',
              help: 'Images need <alt> | text',
              helpUrl: 'javascript:alert(1)',
              nodes: [{ target: 'img', html: '<img>' }],
            },
          ],
        },
      ],
    };
    const md = markdownReport(withA11y);
    expect(md).toContain('| Step add-mug, http://localhost:4321/?q=a\\|b (#x) | critical |');
    expect(md).toContain('Images need <alt> \\| text');
    expect(md).toContain(
      '- **Accessibility:** 1 accessibility problem type(s), 1 element(s): 1 critical.',
    );

    const html = htmlReport(withA11y, '/nowhere');
    expect(html).toContain('Images need &#60;alt&#62; | text');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="#">image-alt</a>');
    expect(html).toContain('<caption class="sr-only">Accessibility problems</caption>');
    expect(html).toContain('<h3>Steps to reproduce</h3>');
    expect(html).not.toContain('<h4>');
  });

  it('allows only http and https links', () => {
    expect(safeHref('https://example.com/a?b=1&c=2')).toBe('https://example.com/a?b=1&#38;c=2');
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('data:text/html,hi')).toBe('#');
    expect(safeHref(undefined)).toBe('#');
  });

  it('hides secrets that have characters HTML escapes', () => {
    const dir = tempDir('report-secrets');
    mkdirSync(join(dir, '.walkthrough'), { recursive: true });
    const secret = 'p"s&<w|d\\9';
    writeFileSync(join(dir, '.walkthrough', '.env'), `PASS='${secret}'\n`);
    const secrets = SecretStore.forProject(dir);
    const store = RunStore.create(dir, { name: 'Secret run', mode: 'autonomous' });
    store.run.steps.push({
      id: 'one',
      index: 1,
      title: 'Log in',
      confirm: false,
      status: 'fail',
      notes: `The page showed ${secret} in the header`,
      screenshots: [],
      actions: [],
    });
    store.run.summary = `Found ${secret}`;
    const paths = writeReports(store, secrets);
    for (const file of [paths.markdown, paths.html]) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).toContain('The page showed **** in the header');
      expect(text, file).not.toContain('p&#34;s');
      expect(text, file).not.toContain('p"s');
    }
  });
});
