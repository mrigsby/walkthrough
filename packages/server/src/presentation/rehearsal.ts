import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkSlideImage } from '../guards/paths.js';
import { buildOps } from '../replay/ops.js';
import type { Plan, PlanStep } from '../run/plan-schema.js';
import type { Run } from '../run/run-store.js';

// A rehearsal stays good for this long. After that, the app may have changed.
export const REHEARSAL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// A step that is only a slide. Test runs skip it, and a presentation shows the slide.
export function isSlideOnly(step: PlanStep): boolean {
  return Boolean(step.slide) && !step.action;
}

// A hash of what a rehearsal does. Notes, slides, pauses, captions, and times do not
// count, so a change to them needs no new rehearsal.
export function executionHash(plan: Plan): string {
  const steps = plan.steps
    .map((step, i) => ({ step, id: step.id ?? `step-${i + 1}` }))
    .filter(({ step }) => !isSlideOnly(step))
    .map(({ step, id }) => ({
      id,
      action: step.action,
      expect: step.expect,
      emulate: step.emulate,
      mock: step.mock,
      cookies: step.cookies,
    }));
  const what = {
    baseUrl: plan.baseUrl,
    session: plan.session,
    device: plan.device,
    colorScheme: plan.colorScheme,
    network: plan.network,
    emulate: plan.emulate,
    vars: plan.vars,
    steps,
  };
  return createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 16);
}

// Why a run cannot be presented. Empty when it can.
export function rehearsalProblems(run: Run, plan?: Plan): string[] {
  const problems: string[] = [];
  if (run.status !== 'finished') problems.push(`The run is ${run.status}, not finished.`);
  const slides = new Set(
    (plan?.steps ?? [])
      .map((step, i) => (isSlideOnly(step) ? (step.id ?? `step-${i + 1}`) : undefined))
      .filter(Boolean),
  );
  for (const step of run.steps) {
    if (step.status === 'pass' || (step.status === 'skip' && slides.has(step.id))) continue;
    problems.push(`Step ${step.index} "${step.title}" is ${step.status}.`);
  }
  for (const missing of buildOps(run).missingSelectors) {
    problems.push(`${missing} has no stable selector. Give the plan step an exact action.`);
  }
  return problems;
}

// The slide images that a presentation cannot show.
export function slideProblems(plan: Plan, projectDir: string): string[] {
  const problems: string[] = [];
  const check = (where: string, image?: string) => {
    if (!image) return;
    try {
      checkSlideImage(image, projectDir);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
    }
  };
  const p = plan.presentation;
  check('presentation.title', p?.title && 'image' in p.title ? p.title.image : undefined);
  check('presentation.end', p?.end && 'image' in p.end ? p.end.image : undefined);
  plan.steps.forEach((step, i) => {
    if (step.slide && 'image' in step.slide) {
      check(`Step ${i + 1} [${step.id ?? `step-${i + 1}`}]`, step.slide.image);
    }
  });
  return problems;
}

// The newest finished rehearsal of this plan, with the same hash and environment, from the
// last 12 hours, that can be presented.
export function findRehearsal(
  projectDir: string,
  planFile: string,
  plan: Plan,
  env: string,
  now = Date.now(),
): Run | undefined {
  const root = join(projectDir, '.walkthrough', 'runs');
  if (!existsSync(root)) return undefined;
  const file = relative(projectDir, planFile);
  const hash = executionHash(plan);
  for (const id of readdirSync(root).sort().reverse()) {
    let run: Run;
    try {
      run = JSON.parse(readFileSync(join(root, id, 'run.json'), 'utf8')) as Run;
    } catch {
      continue;
    }
    if (run.planFile !== file || run.planHash !== hash) continue;
    if ((run.environment?.name ?? 'development') !== env) continue;
    const ended = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
    if (!(now - ended <= REHEARSAL_MAX_AGE_MS)) continue;
    if (rehearsalProblems(run, plan).length === 0) return run;
  }
  return undefined;
}
