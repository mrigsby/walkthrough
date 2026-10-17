import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// The page size of runs. Visible windows only test with UIWALK_VISIBLE_TESTS=1,
// because CI has no screen.
let demo: Awaited<ReturnType<typeof startDemoServer>>;

beforeAll(async () => {
  demo = await startDemoServer();
});
afterAll(() => demo?.stop());

async function setup(name: string, visible: boolean, browser = '') {
  const project = tempDir(name);
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n${browser}`,
  );
  writeFileSync(
    join(project, '.walkthrough', 'plans', 'small.yaml'),
    'name: Small\nmode: autonomous\nbrowser: { window: { width: 1024, height: 700 } }\nsteps:\n  - do: Look\n',
  );
  writeFileSync(
    join(project, '.walkthrough', 'plans', 'plain.yaml'),
    'name: Plain\nmode: autonomous\nsteps:\n  - do: Look\n',
  );
  const chromeFile = endpointFile();
  const mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir(`${name}-tmp`),
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
    ...(visible ? { UIWALK_HEADLESS: '0' } : {}),
  });
  const open = await mcp.call('browser_open');
  expect(open.isError, open.text).toBe(false);
  const chrome: Browser = await connectChrome(chromeFile, { defaultViewport: null });
  const page = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
  const size = () =>
    page.evaluate(() => ({ width: innerWidth, height: innerHeight, outer: outerWidth }));
  return { mcp, chrome, page, size };
}

describe('page size in headless Chrome', () => {
  it('uses the plan size for a run, and the config size after it', async () => {
    const { mcp, chrome, size, page } = await setup('window-headless', false);
    const orientationOf = () =>
      page.evaluate(() => ({
        type: screen.orientation.type,
        width: innerWidth,
        height: innerHeight,
      }));
    try {
      expect(await size()).toMatchObject({ width: 1280, height: 800 });
      const start = await mcp.call('run_start', { plan: 'small' });
      expect(start.isError, start.text).toBe(false);
      expect(await size()).toMatchObject({ width: 1024, height: 700 });
      // "default" goes back to the page size of the run, not to 1280 x 800.
      await mcp.call('emulate', { device: 'desktop' });
      expect(await size()).toMatchObject({ width: 1440, height: 900 });
      await mcp.call('emulate', { device: 'default' });
      expect(await size()).toMatchObject({ width: 1024, height: 700 });
      // A phone on its side, then upright again.
      await mcp.call('emulate', { device: 'mobile', orientation: 'landscape' });
      let turned = await orientationOf();
      expect(turned.type).toBe('landscape-primary');
      expect(turned.width).toBeGreaterThan(turned.height);
      await mcp.call('emulate', { orientation: 'portrait' });
      turned = await orientationOf();
      expect(turned.type).toBe('portrait-primary');
      expect(turned.width).toBeLessThan(turned.height);
      await mcp.call('emulate', { device: 'default', orientation: 'landscape' });
      const alone = await mcp.call('emulate', { orientation: 'portrait' });
      expect(alone.text).toContain('An orientation works only with a device');
      await mcp.call('run_finish');
      await mcp.call('run_start', { plan: 'plain' });
      expect(await size()).toMatchObject({ width: 1280, height: 800 });
      await mcp.call('run_finish');
    } finally {
      await chrome.disconnect();
      await mcp.close();
    }
  }, 60_000);
});

describe.skipIf(process.env.UIWALK_VISIBLE_TESTS !== '1')('visible windows', () => {
  it('fits the window to the page, also for devices and new logins', async () => {
    const { mcp, chrome, page, size } = await setup('window-visible', true);
    try {
      // The window can open on a smaller screen. Then the page area is what fits.
      const room = await page.evaluate(() => ({
        width: screen.availWidth - (outerWidth - innerWidth),
        height: screen.availHeight - (outerHeight - innerHeight),
      }));
      const fit = (width: number, height: number) => ({
        width: Math.min(width, room.width),
        height: Math.min(height, room.height),
      });
      expect(await size()).toMatchObject(fit(1280, 800));
      const desktop = await mcp.call('emulate', { device: 'desktop' });
      expect(desktop.isError, desktop.text).toBe(false);
      const big = await size();
      expect(big).toMatchObject({ width: 1440, height: 900 });
      // The window grew as far as the screen lets it. A small screen gets a note.
      expect(big.outer).toBeGreaterThanOrEqual(fit(1440, 900).width);
      if (room.width < 1440 || room.height < 900) expect(desktop.text).toContain('too small');
      await mcp.call('emulate', { device: 'mobile' });
      expect((await size()).width).toBe(393);
      // On its side, the window fits the wide, low page.
      await mcp.call('emulate', { orientation: 'landscape' });
      const side = await size();
      expect(side.width).toBeGreaterThan(side.height);
      expect(side.outer).toBeGreaterThanOrEqual(side.width);
      await mcp.call('emulate', { orientation: 'portrait' });
      await mcp.call('emulate', { device: 'default' });
      expect(await size()).toMatchObject(fit(1280, 800));

      const other = await mcp.call('tabs', { action: 'new', isolated: true, url: '/' });
      expect(other.isError, other.text).toBe(false);
      const pages = await chrome.pages();
      const second = pages.find((p) => p !== page && p.url().startsWith(demo.base)) as Page;
      const secondRoom = await second.evaluate(() => ({
        width: screen.availWidth - (outerWidth - innerWidth),
        height: screen.availHeight - (outerHeight - innerHeight),
      }));
      expect(await second.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
        width: Math.min(1280, secondRoom.width),
        height: Math.min(800, secondRoom.height),
      });
    } finally {
      await chrome.disconnect();
      await mcp.close();
    }
  }, 60_000);
});

describe.skipIf(process.env.UIWALK_VISIBLE_TESTS !== '1')('DevTools', () => {
  it('keeps the page size next to docked DevTools, and DevTools is not a tab', async () => {
    const { mcp, chrome, size } = await setup(
      'devtools-right',
      true,
      'browser:\n  devtools: { dock: right }\n',
    );
    try {
      const page = await size();
      const screenWidth = await chrome
        .pages()
        .then((pages) => pages[0]?.evaluate(() => screen.availWidth) ?? 0);
      // The window grew by the width of DevTools, or to the width of the screen.
      expect(page.height).toBeLessThanOrEqual(800);
      expect(page.outer).toBeGreaterThan(page.width);
      expect(page.width === 1280 || page.outer >= screenWidth - 1).toBe(true);
      const tabs = await mcp.call('tabs', { action: 'list' });
      expect(tabs.text).not.toContain('devtools://');
    } finally {
      await chrome.disconnect();
      await mcp.close();
    }
  }, 60_000);

  it('lets the device toolbar control the page size', async () => {
    const { mcp, chrome } = await setup(
      'devtools-toolbar',
      true,
      'browser:\n  devtools: { dock: right, deviceToolbar: true }\n',
    );
    try {
      const reply = await mcp.call('emulate', { device: 'mobile', colorScheme: 'dark' });
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.text).toContain("DevTools' device toolbar is on");
      expect(reply.text).toContain('color scheme: dark');
    } finally {
      await chrome.disconnect();
      await mcp.close();
    }
  }, 60_000);
});
