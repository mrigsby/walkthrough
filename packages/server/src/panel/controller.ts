import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { log } from '../log.js';
import type { Recorder } from '../record/recorder.js';
import type { ProgressItem } from '../run/record.js';
import { PanelBridge, type PanelMessage } from './bridge.js';
import {
  type AnswerResult,
  buildConfirmView,
  buildStepView,
  type PanelView,
  viewChecklist,
} from './view.js';

export type { AnswerResult } from './view.js';

export interface Question {
  id: string;
  nonce: string;
  tabId: string;
  title: string;
  didWhat: string;
  expected: string;
  step?: number;
  total?: number;
  stepId?: string;
  // A confirm question has two buttons: confirmLabel (pass) and Cancel (stop).
  kind?: 'step' | 'confirm';
  confirmLabel?: string;
  color?: string;
  // What the panel shows. Without it, the panel shows the title and texts above.
  view?: PanelView;
  // What the developer changed in the panel, like ticks and open parts. It survives page loads.
  ui?: Record<string, boolean>;
  // A reference image for the panel. It goes in a message of its own.
  image?: { mime: string; data: string };
  // The element that the developer pointed at, for a bug.
  point?: PointedElement;
}

export interface PointedElement {
  label: string;
  selector?: string;
  // The node that the browser found at that place, while the page still has it.
  backendNodeId?: number;
}

export interface EnvironmentBadge {
  label: string;
  color: string;
}

export interface Answer {
  result: AnswerResult;
  note: string;
  // The check list items and the developer's ticks.
  checklist?: Array<{ text: string; checked: boolean }>;
}

export type WaitOutcome =
  | { kind: 'answer'; answer: Answer; question: Question }
  | { kind: 'timeout' }
  | { kind: 'canceled' }
  | { kind: 'browser_closed' }
  | { kind: 'tab_closed' };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RecordOutcome = 'stopped' | 'timeout' | 'canceled' | 'browser_closed';

const WORKING = 'The agent is working.';
// The most panel changes that one question keeps.
const MAX_UI_KEYS = 500;

// The view of a question that came without one.
export function questionView(q: Omit<Question, 'id' | 'nonce' | 'tabId'>): PanelView {
  if (q.view) return q.view;
  if (q.kind === 'confirm') {
    return buildConfirmView({
      title: q.title,
      message: q.didWhat,
      confirmLabel: q.confirmLabel,
      color: q.color,
    });
  }
  return buildStepView({ title: q.title, didWhat: q.didWhat, expected: q.expected });
}

// The developer panel in the browser: one question at a time.
export class DeveloperPanel {
  private bridges = new Map<string, PanelBridge>();
  private question?: Question;
  private stored?: { answer: Answer; question: Question };
  private waiter?: (outcome: WaitOutcome) => void;
  private status = WORKING;
  private corner = 'bottom-right';
  private recorder?: Recorder;
  private recordStopped = false;
  // Tabs where a screenshot or a check hides the panel for a moment.
  private hiddenIn = new Set<string>();
  // Tabs where the panel stays hidden, also on new pages, and why:
  // "lighthouse" while Lighthouse measures, "video" while Walkthrough records.
  private suppressed = new Map<string, Set<string>>();
  private recordWaiter?: (outcome: RecordOutcome) => void;
  private env: EnvironmentBadge | null = null;
  // The question whose image each tab has now. A page load clears it.
  private imageSent = new Map<string, string>();
  private pages = new Map<string, Page>();
  // The steps of the run, for the progress list. Null hides it.
  private progress: ProgressItem[] | null = null;
  private progressOpen = false;

  async attach(page: Page, tabId: string): Promise<void> {
    const bridge = await PanelBridge.install(page, (msg) => void this.onMessage(tabId, msg));
    if (bridge) this.bridges.set(tabId, bridge);
    this.pages.set(tabId, page);
  }

  detach(tabId: string): void {
    this.bridges.delete(tabId);
    this.pages.delete(tabId);
    this.imageSent.delete(tabId);
    this.hiddenIn.delete(tabId);
    this.suppressed.delete(tabId);
    if (this.question?.tabId === tabId) {
      this.question = undefined;
      this.finish({ kind: 'tab_closed' });
    }
  }

  onBrowserClosed(): void {
    this.question = undefined;
    this.finish({ kind: 'browser_closed' });
    this.finishRecording('browser_closed');
  }

  get pending(): Question | undefined {
    return this.question;
  }

  // True when the panel in this tab has started and can show a question.
  async waitReady(tabId: string, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.bridges.get(tabId)?.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return Boolean(this.bridges.get(tabId)?.ready);
  }

  private stateFor(tabId: string): PanelMessage {
    const q = this.question?.tabId === tabId ? this.question : undefined;
    return {
      type: 'state',
      status: this.status,
      corner: this.corner,
      recording: this.recorder
        ? { count: this.recorder.steps.length, last: this.recorder.lastLabel }
        : null,
      env: this.env,
      progress: this.progress,
      progressOpen: this.progressOpen,
      question: q
        ? {
            id: q.id,
            nonce: q.nonce,
            step: q.step,
            total: q.total,
            view: questionView(q),
            ui: q.ui ?? {},
            point: q.point?.label ?? null,
          }
        : null,
    };
  }

  private async push(tabId: string): Promise<void> {
    const bridge = this.bridges.get(tabId);
    await bridge?.send(this.stateFor(tabId));
    // The image goes once to each page, after the question.
    const q = this.question;
    if (bridge && q?.tabId === tabId && q.image && this.imageSent.get(tabId) !== q.id) {
      if (await bridge.send({ type: 'image', id: q.id, ...q.image }))
        this.imageSent.set(tabId, q.id);
    }
    if (this.suppressed.has(tabId)) await this.sendHidden(tabId);
  }

  // A question for the developer shows, even while Lighthouse measures.
  private async sendHidden(tabId: string): Promise<void> {
    const hidden =
      this.hiddenIn.has(tabId) || (this.suppressed.has(tabId) && this.question?.tabId !== tabId);
    await this.bridges.get(tabId)?.send({ type: 'hide', hidden });
  }

  private async onMessage(tabId: string, msg: PanelMessage): Promise<void> {
    if (msg.type === 'hello') {
      // A page loaded. Show it the current state, so a question survives navigation.
      this.imageSent.delete(tabId);
      await this.push(tabId);
      return;
    }
    if (msg.type === 'ui') {
      this.onUi(tabId, msg);
      return;
    }
    if (msg.type === 'point') {
      await this.onPoint(tabId, msg);
      return;
    }
    if (msg.type === 'progress-open') {
      this.progressOpen = msg.open === true;
      return;
    }
    if (msg.type === 'moved' && typeof msg.corner === 'string') {
      this.corner = msg.corner;
      return;
    }
    if (msg.type.startsWith('rec') && this.recorder) {
      this.onRecordMessage(tabId, msg);
      await Promise.all([...this.bridges.keys()].map((id) => this.push(id)));
      return;
    }
    if (msg.type === 'answer') {
      const q = this.question;
      // Only accept an answer to the current question, with its one-time code.
      if (!q || q.tabId !== tabId || msg.id !== q.id || msg.nonce !== q.nonce) {
        log.warn('ignored a panel answer that did not match the current question');
        return;
      }
      // Only a button that the panel shows for this question.
      const result = msg.result as AnswerResult;
      if (!questionView(q).buttons.some((b) => b.result === result)) return;
      const checklist = viewChecklist(questionView(q), q.ui).map(({ text, checked }) => ({
        text,
        checked,
      }));
      const answer: Answer = {
        result,
        note: typeof msg.note === 'string' ? msg.note.slice(0, 4000) : '',
        ...(checklist.length ? { checklist } : {}),
      };
      this.question = undefined;
      this.status = WORKING;
      if (this.suppressed.has(tabId)) void this.sendHidden(tabId);
      if (this.waiter) this.finish({ kind: 'answer', answer, question: q });
      else this.stored = { answer, question: q };
    }
  }

  // A change the developer made in the panel, like a tick. Only keys the question has count.
  // The panel draws the change itself, so no new state goes back.
  private onUi(tabId: string, msg: PanelMessage): void {
    const q = this.question;
    if (!q || q.tabId !== tabId || msg.id !== q.id || msg.nonce !== q.nonce) return;
    if (this.recorder || typeof msg.key !== 'string' || typeof msg.value !== 'boolean') return;
    const view = questionView(q);
    const allowed =
      viewChecklist(view).some((item) => msg.key === `check:${item.id}`) ||
      view.sections.some((s) => s.collapsible && msg.key === `open:${s.key}`);
    if (!allowed) return;
    const ui = q.ui ?? {};
    if (!(msg.key in ui) && Object.keys(ui).length >= MAX_UI_KEYS) return;
    ui[msg.key] = msg.value;
    q.ui = ui;
  }

  // The developer clicked the element of a bug. The panel sends its place and a name.
  // The browser finds the element at that place. Page scripts cannot change that.
  private async onPoint(tabId: string, msg: PanelMessage): Promise<void> {
    const q = this.question;
    if (!q || q.tabId !== tabId || msg.id !== q.id || msg.nonce !== q.nonce) return;
    if (!questionView(q).point || this.recorder) return;
    if (msg.clear === true) {
      q.point = undefined;
      return;
    }
    const { x, y, label, selector } = msg;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof label !== 'string') return;
    const point: PointedElement = {
      label: label.slice(0, 200),
      ...(typeof selector === 'string' && selector ? { selector: selector.slice(0, 500) } : {}),
    };
    const page = this.pages.get(tabId);
    const cdp = await page?.createCDPSession().catch(() => undefined);
    try {
      await cdp?.send('DOM.getDocument', { depth: 0 });
      const found = await cdp?.send('DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      });
      if (found) point.backendNodeId = found.backendNodeId;
    } catch {
      // The page changed. The selector still names the element.
    } finally {
      await cdp?.detach().catch(() => undefined);
    }
    q.point = point;
  }

  private finish(outcome: WaitOutcome): void {
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve?.(outcome);
  }

  // Shows a new question. Any older question is replaced.
  async ask(input: Omit<Question, 'id' | 'nonce'>): Promise<Question> {
    this.stored = undefined;
    this.question = {
      ...input,
      view: questionView(input),
      id: randomUUID(),
      nonce: randomBytes(16).toString('hex'),
    };
    await this.push(input.tabId);
    return this.question;
  }

  // Waits for the answer, a timeout, or a cancel.
  waitForAnswer(timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (this.stored) {
      const { answer, question } = this.stored;
      this.stored = undefined;
      return Promise.resolve({ kind: 'answer', answer, question });
    }
    if (!this.question) return Promise.resolve({ kind: 'canceled' });
    return new Promise<WaitOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish({ kind: 'timeout' }), timeoutMs);
      const onAbort = () => this.finish({ kind: 'canceled' });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = (outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
    });
  }

  // Removes the question from the panel.
  async clear(status = WORKING): Promise<void> {
    const tabId = this.question?.tabId;
    this.question = undefined;
    this.stored = undefined;
    this.status = status;
    await Promise.all(
      [...this.bridges.keys()].map((id) => (id === tabId || !tabId ? this.push(id) : undefined)),
    );
  }

  async setStatus(tabId: string, status: string): Promise<void> {
    this.status = status;
    await this.push(tabId);
  }

  async hide(tabId: string, hidden: boolean): Promise<void> {
    if (hidden) this.hiddenIn.add(tabId);
    else this.hiddenIn.delete(tabId);
    await this.sendHidden(tabId);
  }

  // Hides the panel in a tab while Lighthouse measures it or a video records it.
  // It shows again when no reason is left.
  async suppress(tabId: string, on: boolean, reason = 'lighthouse'): Promise<void> {
    const reasons = this.suppressed.get(tabId) ?? new Set<string>();
    if (on) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size) this.suppressed.set(tabId, reasons);
    else this.suppressed.delete(tabId);
    await this.bridges.get(tabId)?.hideOnLoad(reasons.size > 0);
    await this.sendHidden(tabId);
  }

  async highlight(tabId: string, rect: Rect, label: string, ms: number): Promise<void> {
    await this.bridges.get(tabId)?.send({ type: 'highlight', rect, label, ms });
  }

  async annotate(tabId: string, rect: Rect | null): Promise<void> {
    await this.bridges.get(tabId)?.send({ type: 'annotate', rect });
  }

  private onRecordMessage(tabId: string, msg: PanelMessage): void {
    const recorder = this.recorder;
    if (!recorder) return;
    if (msg.type === 'rec') {
      recorder.add(msg as unknown as Parameters<Recorder['add']>[0], tabId);
    } else if (msg.type === 'rec-expect' && typeof msg.text === 'string') {
      recorder.addExpectation(msg.text.slice(0, 500));
    } else if (msg.type === 'rec-secret') {
      recorder.markLastSecret();
    } else if (msg.type === 'rec-stop') {
      this.recordStopped = true;
      this.finishRecording('stopped');
    }
  }

  private finishRecording(outcome: RecordOutcome): void {
    const resolve = this.recordWaiter;
    this.recordWaiter = undefined;
    resolve?.(outcome);
  }

  get recording(): Recorder | undefined {
    return this.recorder;
  }

  // Turns recording on in every tab.
  async startRecording(recorder: Recorder): Promise<void> {
    this.recorder = recorder;
    this.recordStopped = false;
    await Promise.all([...this.bridges.keys()].map((id) => this.push(id)));
  }

  // Waits until the developer clicks Stop recording, or a timeout, or a cancel.
  waitForRecordStop(timeoutMs: number, signal?: AbortSignal): Promise<RecordOutcome> {
    if (this.recordStopped) return Promise.resolve('stopped');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishRecording('timeout'), timeoutMs);
      const onAbort = () => this.finishRecording('canceled');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.recordWaiter = (outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
    });
  }

  // Turns recording off and returns what was recorded.
  async stopRecording(): Promise<Recorder | undefined> {
    const recorder = this.recorder;
    this.recorder = undefined;
    this.recordStopped = false;
    this.finishRecording('stopped');
    await Promise.all([...this.bridges.keys()].map((id) => this.push(id)));
    return recorder;
  }

  // The progress list in every tab. Null hides it.
  async setProgress(items: ProgressItem[] | null): Promise<void> {
    this.progress = items;
    await Promise.all([...this.bridges.keys()].map((id) => this.push(id)));
  }

  // Moves the panel to a corner in every tab, like a plan asks.
  async setCorner(corner: string): Promise<void> {
    this.corner = corner;
    await Promise.all([...this.bridges.keys()].map((id) => this.push(id)));
  }

  // The environment badge in every tab. Null hides it.
  async setEnvironment(badge: EnvironmentBadge | null): Promise<void> {
    this.env = badge;
    await Promise.all([...this.bridges.keys()].map((id) => this.push(id)));
  }

  // Shows the same state again, for example after the active tab changes.
  async refresh(tabId: string): Promise<void> {
    await this.push(tabId);
  }
}
