import { randomBytes } from 'node:crypto';
import type { Dialog, ElementHandle, Frame } from 'puppeteer-core';
import type { Emulation } from '../browser/devices.js';
import type { Driver, Tab } from '../browser/driver.js';
import { loadSession, restoreSession } from '../browser/sessions.js';
import type { Config } from '../config.js';
import type { MockRuleInput } from '../devtools/mock-schema.js';
import { writeStorage } from '../devtools/storage.js';
import { elementRect, maskSecretFields } from '../evidence/annotate.js';
import { checkUploadPath } from '../guards/paths.js';
import type { SecretStore } from '../guards/secrets.js';
import { pressKeys, selectOption } from '../page/actions.js';
import { TokenResolver } from '../page/tokens.js';
import { newUnique } from '../page/unique.js';
import { type DialogAnswer, dialogAnswers, type Op, type RunAction, type StepOps } from './ops.js';
import type { Rebaser } from './rebase.js';
import type { Stage } from './stage.js';

export interface Pace {
  typeMs: number;
  glideMs: number;
  holdMs: number;
}

// Full speed, for steps that nobody watches, like a jump ahead in a presentation.
export const INSTANT: Pace = { typeMs: 0, glideMs: 0, holdMs: 0 };

// Long text types faster, so one field does not take too long.
const MAX_TYPE_MS = 3000;

// A failure in one step. The replay stops there.
export class StepError extends Error {}

export type StepOutcome =
  | { ok: true }
  // opIndex is the operation that failed. A retry can start there.
  | { ok: false; opIndex: number; message: string; stopped?: boolean };

const parse = (value?: string): Record<string, unknown> => {
  try {
    return JSON.parse(value ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

// Waits, unless the replay stops first.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Scrolls the element to the middle of the page, so the caption bar does not cover it.
export async function centerInView(handle: ElementHandle<Element>): Promise<void> {
  await handle
    .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    .catch(() => undefined);
}

// Does the operations from one index on. Any error stops the step.
export async function runOps(
  ops: Op[],
  from: number,
  exec: (op: Op) => Promise<void>,
  signal?: AbortSignal,
): Promise<StepOutcome> {
  for (let i = from; i < ops.length; i++) {
    if (signal?.aborted) {
      return { ok: false, opIndex: i, message: 'The replay stopped.', stopped: true };
    }
    try {
      await exec(ops[i] as Op);
    } catch (error) {
      if (signal?.aborted) {
        return { ok: false, opIndex: i, message: 'The replay stopped.', stopped: true };
      }
      return { ok: false, opIndex: i, message: (error as Error).message };
    }
  }
  return { ok: true };
}

export interface EngineOptions {
  driver: Driver;
  config: Config;
  secrets: SecretStore;
  vars?: Record<string, string>;
  pace: Pace;
  stage: Stage;
  rebase: Rebaser;
  signal?: AbortSignal;
}

// Repeats the operations of a run in new logins of the test browser.
export class ReplayEngine {
  // Tabs by their name in the run. The replay has its own tabs.
  readonly tabs = new Map<string, Tab>();
  current = 'main';
  // A new value for each replay, so a flow that makes data can run again.
  unique = newUnique();
  pace: Pace;
  stage: Stage;
  // Logins by their name in the run, and the new login that stands for each.
  private readonly logins = new Map<string, string>();
  // Dialog answers of the step that is going, in order.
  private dialogs: DialogAnswer[] = [];
  // Mock rules of the replay, by their id in the run.
  readonly mocks = new Map<string, string>();
  readonly restores: Array<() => Promise<void>> = [];
  private readonly key = randomBytes(2).toString('hex');
  private readonly before?: string;

  constructor(readonly options: EngineOptions) {
    this.pace = options.pace;
    this.stage = options.stage;
    this.before = options.driver.activeId;
  }

  private get driver(): Driver {
    return this.options.driver;
  }

  private get config(): Config {
    return this.options.config;
  }

  get tab(): Tab {
    const tab = this.tabs.get(this.current);
    if (!tab || tab.closed) throw new StepError(`The tab "${this.current}" is not open.`);
    return tab;
  }

  // The logins that the replay made. They all close at the end.
  get loginNames(): Set<string> {
    return new Set(this.logins.values());
  }

  private login(runLogin: string): string {
    let name = this.logins.get(runLogin);
    if (!name) {
      name = `replay-${this.key}${runLogin === 'main' ? '' : `-${runLogin}`}`.slice(0, 60);
      this.logins.set(runLogin, name);
    }
    return name;
  }

  private readonly answer = async (dialog: Dialog): Promise<void> => {
    const type = dialog.type();
    if (type === 'alert' || type === 'beforeunload') return dialog.accept();
    const next = this.dialogs.shift() ?? { accept: true };
    if (next.accept) await dialog.accept(next.text ?? dialog.defaultValue());
    else await dialog.dismiss();
  };

  async openTab(name: string, runLogin: string): Promise<Tab> {
    const tab = await this.driver.newTab({ isolated: this.login(runLogin) });
    tab.answerDialog = this.answer;
    this.tabs.set(name, tab);
    this.current = name;
    return tab;
  }

  private use(name: string): void {
    this.current = name;
    this.driver.switchTo(this.tab.id);
  }

  private tokens(): TokenResolver {
    return new TokenResolver(this.unique, this.options.vars ?? {}, this.options.secrets);
  }

  // The real value, with vars, {{unique}}, and secrets.
  private text(value: string): string {
    return this.tokens().apply(value);
  }

  // An address of the run, on the environment of the replay.
  private address(value: string): string {
    return this.options.rebase.url(
      new TokenResolver(this.unique, this.options.vars ?? {}).display(value),
    );
  }

  // Opens the main tab in a new login, with the run's settings, at the start page.
  async open(options: {
    emulation?: Emulation;
    // A fixed size for videos. Without it, the page fills the window.
    width?: number;
    session?: string;
    startUrl?: string;
  }): Promise<Tab> {
    const main = await this.openTab('main', 'main');
    const { device, ...rest } = options.emulation ?? {};
    await this.driver.setEmulation(device ? { ...rest, device } : rest, {
      tab: main,
      reload: false,
    });
    if (!device && options.width) {
      await main.page.setViewport({
        width: options.width,
        height: Math.round((options.width * 10) / 16),
        deviceScaleFactor: 1,
      });
    }
    if (options.session)
      await restoreSession(main, loadSession(this.config.projectDir, options.session));
    await main.page.goto(options.startUrl ? this.address(options.startUrl) : 'about:blank', {
      waitUntil: 'load',
    });
    return main;
  }

  // Does one step. "fromOp" starts in the middle, to try a failed operation again.
  async runStep(
    stepOps: StepOps,
    options: { fromOp?: number; caption?: string } = {},
  ): Promise<StepOutcome> {
    const from = options.fromOp ?? 0;
    this.dialogs = dialogAnswers(stepOps.ops, from);
    if (from === 0)
      this.stage.stepStart(options.caption ?? stepOps.step.caption ?? stepOps.step.title);
    return runOps(
      stepOps.ops,
      from,
      async (op) => {
        if (op.type === 'reach') await this.reach(op.url);
        else if (op.type === 'action') {
          await this.act(op.action);
          await this.tab.page
            .waitForNetworkIdle({ idleTime: 250, timeout: 3000, signal: this.options.signal })
            .catch(() => undefined);
        } else if (op.type === 'expect') await this.expectText(op.text);
      },
      this.options.signal,
    );
  }

  private async frameOf(frameUrl?: string): Promise<Frame> {
    const page = this.tab.page;
    if (!frameUrl) return page.mainFrame();
    let part = frameUrl;
    try {
      part = new URL(this.address(frameUrl)).pathname;
    } catch {}
    const end = Date.now() + this.config.actionTimeoutMs;
    while (Date.now() < end && !this.options.signal?.aborted) {
      const found = page.frames().find((f) => f.url().includes(part));
      if (found) return found;
      await sleep(100, this.options.signal);
    }
    throw new StepError(`There is no frame with the address ${part}.`);
  }

  private async find(action: RunAction): Promise<ElementHandle<Element>> {
    const frame = await this.frameOf(action.frameUrl);
    const handle = await frame
      .waitForSelector(action.selector as string, {
        timeout: this.config.actionTimeoutMs,
        signal: this.options.signal,
      })
      .catch(() => null);
    if (!handle)
      throw new StepError(`Walkthrough did not find ${action.label} (${action.selector}).`);
    return handle as ElementHandle<Element>;
  }

  // Moves the pointer to the element before the action.
  private async point(handle: ElementHandle<Element>, kind: string): Promise<void> {
    await centerInView(handle);
    await sleep(this.pace.glideMs, this.options.signal);
    await this.stage.point(this.tab, kind, await elementRect(handle));
  }

  // Goes to the address, unless the last action already went there.
  async reach(url: string): Promise<void> {
    let want: URL;
    try {
      want = new URL(this.address(url));
    } catch {
      return;
    }
    if (!/^https?:$/.test(want.protocol)) return;
    const page = this.tab.page;
    const here = new URL(page.url());
    if (here.pathname === want.pathname && here.search === want.search) return;
    try {
      await page.waitForFunction(
        (path) => location.pathname + location.search === path,
        { timeout: 3000, signal: this.options.signal },
        want.pathname + want.search,
      );
    } catch {
      await page.goto(want.href, { waitUntil: 'load' });
    }
  }

  async expectText(text: string): Promise<void> {
    const want = new TokenResolver(this.unique, this.options.vars ?? {}).display(text);
    const found = await this.tab.page
      .waitForFunction((t) => document.body?.innerText.includes(t), { timeout: 10_000 }, want)
      .then(() => true)
      .catch(() => false);
    if (!found) throw new StepError(`The page does not show "${want}".`);
  }

  // Types like a person, a few characters at a time, so a stop can come in between.
  private async type(text: string): Promise<void> {
    const delay = Math.min(this.pace.typeMs, MAX_TYPE_MS / Math.max(1, text.length));
    const keyboard = this.tab.page.keyboard;
    if (delay <= 0) {
      await keyboard.type(text);
      return;
    }
    for (let i = 0; i < text.length; i += 8) {
      if (this.options.signal?.aborted) throw new StepError('The replay stopped.');
      await keyboard.type(text.slice(i, i + 8), { delay });
    }
  }

  async act(action: RunAction): Promise<void> {
    const page = () => this.tab.page;
    const value = action.value ?? '';
    switch (action.action) {
      case 'navigate':
        await page().goto(this.address(action.value ?? action.label), { waitUntil: 'load' });
        return;
      case 'click':
      case 'dblclick': {
        const handle = await this.find(action);
        await this.point(handle, action.action);
        await handle.click({ count: action.action === 'dblclick' ? 2 : 1 });
        return;
      }
      case 'hover': {
        const handle = await this.find(action);
        await this.point(handle, 'hover');
        await handle.hover();
        return;
      }
      case 'fill': {
        const handle = await this.find(action);
        await this.point(handle, 'fill');
        const shown = new TokenResolver(this.unique, this.options.vars ?? {}).display(value);
        // A secret is hidden before it goes in, so viewers never see it.
        if (this.options.secrets.hasTokens(shown))
          this.restores.push(await maskSecretFields([handle]));
        const text = this.text(value);
        await handle.evaluate((el) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else if ((el as HTMLElement).isContentEditable) {
            el.textContent = '';
          }
        });
        await handle.focus();
        await this.type(text);
        return;
      }
      case 'select': {
        const handle = await this.find(action);
        await this.point(handle, 'select');
        await selectOption(handle, this.text(value));
        return;
      }
      case 'check':
      case 'uncheck': {
        const handle = await this.find(action);
        await this.point(handle, action.action);
        const want = action.action === 'check';
        if ((await handle.evaluate((el) => (el as HTMLInputElement).checked)) !== want)
          await handle.click();
        return;
      }
      case 'press': {
        if (action.selector) await (await this.find(action)).focus();
        await this.stage.point(this.tab, 'press');
        await pressKeys(this.tab, value);
        return;
      }
      case 'scroll': {
        if (action.selector) {
          await (await this.find(action)).scrollIntoView();
          return;
        }
        await page().mouse.wheel({ deltaY: value === 'up' ? -600 : Number(value) || 600 });
        return;
      }
      case 'upload': {
        const handle = await this.find(action);
        await this.point(handle, 'upload');
        const paths = (action.files ?? []).map((f) =>
          checkUploadPath(f, this.config.uploadsRoot, this.config.projectDir),
        );
        await (handle as ElementHandle<HTMLInputElement>).uploadFile(...paths);
        return;
      }
      case 'dialog':
        // The answers are in the queue of the step already.
        return;
      case 'tab-new': {
        const detail = parse(action.value);
        const tab = await this.openTab(
          String(detail.name ?? `tab-${this.tabs.size + 1}`),
          String(detail.login ?? 'main'),
        );
        if (typeof detail.url === 'string')
          await tab.page.goto(this.address(detail.url), { waitUntil: 'load' });
        return;
      }
      case 'tab-switch': {
        const detail = parse(action.value);
        const name = String(detail.name ?? '');
        if (this.tabs.has(name)) {
          this.use(name);
          return;
        }
        const opener = this.tabs.get(String(detail.opener ?? ''));
        if (!opener) throw new StepError(`The replay does not know how the tab "${name}" opened.`);
        // A tab that a click in the opener opened.
        const mine = new Set([...this.tabs.values()].map((t) => t.id));
        const end = Date.now() + 10_000;
        while (Date.now() < end && !this.options.signal?.aborted) {
          const popup = [...this.driver.tabs.values()].find(
            (t) => t.openerId === opener.id && !mine.has(t.id),
          );
          if (popup) {
            popup.answerDialog = this.answer;
            this.tabs.set(name, popup);
            this.use(name);
            return;
          }
          await sleep(100, this.options.signal);
        }
        throw new StepError(`The tab "${name}" did not open.`);
      }
      case 'tab-close': {
        const name = String(parse(action.value).name ?? '');
        const tab = this.tabs.get(name);
        this.tabs.delete(name);
        await tab?.page.close().catch(() => undefined);
        if (this.current === name) this.use([...this.tabs.keys()].at(-1) ?? 'main');
        return;
      }
      case 'emulate': {
        const { allTabs, ...change } = parse(action.value);
        const targets = allTabs ? [...this.tabs.values()] : [this.tab];
        for (const tab of targets) await this.driver.setEmulation(change, { tab, reload: false });
        return;
      }
      case 'mock': {
        const { tab, id, ...rule } = parse(action.value);
        const target = typeof tab === 'string' ? this.tabs.get(tab) : undefined;
        const input = rule as MockRuleInput;
        if (input.url) input.url = this.options.rebase.pattern(input.url);
        // Mocks of a replay stay with its own tabs.
        const tabIds = target ? [target.id] : [...this.tabs.values()].map((t) => t.id);
        for (const tabId of tabIds) {
          const added = await this.driver.addMock({ ...input, tab: tabId });
          this.mocks.set(`${String(id ?? added.id)}:${tabId}`, added.id);
        }
        return;
      }
      case 'mock-clear': {
        const { id } = parse(action.value);
        for (const [key, driverId] of [...this.mocks]) {
          if (id !== undefined && !key.startsWith(`${String(id)}:`)) continue;
          await this.driver.removeMocks(driverId);
          this.mocks.delete(key);
        }
        return;
      }
      case 'storage':
        await this.storage(parse(action.value));
        return;
    }
  }

  private async storage(detail: Record<string, unknown>): Promise<void> {
    const tab = this.tab;
    const op = String(detail.op ?? '');
    const name = typeof detail.name === 'string' ? detail.name : undefined;
    const text = typeof detail.value === 'string' ? this.text(detail.value) : '';
    if (op === 'clearSiteData') {
      const cdp = await tab.page.createCDPSession();
      await cdp.send('Storage.clearDataForOrigin', {
        origin: new URL(tab.page.url()).origin,
        storageTypes: 'all',
      });
      await cdp.detach().catch(() => undefined);
      return;
    }
    if (detail.kind === 'local' || detail.kind === 'session') {
      if (op === 'set' || op === 'delete' || op === 'clear')
        await writeStorage(tab, detail.kind, op, name, text);
      return;
    }
    const context = tab.page.browserContext();
    if (op === 'set' && name) {
      await context.setCookie({
        name,
        value: text,
        domain:
          typeof detail.domain === 'string' && detail.domain
            ? this.options.rebase.host(detail.domain)
            : new URL(tab.page.url()).hostname,
        path: typeof detail.path === 'string' ? detail.path : '/',
        ...(typeof detail.httpOnly === 'boolean' ? { httpOnly: detail.httpOnly } : {}),
        ...(typeof detail.secure === 'boolean' ? { secure: detail.secure } : {}),
      });
      return;
    }
    if (op === 'delete' || op === 'clear') {
      for (const cookie of await context.cookies()) {
        if (op === 'delete' && cookie.name !== name) continue;
        await context.deleteCookie(cookie);
      }
    }
  }

  // Starts over in the same window: the other tabs close, the login and site data go,
  // and {{unique}} gets a new value. The main tab stays, on a blank page.
  async resetLogin(): Promise<void> {
    await this.removeMocks();
    const main = this.tabs.get('main');
    for (const [name, tab] of [...this.tabs]) {
      if (name === 'main') continue;
      this.tabs.delete(name);
      await tab.page.close().catch(() => undefined);
    }
    if (main && !main.closed) {
      this.current = 'main';
      const origins = new Set<string>();
      for (const url of [main.page.url(), this.options.config.baseUrl]) {
        try {
          if (url && /^https?:/.test(url)) origins.add(new URL(url).origin);
        } catch {}
      }
      const cdp = await main.page.createCDPSession();
      try {
        for (const origin of origins)
          await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
      const context = main.page.browserContext();
      for (const cookie of await context.cookies()) await context.deleteCookie(cookie);
      await main.page.goto('about:blank').catch(() => undefined);
    }
    this.unique = newUnique();
    this.dialogs = [];
  }

  private async removeMocks(): Promise<void> {
    for (const driverId of this.mocks.values())
      await this.driver.removeMocks(driverId).catch(() => 0);
    this.mocks.clear();
  }

  // Closes the replay's tabs and logins. The tab from before is active again.
  async dispose(): Promise<void> {
    await this.removeMocks();
    for (const restore of this.restores.reverse()) await restore().catch(() => undefined);
    const logins = this.loginNames;
    for (const tab of [...this.driver.tabs.values()]) {
      if (logins.has(tab.login)) await tab.page.close().catch(() => undefined);
    }
    if (this.before && this.driver.tabs.has(this.before)) this.driver.switchTo(this.before);
  }
}
