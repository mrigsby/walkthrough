import {
  INSTANT,
  type Pace,
  type ReplayEngine,
  type StepOutcome,
  sleep,
} from '../replay/engine.js';
import type { StepOps } from '../replay/ops.js';
import { NullStage } from '../replay/stage.js';
import type { PresentationSession, PresentStep } from './session.js';

// What the audience screen shows besides the app. The stage layer draws it.
export interface AudienceScreen {
  title(): Promise<void>;
  slide(step: PresentStep): Promise<void>;
  end(): Promise<void>;
  // Back to the app: no slide.
  clear(): Promise<void>;
  // "One moment" while steps run at full speed.
  curtain(on: boolean): Promise<void>;
  // Before an action: the spotlight and the zoom.
  gate(step: PresentStep, ops: StepOps): Promise<void>;
}

const NO_SCREEN: AudienceScreen = {
  title: async () => undefined,
  slide: async () => undefined,
  end: async () => undefined,
  clear: async () => undefined,
  curtain: async () => undefined,
  gate: async () => undefined,
};

export interface RunnerOptions {
  pace: Pace;
  // No presenter: each step and slide holds, and the presentation can loop.
  kiosk?: { holdMs: number; loop: boolean; loops: number };
  screen?: AudienceScreen;
}

// What comes next: a step from 0, the title, the end screen, or the end of the presentation.
type Next = number | 'title' | 'end' | 'done';

// Plays a presentation: the title, each step with its pause, and the end screen.
// The presenter's commands move it, such as continue, skip, back, and jump.
export class PresentationRunner {
  private readonly screen: AudienceScreen;

  constructor(
    private readonly session: PresentationSession,
    private readonly engine: ReplayEngine,
    private readonly ops: Map<string, StepOps>,
    private readonly options: RunnerOptions,
  ) {
    this.screen = options.screen ?? NO_SCREEN;
  }

  private get steps(): PresentStep[] {
    return this.session.steps;
  }

  private get signal(): AbortSignal {
    return this.session.abort.signal;
  }

  private get kiosk() {
    return this.options.kiosk;
  }

  private opsOf(step: PresentStep): StepOps | undefined {
    const found = this.ops.get(step.id);
    return step.hasAction && found?.ops.length ? found : undefined;
  }

  async run(): Promise<void> {
    let loopsLeft = this.kiosk?.loop ? this.kiosk.loops : 1;
    let next: Next = 'title';
    try {
      while (!this.signal.aborted && next !== 'done') {
        if (next === 'title') next = await this.title();
        else if (next === 'end') {
          next = await this.endScreen();
          if (next === 'done' && this.kiosk && --loopsLeft > 0 && !this.signal.aborted) {
            await this.engine.restart();
            next = 'title';
          }
        } else if (next >= this.steps.length) next = 'end';
        else next = await this.play(next);
      }
    } finally {
      this.session.stop();
    }
  }

  private async title(): Promise<Next> {
    this.session.setState('title', 0);
    await this.screen.title();
    if (this.kiosk) {
      await sleep(this.kiosk.holdMs, this.signal);
      this.session.startedAt ??= Date.now();
      await this.screen.clear();
      return 0;
    }
    for (;;) {
      const command = await this.session.nextCommand();
      if (command.type === 'end') return 'done';
      if (command.type === 'start' || command.type === 'jump') {
        this.session.startedAt ??= Date.now();
        await this.screen.clear();
        return command.type === 'start' ? 0 : this.jumpTo(command.step - 1, 0);
      }
    }
  }

  private async play(i: number): Promise<Next> {
    const step = this.steps[i] as PresentStep;
    const stepOps = this.opsOf(step);
    if (step.slide) await this.screen.slide(step);
    if (!this.kiosk && step.pause) {
      this.session.setState('gate', i);
      if (stepOps) await this.screen.gate(step, stepOps);
      const next = await this.atGate(i);
      if (next !== 'run') return next;
    } else {
      this.session.setState('gate', i);
      // A slide or a talking point holds for a moment when nobody presses Continue.
      if (this.kiosk) await sleep(this.kiosk.holdMs, this.signal);
      else if (!stepOps) await sleep(this.options.pace.holdMs, this.signal);
    }
    if (!stepOps) return i + 1;
    if (step.slide) await this.screen.clear();
    return this.runAction(i, stepOps, 0);
  }

  private async atGate(i: number): Promise<Next | 'run'> {
    for (;;) {
      const command = await this.session.nextCommand();
      switch (command.type) {
        case 'continue':
          return 'run';
        case 'skip':
          return i + 1;
        case 'back':
          return this.rewindTo(this.previousGate(i));
        case 'jump':
          return this.jumpTo(command.step - 1, i);
        case 'end':
          return 'end';
      }
    }
  }

  private async runAction(i: number, stepOps: StepOps, fromOp: number): Promise<Next> {
    this.session.setState('running', i);
    const outcome = await this.engine.runStep(stepOps, { fromOp });
    if (outcome.ok) {
      this.session.failure = undefined;
      // Viewers see the result for a moment before the next step goes on by itself.
      const following = this.steps[i + 1];
      if (this.kiosk) await sleep(this.kiosk.holdMs, this.signal);
      else if (!following?.pause) await sleep(this.options.pace.holdMs, this.signal);
      return i + 1;
    }
    return this.failed(i, stepOps, outcome);
  }

  // A step did not work. The presenter chooses: retry, skip, do it by hand, or go elsewhere.
  private async failed(
    i: number,
    stepOps: StepOps,
    outcome: Exclude<StepOutcome, { ok: true }>,
  ): Promise<Next> {
    if (outcome.stopped || this.signal.aborted) return 'done';
    this.session.failure = { step: i + 1, opIndex: outcome.opIndex, message: outcome.message };
    this.session.setState('failed', i);
    this.session.push({ type: 'step_failed', step: i + 1, message: outcome.message });
    // Nobody can choose in a kiosk, so it goes on.
    if (this.kiosk) return i + 1;
    for (;;) {
      const command = await this.session.nextCommand();
      switch (command.type) {
        case 'retry':
          return this.runAction(i, stepOps, outcome.opIndex);
        case 'skip':
          return i + 1;
        case 'manual':
          return this.manual(i);
        case 'back':
          return this.rewindTo(this.previousGate(i));
        case 'jump':
          return this.jumpTo(command.step - 1, i);
        case 'end':
          return 'end';
      }
    }
  }

  // The presenter uses the app by hand. Continue goes on with the next step.
  private async manual(i: number): Promise<Next> {
    this.session.setState('manual', i);
    for (;;) {
      const command = await this.session.nextCommand();
      switch (command.type) {
        case 'continue':
          return i >= this.steps.length ? 'end' : i + 1;
        case 'back':
          return this.rewindTo(this.previousGate(Math.min(i, this.steps.length)));
        case 'jump':
          return this.jumpTo(command.step - 1, Math.min(i, this.steps.length));
        case 'end':
          return i >= this.steps.length ? 'done' : 'end';
      }
    }
  }

  private async endScreen(): Promise<Next> {
    this.session.setState('end', this.steps.length);
    await this.screen.end();
    if (this.kiosk) {
      await sleep(this.kiosk.holdMs, this.signal);
      return 'done';
    }
    for (;;) {
      const command = await this.session.nextCommand();
      switch (command.type) {
        case 'end':
          return 'done';
        case 'manual':
          // Back to the app, for questions. Continue shows the end screen again.
          await this.screen.clear();
          await this.manual(this.steps.length);
          return this.session.state === 'stopped' ? 'done' : 'end';
        case 'back':
          return this.rewindTo(this.previousGate(this.steps.length));
        case 'jump':
          return this.jumpTo(command.step - 1, this.steps.length);
      }
    }
  }

  // The step before i that waits for the presenter. Back goes there, so a step that plays
  // by itself does not bring the presentation right back.
  private previousGate(i: number): number {
    let k = Math.max(0, i - 1);
    while (k > 0 && !(this.steps[k] as PresentStep).pause) k -= 1;
    return k;
  }

  // Goes to a step. Ahead, the steps between run at full speed. Back, it starts over.
  private async jumpTo(target: number, from: number): Promise<Next> {
    if (target === from) return target;
    if (target < from) return this.rewindTo(target);
    return this.fastForward(from, target);
  }

  // Starts over in a new login, and runs the steps before the target at full speed.
  private async rewindTo(target: number): Promise<Next> {
    this.session.setState('running', target);
    await this.screen.curtain(true);
    try {
      await this.engine.restart();
    } catch (error) {
      await this.screen.curtain(false);
      throw error;
    }
    return this.fastForward(0, target, true);
  }

  private async fastForward(from: number, to: number, curtainOn = false): Promise<Next> {
    this.session.setState('running', from);
    if (!curtainOn) await this.screen.curtain(true);
    const pace = this.engine.pace;
    const stage = this.engine.stage;
    this.engine.pace = INSTANT;
    this.engine.stage = new NullStage();
    let failure:
      | { i: number; stepOps: StepOps; outcome: Exclude<StepOutcome, { ok: true }> }
      | undefined;
    try {
      for (let i = from; i < to && !this.signal.aborted; i++) {
        const stepOps = this.opsOf(this.steps[i] as PresentStep);
        if (!stepOps) continue;
        const outcome = await this.engine.runStep(stepOps);
        if (!outcome.ok) {
          failure = { i, stepOps, outcome };
          break;
        }
      }
    } finally {
      this.engine.pace = pace;
      this.engine.stage = stage;
      await this.screen.curtain(false);
    }
    if (failure) return this.failed(failure.i, failure.stepOps, failure.outcome);
    return to;
  }
}
