import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Browser,
  ChromeReleaseChannel,
  computeSystemExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from '@puppeteer/browsers';
import { ToolError } from '../errors.js';

// Where "uiwalk setup" saves its own copy of Chrome.
export const CACHE_DIR = process.env.UIWALK_CACHE_DIR ?? join(homedir(), '.cache', 'uiwalk');

export interface ChromeInfo {
  path: string;
  source: 'config' | 'system' | 'downloaded';
}

function systemChrome(): string | undefined {
  try {
    return computeSystemExecutablePath(
      { browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE },
      true,
    );
  } catch {
    return undefined;
  }
}

async function downloadedChrome(): Promise<string | undefined> {
  try {
    const installed = await getInstalledBrowsers({ cacheDir: CACHE_DIR });
    const chrome = installed
      .filter((b) => b.browser === Browser.CHROME)
      .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))[0];
    return chrome && existsSync(chrome.executablePath) ? chrome.executablePath : undefined;
  } catch {
    return undefined;
  }
}

// Finds Chrome: the config path first, then the installed Chrome, then our download.
export async function findChrome(configPath?: string): Promise<ChromeInfo | undefined> {
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new ToolError(
        `Walkthrough did not find Chrome at ${configPath}. This path comes from the "browser.executablePath" setting. Fix the path or remove the setting.`,
        'chrome_missing',
      );
    }
    return { path: configPath, source: 'config' };
  }
  const system = systemChrome();
  if (system) return { path: system, source: 'system' };
  const downloaded = await downloadedChrome();
  if (downloaded) return { path: downloaded, source: 'downloaded' };
  return undefined;
}

// The command that runs this server file, so the message works with or without npm.
const SELF = process.argv[1] ? `node "${process.argv[1]}"` : 'npx -y walkthrough-ui';

export const NO_CHROME_MESSAGE = `Walkthrough did not find Google Chrome. Install Chrome from https://www.google.com/chrome. Or, to download a copy for testing (about 170 MB), run: ${SELF} setup`;

// Downloads Chrome for Testing into the cache folder.
export async function installChrome(onProgress?: (percent: number) => void): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new ToolError('Chrome for Testing does not support this type of computer.');
  const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
  let last = -1;
  const result = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: CACHE_DIR,
    platform,
    downloadProgressCallback: (done, total) => {
      const percent = total ? Math.floor((done / total) * 100) : 0;
      if (percent !== last && percent % 10 === 0) {
        last = percent;
        onProgress?.(percent);
      }
    },
  });
  return result.executablePath;
}
