import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/context.js';
import { htmlReport } from '../../src/report/html.js';
import { markdownReport } from '../../src/report/markdown.js';
import { validatePlanText } from '../../src/run/plans.js';
import { progressItems, recordResult, recordTry } from '../../src/run/record.js';
import { RunStore } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

function setup(planText: string) {
  const result = validatePlanText(planText);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const store = RunStore.create(tempDir('retry'), {
    name: 'Retry',
    mode: 'interactive',
    plan: result.plan,
  });
  const action = (label: string) => ({
    tab: 't1',
    action: 'click',
    label,
    selector: `#${label}`,
    url: 'http://localhost/',
  });
  const ctx = {
    run: store,
    actionLog: [],
    actionCursor: 0,
    driver: undefined,
  } as unknown as Context & {
    actionLog: ReturnType<typeof action>[];
  };
  return { store, ctx, action };
}

const PLAN = 'name: Retry\nsteps:\n  - id: buy\n    do: Buy\n  - id: pay\n    do: Pay\n';

describe('retry', () => {
  it('keeps the earlier try, and only the last try in the step actions', () => {
    const { store, ctx, action } = setup(PLAN);
    ctx.actionLog.push(action('first'));
    const tried = recordTry(ctx, { id: 'buy' }, { notes: 'I missed the button.' });
    expect(tried?.tries).toBe(1);
    const step = store.run.steps[0];
    expect(step?.status).toBe('pending');
    expect(store.nextPending()?.id).toBe('buy');
    expect(step?.tries?.[0]).toMatchObject({ notes: 'I missed the button.' });
    expect(step?.tries?.[0]?.actions.map((a) => a.label)).toEqual(['first']);

    ctx.actionLog.push(action('second'));
    recordResult(ctx, { id: 'buy' }, { status: 'pass', checkedBy: 'developer' });
    expect(step?.actions.map((a) => a.label)).toEqual(['second']);

    const md = markdownReport(store.run);
    expect(md).toContain(
      '- **Tries:** 2. The developer asked to do the step again:\n  - Try 1: I missed the button.',
    );
    expect(htmlReport(store.run, store.dir)).toContain('<dt>Tries</dt><dd>2.');
  });

  it('lists the steps for the progress list, and marks the next one', () => {
    const { ctx } = setup(PLAN);
    recordResult(ctx, { id: 'buy' }, { status: 'pass', checkedBy: 'agent' });
    expect(progressItems(ctx)).toEqual([
      { index: 1, title: 'Buy', status: 'pass' },
      { index: 2, title: 'Pay', status: 'pending', current: true },
    ]);
    const quiet = setup(`name: Q\npanel: { progress: false }\nsteps:\n  - do: One\n`);
    expect(progressItems(quiet.ctx)).toBeUndefined();
  });

  it('shows the pointed element in both reports', () => {
    const { store, ctx } = setup(PLAN);
    recordResult(
      ctx,
      { id: 'buy' },
      {
        status: 'bug',
        checkedBy: 'developer',
        notes: 'Wrong color',
        pointed: { label: 'button "Buy"', selector: '#buy' },
      },
    );
    expect(markdownReport(store.run)).toContain('- **Pointed at:** button "Buy" (`#buy`)');
    expect(htmlReport(store.run, store.dir)).toContain(
      '<dt>Pointed at</dt><dd>button &#34;Buy&#34; <code>#buy</code></dd>',
    );
  });
});
