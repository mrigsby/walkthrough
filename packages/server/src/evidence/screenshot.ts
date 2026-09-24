import { join, relative } from 'node:path';
import type { ElementHandle } from 'puppeteer-core';
import type { Tab } from '../browser/driver.js';
import { fileStamp } from '../project-files.js';

export interface Shot {
  path: string;
  relativePath: string;
  preview: string;
}

// Saves a full-size PNG, and returns a small JPEG preview for the agent.
export async function takeScreenshot(
  tab: Tab,
  dir: string,
  projectDir: string,
  options: { handle?: ElementHandle<Element>; fullPage?: boolean; label?: string },
): Promise<Shot> {
  const path = join(dir, `${fileStamp(options.label)}.png`);
  const { handle, fullPage = false } = options;

  if (handle) {
    await handle.scrollIntoView().catch(() => undefined);
    await handle.screenshot({ path });
  } else {
    await tab.page.screenshot({ path, fullPage });
  }

  // The preview shows what is on screen, or the element. It keeps the reply small.
  const preview = handle
    ? await handle.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' })
    : await tab.page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });

  return { path, relativePath: relative(projectDir, path), preview: preview as string };
}
