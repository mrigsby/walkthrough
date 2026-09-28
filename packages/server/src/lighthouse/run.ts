import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FetchRouter } from '../browser/fetch-router.js';
import { killChrome, launchChrome, removeProfile } from '../browser/launch.js';
import { restoreSession, type SavedSession } from '../browser/sessions.js';
import type { Config } from '../config.js';
import type { MockRule } from '../devtools/mock-schema.js';
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

// Runs Lighthouse on one page in a new hidden Chrome with an empty profile. Chrome keeps
// things between pages, like a cache and failed favicons, so each page gets its own Chrome.
// A copy of the test's login goes in first, so the page stays logged in.
export async function auditPage(
  url: string,
  options: {
    config: Config;
    login?: SavedSession;
    isAllowed: (url: string) => boolean;
    rules: MockRule[];
    device: LhDevice;
    categories: LhCategory[];
    runDir: string;
    index: number;
    secrets: SecretStore;
    clean: (t: string) => string;
  },
): Promise<LighthouseCheck> {
  const lighthouse = await loadLighthouse();
  const { browser, profileDir } = await launchChrome(options.config, { background: true });
  let result: LighthouseResult;
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    // The same guard and mock rules as the test tabs.
    await FetchRouter.install(page, {
      isAllowed: options.isAllowed,
      onBlocked: () => undefined,
      rules: () => options.rules,
      onHit: () => undefined,
    });
    if (options.rules.length) await page.setCacheEnabled(false);
    if (options.login) await restoreSession({ page }, options.login, { everyLoad: true });
    result = (await lighthouse.default(
      url,
      {
        output: ['html', 'json'],
        logLevel: 'error',
        disableStorageReset: true,
        onlyCategories: options.categories,
      },
      options.device === 'desktop' ? lighthouse.desktopConfig : undefined,
      page,
    )) as LighthouseResult;
  } finally {
    await killChrome(browser);
    removeProfile(profileDir);
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
