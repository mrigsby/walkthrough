import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFfmpeg } from '../../src/downloads/ffmpeg.js';
import { freePort, startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { panelHidden } from '../helpers/panel.js';
import { tempDir } from '../helpers/temp.js';

// Video recording: formats, privacy, long GIFs, whole runs, and the ffmpeg fallback.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let chrome: Browser;
let page: Page;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The first bytes of each format.
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  gif: (b) => b.subarray(0, 6).toString('latin1') === 'GIF89a',
  webm: (b) => b.subarray(0, 4).toString('hex') === '1a45dfa3',
  mp4: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
};

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('video');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\nhighlightMs: 0\n`,
  );
  writeFileSync(join(project, '.walkthrough', '.env'), 'DEMO_PASSWORD=demo123\n');
  writeFileSync(
    join(project, '.walkthrough', 'plans', 'cart-video.yaml'),
    [
      'name: Cart video',
      'mode: autonomous',
      'video: { format: webm }',
      'steps:',
      '  - id: add-mug',
      '    do: Click "Add to cart" on the Coffee Mug',
      '    caption: Add the coffee mug',
      '    action: { click: { selector: "[data-add=\\"mug\\"]" } }',
      '  - id: open-cart',
      '    do: Open the cart',
      '    action: { navigate: /cart }',
      '',
    ].join('\n'),
  );
  const debugPort = await freePort();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('video-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_PORT: String(debugPort),
  });
  expect((await mcp.call('browser_open')).isError).toBe(false);
  // The test connects to the same Chrome, to check the page while it records.
  chrome = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${debugPort}`,
    defaultViewport: null,
  });
  page = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
}, 60_000);

afterAll(async () => {
  await chrome?.disconnect();
  await mcp?.close();
  demo?.stop();
});

async function addToCart(): Promise<void> {
  await mcp.call('navigate', { url: '/' });
  await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
  await mcp.call('act', { action: 'click', selector: '[data-add="shirt"]' });
  await mcp.call('navigate', { url: '/cart' });
}

describe('video', () => {
  it('records the active tab and saves GIF, WebM, and MP4', async () => {
    for (const format of ['gif', 'webm', 'mp4']) {
      const start = await mcp.call('video', { action: 'start', name: 'cart' });
      expect(start.text).toContain('The video hides the panel and typed secrets.');
      await mcp.call('video', { action: 'caption', text: 'Add two items to the cart' });
      await addToCart();
      const stop = await mcp.call(
        'video',
        { action: 'stop', path: `docs/cart.${format}` },
        { timeoutMs: 120_000 },
      );
      expect(stop.isError, stop.text).toBe(false);
      expect(stop.text).toContain(`Saved the video (${format.toUpperCase()}`);
      expect(stop.text).toContain('It shows 2 action(s).');
      expect(stop.images).toBe(1);
      expect(MAGIC[format]?.(readFileSync(join(project, 'docs', `cart.${format}`)))).toBe(true);
    }
  }, 180_000);

  it('hides the panel and typed secrets while it records', async () => {
    await mcp.call('navigate', { url: '/login' });
    await mcp.call('video', { action: 'start' });
    expect(await panelHidden(page)).toBe(true);
    await mcp.call('act', {
      action: 'fill',
      selector: 'input[name="username"]',
      value: '{{secret:DEMO_PASSWORD}}',
    });
    const masked = () =>
      page.$eval(
        'input[name="username"]',
        (el) => getComputedStyle(el).getPropertyValue('-webkit-text-security') || 'none',
      );
    expect(await masked()).toBe('disc');
    const stop = await mcp.call('video', { action: 'stop', format: 'webm' });
    expect(stop.isError, stop.text).toBe(false);
    expect(await masked()).toBe('none');
    expect(await panelHidden(page)).toBe(false);
  }, 90_000);

  it('refuses a long GIF, and keeps the recording for another format', async () => {
    // Its own server, with a low GIF limit that the other tests must not hit.
    const short = tempDir('video-short');
    mkdirSync(join(short, '.walkthrough'), { recursive: true });
    writeFileSync(
      join(short, '.walkthrough', 'config.yaml'),
      `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\nhighlightMs: 0\nvideo:\n  maxGifSeconds: 5\n`,
    );
    const other = await startClient({
      UIWALK_PROJECT_DIR: short,
      TMPDIR: tempDir('video-short-tmp'),
    });
    try {
      await other.call('browser_open');
      await other.call('video', { action: 'start' });
      for (const item of ['mug', 'shirt', 'cap']) {
        await other.call('act', { action: 'click', selector: `[data-add="${item}"]` });
        await pause(1200);
      }
      const gif = await other.call('video', { action: 'stop', format: 'gif' });
      expect(gif.isError).toBe(true);
      expect(gif.text).toMatch(/GIF files of up to 5 seconds \(maxGifSeconds\)/);
      const status = await other.call('video', { action: 'status' });
      expect(status.text).toContain('stopped, but Walkthrough has not saved it');
      const webm = await other.call(
        'video',
        { action: 'stop', format: 'webm' },
        { timeoutMs: 120_000 },
      );
      expect(webm.isError, webm.text).toBe(false);
      expect((await other.call('video', { action: 'status' })).text).toBe('No video is recording.');
    } finally {
      await other.close();
    }
  }, 90_000);

  it('records a whole run with step captions, and the report plays it', async () => {
    const start = await mcp.call('run_start', { plan: 'cart-video' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('Walkthrough records this run as a video.');
    expect(start.text).toContain('Caption: Add the coffee mug');
    const runDir = join(project, /Run folder: (\S+)/.exec(start.text)?.[1] as string);
    await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
    await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
    await mcp.call('navigate', { url: '/cart' });
    await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
    const finish = await mcp.call('run_finish', {}, { timeoutMs: 120_000 });
    expect(finish.text).toContain('Saved the video (WEBM');
    expect(existsSync(join(runDir, 'video', 'run.webm'))).toBe(true);
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(run.videos[0]).toMatchObject({ file: 'video/run.webm', format: 'webm', whole: true });
    const report = readFileSync(join(runDir, 'report.html'), 'utf8');
    expect(report).toContain('<video controls preload="metadata" src="video/run.webm"');
    expect(readFileSync(join(runDir, 'report.md'), 'utf8')).toContain('[video/run.webm]');
  }, 120_000);
});

describe('video without H.264 in Chrome', () => {
  // Records one click with a server that acts as if Chrome cannot make MP4.
  async function fallback(env: Record<string, string>, name: string) {
    const other = await startClient({
      UIWALK_PROJECT_DIR: project,
      TMPDIR: tempDir(`video-${name}-tmp`),
      UIWALK_VIDEO_NO_CHROME_MP4: '1',
      ...env,
    });
    try {
      await other.call('browser_open');
      await other.call('video', { action: 'start', name });
      await other.call('act', { action: 'click', selector: '[data-add="mug"]' });
      const stop = await other.call(
        'video',
        { action: 'stop', format: 'mp4' },
        { timeoutMs: 120_000 },
      );
      expect(stop.isError, stop.text).toBe(false);
      const dir = join(project, '.walkthrough', 'runs');
      const day = readdirSync(dir).find((d) => d.startsWith('adhoc-')) as string;
      const files = readdirSync(join(dir, day, 'video')).filter((f) => f.includes(name));
      return { text: stop.text, files };
    } finally {
      await other.close();
    }
  }

  // No ffmpeg on this PATH and none in this cache folder.
  const bare = { PATH: '/usr/bin:/bin', UIWALK_CACHE_DIR: tempDir('video-empty-cache') };
  const bareHasFfmpeg = Boolean(
    findFfmpeg({ env: { PATH: bare.PATH }, cacheDir: bare.UIWALK_CACHE_DIR }),
  );

  it.skipIf(bareHasFfmpeg)(
    'saves WebM when ffmpeg is missing',
    async () => {
      const { text, files } = await fallback({ ...bare, UIWALK_FFMPEG: '' }, 'no-ffmpeg');
      expect(text).toContain('ffmpeg is missing, so the video is WebM');
      expect(text).toContain('setup ffmpeg');
      expect(files.some((f) => f.endsWith('.webm'))).toBe(true);
    },
    120_000,
  );

  it.skipIf(!findFfmpeg())(
    'makes MP4 with ffmpeg',
    async () => {
      const { text, files } = await fallback({}, 'with-ffmpeg');
      expect(text).toContain('This Chrome cannot make MP4, so ffmpeg');
      expect(files.some((f) => f.endsWith('.mp4'))).toBe(true);
    },
    120_000,
  );
});
