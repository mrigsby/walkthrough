import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/context.js';
import { checkSlideImage } from '../../src/guards/paths.js';
import { Mutex } from '../../src/mutex.js';
import { checkPresentationPolicy } from '../../src/presentation/policy.js';
import {
  executionHash,
  findRehearsal,
  rehearsalProblems,
  slideProblems,
} from '../../src/presentation/rehearsal.js';
import { durationSeconds, type Plan } from '../../src/run/plan-schema.js';
import { validatePlanText } from '../../src/run/plans.js';
import { type Run, RunStore } from '../../src/run/run-store.js';
import { runTool } from '../../src/tools/util.js';
import { tempDir } from '../helpers/temp.js';

const TOUR = `name: Checkout tour
environment: staging
presentation:
  title: { image: .walkthrough/slides/title.png, fit: cover, background: "#000" }
  end: { title: Thank you, text: Questions? }
  pause: before
  pace: slow
  spotlight: true
  captions: true
  window: { width: 1920, height: 1080 }
  pageZoom: 1.25
  mirror: true
  timeBudget: 10m
  mask: [".customer-name"]
  record: { format: mp4 }
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: "Browse, cart, checkout" }
    notes: Welcome.
  - id: add-mug
    do: Click "Add to cart" on the mug
    action: { click: { selector: '[data-add="mug"]' } }
    caption: Add a mug
    notes: The cart count updates.
    zoom: 1.5
    timeBudget: 45s
    expect: The cart count is "1".
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    pause: false
`;

function parse(text: string): Plan {
  const result = validatePlanText(text);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.plan;
}

function problems(text: string): string {
  const result = validatePlanText(text);
  if (result.ok) throw new Error('expected problems');
  return result.problems.map((p) => p.message).join(' | ');
}

describe('presentation plans', () => {
  it('accept the presentation block and the step keys', () => {
    const plan = parse(TOUR);
    expect(plan.presentation?.window).toEqual({ width: 1920, height: 1080 });
    expect(plan.steps[0]?.slide).toEqual({ title: 'Today', text: 'Browse, cart, checkout' });
    expect(plan.steps[1]?.zoom).toBe(1.5);
  });

  it('explain bad slides, times, and settings', () => {
    expect(
      problems(TOUR.replace('{ title: Today, text: "Browse, cart, checkout" }', '{ text: x }')),
    ).toMatch(/A slide has an "image", or a "title"/);
    expect(problems(TOUR.replace('timeBudget: 45s', 'timeBudget: 45 seconds'))).toMatch(
      /time like "45s"/,
    );
    expect(
      problems(
        TOUR.replace('  record: { format: mp4 }', '  record: true\n  kiosk: { loop: true }'),
      ),
    ).toMatch(/kiosk presentation cannot record/);
    expect(problems(TOUR.replace('zoom: 1.5', 'zoom: 9'))).not.toBe('');
  });

  it('read times', () => {
    expect(durationSeconds('45s')).toBe(45);
    expect(durationSeconds('10m')).toBe(600);
    expect(durationSeconds('1h30m')).toBe(5400);
    expect(durationSeconds('2m5s')).toBe(125);
  });

  it('hash only what a rehearsal does', () => {
    const base = executionHash(parse(TOUR));
    expect(executionHash(parse(TOUR.replace('Welcome.', 'Hello all.')))).toBe(base);
    expect(executionHash(parse(TOUR.replace('pause: false', 'pause: true')))).toBe(base);
    expect(executionHash(parse(TOUR.replace('caption: Add a mug', 'caption: A mug')))).toBe(base);
    expect(executionHash(parse(TOUR.replace('Today', 'Agenda')))).toBe(base);
    expect(executionHash(parse(TOUR.replace('navigate: /cart', 'navigate: /cart?x=1')))).not.toBe(
      base,
    );
    expect(executionHash(parse(TOUR.replace('"1"', '"2"')))).not.toBe(base);
  });

  it('skip a step that is only a slide in a test run', () => {
    const dir = tempDir('tour-run');
    const store = RunStore.create(dir, { name: 'Tour', mode: 'autonomous', plan: parse(TOUR) });
    expect(store.run.steps.map((s) => s.status)).toEqual(['skip', 'pending', 'pending']);
    expect(store.run.steps[0]?.notes).toMatch(/slide/);
  });
});

describe('rehearsals', () => {
  const plan = parse(TOUR);
  function run(extra: Partial<Run> = {}): Run {
    return {
      version: 1,
      id: '2026-10-02_100000-000-checkout-tour-staging-aaaa',
      name: 'Checkout tour',
      planFile: '.walkthrough/plans/tour.yaml',
      planHash: executionHash(plan),
      environment: {
        name: 'staging',
        label: 'Staging',
        color: '#b45309',
        protected: false,
      },
      mode: 'autonomous',
      status: 'finished',
      startedAt: '2026-10-02T10:00:00.000Z',
      endedAt: '2026-10-02T10:01:00.000Z',
      steps: [
        {
          id: 'agenda',
          index: 1,
          title: 'Agenda',
          confirm: false,
          status: 'skip',
          screenshots: [],
          actions: [],
        },
        {
          id: 'add-mug',
          index: 2,
          title: 'Add',
          confirm: false,
          status: 'pass',
          screenshots: [],
          actions: [
            { action: 'click', selector: '[data-add="mug"]', label: 'Add', url: 'http://x/' },
          ],
        },
        {
          id: 'open-cart',
          index: 3,
          title: 'Cart',
          confirm: false,
          status: 'pass',
          screenshots: [],
          actions: [
            {
              action: 'navigate',
              label: 'http://x/cart',
              value: 'http://x/cart',
              url: 'http://x/',
            },
          ],
        },
      ],
      ...extra,
    };
  }

  it('find no problems in a good run, and name each problem', () => {
    expect(rehearsalProblems(run(), plan)).toEqual([]);
    const bad = run({ status: 'incomplete' });
    bad.steps[2] = { ...bad.steps[2], status: 'skip' } as never;
    bad.steps[1] = {
      ...bad.steps[1],
      actions: [{ action: 'click', label: 'Add', url: 'http://x/' }],
    } as never;
    expect(rehearsalProblems(bad, plan)).toEqual([
      'The run is incomplete, not finished.',
      'Step 3 "Cart" is skip.',
      'Step 2: Add has no stable selector. Give the plan step an exact action.',
    ]);
  });

  it('reuse a recent rehearsal of the same plan and environment', () => {
    const dir = tempDir('tour-find');
    const save = (r: Run) => {
      mkdirSync(join(dir, '.walkthrough', 'runs', r.id), { recursive: true });
      writeFileSync(join(dir, '.walkthrough', 'runs', r.id, 'run.json'), JSON.stringify(r));
    };
    const planFile = join(dir, '.walkthrough', 'plans', 'tour.yaml');
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    save(run());
    save(
      run({
        id: '2026-10-02_110000-000-tour-production-bbbb',
        environment: { name: 'production', label: 'P', color: '#b91c1c', protected: true },
      }),
    );
    expect(findRehearsal(dir, planFile, plan, 'staging', now)?.id).toBe(run().id);
    expect(findRehearsal(dir, planFile, plan, 'development', now)).toBeUndefined();
    // Too old after 12 hours.
    expect(findRehearsal(dir, planFile, plan, 'staging', now + 13 * 3600_000)).toBeUndefined();
    // A changed action needs a new rehearsal.
    const changed = parse(TOUR.replace('navigate: /cart', 'navigate: /checkout'));
    expect(findRehearsal(dir, planFile, changed, 'staging', now)).toBeUndefined();
  });
});

describe('slide images', () => {
  it('must be in the project, and not in a hidden or private folder', () => {
    const dir = tempDir('slides');
    const put = (path: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), 'x');
    };
    put('.walkthrough/slides/title.png');
    put('docs/end.svg');
    put('.git/x.png');
    put('.walkthrough/sessions/a.png');
    put('docs/notes.txt');
    expect(checkSlideImage('.walkthrough/slides/title.png', dir)).toContain('title.png');
    expect(checkSlideImage('docs/end.svg', dir)).toContain('end.svg');
    expect(() => checkSlideImage('.git/x.png', dir)).toThrow(/hidden or private/);
    expect(() => checkSlideImage('.walkthrough/sessions/a.png', dir)).toThrow(/hidden or private/);
    expect(() => checkSlideImage('docs/notes.txt', dir)).toThrow(/ends with/);
    expect(() => checkSlideImage('docs/nope.png', dir)).toThrow(/does not exist/);
    expect(slideProblems(parse(TOUR), dir)).toEqual([]);
    expect(
      slideProblems(parse(TOUR.replace('slides/title.png', 'slides/gone.png')), dir)[0],
    ).toMatch(/presentation\.title: The slide image .* does not exist/);
  });
});

describe('tools during a presentation', () => {
  const live = { active: true };

  it('allow the tools that read, and refuse the others', () => {
    for (const tool of ['snapshot', 'read', 'screenshot', 'present', 'logs', 'runs'])
      expect(() => checkPresentationPolicy(live, tool)).not.toThrow();
    expect(() => checkPresentationPolicy(live, 'environment', 'list')).not.toThrow();
    for (const tool of ['act', 'navigate', 'run_start', 'browser_open', 'emulate'])
      expect(() => checkPresentationPolicy(live, tool)).toThrow(/presentation is going/);
    expect(() => checkPresentationPolicy(live, 'environment', 'use')).toThrow(/action "use"/);
    expect(() => checkPresentationPolicy({ active: false }, 'act')).not.toThrow();
  });

  it('run a tool without the lock while another tool waits', async () => {
    const ctx = { lock: new Mutex(), secrets: async () => undefined } as unknown as Context;
    let release: () => void = () => undefined;
    const slow = runTool(
      ctx,
      'ask_developer',
      () =>
        new Promise<string>((r) => {
          release = () => r('slow');
        }),
    );
    const fast = await runTool(ctx, 'present', async () => 'fast', { exclusive: false });
    expect(fast.content[0]).toEqual({ type: 'text', text: 'fast' });
    release();
    expect((await slow).content[0]).toEqual({ type: 'text', text: 'slow' });
  });
});
