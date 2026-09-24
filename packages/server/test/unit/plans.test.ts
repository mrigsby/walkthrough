import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planJsonSchema } from '../../src/run/plan-schema.js';
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

  it('lists keys that come in a later phase', () => {
    const result = validatePlanText(
      `name: Demo\ndevice: mobile\nsteps:\n  - do: One\n    visual: true\n`,
    );
    if (!result.ok) throw new Error('should be valid');
    expect(laterFeatures(result.plan)).toEqual([
      '"device" (comes in Phase 5)',
      '"visual" in step 1 (comes in Phase 5)',
    ]);
  });
});

describe('sample plans and schema', () => {
  it('has valid sample plans in the demo project', () => {
    for (const name of ['checkout', 'login']) {
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
