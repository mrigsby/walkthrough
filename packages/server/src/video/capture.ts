import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, ElementHandle, Protocol } from 'puppeteer-core';
import type { Driver } from '../browser/driver.js';
import { maskSecretFields } from '../evidence/annotate.js';
import type { Rect } from '../panel/controller.js';
import type { CaptureFrame, TimelineEvent } from './timeline.js';

// Chrome sends a picture each time the page paints. More than about 30 each second
// only makes the folder bigger, so a quick picture replaces the one before it.
const MIN_GAP_MS = 33;

export interface CaptureOptions {
  maxWidth: number;
  showPanel: boolean;
}

// Records the active tab with Chrome's screencast, and follows it to other tabs.
// The pictures go to a temp folder. Events tell the timeline what happened when.
export class VideoCapture {
  readonly frames: CaptureFrame[] = [];
  readonly events: TimelineEvent[] = [];
  readonly dir = mkdtempSync(join(tmpdir(), 'uiwalk-video-'));
  readonly startedAt = Date.now();
  stoppedAt?: number;
  caption = '';
  private session?: { tabId: string; cdp: CDPSession };
  private hiddenTabs = new Set<string>();
  private restores: Array<() => Promise<void>> = [];
  private work: Promise<void> = Promise.resolve();
  private readonly onActive = (id?: string) => {
    this.work = this.work.then(() => this.follow(id)).catch(() => undefined);
  };

  constructor(
    private readonly driver: Driver,
    readonly options: CaptureOptions,
  ) {}

  get recording(): boolean {
    return this.stoppedAt === undefined;
  }

  async start(): Promise<void> {
    // Secrets that are already typed stay hidden while Walkthrough records.
    this.restores.push(await maskSecretFields(this.driver.secretFields));
    this.driver.emitter.on('active-changed', this.onActive);
    this.onActive(this.driver.activeId);
    await this.work;
  }

  private async follow(tabId?: string): Promise<void> {
    if (!this.recording || this.session?.tabId === tabId) return;
    const old = this.session;
    this.session = undefined;
    if (old) {
      await old.cdp.send('Page.stopScreencast').catch(() => undefined);
      await old.cdp.detach().catch(() => undefined);
    }
    const tab = tabId ? this.driver.tabs.get(tabId) : undefined;
    if (!tab) return;
    if (!this.options.showPanel && !this.hiddenTabs.has(tab.id)) {
      this.hiddenTabs.add(tab.id);
      await this.driver.panel?.suppress(tab.id, true, 'video');
    }
    const cdp = await tab.page.createCDPSession();
    this.session = { tabId: tab.id, cdp };
    // A minimized window paints nothing, so it gets its normal size again.
    try {
      const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
      if (bounds.windowState === 'minimized')
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    } catch {
      // Headless Chrome has no window.
    }
    cdp.on('Page.screencastFrame', (event: Protocol.Page.ScreencastFrameEvent) =>
      this.onFrame(tab.id, cdp, event),
    );
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: this.options.maxWidth,
      maxHeight: this.options.maxWidth,
    });
  }

  private onFrame(tabId: string, cdp: CDPSession, event: Protocol.Page.ScreencastFrameEvent): void {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    if (!this.recording || this.session?.cdp !== cdp) return;
    const now = Date.now();
    const last = this.frames.at(-1);
    const data = Buffer.from(event.data, 'base64');
    if (last && last.tabId === tabId && now - last.t < MIN_GAP_MS) {
      writeFileSync(join(this.dir, last.file), data);
      return;
    }
    const file = `${String(this.frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.dir, file), data);
    this.frames.push({
      file,
      t: now,
      tabId,
      width: event.metadata.deviceWidth ?? 0,
      height: event.metadata.deviceHeight ?? 0,
    });
  }

  // An action on an element. The video moves the pointer there and marks clicks.
  action(tabId: string, kind: string, rect?: Rect): void {
    this.events.push({
      type: 'action',
      t: Date.now(),
      tabId,
      kind,
      ...(rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : {}),
    });
  }

  // A tool call that changes the page. This time plays at normal speed.
  activity(start: number, end = Date.now()): void {
    this.events.push({ type: 'activity', start, end });
  }

  setCaption(text: string): void {
    if (text === this.caption) return;
    this.caption = text;
    this.events.push({ type: 'caption', t: Date.now(), text });
  }

  question(open: boolean): void {
    this.events.push({ type: 'question', t: Date.now(), open });
  }

  // Hides a field before a secret goes in, until the recording stops.
  async maskSecret(handle: ElementHandle): Promise<void> {
    this.restores.push(await maskSecretFields([handle]));
  }

  // Stops recording. The pictures stay until discard.
  async stop(): Promise<void> {
    if (!this.recording) return;
    this.stoppedAt = Date.now();
    this.driver.emitter.off('active-changed', this.onActive);
    await this.work;
    const session = this.session;
    this.session = undefined;
    if (session) {
      await session.cdp.send('Page.stopScreencast').catch(() => undefined);
      await session.cdp.detach().catch(() => undefined);
    }
    for (const tabId of this.hiddenTabs) {
      await this.driver.panel?.suppress(tabId, false, 'video').catch(() => undefined);
    }
    for (const restore of this.restores) await restore().catch(() => undefined);
    this.restores = [];
  }

  discard(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
