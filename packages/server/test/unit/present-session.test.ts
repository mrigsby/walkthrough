import { describe, expect, it } from 'vitest';
import { PresentationSession, type PresentStep } from '../../src/presentation/session.js';

const step = (index: number): PresentStep => ({
  index,
  id: `s${index}`,
  title: `Step ${index}`,
  hasAction: true,
  pause: true,
  spotlight: true,
});

function session() {
  return new PresentationSession([step(1), step(2), step(3)], {
    name: 'Tour',
    runId: 'r1',
    environment: { name: 'development', label: 'Development', color: '#15803d' },
    kiosk: false,
  });
}

describe('PresentationSession', () => {
  it('says which commands work in each state', () => {
    const s = session();
    expect(s.check({ type: 'start' })).toBeUndefined();
    expect(s.check({ type: 'continue' })).toMatch(/at "title", so "continue" does not work now/);
    s.setState('gate', 0);
    expect(s.check({ type: 'retry' })).toMatch(/It can: continue, skip, back, jump, end/);
    expect(s.check({ type: 'jump', step: 9 })).toMatch(/no step 9\. The steps are 1 to 3/);
  });

  it('gives the runner the commands in order, also when they come first', async () => {
    const s = session();
    s.command({ type: 'start' });
    expect(await s.nextCommand()).toEqual({ type: 'start' });
    const waiting = s.nextCommand();
    s.command({ type: 'jump', step: 2 });
    expect(await waiting).toEqual({ type: 'jump', step: 2 });
  });

  it('passes questions to the listener and answers back', async () => {
    const s = session();
    const heard = s.listen(5000);
    expect(s.listening).toBe(true);
    const q = s.ask('Where does the cart save?');
    expect(await heard).toEqual({
      kind: 'event',
      event: { type: 'question', id: 'q1', text: 'Where does the cart save?' },
    });
    s.answer(q.id, 'In local storage.', true);
    expect(s.chat[0]).toMatchObject({ answer: 'In local storage.', onScreen: true });
    s.answer(undefined, 'Step 2 failed because the button moved.');
    expect(s.chat[1]).toMatchObject({
      id: 'n2',
      answer: 'Step 2 failed because the button moved.',
    });
    expect(() => s.answer('q9', 'x')).toThrow(/no question "q9"/);
  });

  it('keeps events until someone listens, and ends an older listen', async () => {
    const s = session();
    s.push({ type: 'step_failed', step: 2, message: 'Not found' });
    expect(await s.listen(1000)).toMatchObject({ kind: 'event', event: { type: 'step_failed' } });
    const first = s.listen(5000);
    const second = s.listen(5000);
    expect(await first).toEqual({ kind: 'superseded' });
    s.stop();
    expect(await second).toEqual({ kind: 'event', event: { type: 'ended' } });
    expect(s.active).toBe(false);
    expect(await s.nextCommand()).toEqual({ type: 'end' });
  });

  it('times out a listen, and waits for a quiet page', async () => {
    const s = session();
    expect(await s.listen(20)).toEqual({ kind: 'timeout' });
    s.setState('running', 1);
    let settled = false;
    const waiting = s.settled(5000).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    s.setState('gate', 2);
    await waiting;
    expect(settled).toBe(true);
  });

  it('counts the time of each step', async () => {
    const s = session();
    s.setState('gate', 0);
    await new Promise((r) => setTimeout(r, 30));
    s.setState('gate', 1);
    expect(s.stepTimes.get(0)).toBeGreaterThanOrEqual(25);
    expect(s.stepElapsed()).toBeLessThan(25);
  });
});
