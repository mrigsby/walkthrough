import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Checks that the demo shop works and has its planted bugs.
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const port = 4390 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;

let server: ChildProcess;
let browser: Browser;
let page: Page;

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/products`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Demo server did not start');
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [join(root, 'scripts/demo-server.mjs'), '--port', String(port)],
    {
      stdio: 'ignore',
    },
  );
  await waitForServer();
  browser = await puppeteer.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
});

afterEach(async () => {
  await page?.close();
});

async function addItems(...ids: string[]): Promise<void> {
  await page.goto(base);
  for (const id of ids) {
    await page.locator(`[data-add="${id}"]`).click();
  }
}

describe('demo shop', () => {
  it('shows the wrong total with two different items', async () => {
    await addItems('mug', 'shirt');
    await page.locator('a[href="/cart"]').click();
    const total = await page
      .locator('#cart-total')
      .map((el) => el.textContent)
      .wait();
    expect(total).toBe('$40.00');
  });

  it('shows the right total with one item', async () => {
    await addItems('mug');
    await page.goto(`${base}/cart`);
    const total = await page
      .locator('#cart-total')
      .map((el) => el.textContent)
      .wait();
    expect(total).toBe('$10.00');
  });

  it('throws a console error on Apply coupon', async () => {
    await addItems('mug');
    await page.goto(`${base}/cart`);
    const error = new Promise<Error>((resolve) =>
      page.once('pageerror', (e) => resolve(e as Error)),
    );
    await page.locator('#apply-coupon').click();
    expect((await error).message).toMatch(/Cannot read properties of undefined/);
  });

  it('gets a server error on Check stock', async () => {
    const response = page.waitForResponse((res) => res.url().includes('/api/stock'));
    await page.locator('[data-stock="mug"]').click();
    expect((await response).status()).toBe(500);
  });

  it('has an image without alt text', async () => {
    const missing = await page.$$eval('img:not([alt])', (imgs) => imgs.length);
    expect(missing).toBe(1);
  });

  it('logs in and reaches the account page', async () => {
    await page.goto(`${base}/login`);
    await page.locator('input[name="username"]').fill('demo');
    await page.locator('input[name="password"]').fill('demo123');
    await page.locator('#login-form button[type="submit"]').click();
    await page.waitForFunction(() => location.pathname === '/account');
    const heading = await page
      .locator('h1')
      .map((el) => el.textContent)
      .wait();
    expect(heading).toBe('Account');
  });

  it('places an order through the iframe card form and confirm dialog', async () => {
    await addItems('mug');
    await page.goto(`${base}/checkout`);
    await page.locator('input[name="name"]').fill('Test Person');
    await page.locator('input[name="email"]').fill('test@example.com');
    await page.locator('textarea[name="address"]').fill('1 Main St');

    const frameHandle = await page.waitForSelector('iframe.payment-frame');
    const frame = await frameHandle?.contentFrame();
    if (!frame) throw new Error('Payment frame not found');
    await frame.locator('input[name="card"]').fill('4242424242424242');
    await frame.locator('button[type="submit"]').click();
    await page.waitForFunction(() =>
      document.getElementById('card-status')?.textContent?.includes('4242'),
    );

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#place-order').click();
    await page.waitForFunction(() => location.pathname.startsWith('/order/'));
    expect(await page.$eval('#order-id', (el) => el.textContent)).toMatch(/^A\d{4}$/);
  });
});
