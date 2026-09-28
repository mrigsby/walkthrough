import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkableText, exportScript } from '../../src/export/puppeteer-script.js';
import { draftIssue, MAX_ENCODED_BODY } from '../../src/issue/draft.js';
import type { Run, RunStep } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

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
    expect(result.captures).toEqual([]);
    expect(result.code).not.toContain('async function capture(');
    // Without a device, a fixed size, so screenshots always match.
    expect(result.code).toContain(
      'await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });',
    );
  });

  const shotRun: Run = {
    ...run,
    emulation: { device: 'desktop', colorScheme: 'dark' },
    steps: [
      {
        id: 'login',
        index: 1,
        title: 'Log in',
        confirm: false,
        status: 'pass',
        screenshots: [],
        actions: [
          {
            action: 'fill',
            label: 'textbox "Password"',
            selector: '#password',
            value: '{{secret:PASSWORD}}',
            url: 'http://localhost:4321/login',
          },
        ],
      },
      {
        id: 'cart',
        index: 2,
        title: 'Open the cart',
        confirm: false,
        status: 'pass',
        screenshots: [],
        actions: [],
        captures: [
          { path: 'docs/images/cart.png' },
          { path: 'docs/images/total.png', selector: '#total' },
          { path: 'docs/images/page.webp', fullPage: true },
          { path: 'docs/images/lost.png', element: 'region "Offers" [e9]' },
        ],
      },
      // A step with a screenshot but no result still takes the screenshot.
      {
        id: 'later',
        index: 3,
        title: 'Later',
        confirm: false,
        status: 'pending',
        screenshots: [],
        actions: [],
        captures: [{ path: '/tmp/outside/later.png' }],
      },
    ],
  };

  it('saves screenshots to exact files, with the screen and color of the run', () => {
    const result = exportScript(shotRun);
    expect(result.code).toContain(
      'await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });',
    );
    expect(result.code).toContain('value: "dark"');
    expect(result.code).toContain('await capture(resolve(PROJECT_DIR, "docs/images/cart.png"));');
    expect(result.code).toContain(
      'await capture(resolve(PROJECT_DIR, "docs/images/total.png"), { selector: "#total" });',
    );
    expect(result.code).toContain(
      'await capture(resolve(PROJECT_DIR, "docs/images/page.webp"), { fullPage: true });',
    );
    expect(result.code).toContain('await capture("/tmp/outside/later.png");');
    expect(result.code).toContain(
      '// Fix by hand: Walkthrough found no stable selector for the screenshot of region "Offers" [e9]',
    );
    expect(result.missingSelectors).toEqual(['Step 2: screenshot of region "Offers" [e9]']);
    expect(result.captures).toEqual([
      'docs/images/cart.png',
      'docs/images/total.png',
      'docs/images/page.webp',
      '/tmp/outside/later.png',
    ]);
    expect(result.code).toContain('const SECRET_FIELDS = ["#password"];');
    expect(result.code).toContain('SHOT matches no screenshot.');
  });

  it('writes a script that Node can parse', () => {
    const dir = tempDir('export-syntax');
    for (const [name, value] of [
      ['plain.mjs', run],
      ['shots.mjs', shotRun],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, exportScript(value).code);
      expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
    }
  });

  it('turns {{unique}} into a new value on each run', () => {
    const uniqueRun: Run = {
      ...run,
      steps: [
        {
          id: 'sign-up',
          index: 1,
          title: 'Sign up',
          confirm: false,
          status: 'pass',
          screenshots: [],
          actions: [
            {
              tab: 'main',
              action: 'fill',
              label: 'textbox "Email"',
              selector: '#email',
              value: 'demo+{{unique}}@example.com',
              url: 'http://localhost:4321/signup',
            },
            {
              tab: 'main',
              action: 'navigate',
              label: 'http://localhost:4321/users/abc',
              value: 'http://localhost:4321/users/{{unique}}',
              url: 'http://localhost:4321/signup',
            },
            {
              tab: 'main',
              action: 'dialog',
              label: 'Accept the confirm dialog',
              value: '{"accept":true}',
              url: 'http://localhost:4321/users/{{unique}}',
            },
          ],
        },
      ],
    };
    const result = exportScript(uniqueRun);
    expect(result.code).toContain(
      "const UNIQUE = process.env.UNIQUE ?? 'u' + Date.now().toString(36).slice(-5);",
    );
    expect(result.code).toContain('.fill("demo+" + UNIQUE + "@example.com");');
    expect(result.code).toContain('new URL("/users/" + UNIQUE, BASE_URL).href');
    // Only comments still name the token.
    const code = result.code.split('\n').filter((line) => !line.trim().startsWith('//'));
    expect(code.join('\n')).not.toContain('{{unique}}');
    expect(result.missingSelectors).toEqual([]);
    const file = join(tempDir('export-unique'), 'unique.mjs');
    writeFileSync(file, result.code);
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
    // A run without {{unique}} gets no UNIQUE constant.
    expect(exportScript(run).code).not.toContain('UNIQUE');
  });

  it('repeats tabs, logins, settings, and dialog answers', () => {
    const at = 'http://localhost:4321/';
    const tabsRun: Run = {
      ...run,
      emulation: { colorScheme: 'dark', timezone: 'Asia/Tokyo' },
      steps: [
        {
          id: 'two-users',
          index: 1,
          title: 'Two users',
          confirm: false,
          status: 'pass',
          screenshots: [],
          actions: [
            {
              tab: 'buyer',
              action: 'tab-new',
              label: 'Open a new tab "buyer"',
              value: JSON.stringify({
                name: 'buyer',
                login: 'iso-ab12',
                isolated: true,
                url: `${at}cart`,
              }),
              url: '',
            },
            {
              tab: 'buyer',
              action: 'emulate',
              label: 'In the tab "buyer", set device: mobile',
              value: JSON.stringify({ device: 'mobile', reducedMotion: 'reduce' }),
              url: `${at}cart`,
            },
            {
              tab: 'buyer',
              action: 'click',
              label: 'link "Help"',
              selector: 'a[href="/help.html"]',
              url: `${at}cart`,
            },
            {
              tab: 'help',
              action: 'tab-switch',
              label: 'Switch to the tab "help"',
              value: JSON.stringify({ name: 'help', opener: 'buyer', newest: true }),
              url: `${at}help.html`,
            },
            {
              tab: 'help',
              action: 'tab-close',
              label: 'Close the tab "help"',
              value: JSON.stringify({ name: 'help' }),
              url: '',
            },
            {
              tab: 'main',
              action: 'tab-switch',
              label: 'Switch to the tab "main"',
              value: JSON.stringify({ name: 'main' }),
              url: at,
            },
            {
              tab: 'main',
              action: 'emulate',
              label: 'On all tabs, set CPU: 4x slower',
              value: JSON.stringify({ cpu: 4, allTabs: true }),
              url: at,
            },
            {
              tab: 'main',
              action: 'dialog',
              label: 'Dismiss the confirm dialog',
              value: JSON.stringify({ accept: false }),
              url: at,
            },
          ],
        },
      ],
    };
    const result = exportScript(tabsRun);
    const code = result.code;
    expect(code).toContain("import puppeteer, { PredefinedNetworkConditions } from 'puppeteer';");
    expect(code).toContain('let page = await browser.newPage();');
    expect(code).toContain('page = await openTab("buyer", "iso-ab12");');
    expect(code).toContain('"timezone":"Asia/Tokyo"');
    expect(code).toContain(
      '"media":{"type":"","features":[{"name":"prefers-color-scheme","value":"dark"},{"name":"prefers-reduced-motion","value":"reduce"}]}',
    );
    expect(code).toContain('page = tabs["help"] = await popupOf(tabs["buyer"]);');
    expect(code).toContain('await tabs["help"]?.close();');
    expect(code).toContain('page = tabs["main"];');
    expect(code).toContain(
      'for (const tab of await browser.pages()) await emulate(tab, {"cpu":4});',
    );
    expect(code).toContain('const DIALOG_ANSWERS = [{"accept":false}];');
    expect(code).not.toContain('Fix by hand');
    const file = join(tempDir('export-tabs'), 'tabs.mjs');
    writeFileSync(file, code);
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
    // A run with one tab keeps the old, short script.
    const plain = exportScript(run).code;
    expect(plain).toContain('const page = await browser.newPage();');
    expect(plain).toContain("page.on('dialog', (dialog) => void dialog.accept());");
    expect(plain).not.toContain('async function emulate(');
  });

  it('uses the viewport of a named device', () => {
    const result = exportScript({ ...run, emulation: { device: 'mobile' } });
    expect(result.code).toContain('// Screen: mobile.');
    expect(result.code).toMatch(/await page\.setViewport\(\{"width":\d+,"height":\d+/);
    expect(result.code).toContain('await page.setUserAgent(');
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
