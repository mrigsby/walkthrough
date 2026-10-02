import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  ElementHandle,
  Page,
  Protocol,
  Target,
} from 'puppeteer-core';
import type { Config, DialogPolicy } from '../config.js';
import { describeIssue } from '../devtools/issues.js';
import { checkRule, hitText, type MockRule, type MockRuleInput } from '../devtools/mock-schema.js';
import type { EnvNetwork } from '../environments.js';
import { ToolError } from '../errors.js';
import { LogBook } from '../evidence/logs.js';
import { NetworkBook } from '../evidence/network.js';
import { scrubUrl } from '../evidence/scrub.js';
import { onShutdown } from '../lifecycle.js';
import { log } from '../log.js';
import { RefTable } from '../page/refs.js';
import { DeveloperPanel } from '../panel/controller.js';
import { attachChrome } from './attach.js';
import { applyEmulation, checkEmulation, type Emulation } from './devices.js';
import { mergeEmulation, permissionEntries } from './emulation-schema.js';
import { FetchRouter } from './fetch-router.js';
import { killChrome, launchChrome, removeProfile } from './launch.js';

export interface Tab {
  id: string;
  // "main" for the first tab. Plans and exports use the name.
  name: string;
  // The login (cookie jar) of the tab. "main" is the normal one.
  login: string;
  page: Page;
  openerId?: string;
  nav: number;
  crashed: boolean;
  closed: boolean;
  // True when the tab emulates a phone or tablet.
  mobile: boolean;
  // The screen, color, network, and other settings of this tab.
  emulation: Emulation;
  // The session that sees each request first: the guard and the mocks.
  router?: FetchRouter;
  cdp?: CDPSession;
  // Answers dialogs in this tab instead of the dialog policy, like a replay does.
  answerDialog?: (dialog: Dialog) => Promise<void>;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface PendingDialog {
  tabId: string;
  type: string;
  message: string;
  defaultValue: string;
  dialog: Dialog;
}

// Things that happened in the browser that the agent should hear about.
export interface DriverEvents {
  notes: string[];
}

export interface DriverOptions {
  config: Config;
  isAllowed: (url: string) => boolean;
  attach?: string;
}

// Owns one browser and its tabs. Tracks dialogs, crashes, and closing.
export class Driver {
  readonly refs = new RefTable();
  readonly emitter = new EventEmitter();
  readonly tabs = new Map<string, Tab>();
  readonly secretFields: ElementHandle[] = [];
  readonly logs = new LogBook();
  readonly network = new NetworkBook();
  readonly panel?: DeveloperPanel;
  // The element of the last action, for the red box in bug screenshots.
  lastTarget?: { tabId: string; handle: ElementHandle<Element>; label: string };
  // Settings that new tabs start with. Each tab also has its own.
  defaultEmulation: Emulation = {};
  // Cookie jars by login name. "main" is the browser's own.
  readonly logins = new Map<string, BrowserContext>();
  // Mock rules for requests, in order. The first match wins.
  readonly mocks: MockRule[] = [];
  private mockCounter = 0;
  // What the mocks did in the current step.
  private mockHits = new Set<string>();
  private userAgent = '';
  private active?: string;
  dialogPolicy: DialogPolicy;
  closedReason?: 'browser_closed' | 'closed_by_agent';
  // Protected environments that the developer confirmed for this browser.
  readonly confirmedEnvs = new Set<string>();
  // Headers and a login for the site of the environment.
  private envNetwork?: EnvNetwork;
  private ignoringCertErrors = false;
  // The certificate setting lasts only while this session stays open.
  private securitySession?: CDPSession;

  private tabCounter = 0;
  private notes: string[] = [];
  private pendingDialogs = new Map<string, PendingDialog>();
  private pendingWork = new Map<string, Promise<unknown>>();
  private removeShutdown?: () => void;
  private inflight = new Set<Promise<unknown>>();
  // A tab that newTab is making. The new-tab event waits for it.
  private newTabWork?: Promise<unknown>;

  private constructor(
    readonly browser: Browser,
    readonly mode: 'launched' | 'attached',
    readonly chromeVersion: string,
    private readonly options: DriverOptions,
    private readonly profileDir?: string,
  ) {
    this.dialogPolicy = options.config.dialogs;
    if (options.config.panel) this.panel = new DeveloperPanel();
  }

  static async start(options: DriverOptions): Promise<Driver> {
    let driver: Driver;
    if (options.attach) {
      const browser = await attachChrome(options.attach);
      driver = new Driver(browser, 'attached', await browser.version(), options);
      driver.logins.set('main', browser.defaultBrowserContext());
      // Use a new tab of our own. Never touch the developer's other tabs.
      await driver.addTab(await browser.newPage());
    } else {
      const { browser, profileDir } = await launchChrome(options.config);
      driver = new Driver(browser, 'launched', await browser.version(), options, profileDir);
      driver.logins.set('main', browser.defaultBrowserContext());
      const first = (await browser.pages())[0] ?? (await browser.newPage());
      await driver.addTab(first);
    }
    driver.watchBrowser();
    return driver;
  }

  // The tab that tools act on. A change sends "active-changed", so a video can follow it.
  get activeId(): string | undefined {
    return this.active;
  }

  set activeId(id: string | undefined) {
    if (id === this.active) return;
    this.active = id;
    this.emitter.emit('active-changed', id);
  }

  get alive(): boolean {
    return !this.closedReason;
  }

  // False when the developer closed the last tab, but Chrome still runs.
  get hasActiveTab(): boolean {
    return Boolean(this.activeId && this.tabs.has(this.activeId));
  }

  // Opens a tab when none is left. It takes the name "main" if that name is free.
  async reopenTab(): Promise<Tab> {
    return this.newTab({ name: this.tabByRef('main') ? undefined : 'main' });
  }

  private watchBrowser(): void {
    this.browser.on('disconnected', () => {
      if (!this.closedReason) {
        this.closedReason = 'browser_closed';
        log.info('the browser was closed');
        this.panel?.onBrowserClosed();
        this.emitter.emit('closed');
      }
      if (this.profileDir) removeProfile(this.profileDir);
      this.removeShutdown?.();
    });

    this.browser.on('targetcreated', (target: Target) => this.track(this.onTarget(target)));

    // Close a Chrome we started if the server stops.
    this.removeShutdown = onShutdown(async () => {
      if (this.mode === 'launched') {
        await killChrome(this.browser);
        // Wait a moment for Chrome helpers to stop writing to the profile.
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (this.profileDir) removeProfile(this.profileDir);
      } else {
        await this.closeLogins();
        await this.browser.disconnect().catch(() => undefined);
      }
    });
  }

  // A new tab or popup opened.
  private async onTarget(target: Target): Promise<void> {
    if (target.type() !== 'page') return;
    const page = await target.page().catch(() => null);
    if (!page) return;
    // newTab adds its own tab. Wait for it, then skip that tab here.
    if (this.newTabWork) await this.newTabWork.catch(() => undefined);
    if (this.findTab(page)) return;
    const openerPage = await target
      .opener()
      ?.page()
      .catch(() => null);
    const opener = openerPage ? this.findTab(openerPage) : undefined;
    // In attach mode, only follow tabs that our tabs opened.
    if (this.mode === 'attached' && !opener) return;
    // A popup gets the login and settings of the tab that opened it.
    const tab = await this.addTab(page, opener?.id, {
      login: opener?.login ?? this.loginOf(page),
      emulation: opener ? { ...opener.emulation } : undefined,
    });
    this.note(`A new tab opened: ${tab.id}. Use the tabs tool to switch to it.`);
  }

  // Keeps event work that is still running, so an action can wait for it.
  private track(work: Promise<unknown>): void {
    const done = work.catch(() => undefined).finally(() => this.inflight.delete(done));
    this.inflight.add(done);
  }

  // After a click, Chrome reports new tabs and blocked pages a moment later.
  // Wait for those reports, so the agent hears about them in the same reply.
  async settleEvents(graceMs = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    const pending = Promise.allSettled([...this.inflight]);
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  findTab(page: Page): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.page === page) return tab;
    return undefined;
  }

  // A tab by its id, like "t2", or its name, like "customer". "newest" is the last tab that opened.
  tabByRef(ref: string): Tab | undefined {
    if (ref === 'newest') return [...this.tabs.values()].at(-1);
    return this.tabs.get(ref) ?? [...this.tabs.values()].find((t) => t.name === ref);
  }

  // Checks a name for a tab. Names like "t2" are ids, and "newest" means the last tab.
  checkTabName(name: string, tab?: Tab): void {
    if (!NAME.test(name) || /^t\d+$/.test(name) || name === 'newest') {
      throw new ToolError(
        'Use a tab name with lowercase letters, numbers, and dashes, like "customer". Names like "t2" are tab ids.',
        'bad_input',
      );
    }
    const other = this.tabByRef(name);
    if (other && other !== tab)
      throw new ToolError(`A tab named "${name}" is already open.`, 'bad_input');
  }

  // The login name of a page, from its cookie jar.
  private loginOf(page: Page): string {
    const context = page.browserContext();
    for (const [name, value] of this.logins) if (value === context) return name;
    return 'main';
  }

  async addTab(
    page: Page,
    openerId?: string,
    options: { login?: string; name?: string; emulation?: Emulation; panel?: boolean } = {},
  ): Promise<Tab> {
    this.tabCounter += 1;
    const id = `t${this.tabCounter}`;
    const tab: Tab = {
      id,
      name: options.name ?? (this.tabCounter === 1 ? 'main' : id),
      login: options.login ?? 'main',
      page,
      openerId,
      nav: 0,
      crashed: false,
      closed: false,
      mobile: false,
      emulation: { ...(options.emulation ?? this.defaultEmulation) },
    };
    this.tabs.set(tab.id, tab);
    this.activeId ??= tab.id;

    page.setDefaultTimeout(this.options.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(30_000);

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.nav += 1;
      this.emitter.emit('navigated', { tabId: tab.id, url: frame.url() });
    });
    page.on('error', () => {
      tab.crashed = true;
      this.note(`The page in tab ${tab.id} crashed.`);
    });
    page.on('close', () => this.onTabClosed(tab));
    page.on('dialog', (dialog) => void this.onDialog(tab, dialog));
    this.logs.attach(page, tab.id);
    this.network.attach(page, tab.id);
    if (options.panel !== false) await this.panel?.attach(page, tab.id);

    tab.router = await FetchRouter.install(page, {
      isAllowed: (url) => this.options.isAllowed(url),
      onBlocked: (url) =>
        this.note(
          `Walkthrough blocked the tab from opening ${url}, because that site is not allowed.`,
        ),
      rules: () => this.rulesFor(tab),
      onHit: (rule, request) =>
        this.mockHits.add(hitText(rule, request.method, scrubUrl(request.url))),
      network: () => this.envNetwork,
    });
    tab.cdp = tab.router?.cdp;
    if (this.rulesFor(tab).length > 0) await this.refreshRouter(tab);

    // Chrome's Issues panel: blocked cookies, CSP, CORS, and more.
    if (tab.cdp) {
      tab.cdp.on('Audits.issueAdded', ({ issue }: Protocol.Audits.IssueAddedEvent) => {
        const found = describeIssue(issue);
        if (found) this.logs.addIssue(tab.id, found.level, found.text);
      });
      await tab.cdp.send('Audits.enable').catch(() => undefined);
    }

    // Settings need tab.cdp, so they come after the guard.
    if (Object.keys(tab.emulation).length > 0)
      await this.emulateTab(tab, tab.emulation).catch(() => undefined);

    // A popup may have started loading before the guard was ready.
    const url = page.url();
    if (url && !this.options.isAllowed(url)) {
      this.note(`Tab ${tab.id} opened ${url}, which is not allowed. Walkthrough cleared the tab.`);
      await page.goto('about:blank').catch(() => undefined);
    }
    return tab;
  }

  private onTabClosed(tab: Tab): void {
    tab.closed = true;
    this.tabs.delete(tab.id);
    this.pendingDialogs.delete(tab.id);
    this.panel?.detach(tab.id);
    // A separate login ends with its last tab.
    const context = this.logins.get(tab.login);
    if (
      tab.login !== 'main' &&
      context &&
      ![...this.tabs.values()].some((t) => t.login === tab.login)
    ) {
      this.logins.delete(tab.login);
      void context.close().catch(() => undefined);
    }
    if (this.activeId === tab.id) {
      const next = [...this.tabs.values()].at(-1);
      this.activeId = next?.id;
      if (!this.closedReason) {
        this.note(
          next
            ? `Tab ${tab.id} closed. The active tab is now ${next.id}.`
            : `Tab ${tab.id} closed. No tabs are open. browser_open opens a new tab.`,
        );
      }
    }
  }

  private async onDialog(tab: Tab, dialog: Dialog): Promise<void> {
    if (tab.answerDialog) {
      await tab.answerDialog(dialog).catch((error) => log.warn('could not answer a dialog', error));
      return;
    }
    const type = dialog.type();
    const message = dialog.message();
    const said = message ? ` It said: "${message}"` : '';
    try {
      // Alerts have one button, and leaving a page is part of the task. Answer these right away.
      if (type === 'alert' || type === 'beforeunload') {
        await dialog.accept();
        this.note(
          `The page showed ${type === 'alert' ? 'an alert' : 'a "leave page" dialog'}. Walkthrough accepted it.${said}`,
        );
        return;
      }
      if (this.dialogPolicy === 'accept') {
        await dialog.accept(dialog.defaultValue());
        this.note(
          `The page showed a ${type} dialog. Walkthrough accepted it (dialog policy "accept").${said}`,
        );
        return;
      }
      if (this.dialogPolicy === 'dismiss') {
        await dialog.dismiss();
        this.note(
          `The page showed a ${type} dialog. Walkthrough dismissed it (dialog policy "dismiss").${said}`,
        );
        return;
      }
    } catch (error) {
      log.warn('could not answer a dialog', error);
      return;
    }
    // Policy "ask": keep it open until the agent answers with the dialog tool.
    const pending: PendingDialog = {
      tabId: tab.id,
      type,
      message,
      defaultValue: dialog.defaultValue(),
      dialog,
    };
    this.pendingDialogs.set(tab.id, pending);
    this.emitter.emit('dialog', pending);
  }

  // Applies changed settings to a tab. tab.emulation already has them.
  private async emulateTab(tab: Tab, change: Emulation): Promise<boolean> {
    this.userAgent ||= await this.browser.userAgent();
    const result = await applyEmulation(tab.page, change, tab.emulation, {
      headless: this.options.config.browser.headless,
      userAgent: this.userAgent,
      wasMobile: tab.mobile,
      cdp: tab.cdp,
    });
    tab.mobile = result.isMobile;
    return result.needsReload;
  }

  // Changes the settings of one tab, or of every tab and of new tabs.
  // A tab reloads when it switches between desktop and phone mode.
  async setEmulation(
    change: Emulation,
    options: { tab?: Tab; reload: boolean },
  ): Promise<string[]> {
    checkEmulation(change);
    const targets = options.tab ? [options.tab] : [...this.tabs.values()];
    if (!options.tab) this.defaultEmulation = mergeEmulation(this.defaultEmulation, change);
    const reloaded: string[] = [];
    for (const tab of targets) {
      tab.emulation = mergeEmulation(tab.emulation, change);
      const needsReload = await this.emulateTab(tab, change);
      if (needsReload && options.reload && /^https?:/.test(tab.page.url())) {
        await tab.page.reload({ waitUntil: 'load' }).catch(() => undefined);
        reloaded.push(tab.id);
      }
    }
    const logins = options.tab ? [options.tab.login] : [...this.logins.keys()];
    await this.applyPermissions(change, logins);
    return reloaded;
  }

  // Permissions belong to a login, not a tab.
  private async applyPermissions(change: Emulation, logins: string[]): Promise<void> {
    const entries = permissionEntries(change);
    if (entries.length === 0) return;
    for (const login of new Set(logins)) {
      await this.logins.get(login)?.setPermission('*', ...entries);
    }
  }

  // Opens a new tab. isolated: true makes a one-off login. A string names a login that tabs share.
  // A bare tab has no panel and no settings, and does not become the active tab.
  async newTab(
    options: { name?: string; isolated?: true | string; bare?: boolean } = {},
  ): Promise<Tab> {
    this.assertAlive();
    if (options.name !== undefined) this.checkTabName(options.name);
    const login =
      options.isolated === true
        ? `iso-${randomBytes(2).toString('hex')}`
        : (options.isolated ?? 'main');
    if (!NAME.test(login)) {
      throw new ToolError(
        `Use a login name with lowercase letters, numbers, and dashes, like "customer".`,
        'bad_input',
      );
    }
    const work = (async () => {
      let context = this.logins.get(login);
      if (!context) {
        context = await this.browser.createBrowserContext();
        this.logins.set(login, context);
      }
      const page = await context.newPage();
      return this.addTab(page, undefined, {
        login,
        name: options.name,
        ...(options.bare ? { emulation: {}, panel: false } : {}),
      });
    })();
    this.newTabWork = work;
    try {
      const tab = await work;
      if (!options.bare) this.switchTo(tab.id);
      return tab;
    } finally {
      if (this.newTabWork === work) this.newTabWork = undefined;
    }
  }

  // Closes the separate logins. The main login is the browser's own.
  private async closeLogins(): Promise<void> {
    for (const [name, context] of this.logins) {
      if (name !== 'main') await context.close().catch(() => undefined);
    }
  }

  pendingDialog(tabId = this.activeId): PendingDialog | undefined {
    return tabId ? this.pendingDialogs.get(tabId) : undefined;
  }

  // Resolves when a dialog opens and waits for an answer.
  nextDialog(tabId: string): { promise: Promise<PendingDialog>; cancel: () => void } {
    let listener: (d: PendingDialog) => void = () => undefined;
    const promise = new Promise<PendingDialog>((resolve) => {
      listener = (d) => {
        if (d.tabId === tabId) resolve(d);
      };
      this.emitter.on('dialog', listener);
    });
    return { promise, cancel: () => this.emitter.off('dialog', listener) };
  }

  // Keeps an action that is stuck behind a dialog, so it can finish later.
  setPendingWork(tabId: string, work: Promise<unknown>): void {
    this.pendingWork.set(
      tabId,
      work.catch(() => undefined),
    );
  }

  async answerDialog(accept: boolean, text?: string): Promise<PendingDialog> {
    const pending = this.pendingDialog();
    if (!pending) throw new ToolError('No dialog is open in the active tab.', 'no_dialog');
    this.pendingDialogs.delete(pending.tabId);
    if (accept) await pending.dialog.accept(text ?? pending.defaultValue);
    else await pending.dialog.dismiss();
    const work = this.pendingWork.get(pending.tabId);
    this.pendingWork.delete(pending.tabId);
    if (work) await Promise.race([work, new Promise((r) => setTimeout(r, 5000))]);
    return pending;
  }

  // The tab that tools act on. Throws a clear message if it cannot be used.
  activeTab(options: { allowDialog?: boolean } = {}): Tab {
    this.assertAlive();
    const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!tab)
      throw new ToolError(
        'No tab is open. Call browser_open, or navigate with a url. Both open a new tab.',
        'no_tab',
      );
    if (tab.crashed) {
      throw new ToolError(
        `The page in tab ${tab.id} crashed. Use navigate with action "reload", or close the tab.`,
        'page_crashed',
      );
    }
    const dialog = this.pendingDialogs.get(tab.id);
    if (dialog && !options.allowDialog) {
      throw new ToolError(dialogOpenMessage(dialog), 'dialog_pending');
    }
    return tab;
  }

  assertAlive(): void {
    if (this.closedReason === 'browser_closed') {
      throw new ToolError(
        'The browser was closed. Call browser_open to start a new one.',
        'browser_closed',
      );
    }
    if (this.closedReason === 'closed_by_agent') {
      throw new ToolError(
        'The browser is closed. Call browser_open to start one.',
        'browser_closed',
      );
    }
  }

  switchTo(ref: string): Tab {
    this.assertAlive();
    const tab = this.tabByRef(ref);
    if (!tab)
      throw new ToolError(`There is no tab "${ref}". Use the tabs tool to list tabs.`, 'no_tab');
    this.activeId = tab.id;
    void tab.page.bringToFront().catch(() => undefined);
    void this.panel?.refresh(tab.id);
    return tab;
  }

  // Ends a step in the logs and in the network list.
  endStep(label: string): void {
    this.logs.endStep(label);
    this.network.endStep(label);
    this.mockHits.clear();
  }

  // What the mocks did since the step started.
  get stepMocks(): string[] {
    return [...this.mockHits];
  }

  // The mock rules for one tab.
  rulesFor(tab: Tab): MockRule[] {
    return this.mocks.filter((r) => !r.tab || r.tab === tab.id || r.tab === tab.name);
  }

  async addMock(input: MockRuleInput): Promise<MockRule> {
    const problem = checkRule(input);
    if (problem) throw new ToolError(problem, 'bad_input');
    const rule: MockRule = { ...input, id: `m${++this.mockCounter}`, hits: 0 };
    this.mocks.push(rule);
    await this.refreshRouters();
    return rule;
  }

  // Removes one rule, or all rules without an id. Returns how many it removed.
  async removeMocks(id?: string): Promise<number> {
    const before = this.mocks.length;
    const keep = id ? this.mocks.filter((r) => r.id !== id) : [];
    this.mocks.splice(0, this.mocks.length, ...keep);
    await this.refreshRouters();
    return before - this.mocks.length;
  }

  // Uses the settings of another environment: its time limit, request rules, and certificates.
  async applyEnvironment(config: Config, network?: EnvNetwork): Promise<void> {
    this.options.config = config;
    for (const tab of this.tabs.values()) tab.page.setDefaultTimeout(config.actionTimeoutMs);
    const changed = JSON.stringify(network) !== JSON.stringify(this.envNetwork);
    this.envNetwork = network;
    if (changed) await this.refreshRouters();
    // Chrome has one setting for the whole browser, so it follows the environment in use.
    const ignore = config.environment.ignoreHttpsErrors;
    if (ignore !== this.ignoringCertErrors) {
      try {
        this.securitySession ??= await this.browser.target().createCDPSession();
        await this.securitySession.send('Security.setIgnoreCertificateErrors', { ignore });
        this.ignoringCertErrors = ignore;
      } catch (error) {
        log.warn('could not change the certificate setting', error);
      }
    }
  }

  async refreshRouters(): Promise<void> {
    for (const tab of this.tabs.values()) await this.refreshRouter(tab);
  }

  // While mocks exist, the cache is off, so every request reaches the rules.
  // DevTools does the same when it intercepts requests.
  private async refreshRouter(tab: Tab): Promise<void> {
    await tab.router?.refresh().catch(() => undefined);
    await tab.page.setCacheEnabled(this.rulesFor(tab).length === 0).catch(() => undefined);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  // Returns and clears the notes since the last call.
  drainNotes(): string[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }

  async close(): Promise<void> {
    if (this.closedReason) return;
    this.closedReason = 'closed_by_agent';
    this.removeShutdown?.();
    await this.refs.reset();
    if (this.mode === 'launched') {
      await this.browser.close().catch(() => killChrome(this.browser));
      if (this.profileDir) removeProfile(this.profileDir);
    } else {
      await this.closeLogins();
      await this.browser.disconnect().catch(() => undefined);
    }
  }
}

export function dialogOpenMessage(d: PendingDialog): string {
  const said = d.message ? ` It says: "${d.message}".` : '';
  return `A ${d.type} dialog is open in tab ${d.tabId}.${said} Ask the developer how to answer it. Then call the dialog tool with action "accept" or "dismiss".`;
}
