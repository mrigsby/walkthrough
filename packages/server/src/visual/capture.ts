import type { ElementHandle } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { ToolError } from '../errors.js';
import { withCleanPage } from '../evidence/annotate.js';
import type { Rect } from '../panel/controller.js';

// Stops movement on the page, so two screenshots of the same page match.
export const FREEZE_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

export interface Capture {
  png: Buffer;
  masks: Rect[];
}

// Takes a steady screenshot for comparison, and finds the masked areas in it.
export async function steadyCapture(
  driver: Driver,
  tab: Tab,
  options: { handle?: ElementHandle<Element>; fullPage?: boolean; mask?: string[] },
): Promise<Capture> {
  const page = tab.page;
  const style = await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
  try {
    await page.evaluate(() => document.fonts?.ready.then(() => null)).catch(() => undefined);
    return await withCleanPage(driver, tab, {}, async () => {
      // Where the picture starts on the page, to place the masks in it.
      const origin = options.handle
        ? await options.handle.boundingBox()
        : options.fullPage
          ? { x: 0, y: 0 }
          : await page.evaluate(() => ({ x: 0, y: 0 }));
      if (options.handle && !origin)
        throw new ToolError('The element is not visible on the page.', 'not_visible');
      const scroll = options.fullPage
        ? await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
        : { x: 0, y: 0 };

      const masks: Rect[] = [];
      for (const selector of options.mask ?? []) {
        const handles = await page.$$(selector).catch(() => {
          throw new ToolError(`The mask selector "${selector}" is not valid.`, 'bad_selector');
        });
        for (const handle of handles) {
          const box = await handle.boundingBox();
          if (box) {
            masks.push({
              x: box.x - (origin?.x ?? 0) + scroll.x,
              y: box.y - (origin?.y ?? 0) + scroll.y,
              width: box.width,
              height: box.height,
            });
          }
          await handle.dispose();
        }
      }
      const png = options.handle
        ? await options.handle.screenshot({ type: 'png' })
        : await page.screenshot({ type: 'png', fullPage: options.fullPage ?? false });
      return { png: Buffer.from(png), masks };
    });
  } finally {
    await style?.evaluate((el) => el.remove()).catch(() => undefined);
  }
}
