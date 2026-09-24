import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { log } from '../log.js';
import type { Recorder } from '../record/recorder.js';
import { PanelBridge, type PanelMessage } from './bridge.js';

export type AnswerResult = 'pass' | 'bug' | 'skip' | 'stop';

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
}

export interface Answer {
  result: AnswerResult;
  note: string;
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
const RESULTS: AnswerResult[] = ['pass', 'bug', 'skip', 'stop'];

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
  private recordWaiter?: (outcome: RecordOutcome) => void;

  async attach(page: Page, tabId: string): Promise<void> {
    const bridge = await PanelBridge.install(page, (msg) => void this.onMessage(tabId, msg));
    if (bridge) this.bridges.set(tabId, bridge);
  }

  detach(tabId: string): void {
    this.bridges.delete(tabId);
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
      question: q
        ? {
            id: q.id,
            nonce: q.nonce,
            title: q.title,
            didWhat: q.didWhat,
            expected: q.expected,
            step: q.step,
            total: q.total,
          }
        : null,
    };
  }

  private async push(tabId: string): Promise<void> {
    await this.bridges.get(tabId)?.send(this.stateFor(tabId));
  }

  private async onMessage(tabId: string, msg: PanelMessage): Promise<void> {
    if (msg.type === 'hello') {
      // A page loaded. Show it the current state, so a question survives navigation.
      await this.push(tabId);
      return;
    }
    if (msg.type === 'moved' && typeof msg.corner === 'string') {
      this.corner = msg.corner;
      return;
    }
    if (msg.type.startsWith('rec') && this.recorder) {
      this.onRecordMessage(msg);
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
      const result = msg.result as AnswerResult;
      if (!RESULTS.includes(result)) return;
      const answer: Answer = {
        result,
        note: typeof msg.note === 'string' ? msg.note.slice(0, 4000) : '',
      };
      this.question = undefined;
      this.status = WORKING;
      if (this.waiter) this.finish({ kind: 'answer', answer, question: q });
      else this.stored = { answer, question: q };
    }
  }

  private finish(outcome: WaitOutcome): void {
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve?.(outcome);
  }

  // Shows a new question. Any older question is replaced.
  async ask(input: Omit<Question, 'id' | 'nonce'>): Promise<Question> {
    this.stored = undefined;
    this.question = { ...input, id: randomUUID(), nonce: randomBytes(16).toString('hex') };
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
    await this.bridges.get(tabId)?.send({ type: 'hide', hidden });
  }

  async highlight(tabId: string, rect: Rect, label: string, ms: number): Promise<void> {
    await this.bridges.get(tabId)?.send({ type: 'highlight', rect, label, ms });
  }

  async annotate(tabId: string, rect: Rect | null): Promise<void> {
    await this.bridges.get(tabId)?.send({ type: 'annotate', rect });
  }

  private onRecordMessage(msg: PanelMessage): void {
    const recorder = this.recorder;
    if (!recorder) return;
    if (msg.type === 'rec') {
      recorder.add(msg as unknown as Parameters<Recorder['add']>[0]);
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

  // Shows the same state again, for example after the active tab changes.
  async refresh(tabId: string): Promise<void> {
    await this.push(tabId);
  }
}
