import type { ElementHandle } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import type { Rect } from '../panel/controller.js';

// Hides typed secrets on screen. Password fields already show dots.
async function maskSecretFields(fields: ElementHandle[]): Promise<() => Promise<void>> {
  const masked: Array<{ handle: ElementHandle; previous: string }> = [];
  for (const handle of fields) {
    const previous = await handle
      .evaluate((el) => {
        const input = el as HTMLInputElement;
        if (!input.isConnected || input.type === 'password') return null;
        const old = input.style.getPropertyValue('-webkit-text-security');
        input.style.setProperty('-webkit-text-security', 'disc', 'important');
        return old;
      })
      .catch(() => null);
    if (previous !== null) masked.push({ handle, previous });
  }
  return async () => {
    for (const { handle, previous } of masked) {
      await handle
        .evaluate((el, old) => {
          const input = el as HTMLElement;
          if (old) input.style.setProperty('-webkit-text-security', old);
          else input.style.removeProperty('-webkit-text-security');
        }, previous)
        .catch(() => undefined);
    }
  };
}

// Gets the page ready for a screenshot: no panel, no highlight, secrets masked.
// An optional red box marks one element. It has no text label, so it does not cover
// page text near the element. The reply names the element instead.
export async function withCleanPage<T>(
  driver: Driver,
  tab: Tab,
  options: { annotate?: Rect },
  capture: () => Promise<T>,
): Promise<T> {
  const panel = driver.panel;
  await panel?.hide(tab.id, true);
  if (options.annotate) await panel?.annotate(tab.id, options.annotate);
  const restore = await maskSecretFields(driver.secretFields);
  // Let the page draw the changes before the capture.
  await tab.page
    .evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
    .catch(() => undefined);
  try {
    return await capture();
  } finally {
    await restore();
    if (options.annotate) await panel?.annotate(tab.id, null);
    await panel?.hide(tab.id, false);
  }
}

// The box of an element on screen, if it is still on the page.
export async function elementRect(handle: ElementHandle<Element>): Promise<Rect | undefined> {
  const connected = await handle.evaluate((el) => el.isConnected).catch(() => false);
  if (!connected) return undefined;
  const box = await handle.boundingBox().catch(() => null);
  return box ?? undefined;
}
