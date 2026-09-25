import { mkdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import type { ElementHandle } from 'puppeteer-core';
import type { Tab } from '../browser/driver.js';
import { fileStamp } from '../project-files.js';

export interface Shot {
  path: string;
  relativePath: string;
  preview: string;
}

// The image type from the file extension.
export function imageType(path: string): 'png' | 'jpeg' | 'webp' {
  const ext = extname(path).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.webp' ? 'webp' : 'png';
}

// Saves a full-size image, and returns a small JPEG preview for the agent.
// With "path", it saves to that exact file and replaces it. Otherwise it makes a name in dir.
export async function takeScreenshot(
  tab: Tab,
  dir: string,
  projectDir: string,
  options: {
    handle?: ElementHandle<Element>;
    fullPage?: boolean;
    label?: string;
    path?: string;
  },
): Promise<Shot> {
  const path = options.path ?? join(dir, `${fileStamp(options.label)}.png`);
  const { handle, fullPage = false } = options;
  const type = imageType(path);
  if (options.path) {
    mkdirSync(dirname(path), { recursive: true });
    // Web fonts change the text, so wait for them.
    await tab.page.evaluate(() => document.fonts?.ready.then(() => null)).catch(() => undefined);
  }

  if (handle) {
    await handle.scrollIntoView().catch(() => undefined);
    await handle.screenshot({ path, type });
  } else {
    await tab.page.screenshot({ path, type, fullPage });
  }

  // The preview shows what is on screen, or the element. It keeps the reply small.
  const preview = handle
    ? await handle.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' })
    : await tab.page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });

  return { path, relativePath: relative(projectDir, path), preview: preview as string };
}
