import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ToolError } from '../errors.js';
import type { ActionRecord } from '../page/actions.js';
import { ensureWalkthroughDir } from '../project-files.js';
import type { Mode, Plan } from './plan-schema.js';

export type StepStatus = 'pending' | 'pass' | 'fail' | 'bug' | 'skip' | 'stop' | 'blocked';
export type RunStatus = 'running' | 'finished' | 'stopped' | 'incomplete';

export interface RunStep {
  id: string;
  index: number;
  title: string;
  expect?: string;
  confirm: boolean;
  status: StepStatus;
  checkedBy?: 'developer' | 'agent';
  notes?: string;
  actual?: string;
  screenshots: string[];
  logs?: string;
  errorCount?: number;
  actions: Array<Pick<ActionRecord, 'action' | 'label' | 'selector' | 'value' | 'url'>>;
  at?: string;
}

export interface Run {
  version: 1;
  id: string;
  name: string;
  planFile?: string;
  mode: Mode;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  baseUrl?: string;
  chrome?: string;
  summary?: string;
  steps: RunStep[];
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'run'
  );
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Should the developer confirm this step, in this mode?
export function needsConfirm(mode: Mode, checkpoint?: boolean): boolean {
  if (mode === 'interactive') return true;
  if (mode === 'checkpoints') return Boolean(checkpoint);
  return false;
}

// One test run on disk: run.json, screenshots, and reports.
export class RunStore {
  private constructor(
    readonly dir: string,
    readonly run: Run,
    readonly projectDir: string,
  ) {}

  static create(
    projectDir: string,
    input: {
      name: string;
      mode: Mode;
      plan?: Plan;
      planFile?: string;
      baseUrl?: string;
      chrome?: string;
    },
  ): RunStore {
    const id = `${stamp()}-${slug(input.name)}-${randomBytes(2).toString('hex')}`;
    const dir = join(ensureWalkthroughDir(projectDir), 'runs', id);
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    const steps: RunStep[] = (input.plan?.steps ?? []).map((step, i) => ({
      id: step.id ?? `step-${i + 1}`,
      index: i + 1,
      title: step.do,
      expect: step.expect,
      confirm: needsConfirm(input.mode, step.checkpoint),
      status: 'pending',
      screenshots: [],
      actions: [],
    }));
    const run: Run = {
      version: 1,
      id,
      name: input.name,
      planFile: input.planFile ? relative(projectDir, input.planFile) : undefined,
      mode: input.mode,
      status: 'running',
      startedAt: new Date().toISOString(),
      baseUrl: input.baseUrl,
      chrome: input.chrome,
      steps,
    };
    const store = new RunStore(dir, run, projectDir);
    store.save();
    return store;
  }

  static open(projectDir: string, id: string): RunStore {
    const dir = join(projectDir, '.walkthrough', 'runs', id);
    try {
      const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Run;
      return new RunStore(dir, run, projectDir);
    } catch {
      throw new ToolError(`There is no run "${id}" in .walkthrough/runs.`, 'run_not_found');
    }
  }

  get screenshotsDir(): string {
    return join(this.dir, 'screenshots');
  }

  get relativeDir(): string {
    return relative(this.projectDir, this.dir);
  }

  // Writes run.json safely: a crash never leaves a half-written file.
  save(): void {
    const file = join(this.dir, 'run.json');
    writeFileSync(`${file}.tmp`, `${JSON.stringify(this.run, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  // Finds a step by id, by number, or by title. Adds a new step if none matches.
  step(ref: { id?: string; index?: number; title?: string; expect?: string }): RunStep {
    const found =
      (ref.id && this.run.steps.find((s) => s.id === ref.id)) ||
      (ref.index && this.run.steps.find((s) => s.index === ref.index)) ||
      (ref.title && this.run.steps.find((s) => s.title === ref.title));
    if (found) return found;
    const index = this.run.steps.length + 1;
    const added: RunStep = {
      id: ref.id ?? `step-${index}`,
      index,
      title: ref.title ?? ref.id ?? `Step ${index}`,
      expect: ref.expect,
      confirm: false,
      status: 'pending',
      screenshots: [],
      actions: [],
    };
    this.run.steps.push(added);
    return added;
  }

  // The first step that has no result yet.
  nextPending(): RunStep | undefined {
    return this.run.steps.find((s) => s.status === 'pending');
  }

  finish(summary?: string): void {
    if (this.run.status === 'running') {
      this.run.status = this.run.steps.some((s) => s.status === 'stop') ? 'stopped' : 'finished';
    }
    this.run.endedAt = new Date().toISOString();
    if (summary) this.run.summary = summary;
    this.save();
  }

  markIncomplete(): void {
    this.run.status = 'incomplete';
    this.run.endedAt = new Date().toISOString();
    this.save();
  }
}

export function countSteps(run: Run): Record<StepStatus, number> {
  const counts: Record<StepStatus, number> = {
    pending: 0,
    pass: 0,
    fail: 0,
    bug: 0,
    skip: 0,
    stop: 0,
    blocked: 0,
  };
  for (const step of run.steps) counts[step.status] += 1;
  return counts;
}
