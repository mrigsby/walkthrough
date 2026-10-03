import type { Slide } from '../run/plan-schema.js';
import type { LivePresentation } from './policy.js';

// title: the title slide shows. gate: waiting before a step. running: a step plays.
// failed: a step did not work. manual: the presenter uses the app by hand. end: the end screen.
export type PresentState = 'title' | 'gate' | 'running' | 'failed' | 'manual' | 'end' | 'stopped';

export interface PresentStep {
  // From 1.
  index: number;
  id: string;
  title: string;
  caption?: string;
  notes?: string;
  slide?: Slide;
  // False for a step with nothing to do, like a slide or a talking point.
  hasAction: boolean;
  pause: boolean;
  spotlight: boolean;
  zoom?: number;
  timeBudgetSec?: number;
}

export type Command =
  | { type: 'start' }
  | { type: 'continue' }
  | { type: 'skip' }
  | { type: 'retry' }
  | { type: 'manual' }
  | { type: 'back' }
  | { type: 'jump'; step: number }
  | { type: 'end' };

export type CommandType = Command['type'];

// What each state can do. Other commands get a clear "not now".
export const COMMANDS_IN: Record<PresentState, readonly CommandType[]> = {
  title: ['start', 'jump', 'end'],
  gate: ['continue', 'skip', 'back', 'jump', 'end'],
  running: ['end'],
  failed: ['retry', 'skip', 'manual', 'back', 'jump', 'end'],
  manual: ['continue', 'back', 'jump', 'end'],
  end: ['manual', 'back', 'jump', 'end'],
  stopped: [],
};

export type PresentEvent =
  | { type: 'question'; id: string; text: string }
  | { type: 'step_failed'; step: number; message: string }
  | { type: 'ended' };

export type ListenOutcome =
  | { kind: 'event'; event: PresentEvent }
  | { kind: 'timeout' }
  | { kind: 'superseded' }
  | { kind: 'canceled' };

export interface ChatEntry {
  id: string;
  // Empty for a note that the agent sent without a question.
  question?: string;
  answer?: string;
  askedAt: number;
  answeredAt?: number;
  // The answer shows on the audience screen too.
  onScreen?: boolean;
}

// A presentation that is going: its state, the commands from the presenter, and the chat.
export class PresentationSession implements LivePresentation {
  state: PresentState = 'title';
  // The step at the gate, playing, or failed, from 0. steps.length means the end screen.
  current = 0;
  // The audience screen shows black.
  blank = false;
  readonly openedAt = Date.now();
  // When the presenter clicked Start.
  startedAt?: number;
  failure?: { step: number; opIndex: number; message: string };
  // Time spent on each step, in milliseconds, by index from 0.
  readonly stepTimes = new Map<number, number>();
  readonly chat: ChatEntry[] = [];

  private stepSince?: number;
  private commands: Command[] = [];
  private commandWaiter?: (command: Command) => void;
  private events: PresentEvent[] = [];
  private listener?: (outcome: ListenOutcome) => void;
  private readonly idle = new Set<() => void>();
  private readonly watchers = new Set<() => void>();

  constructor(
    readonly steps: PresentStep[],
    readonly info: {
      name: string;
      runId: string;
      environment: { name: string; label: string; color: string; baseUrl?: string };
      kiosk: boolean;
      timeBudgetSec?: number;
    },
    // Stops the runner and the replay at once.
    readonly abort = new AbortController(),
  ) {}

  get active(): boolean {
    return this.state !== 'stopped';
  }

  // True while a listen call waits for an event. The presenter window shows it.
  get listening(): boolean {
    return Boolean(this.listener);
  }

  // Calls fn after each change, for the presenter window. Returns a way to stop.
  watch(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private changed(): void {
    for (const fn of this.watchers) {
      try {
        fn();
      } catch {}
    }
  }

  setState(state: PresentState, current = this.current): void {
    // The time of a step counts from its gate to the next step.
    if (current !== this.current || state === 'end' || state === 'stopped') this.closeStepTime();
    if (this.stepSince === undefined && state !== 'title' && state !== 'stopped')
      this.stepSince = Date.now();
    this.state = state;
    this.current = current;
    if (state !== 'running') {
      for (const done of this.idle) done();
      this.idle.clear();
    }
    this.changed();
  }

  private closeStepTime(): void {
    if (this.stepSince === undefined) return;
    this.stepTimes.set(
      this.current,
      (this.stepTimes.get(this.current) ?? 0) + Date.now() - this.stepSince,
    );
    this.stepSince = undefined;
  }

  // The time on the step that shows now, in milliseconds.
  stepElapsed(): number {
    return (
      (this.stepTimes.get(this.current) ?? 0) +
      (this.stepSince === undefined ? 0 : Date.now() - this.stepSince)
    );
  }

  setBlank(on: boolean): void {
    this.blank = on;
    this.changed();
  }

  // Waits until no step plays, so a tool can read the page without a race.
  settled(ms = 5000): Promise<void> {
    if (this.state !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idle.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.idle.add(done);
    });
  }

  // Returns a reason when the command cannot run now.
  check(command: Command): string | undefined {
    if (!COMMANDS_IN[this.state].includes(command.type)) {
      return `The presentation is at "${this.state}", so "${command.type}" does not work now. It can: ${COMMANDS_IN[this.state].join(', ') || 'nothing'}.`;
    }
    if (command.type === 'jump' && (command.step < 1 || command.step > this.steps.length)) {
      return `There is no step ${command.step}. The steps are 1 to ${this.steps.length}.`;
    }
    return undefined;
  }

  // A command from the presenter or the agent. The runner takes it at its next stop.
  command(command: Command): void {
    const waiter = this.commandWaiter;
    if (waiter) {
      this.commandWaiter = undefined;
      waiter(command);
    } else {
      this.commands.push(command);
    }
  }

  // The next command for the runner. A stop gives "end".
  nextCommand(): Promise<Command> {
    const queued = this.commands.shift();
    if (queued) return Promise.resolve(queued);
    if (this.abort.signal.aborted) return Promise.resolve({ type: 'end' });
    return new Promise((resolve) => {
      this.commandWaiter = resolve;
    });
  }

  // A question from the presenter, for the agent.
  ask(text: string): ChatEntry {
    const entry: ChatEntry = {
      id: `q${this.chat.length + 1}`,
      question: text,
      askedAt: Date.now(),
    };
    this.chat.push(entry);
    this.push({ type: 'question', id: entry.id, text });
    this.changed();
    return entry;
  }

  // The agent's answer. Without an id, it is a note, such as about a failed step.
  answer(id: string | undefined, text: string, onScreen = false): ChatEntry {
    let entry = id ? this.chat.find((c) => c.id === id) : undefined;
    if (id && !entry) throw new Error(`There is no question "${id}".`);
    if (!entry) {
      entry = { id: `n${this.chat.length + 1}`, askedAt: Date.now() };
      this.chat.push(entry);
    }
    entry.answer = text;
    entry.answeredAt = Date.now();
    entry.onScreen = onScreen;
    this.changed();
    return entry;
  }

  push(event: PresentEvent): void {
    const listener = this.listener;
    if (listener) {
      this.listener = undefined;
      listener({ kind: 'event', event });
    } else {
      this.events.push(event);
    }
  }

  // Waits for the next event. A newer call ends this one.
  listen(timeoutMs: number, signal?: AbortSignal): Promise<ListenOutcome> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve({ kind: 'event', event: queued });
    this.listener?.({ kind: 'superseded' });
    return new Promise((resolve) => {
      const finish = (outcome: ListenOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.listener === finish) this.listener = undefined;
        this.changed();
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: 'canceled' });
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.listener = finish;
      this.changed();
    });
  }

  // Ends the presentation. The runner stops, and a listen call hears "ended".
  stop(): void {
    if (this.state === 'stopped') return;
    this.setState('stopped');
    this.abort.abort();
    this.command({ type: 'end' });
    this.push({ type: 'ended' });
  }
}
