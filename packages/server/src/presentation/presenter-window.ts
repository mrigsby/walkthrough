import { randomBytes } from 'node:crypto';
import type { BrowserContext, CDPSession, Page } from 'puppeteer-core';
import type { Driver } from '../browser/driver.js';
import { log } from '../log.js';
import { sleep } from '../replay/engine.js';
import type {
  PresenterBoot,
  PresenterMessage,
  PresenterView,
  ToPresenter,
} from './presenter-protocol.js';
import { presenterSource } from './presenter-source.js';
import { COMMANDS_IN, type PresentationSession } from './session.js';

// The presenter page has an address that no server answers. Chrome gets the page from us,
// so nothing else can reach it. A .localhost name is a secure context, and the app never
// uses it, so the app's zoom does not apply.
export const PRESENTER_ORIGIN = 'http://uiwalk-presenter.localhost';
const PRESENTER_URL = `${PRESENTER_ORIGIN}/`;

// What the presenter window does through the rest of the presentation.
export interface PresenterControls {
  // The presenter confirmed a protected environment. Open the app.
  confirm(): Promise<void>;
  cancel(): void;
  toggleFullscreen(): Promise<void>;
  moveToScreen(screen: { left: number; top: number; width: number; height: number }): Promise<void>;
}

export interface PresenterOptions {
  audience: Page;
  mirror: boolean;
  protectedEnv: boolean;
  controls: PresenterControls;
}

// Everything that the presenter window shows, from the session.
export function presenterView(
  session: PresentationSession,
  options: { protectedEnv: boolean; mirror: boolean },
): PresenterView {
  return {
    name: session.info.name,
    runId: session.info.runId,
    environment: { ...session.info.environment, protected: options.protectedEnv },
    state: session.state,
    current: session.current,
    blank: session.blank,
    titleShown: session.titleShown,
    ...(session.confirmNeeded ? { confirmNeeded: session.confirmNeeded } : {}),
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.info.timeBudgetSec ? { timeBudgetSec: session.info.timeBudgetSec } : {}),
    stepElapsedMs: session.stepElapsed(),
    stepClockRunning: session.state !== 'title' && session.state !== 'stopped',
    steps: session.steps.map((step, i) => ({
      index: step.index,
      title: step.title,
      ...(step.notes ? { notes: step.notes } : {}),
      hasAction: step.hasAction,
      pause: step.pause,
      slide: Boolean(step.slide),
      ...(step.timeBudgetSec ? { timeBudgetSec: step.timeBudgetSec } : {}),
      spentMs: i === session.current ? session.stepElapsed() : (session.stepTimes.get(i) ?? 0),
    })),
    ...(session.failure
      ? { failure: { step: session.failure.step, message: session.failure.message } }
      : {}),
    chat: session.chat.map((c) => ({
      id: c.id,
      ...(c.question ? { question: c.question } : {}),
      ...(c.answer ? { answer: c.answer } : {}),
      state: c.answer ? 'answered' : c.takenAt ? 'thinking' : 'waiting',
      onScreen: Boolean(c.shownAt),
    })),
    listening: session.listening,
    can: session.confirmNeeded ? ['end'] : [...COMMANDS_IN[session.state]],
    mirror: options.mirror,
  };
}

function pageHtml(source: string, boot: PresenterBoot): string {
  // Text in a script tag must not end the tag early.
  const safe = (text: string) => text.replace(/<\/(script)/gi, '<\\/$1');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Presenter</title></head><body>',
    `<script>window.__uiwalkPresenterBoot = ${safe(JSON.stringify(boot))};</script>`,
    `<script>${safe(source)}</script>`,
    '</body></html>',
  ].join('');
}

// The presenter window: a page of our own in its own browser login. The tools never see it,
// and it never leaves its address.
export class PresenterWindow {
  private closed = false;
  private stopWatch?: () => void;
  private viewTimer?: NodeJS.Timeout;
  private mirrorCdp?: CDPSession;
  private latestFrame?: string;
  private sendingFrames = false;

  private constructor(
    private readonly session: PresentationSession,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly nonce: string,
    private readonly options: PresenterOptions,
  ) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  static async open(
    driver: Driver,
    session: PresentationSession,
    options: PresenterOptions,
  ): Promise<PresenterWindow> {
    const context = await driver.browser.createBrowserContext();
    // Before the page opens, so the driver never takes it as a tab.
    driver.addForeign(context);
    // The presenter page may list the screens, for "Other screen".
    const browserCdp = await driver.browser.target().createCDPSession();
    await browserCdp
      .send('Browser.grantPermissions', {
        permissions: ['windowManagement'],
        origin: PRESENTER_ORIGIN,
        browserContextId: context.id,
      })
      .catch((error) => log.warn('the presenter window cannot list the screens', error));
    await browserCdp.detach().catch(() => undefined);

    const page = await context.newPage({ type: 'window' });
    const nonce = randomBytes(16).toString('hex');
    const binding = `__uiwalkPresenter_${randomBytes(6).toString('hex')}`;
    const html = pageHtml(await presenterSource(), { binding, nonce });
    const win = new PresenterWindow(session, context, page, nonce, options);

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url === PRESENTER_URL) {
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      } else if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        // A 204 answer keeps the page where it is.
        void request.respond({ status: 204, body: '' });
      } else {
        void request.abort('blockedbyclient');
      }
    });
    await page.exposeFunction(binding, (payload: string) => win.onPayload(payload));
    page.once('close', () => win.onClosed());
    await page.goto(PRESENTER_URL);
    win.stopWatch = session.watch(() => win.queueView());
    if (options.mirror) await win.startMirror().catch((error) => log.warn('no mirror', error));
    session.setPresenterOpen(true);
    return win;
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatch?.();
    if (this.viewTimer) clearTimeout(this.viewTimer);
    void this.mirrorCdp?.detach().catch(() => undefined);
    this.session.setPresenterOpen(false);
  }

  async close(): Promise<void> {
    this.onClosed();
    await this.context.close().catch(() => undefined);
  }

  private async post(msg: ToPresenter): Promise<void> {
    if (this.closed) return;
    await this.page
      .evaluate((m) => {
        const target = (window as unknown as Record<string, { receive?: (x: unknown) => void }>)
          .__uiwalkPresenter;
        target?.receive?.(m);
      }, msg)
      .catch(() => undefined);
  }

  notice(text: string): void {
    void this.post({ type: 'notice', text });
  }

  // Many changes can come at once. Send the view once for them.
  private queueView(): void {
    if (this.closed || this.viewTimer) return;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = undefined;
      void this.post({ type: 'view', view: this.view() });
    }, 30);
  }

  private view(): PresenterView {
    return presenterView(this.session, {
      protectedEnv: this.options.protectedEnv,
      mirror: this.options.mirror,
    });
  }

  // ---------- Messages from the page ----------

  private onPayload(payload: string): void {
    let parsed: { nonce?: string; msg?: PresenterMessage };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed.nonce !== this.nonce || !parsed.msg) return;
    void this.onMessage(parsed.msg).catch((error) => {
      log.warn('a presenter action did not work', error);
      this.notice(`That did not work: ${(error as Error).message}`);
    });
  }

  private async onMessage(msg: PresenterMessage): Promise<void> {
    const s = this.session;
    switch (msg.type) {
      case 'hello':
        await this.post({ type: 'view', view: this.view() });
        return;
      case 'command': {
        const problem = s.check(msg.command);
        if (problem) this.notice(problem);
        else s.command(msg.command);
        return;
      }
      case 'next': {
        const next =
          s.state === 'title' ? { type: 'start' as const } : { type: 'continue' as const };
        if (!s.check(next)) s.command(next);
        return;
      }
      case 'confirm':
        await this.options.controls.confirm();
        return;
      case 'cancel':
        this.options.controls.cancel();
        return;
      case 'blank':
        s.setBlank(!s.blank);
        return;
      case 'title':
        s.setTitleShown(!s.titleShown);
        return;
      case 'fullscreen':
        await this.options.controls.toggleFullscreen();
        return;
      case 'screen':
        this.notice('The audience window moves to the screen.');
        await this.options.controls.moveToScreen(msg);
        return;
      case 'ask': {
        const text = String(msg.text ?? '')
          .trim()
          .slice(0, 500);
        if (text) s.ask(text);
        return;
      }
      case 'show':
        s.showOnScreen(String(msg.id));
        return;
    }
  }

  // ---------- The mirror ----------

  // A live picture of the audience screen, from its own screencast.
  private async startMirror(): Promise<void> {
    const cdp = await this.options.audience.createCDPSession();
    this.mirrorCdp = cdp;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      this.latestFrame = `data:image/jpeg;base64,${data}`;
      void this.sendFrames();
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 960,
      maxHeight: 600,
    });
  }

  // Sends the newest frame, about ten times a second at most. Older frames are dropped.
  private async sendFrames(): Promise<void> {
    if (this.sendingFrames) return;
    this.sendingFrames = true;
    try {
      while (this.latestFrame && !this.closed) {
        const src = this.latestFrame;
        this.latestFrame = undefined;
        await this.post({ type: 'frame', src });
        await sleep(100);
      }
    } finally {
      this.sendingFrames = false;
    }
  }
}
