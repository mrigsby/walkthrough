import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stableSelector } from '../../src/page/selectors.js';
import { startDemoServer } from '../helpers/demo-server.js';

let demo: Awaited<ReturnType<typeof startDemoServer>>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  demo = await startDemoServer();
  browser = await puppeteer.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  demo?.stop();
});

async function el(selector: string): Promise<ElementHandle<Element>> {
  const handle = await page.waitForSelector(selector);
  if (!handle) throw new Error(`missing ${selector}`);
  return handle as ElementHandle<Element>;
}

// The selector must find this element and nothing else.
async function expectUnique(selector: string | undefined, handle: ElementHandle<Element>) {
  expect(selector).toBeDefined();
  const matches = await page.$$(selector as string);
  expect(matches.length).toBe(1);
  expect(await page.evaluate((a, b) => a === b, matches[0], handle)).toBe(true);
}

describe('stableSelector', () => {
  it('prefers a test id', async () => {
    await page.goto(`${demo.base}/`);
    await page.locator('[data-add="mug"]').click();
    await page.goto(`${demo.base}/checkout`);
    const handle = await el('#place-order');
    expect(await stableSelector(handle, { role: 'button', name: 'Place order' })).toBe(
      '[data-testid="place-order"]',
    );
  });

  it('uses the ARIA role and name next', async () => {
    await page.goto(`${demo.base}/login`);
    const handle = await el('input[name="username"]');
    expect(await stableSelector(handle, { role: 'textbox', name: 'Username' })).toBe(
      '::-p-aria(Username[role="textbox"])',
    );
  });

  it('uses an id or name without a hint', async () => {
    await page.goto(`${demo.base}/login`);
    expect(await stableSelector(await el('input[name="username"]'))).toBe('input[name="username"]');
    await page.goto(`${demo.base}/`);
    expect(await stableSelector(await el('#cart-count'))).toBe('#cart-count');
  });

  it('falls back to a unique CSS path for repeated buttons', async () => {
    await page.goto(`${demo.base}/`);
    const handle = await el('[data-add="shirt"]');
    const selector = await stableSelector(handle, { role: 'button', name: 'Add to cart' });
    expect(selector).not.toContain('::-p-aria');
    await expectUnique(selector, handle);
  });
});
