import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { Config } from '../config.js';
import { ToolError } from '../errors.js';
import { findChrome, NO_CHROME_MESSAGE } from './chrome.js';

export interface Launched {
  browser: Browser;
  profileDir: string;
  chromePath: string;
}

// Starts a new Chrome with a fresh, temporary profile.
export async function launchChrome(config: Config): Promise<Launched> {
  const chrome = await findChrome(config.browser.executablePath);
  if (!chrome) throw new ToolError(NO_CHROME_MESSAGE, 'chrome_missing');

  // A new profile each time, so two sessions never lock each other.
  const profileDir = mkdtempSync(join(tmpdir(), 'uiwalk-profile-'));
  const headless = config.browser.headless;
  try {
    const browser = await puppeteer.launch({
      executablePath: chrome.path,
      headless,
      slowMo: config.browser.slowMo,
      userDataDir: profileDir,
      // A visible window keeps its own size. Headless gets a fixed size.
      defaultViewport: headless ? { width: 1280, height: 800 } : null,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,900',
        // For tests only: a fixed port lets a test connect to this Chrome.
        ...(process.env.UIWALK_DEBUG_PORT
          ? [`--remote-debugging-port=${process.env.UIWALK_DEBUG_PORT}`]
          : []),
      ],
      // Our own shutdown code closes Chrome and removes the profile.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    return { browser, profileDir, chromePath: chrome.path };
  } catch (error) {
    removeProfile(profileDir);
    throw new ToolError(`Chrome did not start: ${(error as Error).message}`, 'launch_failed');
  }
}

export function removeProfile(dir: string): void {
  try {
    // Retry, because Chrome helpers can still be writing for a moment.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

// Stops a Chrome we started and waits until it is really gone.
export async function killChrome(browser: Browser): Promise<void> {
  const proc = browser.process();
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGKILL');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
}
