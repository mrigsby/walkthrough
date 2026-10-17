import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { issueMessage, ToolError } from '../errors.js';
import {
  includeStepSchema,
  LATER_KEYS,
  LATER_STEP_KEYS,
  type Plan,
  type PlanStep,
  planSchema,
} from './plan-schema.js';

export interface PlanProblem {
  line?: number;
  path: string;
  message: string;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; problems: PlanProblem[] };

export function plansDir(projectDir: string): string {
  return join(projectDir, '.walkthrough', 'plans');
}

interface ParsedFile {
  plan: Plan;
  // { include: name } items, by their place in "steps". The plan has a stand-in step there.
  includes: Array<{ index: number; name: string; line?: number }>;
  // The line of each step in the file.
  stepLines: Array<number | undefined>;
}

type Parsed = { ok: true; parsed: ParsedFile } | { ok: false; problems: PlanProblem[] };

// Checks the text of one plan file. Include items are checked here, but not expanded.
function parseFile(text: string): Parsed {
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
  // The line of the deepest part of the path that exists in the file.
  const lineOf = (path: Array<string | number>): number | undefined => {
    for (let depth = path.length; depth >= 0; depth--) {
      const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
      const range = (node as { range?: [number, number, number] } | undefined)?.range;
      if (range) return lineCounter.linePos(range[0]).line;
    }
    return undefined;
  };
  const pathText = (path: Array<string | number>) =>
    path.length
      ? path
          .map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`))
          .join('')
          .replace(/^\./, '')
      : '(top)';

  const raw = doc.toJS() as Record<string, unknown> | null;
  const includes: ParsedFile['includes'] = [];
  const problems: PlanProblem[] = [];
  let data: unknown = raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.steps)) {
    const steps = raw.steps.map((step: unknown, index: number) => {
      if (!step || typeof step !== 'object' || Array.isArray(step) || !('include' in step))
        return step;
      const check = includeStepSchema.safeParse(step);
      if (check.success) {
        includes.push({ index, name: check.data.include, line: lineOf(['steps', index]) });
      } else {
        for (const issue of check.error.issues) {
          const path = [
            'steps',
            index,
            ...issue.path.map((p) => (typeof p === 'number' ? p : String(p))),
          ];
          problems.push({ line: lineOf(path), path: pathText(path), message: issueMessage(issue) });
        }
      }
      // A stand-in, so the other steps get checked with their own numbers.
      return { do: '(include)' };
    });
    data = { ...raw, steps };
  }

  const result = planSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map((p) => (typeof p === 'number' ? p : String(p)));
      problems.push({ line: lineOf(path), path: pathText(path), message: issueMessage(issue) });
    }
  }
  if (problems.length || !result.success) return { ok: false, problems };
  const stepLines = result.data.steps.map((_, i) => lineOf(['steps', i]));
  return { ok: true, parsed: { plan: result.data, includes, stepLines } };
}

export interface PlanOptions {
  // The project folder. Plans with { include: name } need it.
  projectDir?: string;
  // The file of the plan, so a plan that includes itself is found.
  file?: string;
}

// Includes can go this deep: a plan, a part, a part of the part.
const MAX_INCLUDE_DEPTH = 3;

interface Origin {
  file: string;
  line?: number;
}

// A plan in .walkthrough/plans, by name only.
function partFile(projectDir: string, name: string): string | undefined {
  const dir = plansDir(projectDir);
  return [join(dir, `${name}.yaml`), join(dir, `${name}.yml`)].find((f) => existsSync(f));
}

// A step from a part keeps the part's snippets and its screenshot folder.
function partStep(step: PlanStep, part: Plan, projectDir: string): PlanStep {
  const out: PlanStep = { ...step };
  if (part.snippets) out.snippets = { ...part.snippets, ...step.snippets };
  const shot = step.screenshot;
  const shotPath =
    typeof shot === 'string' ? shot : typeof shot === 'object' ? shot.path : undefined;
  if (shotPath && !isAbsolute(shotPath)) {
    // A full path, so the screenshotDir of the outer plan does not change it.
    const full = join(projectDir, part.screenshotDir ?? '', shotPath);
    out.screenshot = typeof shot === 'object' ? { ...shot, path: full } : full;
  }
  return out;
}

function expand(
  parsed: ParsedFile,
  label: string,
  projectDir: string,
  chain: string[],
): { ok: true; plan: Plan; origins: Origin[] } | { ok: false; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const steps: PlanStep[] = [];
  const origins: Origin[] = [];
  let vars = parsed.plan.vars;
  parsed.plan.steps.forEach((step, i) => {
    const include = parsed.includes.find((inc) => inc.index === i);
    if (!include) {
      steps.push(step);
      origins.push({ file: label, line: parsed.stepLines[i] });
      return;
    }
    const at = { line: include.line, path: `steps[${i}].include` };
    const file = partFile(projectDir, include.name);
    if (!file) {
      problems.push({
        ...at,
        message: `There is no plan "${include.name}" in .walkthrough/plans to include.`,
      });
      return;
    }
    if (chain.includes(file)) {
      const names = [...chain, file].map((f) => basename(f, extname(f)));
      problems.push({ ...at, message: `The plans include each other: ${names.join(' > ')}.` });
      return;
    }
    if (chain.length >= MAX_INCLUDE_DEPTH) {
      problems.push({
        ...at,
        message: `Includes can go only ${MAX_INCLUDE_DEPTH} levels deep. Put the steps of "${include.name}" in a plan nearer the top.`,
      });
      return;
    }
    const partLabel = basename(file);
    const part = parseFile(readFileSync(file, 'utf8'));
    if (!part.ok) {
      problems.push(...part.problems.map((p) => ({ ...p, path: `${partLabel} ${p.path}` })));
      return;
    }
    const inner = expand(part.parsed, partLabel, projectDir, [...chain, file]);
    if (!inner.ok) {
      problems.push(...inner.problems);
      return;
    }
    steps.push(...inner.plan.steps.map((s) => partStep(s, inner.plan, projectDir)));
    origins.push(...inner.origins);
    // Values of the part are defaults. The outer plan wins.
    if (inner.plan.vars) vars = { ...inner.plan.vars, ...vars };
  });
  if (problems.length) return { ok: false, problems };

  // Each step id must be used once, also across parts.
  const seen = new Map<string, Origin>();
  steps.forEach((step, i) => {
    if (!step.id) return;
    const here = origins[i] as Origin;
    const first = seen.get(step.id);
    if (!first) {
      seen.set(step.id, here);
      return;
    }
    const where = (o: Origin) => `${o.file}${o.line ? ` line ${o.line}` : ''}`;
    problems.push({
      line: here.file === label ? here.line : undefined,
      path: `steps (id "${step.id}")`,
      message: `The step id "${step.id}" is in ${where(first)} and in ${where(here)}. Give each step its own id.`,
    });
  });
  if (problems.length) return { ok: false, problems };
  return { ok: true, plan: { ...parsed.plan, steps, ...(vars ? { vars } : {}) }, origins };
}

// Checks plan text. Each problem has a line number when we can find one.
// With a project folder, the steps of { include: name } go in.
export function validatePlanText(text: string, options: PlanOptions = {}): PlanResult {
  const parsed = parseFile(text);
  if (!parsed.ok) return parsed;
  const { includes } = parsed.parsed;
  if (includes.length === 0) return { ok: true, plan: parsed.parsed.plan };
  if (!options.projectDir) {
    return {
      ok: false,
      problems: includes.map((inc) => ({
        line: inc.line,
        path: `steps[${inc.index}].include`,
        message: 'Walkthrough needs the project folder to check "include".',
      })),
    };
  }
  const label = options.file ? basename(options.file) : '(this plan)';
  const result = expand(
    parsed.parsed,
    label,
    options.projectDir,
    options.file ? [options.file] : [],
  );
  return result.ok ? { ok: true, plan: result.plan } : { ok: false, problems: result.problems };
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
  const result = validatePlanText(readFileSync(file, 'utf8'), { projectDir, file });
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
      const result = validatePlanText(readFileSync(join(dir, f), 'utf8'), {
        projectDir,
        file: join(dir, f),
      });
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
  const dir = plansDir(projectDir);
  const result = validatePlanText(text, { projectDir, file: join(dir, `${name}.yaml`) });
  if (!result.ok)
    throw new ToolError(formatProblems(`${name}.yaml`, result.problems), 'plan_invalid');
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

// The plan of a run, if its file is still there and valid.
export function loadRunPlan(projectDir: string, planFile?: string): Plan | undefined {
  if (!planFile || !existsSync(join(projectDir, planFile))) return undefined;
  try {
    return loadPlan(projectDir, join(projectDir, planFile)).plan;
  } catch {
    return undefined;
  }
}
