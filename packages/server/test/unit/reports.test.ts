import { describe, expect, it } from 'vitest';
import { htmlReport } from '../../src/report/html.js';
import { markdownReport } from '../../src/report/markdown.js';
import type { Run } from '../../src/run/run-store.js';

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
});
