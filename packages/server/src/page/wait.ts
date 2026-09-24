import type { Tab } from '../browser/driver.js';
import { ToolError } from '../errors.js';

export interface WaitInput {
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  networkIdle?: boolean;
  ms?: number;
  timeoutMs?: number;
}

// Waits for something on the page. Only one condition per call.
export async function waitFor(tab: Tab, input: WaitInput): Promise<string> {
  const timeout = input.timeoutMs ?? 10_000;
  const page = tab.page;
  try {
    if (input.text !== undefined) {
      await page.waitForFunction(
        (t) => document.body?.innerText.includes(t),
        { timeout },
        input.text,
      );
      return `The text "${input.text}" is on the page.`;
    }
    if (input.textGone !== undefined) {
      await page.waitForFunction(
        (t) => !document.body?.innerText.includes(t),
        { timeout },
        input.textGone,
      );
      return `The text "${input.textGone}" is gone from the page.`;
    }
    if (input.selector) {
      await page.waitForSelector(input.selector, { timeout, visible: true });
      return `An element matching "${input.selector}" is visible.`;
    }
    if (input.url) {
      const wanted = input.url;
      await page.waitForFunction((u) => location.href.includes(u), { timeout }, wanted);
      return `The page URL is now ${page.url()}.`;
    }
    if (input.networkIdle) {
      await page.waitForNetworkIdle({ idleTime: 500, timeout });
      return 'The page finished loading. No requests are running.';
    }
    if (input.ms !== undefined) {
      const ms = Math.min(Math.max(input.ms, 0), 30_000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `Waited ${ms} ms.`;
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ToolError(`Waited ${timeout} ms, but the condition did not happen.`, 'timeout');
    }
    throw error;
  }
  throw new ToolError(
    'Give one thing to wait for: text, textGone, selector, url, networkIdle, or ms.',
    'bad_input',
  );
}
