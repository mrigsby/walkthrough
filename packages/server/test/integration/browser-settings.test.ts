import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChrome, endpointFile } from '../helpers/chrome.js';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Browser settings from a plan: a new browser when they change, the language, downloads,
// and an unpacked extension.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let chromeFile: string;

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('browser-settings');
  const plans = join(project, '.walkthrough', 'plans');
  mkdirSync(plans, { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\n`,
  );
  writeFileSync(
    join(plans, 'german.yaml'),
    'name: German\nmode: autonomous\nbrowser: { language: de-DE, downloads: true }\nsteps:\n  - do: Look\n',
  );
  mkdirSync(join(project, 'ext'));
  writeFileSync(
    join(project, 'ext', 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Test extension',
      version: '1.0',
      content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'], run_at: 'document_idle' }],
    }),
  );
  writeFileSync(
    join(project, 'ext', 'c.js'),
    'const p = document.createElement("p"); p.textContent = "The test extension is here."; document.body.append(p);',
  );
  writeFileSync(
    join(plans, 'extension.yaml'),
    'name: Extension\nmode: autonomous\nbrowser: { extensions: [ext] }\nsteps:\n  - do: Look\n',
  );
  writeFileSync(
    join(plans, 'outside.yaml'),
    'name: Outside\nmode: autonomous\nbrowser: { extensions: [../elsewhere] }\nsteps:\n  - do: Look\n',
  );
  chromeFile = endpointFile();
  mcp = await startClient({
    UIWALK_PROJECT_DIR: project,
    TMPDIR: tempDir('browser-settings-tmp'),
    UIWALK_DEBUG_ENDPOINT_FILE: chromeFile,
  });
  const open = await mcp.call('browser_open');
  expect(open.isError, open.text).toBe(false);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

async function page(): Promise<{ chrome: Browser; page: Page }> {
  const chrome = await connectChrome(chromeFile, { defaultViewport: null });
  const found = (await chrome.pages()).find((p) => p.url().startsWith(demo.base)) as Page;
  return { chrome, page: found };
}

describe('browser settings in plans', () => {
  it('starts a new browser for the language, and saves downloads in the run', async () => {
    const start = await mcp.call('run_start', { plan: 'german' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('so the run started in a new browser');
    expect(start.text).toContain('language de-DE, downloads to the run folder');
    const runDir = /Run folder: (\S+)/.exec(start.text)?.[1] as string;
    const { chrome, page: tab } = await page();
    try {
      expect(await tab.evaluate(() => navigator.languages[0])).toBe('de-DE');
      await tab.evaluate(() => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['hello'], { type: 'text/plain' }));
        a.download = 'notes.txt';
        document.body.append(a);
        a.click();
      });
      const file = join(project, runDir, 'downloads', 'notes.txt');
      for (let i = 0; i < 50 && !existsSync(file); i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(readFileSync(file, 'utf8')).toBe('hello');
    } finally {
      await chrome.disconnect();
    }
    await mcp.call('run_step', { stepId: 'step-1', status: 'pass' });
    await mcp.call('run_finish');
    const run = JSON.parse(readFileSync(join(project, runDir, 'run.json'), 'utf8'));
    expect(run.browser).toEqual({ language: 'de-DE' });
    expect(run.downloads?.[0]?.file).toBe('downloads/notes.txt');
    expect(readFileSync(join(project, runDir, 'report.md'), 'utf8')).toContain('## Downloads');
  }, 60_000);

  it('loads an extension from the project, and refuses one from outside', async () => {
    const outside = await mcp.call('run_start', { plan: 'outside' });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('is outside the project');
    const start = await mcp.call('run_start', { plan: 'extension' });
    expect(start.isError, start.text).toBe(false);
    let text = '';
    for (let i = 0; i < 30 && !text.includes('The test extension is here.'); i++) {
      text = (await mcp.call('read', { selector: 'body' })).text;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(text).toContain('The test extension is here.');
    await mcp.call('run_finish');
  }, 60_000);
});
