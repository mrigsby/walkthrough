import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Driver, Tab } from '../browser/driver.js';
import { loadLighthouse } from '../downloads/lighthouse.js';
import { ToolError } from '../errors.js';
import type { SecretStore } from '../guards/secrets.js';
import { slug } from '../text.js';
import { type LighthouseCheck, summarizeLhr } from './audit.js';
import type { LhCategory, LhDevice } from './categories.js';

interface LighthouseResult {
  lhr: Parameters<typeof summarizeLhr>[0];
  report: string | string[];
}

// Runs Lighthouse on one page, in a new tab of the same login.
// The tab has no panel and no settings, so neither changes the scores.
// Storage stays, so the tab stays logged in.
export async function auditPage(
  driver: Driver,
  from: Tab,
  url: string,
  options: {
    device: LhDevice;
    categories: LhCategory[];
    runDir: string;
    index: number;
    secrets: SecretStore;
    clean: (t: string) => string;
  },
): Promise<LighthouseCheck> {
  const lighthouse = await loadLighthouse();
  const tab = await driver.newTab({
    isolated: from.login === 'main' ? undefined : from.login,
    bare: true,
  });
  let result: LighthouseResult;
  try {
    result = (await lighthouse.default(
      url,
      {
        output: ['html', 'json'],
        logLevel: 'error',
        disableStorageReset: true,
        onlyCategories: options.categories,
      },
      options.device === 'desktop' ? lighthouse.desktopConfig : undefined,
      tab.page,
    )) as LighthouseResult;
  } finally {
    await tab.page.close().catch(() => undefined);
    await from.page.bringToFront().catch(() => undefined);
  }
  const { lhr } = result;
  if (lhr.runtimeError) {
    throw new ToolError(
      `Lighthouse could not check ${url}: ${lhr.runtimeError.message}`,
      'lighthouse_failed',
    );
  }
  // Lighthouse's own report files. They hold page text, so secrets are hidden first.
  const [html, json] = Array.isArray(result.report) ? result.report : [result.report];
  const dir = join(options.runDir, 'lighthouse');
  mkdirSync(dir, { recursive: true });
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {}
  const base = `${String(options.index).padStart(2, '0')}-${slug(path, 40, 'home')}`;
  const files: LighthouseCheck['files'] = {};
  if (html) {
    writeFileSync(join(dir, `${base}.report.html`), options.secrets.redact(html));
    files.html = `lighthouse/${base}.report.html`;
  }
  if (json) {
    writeFileSync(join(dir, `${base}.report.json`), options.secrets.redact(json));
    files.json = `lighthouse/${base}.report.json`;
  }
  return {
    ...summarizeLhr(lhr, options.clean),
    at: new Date().toISOString(),
    device: options.device,
    files,
  };
}
