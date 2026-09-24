import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { ToolError } from '../errors.js';
import { LATER_KEYS, LATER_STEP_KEYS, type Plan, planSchema } from './plan-schema.js';

export interface PlanProblem {
  line?: number;
  path: string;
  message: string;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; problems: PlanProblem[] };

export function plansDir(projectDir: string): string {
  return join(projectDir, '.walkthrough', 'plans');
}

// Checks plan text. Each problem has a line number when we can find one.
export function validatePlanText(text: string): PlanResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      problems: doc.errors.map((error) => ({
        line: lineCounter.linePos(error.pos[0]).line,
        path: '(file)',
        message: `The YAML is not valid: ${error.message.split('\n')[0]}`,
      })),
    };
  }

  const result = planSchema.safeParse(doc.toJS());
  if (result.success) return { ok: true, plan: result.data };

  const problems = result.error.issues.map((issue) => {
    const path = issue.path.map((p) => (typeof p === 'number' ? p : String(p)));
    // Use the deepest part of the path that exists in the file.
    let line: number | undefined;
    for (let depth = path.length; depth >= 0 && line === undefined; depth--) {
      const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
      const range = (node as { range?: [number, number, number] } | undefined)?.range;
      if (range) line = lineCounter.linePos(range[0]).line;
    }
    const where = path.length
      ? path
          .map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`))
          .join('')
          .replace(/^\./, '')
      : '(top)';
    return { line, path: where, message: issue.message };
  });
  return { ok: false, problems };
}

export function formatProblems(file: string, problems: PlanProblem[]): string {
  return [
    `The plan ${file} has ${problems.length} problem(s):`,
    ...problems.map((p) => `- ${p.line ? `Line ${p.line}` : 'Plan'} (${p.path}): ${p.message}`),
  ].join('\n');
}

// Finds a plan by name ("checkout") or by path inside the project.
export function findPlanFile(projectDir: string, name: string): string {
  const dir = plansDir(projectDir);
  const candidates = [
    join(dir, name),
    join(dir, `${name}.yaml`),
    join(dir, `${name}.yml`),
    isAbsolute(name) ? name : resolve(projectDir, name),
  ];
  for (const file of candidates) {
    if (existsSync(file) && ['.yaml', '.yml'].includes(extname(file))) {
      const rel = relative(projectDir, file);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new ToolError(`The plan ${name} is outside the project folder.`, 'plan_not_found');
      }
      return file;
    }
  }
  throw new ToolError(
    `There is no plan "${name}". Use the plan tool with action "list" to see the plans in .walkthrough/plans.`,
    'plan_not_found',
  );
}

export function loadPlan(projectDir: string, name: string): { file: string; plan: Plan } {
  const file = findPlanFile(projectDir, name);
  const result = validatePlanText(readFileSync(file, 'utf8'));
  if (!result.ok)
    throw new ToolError(
      formatProblems(relative(projectDir, file), result.problems),
      'plan_invalid',
    );
  return { file, plan: result.plan };
}

// Keys that are valid but not ready yet.
export function laterFeatures(plan: Plan): string[] {
  const found: string[] = [];
  for (const [key, phase] of Object.entries(LATER_KEYS)) {
    if (plan[key as keyof Plan] !== undefined) found.push(`"${key}" (comes in ${phase})`);
  }
  plan.steps.forEach((step, i) => {
    for (const [key, phase] of Object.entries(LATER_STEP_KEYS)) {
      if (step[key as keyof typeof step] !== undefined)
        found.push(`"${key}" in step ${i + 1} (comes in ${phase})`);
    }
  });
  return found;
}

export interface PlanSummary {
  name: string;
  file: string;
  title?: string;
  steps?: number;
  problems?: number;
}

export function listPlans(projectDir: string): PlanSummary[] {
  const dir = plansDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ['.yaml', '.yml'].includes(extname(f)))
    .sort()
    .map((f) => {
      const result = validatePlanText(readFileSync(join(dir, f), 'utf8'));
      const name = basename(f, extname(f));
      const file = relative(projectDir, join(dir, f));
      return result.ok
        ? { name, file, title: result.plan.name, steps: result.plan.steps.length }
        : { name, file, problems: result.problems.length };
    });
}

// Saves a new plan. The text must be a valid plan.
export function savePlan(
  projectDir: string,
  name: string,
  text: string,
  overwrite = false,
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new ToolError(
      'Use a plan name with lowercase letters, numbers, and dashes, like "checkout".',
      'bad_input',
    );
  }
  const result = validatePlanText(text);
  if (!result.ok)
    throw new ToolError(formatProblems(`${name}.yaml`, result.problems), 'plan_invalid');
  const dir = plansDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.yaml`);
  if (existsSync(file) && !overwrite) {
    throw new ToolError(
      `The plan ${name}.yaml already exists. Ask the developer before you replace it. Then use overwrite: true.`,
      'plan_exists',
    );
  }
  const header = '# yaml-language-server: $schema=../plan.schema.json\n';
  writeFileSync(file, text.startsWith('# yaml-language-server') ? text : header + text);
  return file;
}
