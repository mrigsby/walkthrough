import { isAbsolute } from 'node:path';
import { resolveDevice } from '../browser/devices.js';
import type { Run, RunStep } from '../run/run-store.js';

export interface ExportResult {
  code: string;
  actions: number;
  checks: number;
  // Screenshot files that the script saves.
  captures: string[];
  handChecks: number;
  missingSelectors: string[];
  secrets: string[];
  failedSteps: string[];
}

const SECRET = /^\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

// Text in an expectation that a script can check: quoted text and money amounts.
export function checkableText(expect: string): string[] {
  const found = new Set<string>();
  for (const m of expect.matchAll(/"([^"]{1,80})"/g)) if (m[1]) found.add(m[1]);
  for (const m of expect.matchAll(/(?:\$|€|£)\d[\d,]*(?:\.\d+)?/g)) found.add(m[0]);
  return [...found];
}

const js = (value: string) => JSON.stringify(value);

// The address of an action as code, relative to BASE_URL when it can be.
function urlCode(url: string, baseUrl?: string): string {
  try {
    const parsed = new URL(url);
    if (baseUrl && parsed.origin === new URL(baseUrl).origin) {
      return `new URL(${js(parsed.pathname + parsed.search + parsed.hash)}, BASE_URL).href`;
    }
  } catch {}
  return js(url);
}

function frameCode(frameUrl?: string): string {
  if (!frameUrl) return 'page';
  let part = frameUrl;
  try {
    part = new URL(frameUrl).pathname;
  } catch {}
  return `frame(${js(part)})`;
}

function actionCode(
  action: RunStep['actions'][number],
  secrets: Set<string>,
  secretFields: Set<string>,
  baseUrl?: string,
): string[] {
  const where = frameCode(action.frameUrl);
  const sel = action.selector ? js(action.selector) : '';
  const value = (() => {
    const v = action.value ?? '';
    const secret = SECRET.exec(v);
    if (secret?.[1]) {
      secrets.add(secret[1]);
      // Screenshots hide the text of these fields.
      if (action.selector && !action.frameUrl) secretFields.add(action.selector);
      return `process.env.${secret[1]}`;
    }
    return js(v);
  })();
  switch (action.action) {
    case 'navigate':
      return [
        `await page.goto(${urlCode(action.value ?? action.label, baseUrl)}, { waitUntil: 'load' });`,
      ];
    case 'click':
      return [`await ${where}.locator(${sel}).click();`];
    case 'dblclick':
      return [`await ${where}.locator(${sel}).click({ count: 2 });`];
    case 'hover':
      return [`await ${where}.locator(${sel}).hover();`];
    case 'fill':
      return [`await ${where}.locator(${sel}).fill(${value});`];
    case 'select':
      return [`await selectOption(${where}, ${sel}, ${value});`];
    case 'check':
    case 'uncheck':
      return [`await setChecked(${where}, ${sel}, ${action.action === 'check'});`];
    case 'press':
      return [...(sel ? [`await ${where}.focus(${sel});`] : []), `await pressKeys(${value});`];
    case 'scroll':
      return sel
        ? [`await (await ${where}.$(${sel}))?.scrollIntoView();`]
        : [
            `await page.mouse.wheel({ deltaY: ${action.value === 'up' ? -600 : Number(action.value) || 600} });`,
          ];
    case 'upload':
      return [
        `await (await ${where}.$(${sel}))?.uploadFile(${(action.files ?? []).map((f) => `resolve(PROJECT_DIR, ${js(f)})`).join(', ')});`,
      ];
  }
}

// The screen and color scheme of the run. Without a device, a fixed size, so screenshots match.
function setupCode(emulation: Run['emulation']): string[] {
  const lines: string[] = [];
  let resolved: ReturnType<typeof resolveDevice>;
  try {
    resolved = emulation?.device ? resolveDevice(emulation.device) : undefined;
  } catch {
    lines.push(`// Walkthrough does not know the device "${emulation?.device}". Using 1280x800.`);
  }
  if (resolved?.device) {
    lines.push(
      `// Screen: ${resolved.label}.`,
      `await page.setUserAgent(${js(resolved.device.userAgent)});`,
      `await page.setViewport(${JSON.stringify(resolved.device.viewport)});`,
    );
  } else {
    const size = resolved?.size ?? { width: 1280, height: 800 };
    lines.push(
      `// Screen: ${resolved?.label ?? 'default'}.`,
      `await page.setViewport({ width: ${size.width}, height: ${size.height}, deviceScaleFactor: 1 });`,
    );
  }
  const scheme = emulation?.colorScheme;
  if (scheme === 'light' || scheme === 'dark') {
    lines.push(
      `await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: ${js(scheme)} }]);`,
    );
  }
  return lines;
}

// The screenshot helpers. Only scripts with screenshots get them.
function captureHelpers(secretFields: string[]): string {
  return `
// SHOT=cart,settings saves only those screenshots. The steps still run.
// Use the file name, with or without the extension, or the end of the path.
const SHOT = (process.env.SHOT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// Fields filled from secrets. Screenshots hide their text.
const SECRET_FIELDS = ${JSON.stringify(secretFields)};
let shots = 0;

function wanted(file) {
  if (SHOT.length === 0) return true;
  const path = file.split(sep).join('/');
  return SHOT.some((s) => s === basename(file) || s === basename(file, extname(file)) || path.endsWith(\`/\${s}\`));
}

// Saves a screenshot to an exact file, and replaces the file if it exists.
async function capture(file, options = {}) {
  if (!wanted(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  await page.evaluate(() => document.fonts?.ready.then(() => null)).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
  for (const selector of SECRET_FIELDS) {
    await page
      .$$eval(selector, (els) => els.forEach((el) => el.style.setProperty('-webkit-text-security', 'disc', 'important')))
      .catch(() => {});
  }
  if (options.selector) {
    const handle = await page.waitForSelector(options.selector);
    await handle.scrollIntoView();
    await handle.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: Boolean(options.fullPage) });
  }
  shots += 1;
  console.log(\`shot  \${relative(PROJECT_DIR, file)}\`);
}
`;
}

// Writes a plain Puppeteer script that repeats a run, for CI or a quick check.
export function exportScript(
  run: Run,
  options: { installedChrome?: boolean; exportedAt?: string } = {},
): ExportResult {
  const secrets = new Set<string>();
  const secretFields = new Set<string>();
  const missingSelectors: string[] = [];
  const captures: string[] = [];
  const failedSteps = run.steps
    .filter((s) => ['bug', 'fail', 'blocked'].includes(s.status))
    .map((s) => `${s.index}. ${s.title}`);
  let actions = 0;
  let checks = 0;
  let handChecks = 0;
  let lastUrl = run.baseUrl ?? '';
  const body: string[] = [];

  for (const step of run.steps) {
    const shots = step.captures ?? [];
    if ((step.status === 'pending' || step.status === 'skip') && shots.length === 0) continue;
    const lines: string[] = [];
    for (const action of step.actions) {
      if (action.url && action.url !== lastUrl) {
        lines.push(`await reach(${urlCode(action.url, run.baseUrl)});`);
        lastUrl = action.url;
      }
      const needsSelector = !['scroll', 'navigate', 'press'].includes(action.action);
      if (!action.selector && needsSelector) {
        missingSelectors.push(`Step ${step.index}: ${action.label}`);
        lines.push(
          `// Fix by hand: Walkthrough found no stable selector for ${action.label.replace(/\n/g, ' ')}.`,
        );
        continue;
      }
      lines.push(...actionCode(action, secrets, secretFields, run.baseUrl));
      actions += 1;
      // After a page load, the next action starts at the new address.
      if (action.action === 'navigate') lastUrl = action.value ?? lastUrl;
    }
    if (step.expect) {
      const texts = checkableText(step.expect);
      for (const text of texts) lines.push(`await expectText(${js(text)});`);
      checks += texts.length;
      if (texts.length === 0) {
        lines.push(`// Check by hand: ${step.expect.replace(/\n/g, ' ')}`);
        handChecks += 1;
      }
    }
    for (const shot of shots) {
      if (shot.element && !shot.selector) {
        missingSelectors.push(`Step ${step.index}: screenshot of ${shot.element}`);
        lines.push(
          `// Fix by hand: Walkthrough found no stable selector for the screenshot of ${shot.element.replace(/\n/g, ' ')} (${shot.path}).`,
        );
        continue;
      }
      const where = isAbsolute(shot.path)
        ? js(shot.path)
        : `resolve(PROJECT_DIR, ${js(shot.path.split('\\').join('/'))})`;
      if (isAbsolute(shot.path))
        lines.push('// This folder is outside the project. It only works on this computer.');
      const options = [
        shot.selector ? `selector: ${js(shot.selector)}` : '',
        shot.fullPage ? 'fullPage: true' : '',
      ].filter(Boolean);
      lines.push(`await capture(${where}${options.length ? `, { ${options.join(', ')} }` : ''});`);
      captures.push(shot.path);
    }
    if (lines.length === 0) continue;
    const title = `${step.index}. ${step.title}`;
    body.push(
      `  await step(${js(title)}, async () => {`,
      ...lines.map((l) => `    ${l}`),
      '  });',
      '',
    );
  }

  const pkg = options.installedChrome ? 'puppeteer-core' : 'puppeteer';
  const launch = options.installedChrome
    ? "{ channel: 'chrome', headless: !process.env.HEADFUL }"
    : '{ headless: !process.env.HEADFUL }';
  const secretList = [...secrets];
  const hasShots = captures.length > 0;
  const code = `#!/usr/bin/env node
// Walkthrough export of the run "${run.name.replace(/\n/g, ' ')}" (${run.id}).
// It repeats the actions from the run and checks the text that the expectations quote.
// Needs: npm install --save-dev ${pkg}${options.installedChrome ? ' (and Google Chrome)' : ''}
// Run:   node ${'<this file>'}
// Set BASE_URL to test another address. Set HEADFUL=1 to watch the browser.
${hasShots ? `// It saves ${captures.length} screenshot(s). Set SHOT=<name> to save only some of them.\n` : ''}${secretList.length ? `// Secrets come from environment variables: ${secretList.join(', ')}.\n` : ''}${hasShots ? "import { mkdirSync } from 'node:fs';\nimport { basename, dirname, extname, relative, resolve, sep } from 'node:path';" : "import { dirname, resolve } from 'node:path';"}
import { fileURLToPath } from 'node:url';
import puppeteer from '${pkg}';

const BASE_URL = process.env.BASE_URL ?? ${js(run.baseUrl ?? 'http://localhost:3000')};
// The project folder: this file is in .walkthrough/exports.
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const name of ${JSON.stringify(secretList)}) {
  if (!process.env[name]) throw new Error(\`Set the \${name} environment variable first.\`);
}

const browser = await puppeteer.launch(${launch});
const page = await browser.newPage();
page.setDefaultTimeout(10_000);
${setupCode(run.emulation).join('\n')}
// Accept confirm dialogs, like the run did.
page.on('dialog', (dialog) => void dialog.accept());

// Runs one step, and names the step if it fails.
async function step(name, fn) {
  try {
    await fn();
    console.log(\`ok    \${name}\`);
  } catch (error) {
    throw new Error(\`Step \${name}: \${error.message}\`);
  }
}

// Goes to an address, unless the last click already went there.
async function reach(url) {
  const want = new URL(url);
  const here = () => new URL(page.url());
  if (here().pathname === want.pathname && here().search === want.search) return;
  try {
    await page.waitForFunction((path) => location.pathname + location.search === path, { timeout: 3000 }, want.pathname + want.search);
  } catch {
    await page.goto(want.href, { waitUntil: 'load' });
  }
}

// Waits for text on the page.
async function expectText(text) {
  try {
    await page.waitForFunction((t) => document.body?.innerText.includes(t), { timeout: 5000 }, text);
  } catch {
    throw new Error(\`The page does not show "\${text}".\`);
  }
}

function frame(part) {
  const found = page.frames().find((f) => f.url().includes(part));
  if (!found) throw new Error(\`No frame with the address \${part}.\`);
  return found;
}

async function selectOption(where, selector, wanted) {
  const handle = await where.waitForSelector(selector);
  const value = await handle.evaluate(
    (el, text) => [...el.options].find((o) => o.value === text || o.label.trim() === text)?.value,
    wanted,
  );
  if (value === undefined) throw new Error(\`The list has no option "\${wanted}".\`);
  await handle.select(value);
}

async function setChecked(where, selector, on) {
  const handle = await where.waitForSelector(selector);
  if ((await handle.evaluate((el) => el.checked)) !== on) await handle.click();
}

async function pressKeys(combo) {
  const keys = combo.split('+');
  const main = keys.pop();
  for (const key of keys) await page.keyboard.down(key);
  await page.keyboard.press(main);
  for (const key of keys.reverse()) await page.keyboard.up(key);
}
${hasShots ? captureHelpers([...secretFields]) : ''}
try {
  await page.goto(BASE_URL, { waitUntil: 'load' });

${body.join('\n')}${
  hasShots
    ? `  if (SHOT.length && shots === 0) {
    throw new Error(\`SHOT matches no screenshot. The screenshots are: \${${js(captures.map((c) => c.split('\\').join('/')).join(', '))}}.\`);
  }
  console.log(\`Saved \${shots} screenshot(s).\`);
`
    : ''
}  console.log('Passed: every step and check.');
} catch (error) {
  console.error(\`Failed: \${error.message}\`);
  await page.screenshot({ path: resolve(PROJECT_DIR, 'walkthrough-export-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
`;
  return {
    code,
    actions,
    checks,
    captures,
    handChecks,
    missingSelectors,
    secrets: secretList,
    failedSteps,
  };
}
