import type { Page } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { FREEZE_CSS } from '../visual/capture.js';
import {
  type A11yNode,
  type A11yViolation,
  axeWorld,
  evalIn,
  runAxe,
  WITH_SELECTOR_DATA,
} from './axe.js';

export interface DarkModeResult {
  light?: A11yViolation;
  dark?: A11yViolation;
  // Elements with low contrast in dark mode only.
  darkOnly: A11yNode[];
  lightOnly: A11yNode[];
}

export interface ReflowResult {
  width: number;
  pageWidth: number;
  // True when the page scrolls sideways at this width.
  overflow: boolean;
  elements: A11yNode[];
}

// Waits for the page to draw two frames, then a short time for resize code.
async function settle(page: Page, ms: number): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
        ),
    )
    .catch(() => undefined);
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
}

function key(node: A11yNode): string {
  return `${node.frame?.selector ?? ''}|${node.target}`;
}

// Checks color contrast in light mode and in dark mode, and compares them.
// It changes this page only, and puts the color scheme back after.
export async function checkDarkMode(
  driver: Driver,
  tab: Tab,
  options: { frameAllowed?: (url: string) => boolean; clean?: (text: string) => string },
): Promise<DarkModeResult> {
  const page = tab.page;
  const style = await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
  const results: Partial<Record<'light' | 'dark', A11yViolation>> = {};
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await settle(page, 100);
      const run = await runAxe(page, { ...options, rules: ['color-contrast'] });
      results[scheme] = run.violations.find((v) => v.id === 'color-contrast');
    }
  } finally {
    const before = driver.emulation.colorScheme;
    await page
      .emulateMediaFeatures(
        before && before !== 'system' ? [{ name: 'prefers-color-scheme', value: before }] : [],
      )
      .catch(() => undefined);
    await style?.evaluate((el) => el.remove()).catch(() => undefined);
  }
  const lightKeys = new Set((results.light?.nodes ?? []).map(key));
  const darkKeys = new Set((results.dark?.nodes ?? []).map(key));
  return {
    ...results,
    darkOnly: (results.dark?.nodes ?? []).filter((n) => !lightKeys.has(key(n))),
    lightOnly: (results.light?.nodes ?? []).filter((n) => !darkKeys.has(key(n))),
  };
}

// Finds the elements that stick out past the right edge, in an isolated world.
const WIDE_ELEMENTS = `(${WITH_SELECTOR_DATA})(() => {
  const width = document.documentElement.clientWidth;
  const past = (el) => el.getBoundingClientRect().right > width + 1;
  const found = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('uiwalk-panel')) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || !past(el)) continue;
    // Keep the outer element only. Its children stick out because of it.
    if (el.parentElement && el.parentElement !== document.body && past(el.parentElement)) continue;
    found.push({ el, right: box.right });
  }
  found.sort((a, b) => b.right - a.right);
  return {
    pageWidth: document.documentElement.scrollWidth,
    width,
    elements: found.slice(0, 5).map(({ el, right }) => ({
      target: axe.utils.getSelector(el),
      html: el.outerHTML.slice(0, 2000),
      failureSummary: 'The element ends at ' + Math.round(right) + 'px. The screen is ' + width + 'px wide.',
    })),
  };
})`;

// Sets the page to 320px wide, looks for sideways scrolling (WCAG 1.4.10),
// then puts the size and the scroll position back.
export async function checkReflow(
  driver: Driver,
  tab: Tab,
  options: { clean?: (text: string) => string } = {},
): Promise<ReflowResult> {
  const page = tab.page;
  const saved = page.viewport();
  const scroll = await page
    .evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    .catch(() => ({ x: 0, y: 0 }));
  await driver.panel?.hide(tab.id, true);
  const cdp = await page.createCDPSession();
  try {
    await page.setViewport({
      width: 320,
      height: saved?.height ?? 800,
      deviceScaleFactor: saved?.deviceScaleFactor ?? 1,
      isMobile: saved?.isMobile ?? false,
      hasTouch: saved?.hasTouch ?? false,
    });
    await settle(page, 300);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const world = await axeWorld(cdp, frameTree.frame.id);
    const found = await evalIn<{ pageWidth: number; width: number; elements: A11yNode[] }>(
      cdp,
      world,
      WIDE_ELEMENTS,
    );
    for (const node of found.elements) {
      node.html = (options.clean ? options.clean(node.html) : node.html).slice(0, 300);
    }
    return {
      width: found.width,
      pageWidth: found.pageWidth,
      overflow: found.pageWidth > found.width + 1,
      elements: found.pageWidth > found.width + 1 ? found.elements : [],
    };
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.setViewport(saved).catch(() => undefined);
    await settle(page, 0);
    await page.evaluate((s) => window.scrollTo(s.x, s.y), scroll).catch(() => undefined);
    await driver.panel?.hide(tab.id, false);
  }
}
