import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planJsonSchema, stepCapture } from '../../src/run/plan-schema.js';
import { laterFeatures, validatePlanText } from '../../src/run/plans.js';
import { repoRoot } from '../helpers/demo-server.js';

const good = `name: Demo
steps:
  - do: Open the shop
    expect: Three products
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
`;

function problems(text: string) {
  const result = validatePlanText(text);
  if (result.ok) throw new Error('expected problems');
  return result.problems;
}

describe('screenshot paths', () => {
  const plan = (dir: string, shot: string) =>
    `name: Help\n${dir}steps:\n  - id: cart\n    do: Open the cart\n    screenshot: ${shot}\n`;

  it('accepts true, a path, and an object', () => {
    for (const shot of [
      'true',
      'docs/cart.png',
      '{ path: cart.jpg, selector: "#total", fullPage: true }',
    ]) {
      const result = validatePlanText(plan('', shot));
      expect(result.ok, `${shot}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('joins screenshotDir to the path', () => {
    const result = validatePlanText(
      plan('screenshotDir: docs/images/help/\n', '{ path: cart.png, selector: "#total" }'),
    );
    if (!result.ok) throw new Error('expected a valid plan');
    const [step] = result.plan.steps;
    expect(stepCapture(result.plan, step as never)).toEqual({
      path: join('docs', 'images', 'help', 'cart.png'),
      selector: '#total',
    });
  });

  it('keeps an absolute path, and has no capture for true', () => {
    const steps = [
      { do: 'x', screenshot: '/tmp/a.png' },
      { do: 'y', screenshot: true },
    ];
    expect(stepCapture({ screenshotDir: 'docs' }, steps[0] as never)?.path).toBe('/tmp/a.png');
    expect(stepCapture({ screenshotDir: 'docs' }, steps[1] as never)).toBeUndefined();
  });

  it('explains a bad path or key', () => {
    expect(problems(plan('', 'docs/cart.gif'))[0]?.message).toMatch(/End the path with .png/);
    expect(problems(plan('', '{ path: cart.png, zoom: 2 }'))[0]?.message).toMatch(/zoom/);
    expect(problems(plan('', '5'))[0]?.message).toMatch(/Use true, a file path/);
    expect(problems(plan('', '5'))[0]?.line).toBe(5);
  });
});

describe('validatePlanText', () => {
  it('accepts a good plan', () => {
    const result = validatePlanText(good);
    expect(result.ok).toBe(true);
  });

  it('points at the step with a missing "do"', () => {
    const text = `name: Demo\nsteps:\n  - do: One\n  - expect: Two\n    checkpoint: true\n`;
    const [problem] = problems(text);
    expect(problem?.line).toBe(4);
    expect(problem?.path).toBe('steps[1].do');
  });

  it('points at a wrong value', () => {
    const [problem] = problems(`name: Demo\nmode: sometimes\nsteps:\n  - do: One\n`);
    expect(problem?.line).toBe(2);
    expect(problem?.path).toBe('mode');
  });

  it('finds unknown keys, like a typo', () => {
    const [problem] = problems(`name: Demo\nsteps:\n  - do: One\n    expcet: Two\n`);
    expect(problem?.line).toBe(3);
    expect(problem?.message).toMatch(/expcet/);
  });

  it('allows only one action per step', () => {
    const [problem] = problems(
      `name: Demo\nsteps:\n  - do: One\n    action: { navigate: /, wait: Hi }\n`,
    );
    expect(problem?.message).toMatch(/exactly one action/);
    expect(problem?.line).toBe(4);
  });

  it('reports YAML syntax errors with a line', () => {
    const [problem] = problems(`name: Demo\nsteps:\n  - do: [broken\n`);
    expect(problem?.message).toMatch(/YAML is not valid/);
    expect(problem?.line).toBeGreaterThan(0);
  });

  it('accepts the device, session, and visual keys', () => {
    const result = validatePlanText(
      'name: Demo\ndevice: mobile\nsession: admin\nsteps:\n  - do: One\n    visual: true\n',
    );
    if (!result.ok) throw new Error('should be valid');
    expect(laterFeatures(result.plan)).toEqual([]);
  });

  it('accepts the accessibility keys', () => {
    const result = validatePlanText(
      'name: Demo\naccessibility:\n  report: true\n  standard: wcag21aa\n  checks:\n    keyboard: false\nsteps:\n  - do: One\n    a11y: true\n  - do: Two\n    a11y:\n      selector: main\n      checks: [keyboard, darkMode]\n',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(laterFeatures(result.plan)).toEqual([]);
    expect(problems('name: Demo\nsteps:\n  - do: One\n    a11y: false\n')).not.toEqual([]);
  });
});

describe('sample plans and schema', () => {
  it('has valid sample plans in the demo project', () => {
    for (const name of ['checkout', 'login', 'mobile']) {
      const text = readFileSync(
        join(repoRoot, `examples/demo-app/.walkthrough/plans/${name}.yaml`),
        'utf8',
      );
      const result = validatePlanText(text);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
  });

  it('keeps the saved JSON Schema up to date', () => {
    const saved = JSON.parse(readFileSync(join(repoRoot, 'schemas/plan.schema.json'), 'utf8'));
    expect(saved, 'Run "npm run build:plugin" to update the schema.').toEqual(planJsonSchema());
  });
});
