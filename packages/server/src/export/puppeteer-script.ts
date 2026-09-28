import { isAbsolute } from 'node:path';
import { mediaFeatures, NETWORK_PRESETS, resolveDevice } from '../browser/devices.js';
import { type Emulation, mergeEmulation, permissionEntries } from '../browser/emulation-schema.js';
import type { CookieCheck } from '../devtools/cookie-schema.js';
import { ELEMENT_ACTIONS } from '../page/actions.js';
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

// {{unique}} in a value, also after URL encoding.
const UNIQUE_IN = /\{\{\s*unique\s*\}\}|%7B%7B\s*unique\s*%7D%7D/gi;

// The UNIQUE constant, for scripts that use {{unique}}.
const UNIQUE_CODE = [
  '// The value for {{unique}} in this run.',
  "const UNIQUE = process.env.UNIQUE ?? 'u' + Date.now().toString(36).slice(-5);",
  '',
].join('\n');

// Things the script needs because of what the run did.
interface Needs {
  unique: boolean;
  emulate: boolean;
  tabs: boolean;
  cookies: boolean;
  siteData: boolean;
  mocks: boolean;
}

// What the script knows while it is written: open tabs, their settings, and dialog answers.
interface Gen {
  needs: Needs;
  secrets: Set<string>;
  baseUrl?: string;
  known: Set<string>;
  current: string;
  states: Map<string, Emulation>;
  defaults: Emulation;
  dialogs: { accept: boolean; text?: string }[];
}

// Settings for the script's emulate() helper. Device names become sizes here.
export function scriptSettings(change: Emulation, full: Emulation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (change.device !== undefined) {
    let resolved: ReturnType<typeof resolveDevice>;
    try {
      resolved = resolveDevice(change.device);
    } catch {}
    out.device = resolved?.device
      ? { userAgent: resolved.device.userAgent, viewport: resolved.device.viewport }
      : {
          userAgent: null,
          viewport: { ...(resolved?.size ?? { width: 1280, height: 800 }), deviceScaleFactor: 1 },
        };
  }
  // The media type and features go together. Chrome clears the one that a call leaves out.
  if (
    change.colorScheme !== undefined ||
    change.reducedMotion !== undefined ||
    change.media !== undefined
  )
    out.media = { type: full.media === 'print' ? 'print' : '', features: mediaFeatures(full) };
  if (change.network !== undefined) out.network = NETWORK_PRESETS[change.network] ?? change.network;
  if (change.cpu !== undefined) out.cpu = change.cpu;
  if (change.timezone !== undefined) out.timezone = change.timezone;
  if (change.locale !== undefined) out.locale = change.locale;
  if (change.geolocation !== undefined && change.geolocation !== 'off')
    out.geolocation = change.geolocation;
  const permissions = permissionEntries(change);
  if (permissions.length) out.permissions = permissions;
  return out;
}

// The emulate() helper. Only scripts that change settings get it.
const EMULATE_HELPER = `
// Changes the screen, colors, network, and other settings of one tab.
// Media settings need a session that stays open, one for each tab.
async function emulate(target, s) {
  emulate.sessions ??= new WeakMap();
  if (s.device) {
    await target.setUserAgent(s.device.userAgent ?? (await browser.userAgent()));
    await target.setViewport(s.device.viewport);
  }
  if (s.media) {
    if (!emulate.sessions.has(target)) emulate.sessions.set(target, await target.createCDPSession());
    await emulate.sessions.get(target).send('Emulation.setEmulatedMedia', { media: s.media.type, features: s.media.features });
  }
  if (s.network) {
    await target.emulateNetworkConditions(PredefinedNetworkConditions[s.network] ?? null);
    await target.setOfflineMode(s.network === 'offline');
  }
  if (s.cpu) await target.emulateCPUThrottling(s.cpu > 1 ? s.cpu : null);
  if (s.timezone) await target.emulateTimezone(s.timezone === 'system' ? undefined : s.timezone);
  if (s.locale) await target.emulateLocale(s.locale === 'system' ? undefined : s.locale);
  if (s.geolocation) await target.setGeolocation(s.geolocation);
  if (s.permissions) await target.browserContext().setPermission('*', ...s.permissions);
}
`;

// The tab helpers. Only scripts that use more than one tab get them.
const TAB_HELPERS = `
// Tabs by name, and the logins (cookie jars) they use.
const tabs = { main: page };
const logins = { main: browser.defaultBrowserContext() };

async function openTab(name, login) {
  logins[login] ??= await browser.createBrowserContext();
  const tab = await logins[login].newPage();
  tab.setDefaultTimeout(10_000);
  tab.on('dialog', answerDialog);
  if (typeof watchRequests === 'function') await watchRequests(tab);
  tabs[name] = tab;
  return tab;
}

// Finds the tab that a click in the opener tab opened.
async function popupOf(opener) {
  const target = await browser.waitForTarget(
    (t) => t.opener() === opener.target() && !Object.values(tabs).some((p) => p.target() === t),
    { timeout: 10_000 },
  );
  const tab = await target.page();
  tab.setDefaultTimeout(10_000);
  tab.on('dialog', answerDialog);
  if (typeof watchRequests === 'function') await watchRequests(tab);
  return tab;
}
`;

// The code that answers dialogs. It repeats the answers of the run, in order.
function dialogCode(gen: Gen): string {
  const special = gen.dialogs.some((d) => !d.accept || d.text !== undefined);
  if (!special && !gen.needs.tabs) {
    return "// Accept confirm dialogs, like the run did.\npage.on('dialog', (dialog) => void dialog.accept());";
  }
  return [
    '// The answers to dialogs, in the order the run gave them. Other dialogs are accepted.',
    `const DIALOG_ANSWERS = ${JSON.stringify(special ? gen.dialogs : [])};`,
    'function answerDialog(dialog) {',
    '  const next = DIALOG_ANSWERS.shift() ?? { accept: true };',
    '  void (next.accept ? dialog.accept(next.text) : dialog.dismiss());',
    '}',
    "page.on('dialog', answerDialog);",
  ].join('\n');
}

// Code for the tab, settings, and dialog records.
function pageChangeCode(action: RunStep['actions'][number], gen: Gen): string[] {
  const value = (() => {
    try {
      return JSON.parse(action.value ?? '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const fixByHand = `// Fix by hand: ${action.label.replace(/\n/g, ' ')}.`;
  switch (action.action) {
    case 'dialog':
      gen.dialogs.push({
        accept: value.accept !== false,
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
      });
      return [];
    case 'tab-new': {
      const name = String(value.name ?? '');
      if (!name) return [fixByHand];
      gen.needs.tabs = true;
      gen.needs.emulate = true;
      const lines = [`page = await openTab(${js(name)}, ${js(String(value.login ?? 'main'))});`];
      const state = { ...gen.defaults };
      gen.states.set(name, state);
      lines.push(
        `await emulate(page, ${JSON.stringify(scriptSettings({ device: 'default', ...state }, state))});`,
      );
      if (value.session)
        lines.push(
          `// Fix by hand: this tab used the saved login "${String(value.session)}". The script opens it logged out.`,
        );
      if (typeof value.url === 'string')
        lines.push(
          `await page.goto(${urlCode(value.url, gen.needs, gen.baseUrl)}, { waitUntil: 'load' });`,
        );
      gen.known.add(name);
      gen.current = name;
      return lines;
    }
    case 'tab-switch': {
      const name = String(value.name ?? '');
      const opener = typeof value.opener === 'string' ? value.opener : undefined;
      gen.needs.tabs = true;
      if (gen.known.has(name)) {
        gen.current = name;
        return [`page = tabs[${js(name)}];`];
      }
      if (opener && gen.known.has(opener)) {
        gen.needs.emulate = true;
        const state = { ...(gen.states.get(opener) ?? gen.defaults) };
        gen.states.set(name, state);
        gen.known.add(name);
        gen.current = name;
        return [
          `page = tabs[${js(name)}] = await popupOf(tabs[${js(opener)}]);`,
          `await emulate(page, ${JSON.stringify(scriptSettings({ device: 'default', ...state }, state))});`,
        ];
      }
      return [
        `// Fix by hand: switch to the tab "${name}". The script does not know how it opened.`,
      ];
    }
    case 'tab-close': {
      const name = String(value.name ?? '');
      gen.needs.tabs = true;
      gen.known.delete(name);
      gen.states.delete(name);
      const lines = [`await tabs[${js(name)}]?.close();`, `delete tabs[${js(name)}];`];
      if (gen.current === name) {
        lines.push('page = Object.values(tabs).at(-1);');
        gen.current = [...gen.known].at(-1) ?? 'main';
      }
      return lines;
    }
    case 'storage':
      return storageCode(value, gen);
    case 'mock': {
      gen.needs.mocks = true;
      const { tab, ...rule } = value as Record<string, unknown>;
      if (typeof tab !== 'string') return [`await mock(${JSON.stringify(rule)});`];
      // A rule for one tab needs that tab's page.
      if (!gen.known.has(tab))
        return [
          `// Fix by hand: this mock is only for the tab "${tab}", which the script does not know.`,
        ];
      const target = tab === gen.current ? 'page' : `tabs[${js(tab)}]`;
      return [`await mock(${JSON.stringify(rule)}, ${target});`];
    }
    case 'mock-clear': {
      gen.needs.mocks = true;
      return [typeof value.id === 'string' ? `clearMocks(${js(value.id)});` : 'clearMocks();'];
    }
    case 'emulate': {
      const { allTabs, ...change } = value as Emulation & { allTabs?: boolean };
      gen.needs.emulate = true;
      if (allTabs) {
        gen.defaults = mergeEmulation(gen.defaults, change);
        for (const [name, state] of gen.states) gen.states.set(name, mergeEmulation(state, change));
        return [
          `for (const tab of await browser.pages()) await emulate(tab, ${JSON.stringify(scriptSettings(change, gen.defaults))});`,
        ];
      }
      const state = mergeEmulation(gen.states.get(gen.current) ?? gen.defaults, change);
      gen.states.set(gen.current, state);
      return [`await emulate(page, ${JSON.stringify(scriptSettings(change, state))});`];
    }
    default:
      return [
        `// Fix by hand: the script cannot repeat this yet: ${action.label.replace(/\n/g, ' ')}.`,
      ];
  }
}

// A string literal, with {{unique}} turned into the UNIQUE constant.
function literal(value: string, needs: Needs): string {
  const code = js(value);
  if (!UNIQUE_IN.test(code)) return code;
  UNIQUE_IN.lastIndex = 0;
  needs.unique = true;
  return code
    .replace(UNIQUE_IN, '" + UNIQUE + "')
    .replace(/^"" \+ /, '')
    .replace(/ \+ ""$/, '');
}

// A value as code: a secret becomes its environment variable, {{unique}} the UNIQUE constant.
function valueCode(value: string, gen: Gen): string {
  const secret = SECRET.exec(value);
  if (secret?.[1]) {
    gen.secrets.add(secret[1]);
    return `process.env.${secret[1]}`;
  }
  return literal(value, gen.needs);
}

// The cookie and site data helpers. Only scripts that use them get them.
const COOKIE_HELPERS = `
// Checks a cookie of the active tab's login.
async function expectCookie(check) {
  const found = (await page.browserContext().cookies()).find((c) => c.name === check.name);
  if (check.exists === false) {
    if (found) throw new Error(\`The cookie "\${check.name}" is still set.\`);
    return;
  }
  if (!found) throw new Error(\`The cookie "\${check.name}" is not set.\`);
  if (check.value !== undefined && found.value !== check.value)
    throw new Error(\`The cookie "\${check.name}" has another value.\`);
  if (check.contains !== undefined && !found.value.includes(check.contains))
    throw new Error(\`The value of the cookie "\${check.name}" does not have the text.\`);
  for (const flag of ['httpOnly', 'secure', 'sameSite']) {
    if (check[flag] !== undefined && found[flag] !== check[flag])
      throw new Error(\`The cookie "\${check.name}" has \${flag} \${found[flag]}, not \${check[flag]}.\`);
  }
}

// Deletes the cookies that match, in the active tab's login.
async function deleteCookies(match = {}) {
  const context = page.browserContext();
  for (const cookie of await context.cookies()) {
    if (match.name && cookie.name !== match.name) continue;
    if (match.path && cookie.path !== match.path) continue;
    await context.deleteCookie(cookie);
  }
}
`;

// The mock helpers. Only scripts that mock requests get them.
const MOCK_HELPERS = `
// Mocked, blocked, and slow requests, like the run had. The first rule that matches wins.
const MOCKS = [];
const watchedPages = new WeakSet();

// True when the text matches the pattern. * stands for any text.
function globMatch(glob, text) {
  const parts = glob.split('*');
  if (parts.length === 1) return text === glob;
  if (!text.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  const last = parts.at(-1);
  return text.length - last.length >= at && text.endsWith(last);
}

function mockMatches(rule, request, target) {
  if (rule.only && rule.only !== target) return false;
  if (rule.times !== undefined && rule.hits >= rule.times) return false;
  if (rule.method && rule.method.toUpperCase() !== request.method().toUpperCase()) return false;
  if (rule.type && rule.type.toLowerCase() !== request.resourceType()) return false;
  if (rule.urlRegex) return new RegExp(rule.urlRegex).test(request.url());
  if (rule.url.startsWith('/')) {
    const url = new URL(request.url());
    return globMatch(rule.url, rule.url.includes('?') ? url.pathname + url.search : url.pathname);
  }
  return globMatch(rule.url, request.url());
}

async function watchRequests(target) {
  if (watchedPages.has(target)) return;
  watchedPages.add(target);
  await target.setRequestInterception(true);
  target.on('request', async (request) => {
    const rule = MOCKS.find((r) => mockMatches(r, request, target));
    if (!rule) return void request.continue();
    rule.hits += 1;
    if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
    if (rule.block) return void request.abort('blockedbyclient');
    const answers = rule.status !== undefined || rule.json !== undefined || rule.body !== undefined || rule.headers;
    if (!answers) return void request.continue();
    return void request.respond({
      status: rule.status ?? 200,
      headers: rule.headers ?? {},
      contentType: rule.contentType ?? (rule.json !== undefined ? 'application/json' : 'text/plain; charset=utf-8'),
      body: rule.json !== undefined ? JSON.stringify(rule.json) : (rule.body ?? ''),
    });
  });
}

// Adds a rule. "only" limits it to one tab.
async function mock(rule, only) {
  MOCKS.push({ ...rule, only, hits: 0 });
  for (const target of await browser.pages()) await watchRequests(target);
}

// Removes one rule, or all rules.
function clearMocks(id) {
  const keep = id ? MOCKS.filter((r) => r.id !== id) : [];
  MOCKS.splice(0, MOCKS.length, ...keep);
}
`;

const SITE_DATA_HELPER = `
// Clears cookies, storage, cache, IndexedDB, and service workers of the active tab's site.
async function clearSiteData() {
  const client = await page.createCDPSession();
  await client.send('Storage.clearDataForOrigin', { origin: new URL(page.url()).origin, storageTypes: 'all' });
  await client.detach();
}
`;

// A cookie check as code.
function cookieCheckCode(check: CookieCheck, gen: Gen): string {
  const parts = [`name: ${js(check.name)}`];
  if (check.exists !== undefined) parts.push(`exists: ${check.exists}`);
  if (check.value !== undefined) parts.push(`value: ${valueCode(check.value, gen)}`);
  if (check.contains !== undefined) parts.push(`contains: ${valueCode(check.contains, gen)}`);
  if (check.httpOnly !== undefined) parts.push(`httpOnly: ${check.httpOnly}`);
  if (check.secure !== undefined) parts.push(`secure: ${check.secure}`);
  if (check.sameSite !== undefined) parts.push(`sameSite: ${js(check.sameSite)}`);
  return `await expectCookie({ ${parts.join(', ')} });`;
}

// A storage record as code.
function storageCode(value: Record<string, unknown>, gen: Gen): string[] {
  const op = String(value.op ?? '');
  const name = typeof value.name === 'string' ? value.name : undefined;
  const text = typeof value.value === 'string' ? value.value : '';
  if (op === 'clearSiteData') {
    gen.needs.siteData = true;
    return ['await clearSiteData();'];
  }
  if (value.kind === 'local' || value.kind === 'session') {
    const store = value.kind === 'local' ? 'localStorage' : 'sessionStorage';
    if (op === 'set' && name)
      return [
        `await page.evaluate((k, v) => ${store}.setItem(k, v), ${js(name)}, ${valueCode(text, gen)});`,
      ];
    if (op === 'delete' && name)
      return [`await page.evaluate((k) => ${store}.removeItem(k), ${js(name)});`];
    if (op === 'clear') return [`await page.evaluate(() => ${store}.clear());`];
    return [];
  }
  gen.needs.cookies = true;
  if (op === 'set' && name) {
    const domain = typeof value.domain === 'string' ? value.domain : '';
    let base = '';
    try {
      base = gen.baseUrl ? new URL(gen.baseUrl).hostname : '';
    } catch {}
    const fields = [
      `name: ${js(name)}`,
      `value: ${valueCode(text, gen)}`,
      `domain: ${domain && domain !== base ? js(domain) : 'new URL(BASE_URL).hostname'}`,
      `path: ${js(typeof value.path === 'string' ? value.path : '/')}`,
    ];
    for (const key of ['expires', 'httpOnly', 'secure'] as const)
      if (value[key] !== undefined) fields.push(`${key}: ${JSON.stringify(value[key])}`);
    if (typeof value.sameSite === 'string') fields.push(`sameSite: ${js(value.sameSite)}`);
    return [`await page.browserContext().setCookie({ ${fields.join(', ')} });`];
  }
  if (op === 'delete' && name) {
    const path = typeof value.path === 'string' ? `, path: ${js(value.path)}` : '';
    return [`await deleteCookies({ name: ${js(name)}${path} });`];
  }
  if (op === 'clear') return ['await deleteCookies();'];
  return [];
}

// The address of an action as code, relative to BASE_URL when it can be.
function urlCode(url: string, needs: Needs, baseUrl?: string): string {
  try {
    const parsed = new URL(url);
    if (baseUrl && parsed.origin === new URL(baseUrl).origin) {
      return `new URL(${literal(parsed.pathname + parsed.search + parsed.hash, needs)}, BASE_URL).href`;
    }
  } catch {}
  return literal(url, needs);
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
  secretFields: Set<string>,
  gen: Gen,
): string[] {
  const { needs, baseUrl } = gen;
  const where = frameCode(action.frameUrl);
  const sel = action.selector ? js(action.selector) : '';
  const value = (() => {
    const v = action.value ?? '';
    // Screenshots hide the text of fields filled from secrets.
    if (SECRET.test(v) && action.selector && !action.frameUrl) secretFields.add(action.selector);
    return valueCode(v, gen);
  })();
  switch (action.action) {
    case 'navigate':
      return [
        `await page.goto(${urlCode(action.value ?? action.label, needs, baseUrl)}, { waitUntil: 'load' });`,
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
    case 'dialog':
    case 'tab-new':
    case 'tab-switch':
    case 'tab-close':
    case 'emulate':
    case 'mock':
    case 'mock-clear':
    case 'storage':
      return pageChangeCode(action, gen);
  }
}

// The screen and color scheme of the run. Without a device, a fixed size, so screenshots match.
// Other settings go through the emulate() helper.
function setupCode(emulation: Run['emulation'], gen: Gen): string[] {
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
  const { device: _device, colorScheme: _scheme, ...more } = emulation ?? {};
  if (Object.keys(more).length && emulation) {
    gen.needs.emulate = true;
    lines.push(`await emulate(page, ${JSON.stringify(scriptSettings(more, emulation))});`);
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

// The address in a new-tab record.
function parseUrl(value?: string): string | undefined {
  try {
    const url = (JSON.parse(value ?? '{}') as { url?: unknown }).url;
    return typeof url === 'string' ? url : undefined;
  } catch {
    return undefined;
  }
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
  const needs: Needs = {
    unique: false,
    emulate: false,
    tabs: false,
    cookies: false,
    siteData: false,
    mocks: false,
  };
  const gen: Gen = {
    needs,
    secrets,
    baseUrl: run.baseUrl,
    known: new Set(['main']),
    current: 'main',
    states: new Map([['main', { ...run.emulation }]]),
    defaults: { ...run.emulation },
    dialogs: [],
  };
  const setup = setupCode(run.emulation, gen);

  for (const step of run.steps) {
    const shots = step.captures ?? [];
    if ((step.status === 'pending' || step.status === 'skip') && shots.length === 0) continue;
    const lines: string[] = [];
    for (const action of step.actions) {
      if (action.url && action.url !== lastUrl) {
        lines.push(`await reach(${urlCode(action.url, needs, run.baseUrl)});`);
        lastUrl = action.url;
      }
      if (!action.selector && ELEMENT_ACTIONS.includes(action.action)) {
        missingSelectors.push(`Step ${step.index}: ${action.label}`);
        lines.push(
          `// Fix by hand: Walkthrough found no stable selector for ${action.label.replace(/\n/g, ' ')}.`,
        );
        continue;
      }
      lines.push(...actionCode(action, secretFields, gen));
      actions += 1;
      // After a page load, the next action starts at the new address.
      if (action.action === 'navigate') lastUrl = action.value ?? lastUrl;
      if (action.action === 'tab-new') lastUrl = parseUrl(action.value) ?? 'about:blank';
      if (action.action === 'tab-close') lastUrl = '';
    }
    for (const check of step.cookies ?? []) {
      needs.cookies = true;
      lines.push(cookieCheckCode(check, gen));
      checks += 1;
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
  const imports = needs.emulate ? `puppeteer, { PredefinedNetworkConditions }` : 'puppeteer';
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
${hasShots ? `// It saves ${captures.length} screenshot(s). Set SHOT=<name> to save only some of them.\n` : ''}${needs.unique ? '// Values with {{unique}} get a new value on each run. Set UNIQUE to choose the value.\n' : ''}${secretList.length ? `// Secrets come from environment variables: ${secretList.join(', ')}.\n` : ''}${hasShots ? "import { mkdirSync } from 'node:fs';\nimport { basename, dirname, extname, relative, resolve, sep } from 'node:path';" : "import { dirname, resolve } from 'node:path';"}
import { fileURLToPath } from 'node:url';
import ${imports} from '${pkg}';

const BASE_URL = process.env.BASE_URL ?? ${js(run.baseUrl ?? 'http://localhost:3000')};
// The project folder: this file is in .walkthrough/exports.
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const name of ${JSON.stringify(secretList)}) {
  if (!process.env[name]) throw new Error(\`Set the \${name} environment variable first.\`);
}
${needs.unique ? UNIQUE_CODE : ''}
const browser = await puppeteer.launch(${launch});
${needs.tabs ? 'let' : 'const'} page = await browser.newPage();
page.setDefaultTimeout(10_000);
${setup.join('\n')}
${dialogCode(gen)}
${needs.tabs ? TAB_HELPERS : ''}
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
${needs.emulate ? EMULATE_HELPER : ''}${needs.cookies ? COOKIE_HELPERS : ''}${needs.mocks ? MOCK_HELPERS : ''}${needs.siteData ? SITE_DATA_HELPER : ''}${hasShots ? captureHelpers([...secretFields]) : ''}
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
