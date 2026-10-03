import { describe, expect, it } from 'vitest';
import { PresentationRunner } from '../../src/presentation/runner.js';
import {
  PresentationSession,
  type PresentState,
  type PresentStep,
} from '../../src/presentation/session.js';
import { INSTANT, type Pace, type StepOutcome } from '../../src/replay/engine.js';
import type { StepOps } from '../../src/replay/ops.js';
import { NullStage } from '../../src/replay/stage.js';

const NO_WAIT: Pace = { typeMs: 0, glideMs: 0, holdMs: 0 };

// Plays steps without a browser, and keeps a log of what it did.
class FakeEngine {
  pace: Pace = NO_WAIT;
  stage = new NullStage();
  readonly log: string[] = [];
  readonly failOnce = new Set<string>();

  async runStep(stepOps: StepOps, options: { fromOp?: number } = {}): Promise<StepOutcome> {
    const id = stepOps.step.id;
    this.log.push(`${id}@${options.fromOp ?? 0}${this.pace === INSTANT ? ' fast' : ''}`);
    if (this.failOnce.delete(id)) return { ok: false, opIndex: 1, message: 'boom' };
    return { ok: true };
  }

  async restart(): Promise<void> {
    this.log.push('restart');
  }
}

const step = (index: number, extra: Partial<PresentStep> = {}): PresentStep => ({
  index,
  id: `s${index}`,
  title: `Step ${index}`,
  hasAction: true,
  pause: true,
  spotlight: true,
  ...extra,
});

function setup() {
  const steps = [step(1), step(2, { pause: false }), step(3), step(4, { hasAction: false })];
  const session = new PresentationSession(steps, {
    name: 'Tour',
    runId: 'r1',
    environment: { name: 'development', label: 'Development', color: '#15803d' },
    kiosk: false,
  });
  const engine = new FakeEngine();
  const ops = new Map(
    steps.map((s) => [
      s.id,
      {
        step: { id: s.id } as never,
        ops: s.hasAction ? [{ type: 'reach', url: 'x' } as never] : [],
      },
    ]),
  );
  const runner = new PresentationRunner(session, engine as never, ops, { pace: NO_WAIT });
  const done = runner.run();
  // Waits until the presentation is in a state, at a step from 1.
  const at = (state: PresentState, stepNumber?: number) =>
    new Promise<void>((resolve, reject) => {
      const ok = () =>
        session.state === state && (stepNumber === undefined || session.current === stepNumber - 1);
      if (ok()) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`Not ${state} ${stepNumber}: ${session.state} ${session.current}`)),
        2000,
      );
      const stop = session.watch(() => {
        if (!ok()) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  return { session, engine, done, at };
}

describe('PresentationRunner', () => {
  it('waits at gates, plays steps without a pause by themselves, and goes back to a gate', async () => {
    const { session, engine, done, at } = setup();
    await at('title');
    session.command({ type: 'start' });
    await at('gate', 1);
    session.command({ type: 'continue' });
    // Step 2 has no pause, so it plays right after step 1.
    await at('gate', 3);
    expect(engine.log).toEqual(['s1@0', 's2@0']);
    // Back skips step 2, which would play by itself again.
    session.command({ type: 'back' });
    await at('gate', 1);
    expect(engine.log.slice(2)).toEqual(['restart']);
    // Ahead, the steps between play at full speed.
    session.command({ type: 'jump', step: 3 });
    await at('gate', 3);
    expect(engine.log.slice(3)).toEqual(['s1@0 fast', 's2@0 fast']);
    session.command({ type: 'end' });
    await at('end');
    session.command({ type: 'end' });
    await done;
    expect(session.state).toBe('stopped');
  });

  it('retries a failed step from the action that failed', async () => {
    const { session, engine, done, at } = setup();
    engine.failOnce.add('s3');
    session.command({ type: 'jump', step: 3 });
    await at('gate', 3);
    const heard = session.listen(2000);
    session.command({ type: 'continue' });
    await at('failed', 3);
    expect(await heard).toEqual({
      kind: 'event',
      event: { type: 'step_failed', step: 3, message: 'boom' },
    });
    expect(session.failure).toEqual({ step: 3, opIndex: 1, message: 'boom' });
    session.command({ type: 'retry' });
    // Step 4 has nothing to do, but it still waits for the presenter.
    await at('gate', 4);
    expect(engine.log.at(-1)).toBe('s3@1');
    session.command({ type: 'continue' });
    await at('end');
    session.stop();
    await done;
  });

  it('lets the presenter do a failed step by hand', async () => {
    const { session, engine, done, at } = setup();
    engine.failOnce.add('s1');
    session.command({ type: 'start' });
    await at('gate', 1);
    session.command({ type: 'continue' });
    await at('failed', 1);
    session.command({ type: 'manual' });
    await at('manual', 1);
    session.command({ type: 'continue' });
    // Step 2 plays by itself after the manual step.
    await at('gate', 3);
    session.stop();
    await done;
  });
});
