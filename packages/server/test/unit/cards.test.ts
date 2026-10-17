import { describe, expect, it } from 'vitest';
import { buildStepView } from '../../src/panel/view.js';
import { executionHash, rehearsalProblems } from '../../src/presentation/rehearsal.js';
import { buildOps } from '../../src/replay/ops.js';
import { reproSteps, resultLabel, resultLine } from '../../src/report/common.js';
import { shownStepNumber, stepTitle } from '../../src/run/plan-schema.js';
import { validatePlanText } from '../../src/run/plans.js';
import { countSteps, type Run, RunStore } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

const PLAN = `name: Cards
mode: autonomous
steps:
  - id: welcome
    card:
      heading: Checkout test
      subheading: About 5 minutes
      content: |
        This plan checks:
        - the cart
      size: modal
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    expect: The cart shows.
  - id: done
    card: { heading: All done, when: passed }
`;

function parse(text: string) {
  const result = validatePlanText(text);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.plan;
}

const problems = (text: string) => {
  const result = validatePlanText(text);
  return result.ok ? [] : result.problems.map((p) => `${p.line}: ${p.message}`);
};

describe('card steps in plans', () => {
  it('accepts a card without "do", and names it by its heading', () => {
    const plan = parse(PLAN);
    expect(plan.steps[0]?.do).toBeUndefined();
    expect(stepTitle(plan.steps[0] as never)).toBe('Checkout test');
    expect(stepTitle(plan.steps[1] as never)).toBe('Open the cart');
  });

  it('needs "do" or a card, and refuses test keys on a card', () => {
    expect(problems('name: C\nsteps:\n  - expect: y\n')).toEqual([
      '3: A step needs "do", or a "card".',
    ]);
    expect(
      problems('name: C\nsteps:\n  - card: { heading: Hi }\n    action: { navigate: / }\n')[0],
    ).toBe(
      '4: A card step cannot have "action". A card only shows text and waits for the developer.',
    );
    expect(problems('name: C\nsteps:\n  - card: { heading: Hi, size: big }\n')).not.toEqual([]);
    expect(
      problems('name: C\nsteps:\n  - card: { heading: Hi, content: "Run {{copy:x}}" }\n')[0],
    ).toMatch(/There is no snippet "x"/);
  });
});

describe('step numbers in the panel', () => {
  it('leave out a "when" card that does not fit the run so far', () => {
    const plan = parse(
      `${PLAN}  - id: problems\n    card: { heading: Some steps failed, when: problems }\n`,
    );
    // welcome, open-cart, done (passed), problems (problems)
    expect(shownStepNumber(plan, 0, false)).toEqual({ step: 1, total: 3 });
    expect(shownStepNumber(plan, 2, false)).toEqual({ step: 3, total: 3 });
    // After a bug, the "problems" card is the last one.
    expect(shownStepNumber(plan, 1, true)).toEqual({ step: 2, total: 3 });
    expect(shownStepNumber(plan, 3, true)).toEqual({ step: 3, total: 3 });
  });
});

describe('card views', () => {
  it('shows Pass and Stop, and the content', () => {
    const view = buildStepView({
      title: 'Checkout test',
      card: { subheading: 'About 5 minutes', content: '- the cart', size: 'modal' },
      next: 'The agent opens the cart.',
    });
    expect(view).toMatchObject({
      kind: 'card',
      subheading: 'About 5 minutes',
      size: 'modal',
      notes: false,
    });
    expect(view.sections.map((s) => s.key)).toEqual(['content', 'next']);
    expect(view.buttons.map((b) => b.result)).toEqual(['pass', 'stop']);
  });

  it('shows Bug and Skip when the plan asks, and then a notes box', () => {
    const view = buildStepView({
      title: 'End',
      card: {},
      layers: [{ buttons: { bug: { show: true }, skip: { show: true, label: 'Later' } } }],
    });
    expect(view.buttons.map((b) => b.label)).toEqual(['Pass', 'Bug', 'Later', 'Stop']);
    expect(view.notes).toBe(true);
    expect(view.size).toBe('panel');
  });
});

describe('card results', () => {
  it('always ask the developer, even in autonomous mode', () => {
    const store = RunStore.create(tempDir('cards-run'), {
      name: 'Cards',
      mode: 'autonomous',
      plan: parse(PLAN),
    });
    expect(store.run.steps.map((s) => [s.kind ?? 'test', s.confirm])).toEqual([
      ['card', true],
      ['test', false],
      ['card', true],
    ]);
    expect(store.planStep('done')?.step.card?.when).toBe('passed');
  });

  const run: Run = {
    version: 1,
    id: 'r',
    name: 'Cards',
    mode: 'autonomous',
    status: 'finished',
    startedAt: '2026-10-17T10:00:00.000Z',
    baseUrl: 'http://localhost:4321',
    steps: [
      {
        id: 'welcome',
        index: 1,
        kind: 'card',
        title: 'Checkout test',
        confirm: true,
        status: 'pass',
        screenshots: [],
        actions: [],
      },
      {
        id: 'open-cart',
        index: 2,
        title: 'Open the cart',
        expect: 'The cart shows.',
        confirm: false,
        status: 'fail',
        screenshots: [],
        actions: [
          {
            action: 'navigate',
            label: '/cart',
            value: 'http://localhost:4321/cart',
            url: 'http://localhost:4321/',
          },
        ],
      },
      {
        id: 'done',
        index: 3,
        kind: 'card',
        title: 'All done',
        confirm: true,
        status: 'skip',
        screenshots: [],
        actions: [],
      },
    ],
  };

  it('leave cards out of counts and repro steps, and give them their own words', () => {
    expect(resultLine(run)).toBe('1 failed');
    expect(countSteps(run).pass).toBe(0);
    expect(resultLabel(run.steps[0] as never)).toBe('Card: Seen');
    expect(resultLabel(run.steps[2] as never)).toBe('Card: Not shown');
    expect(reproSteps(run, run.steps[1] as never)).toEqual([
      'Open http://localhost:4321',
      'Go to http://localhost:4321/cart',
    ]);
  });

  it('leave cards out of replays and rehearsals', () => {
    expect(buildOps(run).steps.map((s) => s.step.id)).toEqual(['open-cart']);
    const plan = parse(PLAN);
    const withoutCards = { ...plan, steps: plan.steps.filter((s) => !s.card) };
    expect(executionHash(plan)).toBe(executionHash(withoutCards));
    const passed = {
      ...run,
      steps: run.steps.map((s) => ({ ...s, status: s.kind ? s.status : ('pass' as const) })),
    };
    expect(rehearsalProblems(passed, plan)).toEqual([]);
  });
});
