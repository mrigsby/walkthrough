import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFfmpeg } from '../../src/downloads/ffmpeg.js';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { clickPanel, panelHidden, typeNotes, waitForPanel } from '../helpers/panel.js';
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
  const chromeFile = endpointFile();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('video-tmp'),
    UIWALK_FORCE_PANEL: '1',
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
  });
  expect((await mcp.call('browser_open')).isError).toBe(false);
  // The test connects to the same Chrome, to check the page while it records.
  chrome = await connectChrome(chromeFile, { defaultViewport: null });
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

describe('bug clips and slideshows', () => {
  const runFolder = (text: string) => join(project, /Run folder: (\S+)/.exec(text)?.[1] as string);

  it('saves a clip of the seconds before a failed step, and issue_draft lists it', async () => {
    const start = await mcp.call('run_start', { name: 'Bug clip run', mode: 'autonomous' });
    const runDir = runFolder(start.text);
    await mcp.call('navigate', { url: '/' });
    await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
    await mcp.call('navigate', { url: '/cart' });
    const failed = await mcp.call(
      'run_step',
      { title: 'Check the total', status: 'fail', actual: 'The total is wrong.' },
      { timeoutMs: 120_000 },
    );
    const seconds = Number(/Video of the last (\d+) seconds: (\S+)/.exec(failed.text)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(15);
    const clip = join(runDir, 'video', 'bug-check-the-total.gif');
    expect(MAGIC.gif?.(readFileSync(clip))).toBe(true);
    const draft = await mcp.call('issue_draft', { runId: runDir.split(/[/\\]/).pop() });
    expect(draft.text).toContain('bug-check-the-total.gif');
    expect(draft.text).toContain('a video of the seconds before the bug');
    expect(draft.text).toMatch(/\.har/);
    await mcp.call('run_finish');
    expect(readFileSync(join(runDir, 'report.html'), 'utf8')).toContain(
      '<img src="video/bug-check-the-total.gif"',
    );
  }, 120_000);

  it('saves a clip when the developer marks a bug in the panel', async () => {
    const start = await mcp.call('run_start', { name: 'Panel bug run', mode: 'interactive' });
    const runDir = runFolder(start.text);
    await mcp.call('navigate', { url: '/' });
    await mcp.call('act', { action: 'click', selector: '[data-add="shirt"]' });
    const reply = mcp.call(
      'ask_developer',
      {
        title: 'Add the shirt',
        didWhat: 'I clicked Add to cart on the shirt.',
        expected: 'The cart count goes up.',
        stepId: 'add-shirt',
      },
      { timeoutMs: 120_000 },
    );
    await waitForPanel(page, 'Add the shirt');
    await clickPanel(page, 'bug');
    await waitForPanel(page, 'Describe the bug in the notes');
    await typeNotes(page, 'The count did not change.');
    await clickPanel(page, 'bug');
    const result = await reply;
    expect(result.text).toMatch(/^status: bug/);
    expect(result.text).toMatch(/Video of the last \d+ seconds: .*bug-add-shirt\.gif/);
    expect(existsSync(join(runDir, 'video', 'bug-add-shirt.gif'))).toBe(true);
    await mcp.call('run_finish');
  }, 120_000);

  it('makes a slideshow of the screenshots of a run', async () => {
    const start = await mcp.call('run_start', { name: 'Slides', mode: 'autonomous' });
    const runDir = runFolder(start.text);
    await mcp.call('navigate', { url: '/' });
    await mcp.call('run_step', { title: 'The shop', status: 'pass', screenshot: true });
    await mcp.call('navigate', { url: '/help.html' });
    await mcp.call('run_step', { title: 'The help page', status: 'pass', screenshot: true });
    await mcp.call('run_finish');
    const slides = await mcp.call(
      'video',
      { action: 'slideshow', runId: runDir.split(/[/\\]/).pop() },
      { timeoutMs: 120_000 },
    );
    expect(slides.isError, slides.text).toBe(false);
    expect(slides.text).toContain('It shows 2 screenshot(s) from the run "Slides".');
    expect(slides.images).toBe(1);
    expect(MAGIC.gif?.(readFileSync(join(runDir, 'video', 'slideshow.gif')))).toBe(true);
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(run.videos.map((v: { name: string }) => v.name)).toContain('slideshow');
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
