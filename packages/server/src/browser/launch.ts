import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { Config } from '../config.js';
import { ToolError } from '../errors.js';
import { findChrome, NO_CHROME_MESSAGE } from './chrome.js';

// Chrome settings for the new profile. Chrome must not offer to save passwords or check
// them for leaks. Its "Change your password" dialog blocks all clicks in the tab, and
// test passwords are often in leak lists.
export const PROFILE_PREFS = {
  credentials_enable_service: false,
  profile: { password_manager_enabled: false, password_manager_leak_detection: false },
};

export function writeProfilePrefs(profileDir: string): void {
  mkdirSync(join(profileDir, 'Default'), { recursive: true });
  writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify(PROFILE_PREFS));
}

export interface Launched {
  browser: Browser;
  profileDir: string;
  chromePath: string;
}

// Starts a new Chrome with a fresh, temporary profile.
// "background" is a hidden Chrome for work the developer does not watch, like Lighthouse checks.
export async function launchChrome(
  config: Config,
  options: { background?: boolean } = {},
): Promise<Launched> {
  const chrome = await findChrome(config.browser.executablePath);
  if (!chrome) throw new ToolError(NO_CHROME_MESSAGE, 'chrome_missing');

  // A new profile each time, so two sessions never lock each other.
  const profileDir = mkdtempSync(join(tmpdir(), 'uiwalk-profile-'));
  writeProfilePrefs(profileDir);
  const headless = options.background || config.browser.headless;
  try {
    const browser = await puppeteer.launch({
      executablePath: chrome.path,
      headless,
      slowMo: options.background ? 0 : config.browser.slowMo,
      userDataDir: profileDir,
      // A visible window keeps its own size. Headless gets a fixed size.
      defaultViewport: headless ? { width: 1280, height: 800 } : null,
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
      // Our own shutdown code closes Chrome and removes the profile.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    // For tests only: the exact address of this Chrome, so a test can connect to it.
    const endpointFile = process.env.UIWALK_DEBUG_ENDPOINT_FILE;
    if (endpointFile && !options.background) writeFileSync(endpointFile, browser.wsEndpoint());
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Stops a Chrome we started and waits until it is really gone.
// First it asks Chrome to close, so Chrome can remove its own temp files.
export async function killChrome(browser: Browser): Promise<void> {
  const proc = browser.process();
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  await Promise.race([browser.close().catch(() => undefined), wait(1500)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  await Promise.race([exited, wait(2000)]);
}
