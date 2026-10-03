import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { CDPSession } from 'puppeteer-core';
import type { Tab } from '../browser/driver.js';
import {
  type BridgeMessage,
  IsolatedBridge,
  type IsolatedScript,
} from '../browser/isolated-bridge.js';
import { checkSlideImage } from '../guards/paths.js';
import { log } from '../log.js';
import type { Rect } from '../panel/controller.js';
import { type ReplayEngine, sleep } from '../replay/engine.js';
import type { StepOps } from '../replay/ops.js';
import type { Stage } from '../replay/stage.js';
import type { Slide } from '../run/plan-schema.js';
import { STAGE_CSS } from '../stage/stage-css.js';
import { stageMain } from '../stage/stage-script.js';
import type { AudienceScreen } from './runner.js';
import type { Command, PresentationSession, PresentStep } from './session.js';

// A random world and binding for each server, so a page cannot guess them.
const TOKEN = randomBytes(6).toString('hex');
const BINDING = `__uiwalkStage_${TOKEN}`;
const SCRIPT: IsolatedScript = {
  world: `uiwalk-stage-${TOKEN}`,
  binding: BINDING,
  receiver: '__uiwalkStage',
  source: `(${stageMain.toString()})(${JSON.stringify({ binding: BINDING, css: STAGE_CSS })});`,
};

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

// How long an answer from the chat stays on the audience screen.
const ON_SCREEN_MS = 12_000;

type Shown =
  | { kind: 'image'; src: string; fit?: string; background?: string }
  | { kind: 'text'; title: string; text?: string; background?: string; color?: string };

export interface LiveStageOptions {
  projectDir: string;
  planName: string;
  captions: boolean;
  pointer: boolean;
  mask: string[];
  title?: Slide;
  end?: Slide;
  fullscreen?: boolean;
}

// The audience screen of a presentation: it draws in the audience tab, and follows the session.
export class LiveStage implements Stage, AudienceScreen {
  private bridge?: IsolatedBridge;
  private engine?: ReplayEngine;
  private shown: Shown | null = null;
  private stepCaption: string | null = null;
  private curtainOn = false;
  private gateShown = false;
  private answer?: { text: string; until: number };
  private lastShown = 0;
  private titleSlide?: Shown | null;
  private answerTimer?: NodeJS.Timeout;
  private sent = '';
  private stopWatch?: () => void;
  private readonly images = new Map<string, string>();

  constructor(
    private readonly tab: Tab,
    private readonly session: PresentationSession,
    private readonly options: LiveStageOptions,
  ) {}

  // The engine finds the element of a step for the spotlight. It comes after the stage.
  useEngine(engine: ReplayEngine): void {
    this.engine = engine;
  }

  async install(): Promise<void> {
    // An app with a strict policy could block the slide images and the stage.
    await this.tab.page.setBypassCSP(true).catch(() => undefined);
    // No scrollbars on the audience screen, so a slide covers the whole window.
    await this.tab.cdp
      ?.send('Emulation.setScrollbarsHidden', { hidden: true })
      .catch(() => undefined);
    this.bridge = await IsolatedBridge.install(
      this.tab.page,
      SCRIPT,
      (msg) => void this.onMessage(msg),
    );
    this.stopWatch = this.session.watch(() => void this.sync());
    if (this.options.fullscreen) await this.fullscreen().catch(() => undefined);
  }

  dispose(): void {
    this.stopWatch?.();
    if (this.answerTimer) clearTimeout(this.answerTimer);
  }

  private async onMessage(msg: BridgeMessage): Promise<void> {
    if (msg.type === 'hello') {
      // A new page: show it the state again.
      this.sent = '';
      await this.sync();
      return;
    }
    if (msg.type === 'key' && typeof msg.key === 'string') this.onKey(msg.key);
  }

  // Keys from a clicker or the keyboard in the audience window.
  private onKey(key: string): void {
    const s = this.session;
    if (key === 'b' || key === 'B' || key === '.') {
      s.setBlank(!s.blank);
      return;
    }
    if (key === 'Escape') {
      if (s.info.kiosk) s.stop();
      return;
    }
    let command: Command | undefined;
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      command = s.state === 'title' ? { type: 'start' } : { type: 'continue' };
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      command = { type: 'back' };
    }
    if (command && !s.check(command)) s.command(command);
  }

  private async image(path: string): Promise<string | undefined> {
    const cached = this.images.get(path);
    if (cached) return cached;
    try {
      const real = checkSlideImage(path, this.options.projectDir);
      const type = IMAGE_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream';
      const src = `data:${type};base64,${readFileSync(real).toString('base64')}`;
      this.images.set(path, src);
      return src;
    } catch (error) {
      log.warn('a slide image cannot show', error);
      return undefined;
    }
  }

  private async show(slide: Slide | undefined): Promise<Shown | null> {
    if (!slide) return null;
    if ('image' in slide) {
      const src = await this.image(slide.image);
      return src
        ? { kind: 'image', src, fit: slide.fit, background: slide.background }
        : { kind: 'text', title: this.options.planName };
    }
    return {
      kind: 'text',
      title: slide.title,
      text: slide.text,
      background: slide.background,
      color: slide.color,
    };
  }

  // Sends the state to the page, and sets what a new page shows before its first paint.
  private async sync(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    const s = this.session;
    if (this.gateShown && s.state !== 'gate') {
      this.gateShown = false;
      await bridge.send({ type: 'spot', rect: null });
      await bridge.send({ type: 'zoom', src: null });
    }
    // A new answer for the screen shows for a while, in the caption band.
    const latest = s.chat
      .filter((c) => c.answer && c.shownAt)
      .sort((a, b) => (b.shownAt ?? 0) - (a.shownAt ?? 0))[0];
    if (latest?.shownAt && latest.shownAt > this.lastShown) {
      this.lastShown = latest.shownAt;
      this.answer = { text: latest.answer as string, until: Date.now() + ON_SCREEN_MS };
      if (this.answerTimer) clearTimeout(this.answerTimer);
      this.answerTimer = setTimeout(() => void this.sync(), ON_SCREEN_MS + 50);
    }
    const answer = this.answer && this.answer.until > Date.now() ? this.answer.text : null;
    const cover = s.blank ? 'blank' : this.curtainOn ? 'curtain' : 'none';
    // The presenter can show the title slide again, for example during questions.
    if (s.titleShown && this.titleSlide === undefined)
      this.titleSlide = await this.show(this.options.title ?? { title: this.options.planName });
    const state = {
      type: 'state',
      slide: s.titleShown ? (this.titleSlide ?? this.shown) : this.shown,
      caption: answer ?? (this.options.captions ? this.stepCaption : null),
      cover,
      keys: s.active && s.state !== 'manual',
      pointer: this.options.pointer,
      mask: this.options.mask,
    };
    const text = JSON.stringify(state);
    if (text === this.sent) return;
    this.sent = text;
    await bridge.setOnLoad('cover', cover === 'none' ? undefined : { type: 'cover', mode: cover });
    await bridge.send(state);
  }

  // ---------- The audience screen ----------

  async title(): Promise<void> {
    this.shown = await this.show(this.options.title);
    await this.sync();
  }

  async slide(step: PresentStep): Promise<void> {
    this.shown = await this.show(step.slide);
    this.stepCaption = step.caption ?? null;
    await this.sync();
  }

  async end(): Promise<void> {
    this.shown = await this.show(
      this.options.end ?? { title: this.options.planName, text: 'Questions?' },
    );
    this.stepCaption = null;
    await this.sync();
  }

  async clear(): Promise<void> {
    this.shown = null;
    await this.sync();
  }

  async curtain(on: boolean): Promise<void> {
    this.curtainOn = on;
    await this.sync();
  }

  // Before an action: the spotlight on its element, a bigger picture of it, and the pointer.
  async gate(step: PresentStep, ops: StepOps): Promise<void> {
    const bridge = this.bridge;
    const rect = await this.engine?.targetRect(ops);
    if (!bridge || !rect || this.session.state !== 'gate') return;
    const src = step.zoom ? await this.engine?.viewImage() : undefined;
    this.gateShown = true;
    if (step.spotlight) await bridge.send({ type: 'spot', rect });
    if (src) await bridge.send({ type: 'zoom', src, rect, zoom: step.zoom });
    this.glide(this.tab, rect, 600);
  }

  // ---------- The replay's stage ----------

  stepStart(text: string): void {
    this.stepCaption = text;
    void this.sync();
  }

  glide(tab: Tab, rect: Rect, ms: number): void {
    if (tab.id !== this.tab.id) return;
    void this.bridge?.send({
      type: 'glide',
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      ms,
    });
  }

  async point(tab: Tab, kind: string): Promise<void> {
    if (tab.id !== this.tab.id) return;
    if (['click', 'dblclick', 'check', 'uncheck', 'select', 'upload'].includes(kind))
      await this.bridge?.send({ type: 'ripple' });
  }

  // ---------- The window ----------

  private async withWindow(
    fn: (cdp: CDPSession, windowId: number) => Promise<void>,
  ): Promise<void> {
    const cdp = await this.tab.page.createCDPSession();
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await fn(cdp, windowId);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  private fullscreen(): Promise<void> {
    return this.withWindow(async (cdp, windowId) => {
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'fullscreen' },
      });
    });
  }

  // Fullscreen on and off, from the presenter window.
  toggleFullscreen(): Promise<void> {
    return this.withWindow(async (cdp, windowId) => {
      const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: bounds.windowState === 'fullscreen' ? 'normal' : 'fullscreen' },
      });
    });
  }

  // Moves the audience window to another screen, in fullscreen.
  moveToScreen(screen: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): Promise<void> {
    return this.withWindow(async (cdp, windowId) => {
      const bounds = async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds;
      if ((await bounds()).windowState !== 'normal') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        for (let i = 0; i < 30 && (await bounds()).windowState !== 'normal'; i++) await sleep(150);
        // On macOS, the window says "normal" before the animation ends.
        await sleep(800);
      }
      const now = await bounds();
      const width = Math.min(now.width ?? 1280, screen.width);
      const height = Math.min(now.height ?? 800, screen.height);
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: screen.left + Math.round((screen.width - width) / 2),
          top: screen.top + Math.round((screen.height - height) / 2),
          width,
          height,
        },
      });
      await sleep(300);
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'fullscreen' },
      });
    });
  }
}
