import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStepView } from '../../src/panel/view.js';
import { markdownReport } from '../../src/report/markdown.js';
import { planJsonSchema, stepCommand } from '../../src/run/plan-schema.js';
import { listPlans, loadPlan, savePlan, validatePlanText } from '../../src/run/plans.js';
import { RunStore } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

function project(plans: Record<string, string>): string {
  const dir = tempDir('includes');
  mkdirSync(join(dir, '.walkthrough', 'plans'), { recursive: true });
  for (const [name, text] of Object.entries(plans))
    writeFileSync(join(dir, '.walkthrough', 'plans', `${name}.yaml`), text);
  return dir;
}

const LOGIN = `name: Log in
screenshotDir: docs/login
vars: { user: demo, shared: from-login }
snippets: { seed: npm run seed }
steps:
  - id: open-login
    do: Open the login page
    expect: Run {{copy:seed}} first.
  - id: sign-in
    do: Sign in as {{var:user}}
    screenshot: signed-in.png
`;

const problemsOf = (dir: string, name: string) => {
  try {
    loadPlan(dir, name);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('include', () => {
  it('puts the steps of another plan in place', () => {
    const dir = project({
      login: LOGIN,
      checkout: `name: Checkout
vars: { shared: from-checkout }
steps:
  - do: Open the shop
  - include: login
  - id: pay
    do: Pay
`,
    });
    const { plan } = loadPlan(dir, 'checkout');
    expect(plan.steps.map((s) => s.id ?? s.do)).toEqual([
      'Open the shop',
      'open-login',
      'sign-in',
      'pay',
    ]);
    // The outer plan wins for values. The part gives the others.
    expect(plan.vars).toEqual({ user: 'demo', shared: 'from-checkout' });
    // The part keeps its snippets and its screenshot folder.
    expect(plan.steps[1]?.snippets).toEqual({ seed: 'npm run seed' });
    const shot = plan.steps[2]?.screenshot as string;
    expect(isAbsolute(shot)).toBe(true);
    expect(shot).toBe(join(dir, 'docs', 'login', 'signed-in.png'));
    expect(listPlans(dir).find((p) => p.name === 'checkout')?.steps).toBe(4);
  });

  it('names the line of a missing part, and the file of a broken one', () => {
    const dir = project({
      main: 'name: Main\nsteps:\n  - do: One\n  - include: nope\n',
      broken: 'name: Broken\nsteps:\n  - expect: no do\n',
      user: 'name: User\nsteps:\n  - include: broken\n',
    });
    expect(problemsOf(dir, 'main')).toContain(
      'Line 4 (steps[1].include): There is no plan "nope" in .walkthrough/plans to include.',
    );
    expect(problemsOf(dir, 'user')).toContain(
      'Line 3 (broken.yaml steps[0].do): A step needs "do"',
    );
  });

  it('finds loops, too many levels, and step ids used twice', () => {
    const dir = project({
      a: 'name: A\nsteps:\n  - include: b\n',
      b: 'name: B\nsteps:\n  - include: a\n',
      l1: 'name: L1\nsteps:\n  - include: l2\n',
      l2: 'name: L2\nsteps:\n  - include: l3\n',
      l3: 'name: L3\nsteps:\n  - include: l4\n',
      l4: 'name: L4\nsteps:\n  - do: Deep\n',
      part: 'name: Part\nsteps:\n  - id: same\n    do: In the part\n',
      twice: 'name: Twice\nsteps:\n  - include: part\n  - id: same\n    do: Here too\n',
    });
    expect(problemsOf(dir, 'a')).toContain('The plans include each other: a > b > a.');
    expect(problemsOf(dir, 'l1')).toContain('Includes can go only 3 levels deep.');
    expect(problemsOf(dir, 'twice')).toContain(
      'The step id "same" is in part.yaml line 3 and in twice.yaml line 4. Give each step its own id.',
    );
  });

  it('needs the project folder and a plain name', () => {
    const text = 'name: X\nsteps:\n  - include: login\n';
    const alone = validatePlanText(text);
    expect(alone.ok).toBe(false);
    expect(JSON.stringify(alone)).toContain('needs the project folder');
    const bad = validatePlanText('name: X\nsteps:\n  - include: ../secret\n', {
      projectDir: tempDir('inc'),
    });
    expect(JSON.stringify(bad)).toContain('Use the name of a plan');
    const extra = validatePlanText('name: X\nsteps:\n  - include: login\n    do: x\n', {
      projectDir: tempDir('inc'),
    });
    expect(extra.ok).toBe(false);
  });

  it('does not save a plan that includes itself, and editors know include', () => {
    const dir = project({});
    expect(() => savePlan(dir, 'self', 'name: Self\nsteps:\n  - include: self\n')).toThrow(
      /There is no plan "self"|include each other/,
    );
    expect(JSON.stringify(planJsonSchema())).toContain('"include"');
  });
});

describe('terminal commands', () => {
  it('accepts a command as text or with help, but never a secret', () => {
    const ok = validatePlanText(
      'name: C\nsteps:\n  - do: Seed\n    command: npm run seed\n  - do: Reset\n    command: { run: npm run reset, help: Clears the data. }\n',
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.steps.map(stepCommand)).toEqual(['npm run seed', 'npm run reset']);
    expect(
      JSON.stringify(
        validatePlanText('name: C\nsteps:\n  - do: x\n    command: "login {{secret:PW}}"\n'),
      ),
    ).toContain('A command cannot hold a {{secret:NAME}}');
    expect(
      validatePlanText('name: C\nsteps:\n  - card: { heading: Hi }\n    command: ls\n').ok,
    ).toBe(false);
  });

  it('shows the command in the panel, the run, and the report', () => {
    const view = buildStepView({
      title: 'Seed',
      didWhat: 'Nothing yet.',
      expected: 'Done.',
      command: { run: 'npm run seed', help: 'Fills the **test** data.' },
    });
    expect(view.sections.map((s) => `${s.key}:${s.label}`)).toEqual([
      'did:What I did',
      'command:Run this command',
      'expect:What you should see',
    ]);
    expect(view.sections[1]?.blocks[0]).toMatchObject({ t: 'code', v: 'npm run seed' });
    const result = validatePlanText('name: C\nsteps:\n  - do: Seed\n    command: npm run seed\n');
    if (!result.ok) throw new Error('invalid');
    const store = RunStore.create(tempDir('cmd'), {
      name: 'C',
      mode: 'interactive',
      plan: result.plan,
    });
    expect(store.run.steps[0]?.command).toBe('npm run seed');
    expect(markdownReport(store.run)).not.toContain('Command');
    const step = store.run.steps[0];
    if (step) step.status = 'pass';
    expect(markdownReport(store.run)).toContain('- **Command:** `npm run seed`');
  });
});
