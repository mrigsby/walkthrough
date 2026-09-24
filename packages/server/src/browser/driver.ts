import { EventEmitter } from 'node:events';
import type { Browser, CDPSession, Dialog, ElementHandle, Page, Target } from 'puppeteer-core';
import type { Config, DialogPolicy } from '../config.js';
import { ToolError } from '../errors.js';
import { LogBook } from '../evidence/logs.js';
import { onShutdown } from '../lifecycle.js';
import { log } from '../log.js';
import { RefTable } from '../page/refs.js';
import { DeveloperPanel } from '../panel/controller.js';
import { attachChrome } from './attach.js';
import { applyEmulation, type Emulation } from './devices.js';
import { killChrome, launchChrome, removeProfile } from './launch.js';
import { guardNavigation } from './navigation-guard.js';

export interface Tab {
  id: string;
  page: Page;
  openerId?: string;
  nav: number;
  crashed: boolean;
  closed: boolean;
  // True when the tab emulates a phone or tablet.
  mobile: boolean;
  cdp?: CDPSession;
}

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
  readonly panel?: DeveloperPanel;
  // The element of the last action, for the red box in bug screenshots.
  lastTarget?: { tabId: string; handle: ElementHandle<Element>; label: string };
  // Screen, color scheme, and network settings. New tabs get them too.
  emulation: Emulation = {};
  private userAgent = '';
  activeId?: string;
  dialogPolicy: DialogPolicy;
  closedReason?: 'browser_closed' | 'closed_by_agent';

  private tabCounter = 0;
  private notes: string[] = [];
  private pendingDialogs = new Map<string, PendingDialog>();
  private pendingWork = new Map<string, Promise<unknown>>();
  private removeShutdown?: () => void;
  private inflight = new Set<Promise<unknown>>();

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
      // Use a new tab of our own. Never touch the developer's other tabs.
      await driver.addTab(await browser.newPage());
    } else {
      const { browser, profileDir } = await launchChrome(options.config);
      driver = new Driver(browser, 'launched', await browser.version(), options, profileDir);
      const first = (await browser.pages())[0] ?? (await browser.newPage());
      await driver.addTab(first);
    }
    driver.watchBrowser();
    return driver;
  }

  get alive(): boolean {
    return !this.closedReason;
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
        await this.browser.disconnect().catch(() => undefined);
      }
    });
  }

  // A new tab or popup opened.
  private async onTarget(target: Target): Promise<void> {
    if (target.type() !== 'page') return;
    const page = await target.page().catch(() => null);
    if (!page || this.findTab(page)) return;
    const openerPage = await target
      .opener()
      ?.page()
      .catch(() => null);
    const opener = openerPage ? this.findTab(openerPage) : undefined;
    // In attach mode, only follow tabs that our tabs opened.
    if (this.mode === 'attached' && !opener) return;
    const tab = await this.addTab(page, opener?.id);
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

  async addTab(page: Page, openerId?: string): Promise<Tab> {
    this.tabCounter += 1;
    const tab: Tab = {
      id: `t${this.tabCounter}`,
      page,
      openerId,
      nav: 0,
      crashed: false,
      closed: false,
      mobile: false,
    };
    this.tabs.set(tab.id, tab);
    this.activeId ??= tab.id;

    page.setDefaultTimeout(this.options.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(30_000);

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) tab.nav += 1;
    });
    page.on('error', () => {
      tab.crashed = true;
      this.note(`The page in tab ${tab.id} crashed.`);
    });
    page.on('close', () => this.onTabClosed(tab));
    page.on('dialog', (dialog) => void this.onDialog(tab, dialog));
    this.logs.attach(page, tab.id);
    await this.panel?.attach(page, tab.id);
    if (Object.keys(this.emulation).length > 0)
      await this.emulateTab(tab, this.emulation).catch(() => undefined);

    tab.cdp = await guardNavigation(
      page,
      (url) => this.options.isAllowed(url),
      (url) =>
        this.note(
          `Walkthrough blocked the tab from opening ${url}, because that site is not allowed.`,
        ),
    );

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
    if (this.activeId === tab.id) {
      const next = [...this.tabs.values()].at(-1);
      this.activeId = next?.id;
      if (!this.closedReason) {
        this.note(
          next
            ? `Tab ${tab.id} closed. The active tab is now ${next.id}.`
            : `Tab ${tab.id} closed. No tabs are open.`,
        );
      }
    }
  }

  private async onDialog(tab: Tab, dialog: Dialog): Promise<void> {
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

  private async emulateTab(tab: Tab, emulation: Emulation): Promise<boolean> {
    this.userAgent ||= await this.browser.userAgent();
    const result = await applyEmulation(tab.page, emulation, {
      headless: this.options.config.browser.headless,
      userAgent: this.userAgent,
      wasMobile: tab.mobile,
    });
    tab.mobile = result.isMobile;
    return result.needsReload;
  }

  // Changes the screen, color scheme, or network for every tab.
  // A tab reloads when it switches between desktop and phone mode.
  async setEmulation(emulation: Emulation, options: { reload: boolean }): Promise<string[]> {
    this.emulation = { ...this.emulation, ...emulation };
    const reloaded: string[] = [];
    for (const tab of this.tabs.values()) {
      const needsReload = await this.emulateTab(tab, emulation);
      if (needsReload && options.reload && /^https?:/.test(tab.page.url())) {
        await tab.page.reload({ waitUntil: 'load' }).catch(() => undefined);
        reloaded.push(tab.id);
      }
    }
    return reloaded;
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
      throw new ToolError('No tab is open. Use navigate or browser_open to open a page.', 'no_tab');
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

  switchTo(id: string): Tab {
    this.assertAlive();
    const tab = this.tabs.get(id);
    if (!tab)
      throw new ToolError(`There is no tab "${id}". Use the tabs tool to list tabs.`, 'no_tab');
    this.activeId = id;
    void tab.page.bringToFront().catch(() => undefined);
    void this.panel?.refresh(id);
    return tab;
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
      await this.browser.disconnect().catch(() => undefined);
    }
  }
}

export function dialogOpenMessage(d: PendingDialog): string {
  const said = d.message ? ` It says: "${d.message}".` : '';
  return `A ${d.type} dialog is open in tab ${d.tabId}.${said} Ask the developer how to answer it. Then call the dialog tool with action "accept" or "dismiss".`;
}
