import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { A11yNode, A11yPass, A11yViolation } from '../audit/axe.js';
import type { KeyboardResult } from '../audit/keyboard.js';
import { ToolError } from '../errors.js';
import type { ActionRecord } from '../page/actions.js';
import { ensureWalkthroughDir } from '../project-files.js';
import { slug } from '../text.js';
import type { Capture, Mode, Plan } from './plan-schema.js';

export type StepStatus = 'pending' | 'pass' | 'fail' | 'bug' | 'skip' | 'stop' | 'blocked';
export type RunStatus = 'running' | 'finished' | 'stopped' | 'incomplete';

// A screenshot saved to an exact file. "element" names an element that has no stable selector.
export type RunCapture = Capture & { element?: string };

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
  // Screenshots saved to exact files. Exported scripts take them again.
  captures?: RunCapture[];
  logs?: string;
  errorCount?: number;
  actions: Array<
    Pick<ActionRecord, 'action' | 'label' | 'selector' | 'value' | 'files' | 'frameUrl' | 'url'>
  >;
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
  // Screen, color scheme, network, and saved login used for the run.
  setup?: string;
  // The screen and color scheme, for exported scripts.
  emulation?: { device?: string; colorScheme?: string };
  steps: RunStep[];
  accessibility?: A11yCheck[];
}

// One accessibility check of one page. Fields after "violations" are optional,
// because older runs do not have them.
export interface A11yCheck {
  at: string;
  stepId?: string;
  url: string;
  // The page that was asked for, when a redirect went somewhere else.
  requestedUrl?: string;
  scope?: string;
  violations: A11yViolation[];
  incomplete?: A11yViolation[];
  passes?: A11yPass[];
  inapplicable?: number;
  engine?: string;
  standard?: string;
  tags?: string[];
  colorScheme?: string;
  viewport?: string;
  checks?: {
    darkMode?: { darkOnly: A11yNode[]; lightOnly: A11yNode[]; dark?: A11yViolation };
    reflow?: { width: number; pageWidth: number; overflow: boolean; elements: A11yNode[] };
    keyboard?: KeyboardResult;
    framesChecked?: string[];
    framesNotChecked?: Array<{ url: string; reason: string }>;
  };
  shots?: Array<{ rule: string; target: string; file: string }>;
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
      setup?: string;
      emulation?: Run['emulation'];
    },
  ): RunStore {
    const id = `${stamp()}-${slug(input.name, 40, 'run')}-${randomBytes(2).toString('hex')}`;
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
      setup: input.setup,
      emulation: input.emulation,
      steps,
    };
    const store = new RunStore(dir, run, projectDir);
    store.save();
    return store;
  }

  static open(projectDir: string, id: string): RunStore {
    const dir = checkRunId(projectDir, id);
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

// Checks a run folder name, and returns the folder path.
// It must be a plain name, and the folder must be inside .walkthrough/runs.
export function checkRunId(projectDir: string, id: string): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(id) || id.includes('..')) {
    throw new ToolError(
      `"${id}" is not a run folder name. Use a name from the runs tool.`,
      'bad_run_id',
    );
  }
  const root = join(projectDir, '.walkthrough', 'runs');
  const dir = join(root, id);
  let realRoot: string;
  let realDir: string;
  try {
    // Links can point anywhere, so compare the real paths.
    realRoot = realpathSync(root);
    realDir = realpathSync(dir);
  } catch {
    throw new ToolError(`There is no run "${id}" in .walkthrough/runs.`, 'run_not_found');
  }
  if (!realDir.startsWith(realRoot + sep)) {
    throw new ToolError(`"${id}" is not a run folder inside .walkthrough/runs.`, 'bad_run_id');
  }
  return dir;
}

// The newest run folder that has a run.json, or undefined.
export function latestRunId(
  projectDir: string,
  options: { finishedOnly?: boolean } = {},
): string | undefined {
  const dir = join(projectDir, '.walkthrough', 'runs');
  if (!existsSync(dir)) return undefined;
  for (const id of readdirSync(dir).sort().reverse()) {
    try {
      const run = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8')) as Run;
      if (!options.finishedOnly || run.status !== 'running') return id;
    } catch {}
  }
  return undefined;
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
