import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElementHandle, Frame } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { withCleanPage } from '../evidence/annotate.js';
import { slug } from '../text.js';
import type { A11yNode } from './axe.js';

export interface Shot {
  rule: string;
  target: string;
  // The file path, from the folder given to shootElements.
  file: string;
}

// The next free number for a11y/NNN-rule.jpg, so numbers go up across a whole run.
function nextNumber(dir: string): number {
  try {
    const numbers = readdirSync(dir)
      .map((f) => Number.parseInt(f.slice(0, 3), 10))
      .filter((n) => !Number.isNaN(n));
    return numbers.length ? Math.max(...numbers) + 1 : 1;
  } catch {
    return 1;
  }
}

async function findElement(tab: Tab, node: A11yNode): Promise<ElementHandle<Element> | null> {
  let frame: Frame | undefined = tab.page.mainFrame();
  if (node.frame) {
    const url = node.frame.url;
    frame = tab.page.frames().find((f) => f.url() === url || f.url() === url.split('#')[0]);
  }
  if (!frame) return null;
  return (await frame.$(node.target).catch(() => null)) as ElementHandle<Element> | null;
}

// Takes a cropped screenshot of the first element of each problem, with a red box
// around it. It draws the box itself, so it works without the panel (like in CI).
export async function shootElements(
  driver: Driver,
  tab: Tab,
  items: Array<{ rule: string; node: A11yNode }>,
  folder: { root: string; sub: string },
  max: number,
): Promise<Shot[]> {
  const dir = join(folder.root, folder.sub);
  mkdirSync(dir, { recursive: true });
  let number = nextNumber(dir);
  const shots: Shot[] = [];
  const page = tab.page;
  await withCleanPage(driver, tab, {}, async () => {
    for (const { rule, node } of items.slice(0, max)) {
      const handle = await findElement(tab, node);
      if (!handle) continue;
      try {
        await handle.scrollIntoView().catch(() => undefined);
        const box = await handle.boundingBox();
        if (!box || box.width < 1 || box.height < 1) continue;
        const viewport = await page.evaluate(() => ({
          x: window.scrollX,
          y: window.scrollY,
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        // Add the box to the top page, over the element.
        const outline = await page.evaluateHandle((b) => {
          const div = document.createElement('div');
          div.setAttribute('data-uiwalk-outline', '');
          Object.assign(div.style, {
            position: 'fixed',
            left: `${b.x - 3}px`,
            top: `${b.y - 3}px`,
            width: `${b.width + 6}px`,
            height: `${b.height + 6}px`,
            border: '3px solid #e11d48',
            borderRadius: '4px',
            zIndex: '2147483647',
            pointerEvents: 'none',
            boxSizing: 'border-box',
          });
          document.documentElement.append(div);
          return div;
        }, box);
        try {
          // Some space around the element, at least 360 by 200, inside the visible page.
          const width = Math.min(viewport.width, Math.max(360, box.width + 48));
          const height = Math.min(viewport.height, Math.max(200, box.height + 48));
          const x = Math.min(
            Math.max(0, box.x + box.width / 2 - width / 2),
            viewport.width - width,
          );
          const y = Math.min(
            Math.max(0, box.y + box.height / 2 - height / 2),
            viewport.height - height,
          );
          if (width < 1 || height < 1) continue;
          const jpg = await page.screenshot({
            type: 'jpeg',
            quality: 70,
            clip: { x: x + viewport.x, y: y + viewport.y, width, height },
            captureBeyondViewport: false,
          });
          const name = `${String(number).padStart(3, '0')}-${slug(rule, 40, 'rule')}.jpg`;
          writeFileSync(join(dir, name), jpg);
          shots.push({ rule, target: node.target, file: `${folder.sub}/${name}` });
          number += 1;
        } finally {
          await outline.evaluate((el) => (el as Element).remove()).catch(() => undefined);
          await outline.dispose().catch(() => undefined);
        }
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    }
  });
  return shots;
}
