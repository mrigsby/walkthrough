import { describe, expect, it } from 'vitest';
import { checkableText, exportScript } from '../../src/export/puppeteer-script.js';
import { draftIssue, MAX_ENCODED_BODY } from '../../src/issue/draft.js';
import type { Run, RunStep } from '../../src/run/run-store.js';

const bug: RunStep = {
  id: 'check-total',
  index: 2,
  title: 'Read the cart total',
  expect: 'The total is $30.00.',
  confirm: true,
  status: 'bug',
  checkedBy: 'developer',
  notes: 'It shows $40.00.',
  screenshots: ['screenshots/total.png'],
  logs: '#1 [error] page-error in t1: TypeError: x',
  actions: [
    {
      action: 'navigate',
      label: 'http://localhost:4321/cart',
      value: 'http://localhost:4321/cart',
      url: 'http://localhost:4321/',
    },
  ],
};

const run: Run = {
  version: 1,
  id: '2026-09-24_100000-checkout-ab12',
  name: 'Checkout',
  mode: 'checkpoints',
  status: 'finished',
  startedAt: '2026-09-24T10:00:00.000Z',
  baseUrl: 'http://localhost:4321',
  chrome: 'Chrome/154',
  steps: [
    {
      id: 'add-mug',
      index: 1,
      title: 'Add the mug',
      confirm: false,
      status: 'pass',
      screenshots: [],
      actions: [
        {
          action: 'click',
          label: 'button "Add to cart"',
          selector: '#add-mug',
          url: 'http://localhost:4321/',
        },
      ],
    },
    bug,
  ],
};

describe('checkableText', () => {
  it('finds quoted text and money', () => {
    expect(checkableText('The page says "Thank you" and the total is $1,030.50.')).toEqual([
      'Thank you',
      '$1,030.50',
    ]);
    expect(checkableText('The cart looks right.')).toEqual([]);
  });
});

describe('exportScript', () => {
  it('writes steps with a navigation, a click, and checks', () => {
    const result = exportScript(run, { installedChrome: true });
    expect(result.code).toContain("import puppeteer from 'puppeteer-core';");
    expect(result.code).toContain('await page.locator("#add-mug").click();');
    expect(result.code).toContain('await page.goto(new URL("/cart", BASE_URL).href');
    expect(result.code).toContain('await expectText("$30.00");');
    expect(result.failedSteps).toEqual(['2. Read the cart total']);
    expect(result.actions).toBe(2);
  });
});

describe('draftIssue', () => {
  it('writes a title and a body with the evidence', () => {
    const draft = draftIssue(run, bug, {
      reportPath: 'report.md',
      screenshots: ['.walkthrough/runs/x/screenshots/total.png'],
    });
    expect(draft.title).toBe('Read the cart total: It shows $40.00.');
    expect(draft.body).toContain(
      '## Steps to reproduce\n\n1. Open http://localhost:4321\n2. Add the mug\n3. Go to http://localhost:4321/cart',
    );
    expect(draft.body).toContain('## Expected\n\nThe total is $30.00.');
    expect(draft.body).toContain('TypeError: x');
    expect(draft.body).toContain('(drag the file into this issue)');
    expect(draft.shortened).toBe(false);
  });

  it('shortens a long body to fit in the browser address', () => {
    const noisy = {
      ...bug,
      logs: Array.from(
        { length: 400 },
        (_, i) => `#${i} [error] console in t1: Something failed with a long message ${i}`,
      ).join('\n'),
    };
    const draft = draftIssue(run, noisy, { reportPath: 'report.md', screenshots: [] });
    expect(draft.shortened).toBe(true);
    expect(encodeURIComponent(draft.body).length).toBeLessThanOrEqual(MAX_ENCODED_BODY);
    expect(draft.body).toContain('## Steps to reproduce');
  });
});
