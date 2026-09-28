import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Dialog, ElementHandle, Frame } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { loadSession, restoreSession } from '../browser/sessions.js';
import type { Config } from '../config.js';
import type { Context } from '../context.js';
import type { MockRuleInput } from '../devtools/mock-schema.js';
import { writeStorage } from '../devtools/storage.js';
import { ToolError } from '../errors.js';
import { elementRect, maskSecretFields } from '../evidence/annotate.js';
import { checkMediaPath, checkUploadPath } from '../guards/paths.js';
import type { SecretStore } from '../guards/secrets.js';
import { pressKeys, selectOption } from '../page/actions.js';
import { newUnique, withUnique } from '../page/unique.js';
import { fileStamp } from '../project-files.js';
import { latestRunId, RunStore } from '../run/run-store.js';
import { openBrowser } from '../tools/browser-tools.js';
import { VideoCapture } from '../video/capture.js';
import { encodeVideo } from '../video/encoder.js';
import { chooseFormat, type VideoFormat } from '../video/formats.js';
import { liveCaptures, size } from '../video/recording.js';
import { buildSamples } from '../video/timeline.js';
import { buildOps, type RunAction } from './ops.js';

// How fast a replay goes. Typing is per character. The pointer glides before each action,
// and each step holds at its end, so viewers can see the result.
export const PACES = {
  slow: { typeMs: 90, glideMs: 600, holdMs: 1800 },
  normal: { typeMs: 50, glideMs: 400, holdMs: 1200 },
  fast: { typeMs: 20, glideMs: 200, holdMs: 700 },
} as const;
export type Pace = keyof typeof PACES;

// Pictures each second in WebM and MP4. GIF uses the gifFps setting.
const VIDEO_FPS = 15;
// Long text types faster, so one field does not take too long.
const MAX_TYPE_MS = 3000;

export interface ReplayInput {
  runId?: string;
  formats?: VideoFormat[];
  paths?: string[];
  pace: Pace;
  session?: string;
  captions?: boolean;
  pointer?: boolean;
  titleCard?: boolean;
  width?: number;
  // Called at the start of each step, for progress notes.
  onStep?: (text: string) => void;
}

export interface ReplayResult {
  ok: boolean;
  lines: string[];
  preview?: string;
  previewType?: string;
  store: RunStore;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parse = (value?: string): Record<string, unknown> => {
  try {
    return JSON.parse(value ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

// Scrolls the element to the middle of the page, so the caption bar does not cover it.
export async function centerInView(handle: ElementHandle<Element>): Promise<void> {
  await handle
    .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    .catch(() => undefined);
}

// A failure in one step. The replay stops there.
class StepError extends Error {}

// Repeats the operations of a run in a new login of the test browser.
class Replay {
  // Tabs by their name in the run. The replay has its own tabs.
  readonly tabs = new Map<string, Tab>();
  current = 'main';
  // Logins by their name in the run, and the new login that stands for each.
  private readonly logins = new Map<string, string>();
  // Dialog answers of the run, in order.
  readonly dialogs: Array<{ accept: boolean; text?: string }> = [];
  // Mock rules of the replay, by their id in the run.
  readonly mocks = new Map<string, string>();
  readonly restores: Array<() => Promise<void>> = [];
  private readonly key = randomBytes(2).toString('hex');

  constructor(
    readonly driver: Driver,
    readonly config: Config,
    readonly secrets: SecretStore,
    readonly unique: string,
    readonly pace: (typeof PACES)[Pace],
    readonly capture: () => VideoCapture | undefined,
  ) {}

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

  private text(value: string): string {
    return this.secrets.resolve(withUnique(value, this.unique));
  }

  private async frameOf(frameUrl?: string): Promise<Frame> {
    const page = this.tab.page;
    if (!frameUrl) return page.mainFrame();
    let part = frameUrl;
    try {
      part = new URL(withUnique(frameUrl, this.unique)).pathname;
    } catch {}
    const end = Date.now() + this.config.actionTimeoutMs;
    while (Date.now() < end) {
      const found = page.frames().find((f) => f.url().includes(part));
      if (found) return found;
      await sleep(100);
    }
    throw new StepError(`There is no frame with the address ${part}.`);
  }

  private async find(action: RunAction): Promise<ElementHandle<Element>> {
    const frame = await this.frameOf(action.frameUrl);
    const handle = await frame
      .waitForSelector(action.selector as string, { timeout: this.config.actionTimeoutMs })
      .catch(() => null);
    if (!handle)
      throw new StepError(`Walkthrough did not find ${action.label} (${action.selector}).`);
    return handle as ElementHandle<Element>;
  }

  // Moves the video's pointer to the element before the action.
  private async point(handle: ElementHandle<Element>, kind: string): Promise<void> {
    await centerInView(handle);
    await sleep(this.pace.glideMs);
    this.capture()?.action(this.tab.id, kind, await elementRect(handle));
  }

  // Goes to the address, unless the last action already went there.
  async reach(url: string): Promise<void> {
    let want: URL;
    try {
      want = new URL(withUnique(url, this.unique));
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
        { timeout: 3000 },
        want.pathname + want.search,
      );
    } catch {
      await page.goto(want.href, { waitUntil: 'load' });
    }
  }

  async expectText(text: string): Promise<void> {
    const found = await this.tab.page
      .waitForFunction((t) => document.body?.innerText.includes(t), { timeout: 10_000 }, text)
      .then(() => true)
      .catch(() => false);
    if (!found) throw new StepError(`The page does not show "${text}".`);
  }

  async act(action: RunAction): Promise<void> {
    const page = () => this.tab.page;
    const value = action.value ?? '';
    switch (action.action) {
      case 'navigate':
        await page().goto(withUnique(action.value ?? action.label, this.unique), {
          waitUntil: 'load',
        });
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
        // A secret is hidden before it goes in, so the video never shows it.
        if (this.secrets.hasTokens(value)) this.restores.push(await maskSecretFields([handle]));
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
        const delay = Math.min(this.pace.typeMs, MAX_TYPE_MS / Math.max(1, text.length));
        await page().keyboard.type(text, { delay });
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
        this.capture()?.action(this.tab.id, 'press');
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
        // The answers are in the queue already.
        return;
      case 'tab-new': {
        const detail = parse(action.value);
        const tab = await this.openTab(
          String(detail.name ?? `tab-${this.tabs.size + 1}`),
          String(detail.login ?? 'main'),
        );
        if (typeof detail.url === 'string')
          await tab.page.goto(withUnique(detail.url, this.unique), { waitUntil: 'load' });
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
        while (Date.now() < end) {
          const popup = [...this.driver.tabs.values()].find(
            (t) => t.openerId === opener.id && !mine.has(t.id),
          );
          if (popup) {
            popup.answerDialog = this.answer;
            this.tabs.set(name, popup);
            this.use(name);
            return;
          }
          await sleep(100);
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
        // Mocks of a replay stay with its own tabs.
        const tabIds = target ? [target.id] : [...this.tabs.values()].map((t) => t.id);
        for (const tabId of tabIds) {
          const added = await this.driver.addMock({ ...(rule as MockRuleInput), tab: tabId });
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
            ? detail.domain
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
}

// Records a finished run again in a new login, at an even pace, and saves the video.
export async function replayRun(ctx: Context, input: ReplayInput): Promise<ReplayResult> {
  const config = await ctx.config();
  if (ctx.run?.run.status === 'running') {
    throw new ToolError('A run is going. Call run_finish first, then replay it.', 'run_active');
  }
  if (liveCaptures(ctx).length > 0) {
    throw new ToolError('A video is recording. Call video with action stop first.', 'video_active');
  }
  const id = input.runId ?? latestRunId(config.projectDir, { finishedOnly: true });
  if (!id) throw new ToolError('There is no finished run to replay.', 'no_run');
  const store = RunStore.open(config.projectDir, id);
  const run = store.run;
  const plan = buildOps(run);
  if (plan.missingSelectors.length) {
    throw new ToolError(
      [
        `Walkthrough cannot replay the run "${run.name}", because these actions have no stable selector:`,
        ...plan.missingSelectors.map((m) => `- ${m}`),
        'Add an exact action to these plan steps, and run the plan again.',
      ].join('\n'),
      'replay_blocked',
    );
  }
  if (!plan.steps.some((s) => s.ops.some((o) => o.type === 'action'))) {
    throw new ToolError(`The run "${run.name}" has no actions to replay.`, 'nothing_to_do');
  }

  // The formats to make, and the exact files. A path adds its own format.
  const targets = (input.paths ?? []).map((p) => ({
    format: chooseFormat(undefined, p, config.video.runFormat),
    ...checkMediaPath(p, config.projectDir, config.screenshotRoots),
  }));
  const formats = [...new Set([...(input.formats ?? []), ...targets.map((t) => t.format)])];
  if (formats.length === 0) formats.push(config.video.runFormat);

  if (!ctx.driver?.alive) await openBrowser(ctx, {});
  const driver = ctx.requireDriver();
  const before = driver.activeId;
  const width = input.width ?? config.video.width;
  const pace = PACES[input.pace];
  let capture: VideoCapture | undefined;
  const replay = new Replay(driver, config, await ctx.secrets(), newUnique(), pace, () => capture);
  for (const { ops } of plan.steps)
    for (const op of ops) {
      if (op.type !== 'action' || op.action.action !== 'dialog') continue;
      const detail = parse(op.action.value);
      replay.dialogs.push({
        accept: detail.accept !== false,
        ...(typeof detail.text === 'string' ? { text: detail.text } : {}),
      });
    }

  const failure = async (stepTitle: string, error: Error): Promise<ReplayResult> => {
    const lines = [
      `The replay stopped at step ${stepTitle}: ${error.message}`,
      'Walkthrough saved no video. Fix the step or the app, and replay again.',
    ];
    let preview: string | undefined;
    try {
      const shot = await replay.tab.page.screenshot({ type: 'jpeg', quality: 80 });
      preview = Buffer.from(shot).toString('base64');
      const file = join(store.dir, 'video', `replay-failed-${fileStamp('step')}.jpg`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, shot);
      lines.push(`Screenshot: ${relative(config.projectDir, file)}`);
    } catch {}
    return { ok: false, lines, preview, previewType: preview ? 'image/jpeg' : undefined, store };
  };

  try {
    const main = await replay.openTab('main', 'main');
    // The run's screen and settings. Without a device, a fixed 16:10 size.
    const { device, ...rest } = run.emulation ?? {};
    await driver.setEmulation(device ? { ...rest, device } : rest, {
      tab: main,
      reload: false,
    });
    if (!device)
      await main.page.setViewport({
        width,
        height: Math.round((width * 10) / 16),
        deviceScaleFactor: 1,
      });
    const session = input.session ?? run.session;
    if (session) await restoreSession(main, loadSession(config.projectDir, session));
    await main.page.goto(run.baseUrl ?? config.baseUrl ?? 'about:blank', { waitUntil: 'load' });

    capture = new VideoCapture(driver, { maxWidth: width, showPanel: false });
    await capture.start();
    for (const { step, ops } of plan.steps) {
      const title = `${step.index} "${step.title}"`;
      input.onStep?.(`Step ${step.index}: ${step.title}`);
      if (input.captions ?? config.video.captions) capture.setCaption(step.caption ?? step.title);
      try {
        for (const op of ops) {
          if (op.type === 'reach') await replay.reach(op.url);
          else if (op.type === 'action') {
            await replay.act(op.action);
            await replay.tab.page
              .waitForNetworkIdle({ idleTime: 250, timeout: 3000 })
              .catch(() => undefined);
          } else if (op.type === 'expect') await replay.expectText(op.text);
        }
      } catch (error) {
        return await failure(title, error as Error);
      }
      await sleep(pace.holdMs);
    }
    await capture.stop();

    // A replay has no wait time to cut. All of it plays at normal speed.
    const events = [
      ...capture.events,
      { type: 'activity' as const, start: capture.startedAt, end: capture.stoppedAt ?? Date.now() },
    ];
    const lines: string[] = [];
    const videoDir = join(store.dir, 'video');
    mkdirSync(videoDir, { recursive: true });
    const stamp = fileStamp('replay');
    let preview: string | undefined;
    for (const format of formats) {
      const samples = buildSamples(capture.frames, events, {
        start: capture.startedAt,
        end: capture.stoppedAt ?? Date.now(),
        fps: format === 'gif' ? config.video.gifFps : VIDEO_FPS,
        idleSeconds: config.video.idleSeconds,
        pointer: input.pointer ?? config.video.pointer,
        captions: input.captions ?? config.video.captions,
        glideMs: pace.glideMs,
      });
      const seconds = samples.reduce((sum, s) => sum + s.duration, 0);
      if (format === 'gif' && seconds > config.video.maxGifSeconds) {
        lines.push(
          `Walkthrough made no GIF, because the replay is ${Math.round(seconds)} seconds long. GIF files can be up to ${config.video.maxGifSeconds} seconds (maxGifSeconds).`,
        );
        continue;
      }
      const middle = samples[Math.floor(samples.length / 2)];
      if (!preview && middle)
        preview = readFileSync(join(capture.dir, middle.file)).toString('base64');
      const out = await encodeVideo({
        config,
        framesDir: capture.dir,
        samples,
        format,
        outFile: join(videoDir, `${stamp}.${format}`),
        title: (input.titleCard ?? true) ? run.name : undefined,
        width: format === 'gif' ? config.video.gifWidth : width,
      });
      lines.push(
        `Saved the replay (${out.format.toUpperCase()}, ${out.seconds.toFixed(1)} seconds, ${size(out.bytes)}, ${out.width}x${out.height}): ${relative(config.projectDir, out.file)}`,
      );
      if (out.note) lines.push(out.note);
      const copies: string[] = [];
      for (const target of targets.filter((t) => t.format === out.format)) {
        mkdirSync(dirname(target.path), { recursive: true });
        copyFileSync(out.file, target.path);
        copies.push(target.display);
        lines.push(`Also saved it to ${target.display}. It replaced any file that was there.`);
      }
      run.videos ??= [];
      run.videos.push({
        file: relative(store.dir, out.file),
        format: out.format,
        seconds: Math.round(out.seconds * 10) / 10,
        bytes: out.bytes,
        name: 'replay',
        ...(copies[0] ? { path: copies[0] } : {}),
      });
    }
    store.save();
    lines.push(
      `The replay used a new login and a new {{unique}} value (${replay.unique}), at the ${input.pace} pace.`,
    );
    return { ok: true, lines, preview, previewType: preview ? 'image/jpeg' : undefined, store };
  } catch (error) {
    if (error instanceof StepError) return failure('(setup)', error);
    throw error;
  } finally {
    await capture?.stop().catch(() => undefined);
    capture?.discard();
    for (const driverId of replay.mocks.values()) await driver.removeMocks(driverId).catch(() => 0);
    for (const restore of replay.restores.reverse()) await restore().catch(() => undefined);
    // The replay's tabs and logins close. The tab from before is active again.
    const logins = replay.loginNames;
    for (const tab of [...driver.tabs.values()]) {
      if (logins.has(tab.login)) await tab.page.close().catch(() => undefined);
    }
    if (before && driver.tabs.has(before)) driver.switchTo(before);
  }
}
