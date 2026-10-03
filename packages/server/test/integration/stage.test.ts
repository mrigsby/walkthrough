import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { stagePart, waitForStage } from '../helpers/stage.js';
import { tempDir } from '../helpers/temp.js';

// What the audience sees during a presentation.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let chromeFile: string;
let chrome: Browser;
let page: Page;

const TOUR = `name: Stage tour
presentation:
  title: { image: .walkthrough/slides/title.svg }
  mask: ['.card .price']
  pageZoom: 1.25
  mirror: false
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: The mug and the cart }
  - id: add-mug
    do: Add the mug
    action: { click: { selector: '[data-add="mug"]' } }
    caption: Add a mug
    zoom: 2
    expect: The header says "Cart (1)".
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    caption: The cart
`;

async function control(command: string): Promise<string> {
  return (await mcp.call('present', { action: 'control', command })).text;
}

async function until(text: RegExp): Promise<void> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (text.test((await mcp.call('present', { action: 'status' })).text)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The status never matched ${text}`);
}

beforeAll(async () => {
  demo = await startDemoServer();
  const project = tempDir('stage');
  const folder = join(project, '.walkthrough');
  mkdirSync(join(folder, 'plans'), { recursive: true });
  mkdirSync(join(folder, 'slides'), { recursive: true });
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins: [${demo.base}]\n`,
  );
  writeFileSync(join(folder, 'plans', 'tour.yaml'), TOUR);
  writeFileSync(
    join(folder, 'slides', 'title.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#123"/></svg>',
  );
  chromeFile = endpointFile();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('stage-tmp'),
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
  });
  // The rehearsal.
  await mcp.call('run_start', { plan: 'tour', mode: 'autonomous' });
  await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
  await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
  await mcp.call('navigate', { url: '/cart' });
  await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
  await mcp.call('run_finish', {});
  const start = await mcp.call('present', { action: 'start', plan: 'tour' });
  expect(start.isError, start.text).toBe(false);
  // The presentation has a Chrome of its own. The file has its address now.
  chrome = await connectChrome(chromeFile, { defaultViewport: null });
  page = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
}, 90_000);

afterAll(async () => {
  await chrome?.disconnect();
  await mcp?.call('present', { action: 'stop' }).catch(() => undefined);
  await mcp?.close();
  demo?.stop();
});

describe('the audience screen', () => {
  it('shows the title image, then a text slide', async () => {
    const title = await waitForStage(page, 'slide', (p) => p.shown);
    expect(title.src).toMatch(/^data:image\/svg\+xml;base64,/);
    // Chrome's zoom: the page is bigger, and it still fills the 1280 pixel window.
    expect(await page.evaluate(() => [window.innerWidth, window.devicePixelRatio])).toEqual([
      1024, 1.25,
    ]);
    await control('start');
    const slide = await waitForStage(page, 'slide', (p) => p.text.includes('Today'));
    expect(slide.text).toContain('The mug and the cart');
  }, 30_000);

  it('blurs the parts that the plan masks', async () => {
    const filters = await page.$$eval('.card .price', (els) =>
      els.map((el) => getComputedStyle(el).filter),
    );
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) expect(filter).toBe('blur(8px)');
  });

  it('spotlights and zooms the next element, then shows the caption', async () => {
    await control('continue');
    await until(/State: gate, at step 2 of 3/);
    expect((await stagePart(page, 'slide')).shown).toBe(false);
    await waitForStage(page, 'spot', (p) => p.shown);
    const zoom = await waitForStage(page, 'zoom', (p) => p.shown);
    expect(zoom.src).toMatch(/^data:image\/jpeg;base64,/);
    // The picture lines up with the page: the button's color is where the button is.
    const match = await page.evaluate(async (src) => {
      const button = document.querySelector('[data-add="mug"]') as HTMLElement;
      const r = button.getBoundingClientRect();
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d') as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const scale = img.width / window.innerWidth;
      const pixel = g.getImageData((r.x + 4) * scale, (r.y + r.height / 2) * scale, 1, 1).data;
      const color = (getComputedStyle(button).backgroundColor.match(/\d+/g) ?? []).map(Number);
      return [0, 1, 2].reduce((sum, i) => sum + Math.abs((pixel[i] ?? 0) - (color[i] ?? 255)), 0);
    }, zoom.src as string);
    expect(match).toBeLessThan(40);
    await control('continue');
    await until(/State: gate, at step 3 of 3/);
    expect((await stagePart(page, 'spot')).shown).toBe(false);
    expect((await waitForStage(page, 'caption', (p) => p.shown)).text).toBe('Add a mug');
  }, 30_000);

  it('blanks the screen, and shows an answer on it', async () => {
    await control('blank');
    await waitForStage(page, 'cover', (p) => p.shown);
    await control('blank');
    await waitForStage(page, 'cover', (p) => !p.shown);
    await mcp.call('present', {
      action: 'answer',
      text: 'The cart saves in the browser.',
      onScreen: true,
    });
    await waitForStage(page, 'caption', (p) => p.text === 'The cart saves in the browser.');
  }, 30_000);

  it('takes clicker keys, keeps the stage on a new page, and ends with "Questions?"', async () => {
    await page.bringToFront();
    await page.keyboard.press('PageDown');
    await until(/State: end/);
    expect(page.url()).toContain('/cart');
    const end = await waitForStage(page, 'slide', (p) => p.text.includes('Questions?'));
    expect(end.text).toContain('Stage tour');
  }, 30_000);
});
