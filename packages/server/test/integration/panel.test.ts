import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import {
  clickPanel,
  fakeClickPanel,
  modalText,
  panelProp,
  panelText,
  typeNotes,
  waitForPanel,
} from '../helpers/panel.js';
import { tempDir } from '../helpers/temp.js';

// Tests the developer panel: questions, answers, evidence, and safety.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let chrome: Browser;
let page: Page;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('panel');
  mkdirSync(join(project, '.walkthrough'));
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\naskTimeoutSec: 10\nhighlightMs: 50\n`,
  );
  const chromeFile = endpointFile();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('panel-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
  });
  const open = await mcp.call('browser_open');
  expect(open.isError, open.text).toBe(false);
  // The test connects to the same Chrome, to click the panel like a person.
  chrome = await connectChrome(chromeFile, { defaultViewport: null });
  const pages = await chrome.pages();
  page = pages.find((p) => p.url().startsWith(demo.base)) as Page;
  expect(page).toBeDefined();
}, 60_000);

afterAll(async () => {
  await chrome?.disconnect();
  await mcp?.close();
  demo?.stop();
});

async function snap(): Promise<string> {
  return (await mcp.call('snapshot')).text;
}

function ask(args: Record<string, unknown>) {
  return mcp.call('ask_developer', {
    title: 'Check',
    didWhat: 'Did a thing.',
    expected: 'A result.',
    ...args,
  });
}

describe('developer panel', () => {
  it('is on the page but hidden from the page and the agent', async () => {
    await waitForPanel(page, 'Walkthrough');
    // No binding or panel object in the page's own scripts.
    const globals = await page.evaluate(() =>
      Object.keys(window).filter((k) => k.toLowerCase().includes('uiwalk')),
    );
    expect(globals).toEqual([]);
    expect(await page.$eval('uiwalk-panel', (el) => el.getAttribute('aria-hidden'))).toBe('true');
    expect(await page.$eval('uiwalk-panel', (el) => el.shadowRoot)).toBeNull();
    // The snapshot does not show the panel buttons.
    const outline = await snap();
    expect(outline).not.toMatch(/button "Pass"/);
    expect(outline).not.toContain('What you should see');
  });

  it('asks a question and returns Pass', async () => {
    const reply = ask({
      title: 'Open the shop',
      didWhat: 'I opened the shop.',
      expected: 'You see three products.',
      step: 1,
      total: 3,
    });
    const shown = await waitForPanel(page, 'You see three products.');
    expect(shown).toMatch(/^ASKING/);
    expect(shown).toContain('Step 1 of 3');
    await clickPanel(page, 'pass');
    const result = await reply;
    expect(result.text).toMatch(/^status: pass/);
    expect(result.text).toContain('Developer notes: (none)');
    expect(await waitForPanel(page, 'Sent: Pass')).not.toMatch(/^ASKING/);
  });

  it('needs notes for a bug, then saves a screenshot and the step errors', async () => {
    let outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Add to cart') });
    await mcp.call('navigate', { url: '/cart' });
    outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Apply coupon') });

    const reply = ask({
      title: 'Apply coupon',
      didWhat: 'I clicked Apply coupon.',
      expected: 'A message says the coupon is applied.',
      stepId: 'coupon',
    });
    await waitForPanel(page, 'Apply coupon');
    await clickPanel(page, 'bug');
    await waitForPanel(page, 'Describe the bug in the notes');
    await typeNotes(page, 'Nothing happens when I click it.');
    await clickPanel(page, 'bug');

    const result = await reply;
    expect(result.text).toMatch(/^status: bug/);
    expect(result.text).toContain('Developer notes: Nothing happens when I click it.');
    expect(result.text).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(result.text).toContain('step "coupon"');
    expect(result.images).toBe(1);
    const shot = /Screenshot: (\S+)/.exec(result.text)?.[1] as string;
    expect(existsSync(join(project, shot))).toBe(true);
  });

  it('shows failed requests in logs', async () => {
    await mcp.call('navigate', { url: '/' });
    const outline = await snap();
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Check stock') });
    const logs = await mcp.call('logs');
    expect(logs.text).toMatch(/GET http:\/\/localhost:\d+\/api\/stock\?id=\w+ returned HTTP 500/);
    expect(logs.text).toMatch(/Latest marker: \d+/);
  });

  it('ignores fake clicks from page scripts', async () => {
    const reply = ask({ title: 'Fake click', expected: 'Nothing yet.' });
    await waitForPanel(page, 'Fake click');
    await fakeClickPanel(page, 'pass');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await panelText(page)).toMatch(/^ASKING/);
    await clickPanel(page, 'skip');
    expect((await reply).text).toMatch(/^status: skip/);
  });

  it('keeps the question after a timeout and after a page load', async () => {
    const first = await ask({ title: 'Slow answer', expected: 'Wait for it.' });
    expect(first.text).toMatch(/^status: waiting/);
    expect(await panelText(page)).toContain('Slow answer');

    // The page loads again. The question must come back.
    await page.goto(`${demo.base}/cart`);
    await waitForPanel(page, 'Slow answer');

    const resumed = mcp.call('ask_developer', { resume: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clickPanel(page, 'pass');
    expect((await resumed).text).toMatch(/^status: pass/);
  }, 30_000);

  it('puts the panel back if the app removes it', async () => {
    await page.evaluate(() => document.querySelector('uiwalk-panel')?.remove());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await page.$('uiwalk-panel')).not.toBeNull();
  });

  it('clears the question when the agent cancels', async () => {
    const controller = new AbortController();
    const call = mcp.client.callTool(
      { name: 'ask_developer', arguments: { title: 'Cancel me', didWhat: 'x', expected: 'y' } },
      undefined,
      { signal: controller.signal },
    );
    await waitForPanel(page, 'Cancel me');
    controller.abort();
    await expect(call).rejects.toThrow();
    await waitForPanel(page, 'The agent stopped waiting');
    expect(await panelText(page)).not.toMatch(/^ASKING/);
  });

  it('does not let the agent act on the panel', async () => {
    const reply = await mcp.call('act', { action: 'click', selector: 'uiwalk-panel' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/part of the Walkthrough panel/);
  });

  it('marks an element in a screenshot', async () => {
    await mcp.call('navigate', { url: '/' });
    const outline = await snap();
    const reply = await mcp.call('screenshot', {
      ref: refFor(outline, 'link', 'Help'),
      annotate: true,
      label: 'help link',
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toMatch(/the visible page, with link "Help" \[e\d+\] marked/);
    expect(reply.images).toBe(1);
  });

  it('shows custom labels, lists, buttons, and a closed "What\'s next"', async () => {
    const reply = mcp.call('ask_developer', {
      title: 'Seed the data',
      didWhat: 'Nothing yet.',
      expected: 'Run `npm run seed`. Then check:\n- [ ] It prints **Done**\n1. one\n2. two',
      next: 'The agent opens the admin page.',
      panel: {
        labels: { did: 'Setup' },
        buttons: { pass: { label: 'Done', color: '#0369a1' }, skip: { show: false } },
      },
    });
    let shown = await waitForPanel(page, 'Seed the data');
    expect(shown).toMatch(/setup/i);
    expect(shown).toContain('It prints Done');
    expect(shown).toMatch(/what's next/i);
    expect(shown).not.toContain('The agent opens the admin page.');
    expect(shown).not.toMatch(/\bSkip\b/);
    await clickPanel(page, 'toggle-next');
    shown = await waitForPanel(page, 'The agent opens the admin page.');
    // An open box would ask for a second click on Pass.
    await clickPanel(page, 'check-expect-1-0');
    await clickPanel(page, 'pass');
    const result = await reply;
    expect(result.text).toMatch(/^status: pass/);
    expect(result.text).toContain('Checklist: 1 of 1 ticked.');
    await waitForPanel(page, 'Sent: Done');
  });

  it('fills the question from the plan step', async () => {
    mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
    writeFileSync(
      join(project, '.walkthrough', 'plans', 'panel-plan.yaml'),
      `name: Panel plan
mode: interactive
panel:
  labels: { expect: Check this }
  next: { auto: true }
  buttons: { bug: { label: Report } }
steps:
  - id: look
    do: Look at the shop
    expect: The shop shows **three** products.
  - id: done
    do: Say goodbye
    expect: Nothing more.
    panel: { buttons: { pass: { label: Finish } } }
`,
    );
    const start = await mcp.call('run_start', { plan: 'panel-plan' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('call ask_developer with the stepId and didWhat');

    const first = mcp.call('ask_developer', { stepId: 'look', didWhat: 'I opened the shop.' });
    let shown = await waitForPanel(page, 'The shop shows three products.');
    expect(shown).toContain('Look at the shop');
    expect(shown).toContain('Step 1 of 2');
    expect(shown).toMatch(/check this/i);
    expect(shown).toContain('Report');
    await clickPanel(page, 'toggle-next');
    await waitForPanel(page, 'Say goodbye');
    await clickPanel(page, 'pass');
    expect((await first).text).toContain('Saved as step 1 in the run.');

    const second = mcp.call('ask_developer', { stepId: 'done' });
    shown = await waitForPanel(page, 'Nothing more.');
    expect(shown).toContain('Step 2 of 2');
    expect(shown).toContain('Finish');
    expect(shown).not.toMatch(/what i did/i);
    await clickPanel(page, 'toggle-next');
    await waitForPanel(page, 'This is the last step.');
    await clickPanel(page, 'pass');
    expect((await second).text).toMatch(/^status: pass/);
    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('Result: 2 passed');

    // Without a plan step, the agent must give the text.
    const bad = await mcp.call('ask_developer', { stepId: 'look', didWhat: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Give a title, didWhat, and expected/);
  }, 30_000);
});

describe('snippets, check lists, and images in the panel', () => {
  async function waitForModal(text: string, ms = 5000): Promise<string> {
    const end = Date.now() + ms;
    let last = '';
    while (Date.now() < end) {
      last = await modalText(page).catch(() => '');
      if (last.includes(text)) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`The modal did not show "${text}". It showed: ${last}`);
  }

  it('copies a snippet and shows its help', async () => {
    await chrome
      .defaultBrowserContext()
      .overridePermissions(demo.base, ['clipboard-read', 'clipboard-sanitized-write']);
    const reply = mcp.call('ask_developer', {
      title: 'Seed',
      didWhat: 'Nothing yet.',
      expected: 'Run {{copy:seed}} in your terminal.\n```\necho second\n```',
      snippets: { seed: { code: 'npm run seed', help: 'Fills the **test** data.' } },
    });
    await waitForPanel(page, 'Run npm run seed');
    await clickPanel(page, 'copy-snip');
    await waitForPanel(page, 'Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm run seed');

    await clickPanel(page, 'help-snip');
    const help = await waitForModal('About this snippet');
    expect(help).toContain('npm run seed');
    expect(help).toContain('Fills the test data.');
    await page.keyboard.press('Escape');
    expect(await modalText(page)).toBe('');

    await clickPanel(page, 'copy-code');
    await new Promise((r) => setTimeout(r, 300));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('echo second');
    await clickPanel(page, 'pass');
    expect((await reply).text).toMatch(/^status: pass/);
  });

  it('keeps ticks after a page load, and asks again before Pass', async () => {
    const reply = mcp.call('ask_developer', {
      title: 'Tick',
      didWhat: 'I opened the cart.',
      expected: 'Check:\n- [ ] One\n- [ ] Two\n- [x] Three',
    });
    await waitForPanel(page, 'Three');
    // The list is the second block of "expect": a paragraph comes first.
    await clickPanel(page, 'check-expect-1-0');
    expect(await panelProp(page, 'check-expect-1-0', 'checked')).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    await page.reload();
    await waitForPanel(page, 'Three');
    expect(await panelProp(page, 'check-expect-1-0', 'checked')).toBe(true);
    expect(await panelProp(page, 'check-expect-1-1', 'checked')).toBe(false);

    await clickPanel(page, 'pass');
    await waitForPanel(page, '1 item is not ticked. Click Pass again to pass anyway.');
    await clickPanel(page, 'pass');
    const result = await reply;
    expect(result.text).toMatch(/^status: pass/);
    expect(result.text).toContain('Checklist: 2 of 3 ticked. Not ticked: "Two".');
  }, 30_000);

  it('shows a reference image, and a bigger one on a click', async () => {
    mkdirSync(join(project, 'docs'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'examples/demo-app/docs/images/help/cart.png'),
      join(project, 'docs', 'cart.png'),
    );
    const outside = await mcp.call('ask_developer', {
      title: 'Image',
      didWhat: 'x',
      expected: 'y',
      image: '../elsewhere.png',
    });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/reference image/);

    const reply = mcp.call('ask_developer', {
      title: 'Compare',
      didWhat: 'I opened the cart.',
      expected: 'The cart looks like the picture.',
      image: 'docs/cart.png',
    });
    await waitForPanel(page, 'Reference image. Click to make it bigger.');
    expect(await panelProp(page, 'ref-thumb', 'width')).toBe(1280);
    await clickPanel(page, 'ref-thumb');
    await waitForModal('What the page should look like');
    expect(await panelProp(page, 'ref-big', 'width')).toBe(1280);
    await clickPanel(page, 'modal-close');
    expect(await modalText(page)).toBe('');
    await clickPanel(page, 'pass');
    expect((await reply).text).toMatch(/^status: pass/);
  });
});

describe('card steps', () => {
  it('shows cards, waits for them in autonomous mode, and keeps them out of results', async () => {
    writeFileSync(
      join(project, '.walkthrough', 'plans', 'cards.yaml'),
      `name: Cards
mode: autonomous
steps:
  - id: welcome
    card:
      heading: Checkout test
      subheading: About one minute
      content: |
        This plan checks:
        - the cart
      size: modal
    panel: { buttons: { pass: { label: Start }, stop: { label: Cancel } } }
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    expect: The cart page shows.
  - id: all-good
    card: { heading: All done, content: Every step passed., when: passed }
  - id: problems
    card: { heading: Some steps failed, when: problems }
`,
    );
    const start = await mcp.call('run_start', { plan: 'cards' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('Card steps still go to the developer.');
    expect(start.text).toContain(
      '1. [welcome] (card: call ask_developer with only the stepId, and do nothing in the browser) Checkout test',
    );
    const wrong = await mcp.call('run_step', { stepId: 'welcome', status: 'pass' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/is a card/);

    const welcome = mcp.call('ask_developer', { stepId: 'welcome' });
    await waitForPanel(page, 'The card is open in the middle of the page.');
    const end = Date.now() + 5000;
    let shown = '';
    while (Date.now() < end && !shown.includes('About one minute'))
      shown = await modalText(page, 'card-backdrop');
    expect(shown).toContain('Checkout test');
    expect(shown).toContain('the cart');
    expect(shown).toContain('Start');
    expect(shown).not.toContain('Bug');
    // A click outside does not close a card. It needs an answer.
    await page.mouse.click(5, 5);
    expect(await modalText(page, 'card-backdrop')).toContain('Checkout test');
    await clickPanel(page, 'pass');
    const answered = await welcome;
    expect(answered.text).toMatch(/^status: pass/);
    expect(answered.text).toContain('Next: step 2 [open-cart]');
    expect(await modalText(page, 'card-backdrop')).toBe('');

    await mcp.call('navigate', { url: '/cart' });
    const step = await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
    expect(step.text).toContain('Saved step 2 [open-cart] as pass.');

    const good = mcp.call('ask_developer', { stepId: 'all-good' });
    await waitForPanel(page, 'Every step passed.');
    await clickPanel(page, 'pass');
    expect((await good).text).toMatch(/^status: pass/);
    const bad = await mcp.call('ask_developer', { stepId: 'problems' });
    expect(bad.text).toMatch(/^status: skip/);
    expect(bad.text).toContain('Not shown: the run had no problems.');

    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('Result: 1 passed.');
    const runDir = /Reports: (\S+)\/report\.md/.exec(finish.text)?.[1] as string;
    const md = readFileSync(join(project, runDir, 'report.md'), 'utf8');
    expect(md).toContain('| 1 | Checkout test | Card: Seen |');
    expect(md).toContain('| 4 | Some steps failed | Card: Not shown |');
    // The card did not take the actions of the next step.
    const run = JSON.parse(readFileSync(join(project, runDir, 'run.json'), 'utf8'));
    expect(run.steps[0].actions).toEqual([]);
    expect(run.steps[1].actions.map((a: { action: string }) => a.action)).toEqual(['navigate']);
  }, 30_000);
});

describe('retry, keys, progress, and pointing', () => {
  it('keeps a try that the developer wants again, and lists the steps', async () => {
    writeFileSync(
      join(project, '.walkthrough', 'plans', 'again.yaml'),
      'name: Again\nmode: interactive\nsteps:\n  - id: look\n    do: Look at the shop\n    expect: Three products.\n  - id: cart\n    do: Open the cart\n',
    );
    const start = await mcp.call('run_start', { plan: 'again' });
    expect(start.isError, start.text).toBe(false);

    const first = mcp.call('ask_developer', { stepId: 'look', didWhat: 'I opened the shop.' });
    await waitForPanel(page, 'Three products.');
    await clickPanel(page, 'progress-toggle');
    let shown = await waitForPanel(page, '2. Open the cart');
    expect(shown).toContain('1. Look at the shop');
    await typeNotes(page, 'The page was still loading.');
    await clickPanel(page, 'retry');
    const retried = await first;
    expect(retried.text).toMatch(/^status: retry/);
    expect(retried.text).toContain('Saved try 1 of step 1. The step is still open.');

    const second = mcp.call('ask_developer', { stepId: 'look', didWhat: 'I opened it again.' });
    shown = await waitForPanel(page, 'I opened it again.');
    // The list stays open after a new question.
    expect(shown).toContain('2. Open the cart');
    await clickPanel(page, 'pass');
    expect((await second).text).toContain('Saved as step 1 in the run.');
    await waitForPanel(page, '\u2713');
    const finish = await mcp.call('run_finish');
    const runDir = /Reports: (\S+)\/report\.md/.exec(finish.text)?.[1] as string;
    const md = readFileSync(join(project, runDir, 'report.md'), 'utf8');
    expect(md).toContain('Try 1: The page was still loading.');
  }, 30_000);

  it('answers with Alt+Shift keys, and the page does not see them', async () => {
    await page.evaluate(() => {
      const w = window as unknown as { seen: string[] };
      w.seen = [];
      addEventListener('keydown', (e) => w.seen.push(e.code), true);
    });
    const press = async (code: string) => {
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.keyboard.press(code as never);
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
    };
    const reply = ask({ title: 'Keys', expected: 'Press keys.' });
    await waitForPanel(page, 'Press keys.');
    // Bug needs notes, as with a click.
    await press('KeyB');
    await waitForPanel(page, 'Describe the bug in the notes');
    await press('KeyS');
    expect((await reply).text).toMatch(/^status: skip/);
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen).not.toContain('KeyS');
    expect(seen).not.toContain('KeyB');
  });

  it('points at the element of a bug, and the app does not get the click', async () => {
    await mcp.call('navigate', { url: '/' });
    const before = page.url();
    const reply = ask({ title: 'Point', didWhat: 'I opened the shop.', expected: 'A Help link.' });
    await waitForPanel(page, 'A Help link.');
    // Esc ends point mode.
    await clickPanel(page, 'point');
    expect(await panelProp(page, 'point-banner', 'hidden')).toBe(false);
    await page.keyboard.press('Escape');
    expect(await panelProp(page, 'point-banner', 'hidden')).toBe(true);

    await clickPanel(page, 'point');
    const tabs = (await chrome.pages()).length;
    const box = await page.$eval('a[href="/help.html"]', (a) => {
      const r = a.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await waitForPanel(page, 'Pointed at: link "Help"');
    // The link opens a new tab. While pointing, it must not.
    expect(page.url()).toBe(before);
    expect((await chrome.pages()).length).toBe(tabs);
    await typeNotes(page, 'The link is too small.');
    await clickPanel(page, 'bug');
    const result = await reply;
    expect(result.text).toContain('The developer pointed at: link "Help".');
    const details = /Styles and CSS rules of the pointed element: (\S+)/.exec(result.text)?.[1];
    expect(details).toBeDefined();
    expect(readFileSync(join(project, details as string), 'utf8')).toMatch(/^Element: a/);
    expect(result.images).toBe(1);
  });
});

describe('ask_developer without a panel', () => {
  it('asks the agent to use chat when the browser is hidden', async () => {
    const quiet = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir('nopanel-tmp'),
    });
    try {
      await quiet.call('browser_open');
      const reply = await quiet.call('ask_developer', {
        title: 'Check',
        didWhat: 'x',
        expected: 'y',
      });
      expect(reply.text).toMatch(/^status: use_chat/);
      expect(reply.text).toContain('headless');
    } finally {
      await quiet.close();
    }
  });
});
