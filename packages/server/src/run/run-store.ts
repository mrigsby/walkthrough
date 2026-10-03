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
import { CHECKS, type CheckName } from '../audit/standards.js';
import type { Emulation } from '../browser/emulation-schema.js';
import type { CookieCheck } from '../devtools/cookie-schema.js';
import { ToolError } from '../errors.js';
import type { LighthouseCheck } from '../lighthouse/audit.js';
import type { LhMode } from '../lighthouse/categories.js';
import type { ActionRecord } from '../page/actions.js';
import { ensureWalkthroughDir } from '../project-files.js';
import { slug } from '../text.js';
import type { Capture, Mode, Plan, PlanStep } from './plan-schema.js';

export type StepStatus = 'pending' | 'pass' | 'fail' | 'bug' | 'skip' | 'stop' | 'blocked';
export type RunStatus = 'running' | 'finished' | 'stopped' | 'incomplete';

// A screenshot saved to an exact file. "element" names an element that has no stable selector.
export type RunCapture = Capture & { element?: string };

export interface RunStep {
  id: string;
  index: number;
  title: string;
  expect?: string;
  // The text with its {{var:NAME}} tokens, when the values made it different.
  // A replay or an export in another environment fills in its own values.
  template?: { title?: string; expect?: string; caption?: string };
  confirm: boolean;
  status: StepStatus;
  checkedBy?: 'developer' | 'agent';
  notes?: string;
  actual?: string;
  screenshots: string[];
  // Screenshots saved to exact files. Exported scripts take them again.
  captures?: RunCapture[];
  // Other evidence, like HAR files, relative to the run folder.
  files?: string[];
  logs?: string;
  errorCount?: number;
  actions: Array<
    Pick<
      ActionRecord,
      'tab' | 'action' | 'label' | 'selector' | 'value' | 'files' | 'frameUrl' | 'url'
    >
  >;
  at?: string;
  // The accessibility check this step asks for, from the plan.
  a11y?: { selector?: string; checks: CheckName[] };
  // Cookie checks from the plan.
  cookies?: CookieCheck[];
  // What mock rules did during the step, like "GET /api/stock -> 500 (mock m1)".
  mocked?: string[];
  // How Lighthouse measures this step, from the plan. A navigation has the page to load.
  lighthouse?: { mode: LhMode; url?: string };
  // The text that viewers see in videos. Without it, videos show the title.
  caption?: string;
}

// A video of the run, or of part of it.
export interface RunVideo {
  // From the run folder, like "video/run.mp4".
  file: string;
  format: string;
  seconds: number;
  bytes: number;
  name: string;
  // True for the video of the whole run.
  whole?: boolean;
  // The exact file it was also saved to, from the project folder.
  path?: string;
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
  // The environment of the run. Runs from before 0.4.0 have none: they are development.
  environment?: RunEnvironment;
  // The values that {{var:NAME}} had in this run.
  vars?: Record<string, string>;
  // What the run did, from executionHash. A presentation reuses a rehearsal with the same hash.
  planHash?: string;
  chrome?: string;
  summary?: string;
  // Screen, color scheme, network, and saved login used for the run.
  setup?: string;
  // The settings of the first tab, for exported scripts.
  emulation?: Emulation;
  // The value that {{unique}} had in this run.
  unique?: string;
  // The saved login that the run started with. A replay loads it too.
  session?: string;
  steps: RunStep[];
  accessibility?: A11yCheck[];
  // Accessibility settings from the plan.
  a11yPlan?: { report: boolean; standard?: string; checks?: CheckName[] };
  // A scan that stopped at its time limit, with the pages still to check.
  a11yScan?: { pending: string[]; standard: string; tags: string[]; checks: string[] };
  // Lighthouse results, one for each page or flow step.
  lighthouse?: LighthouseCheck[];
  // A Lighthouse check that stopped at its time limit.
  lhScan?: { pending: string[]; device: string; categories: string[] };
  // Lighthouse settings for the flow steps of the plan.
  lhPlan?: { device: string; categories: string[]; report: boolean };
  // True when the run started in a new browser with an empty profile.
  freshBrowser?: boolean;
  videos?: RunVideo[];
  // Why a video of the run is missing.
  videoNote?: string;
}

export interface RunEnvironment {
  name: string;
  label: string;
  color: string;
  baseUrl?: string;
  protected: boolean;
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

// Run ids start with this, so the newest run sorts last. Milliseconds keep two runs
// in the same second in order.
function stamp(date = new Date()): string {
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
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
      unique?: string;
      session?: string;
      // The checks a plain "a11y: true" step runs when the plan names none.
      a11yChecks?: CheckName[];
      // Lighthouse settings from config.yaml, for a plan that names none.
      lighthouse?: { device: string; categories: string[] };
      freshBrowser?: boolean;
      environment?: RunEnvironment;
      vars?: Record<string, string>;
      planHash?: string;
      // Fills in {{var:NAME}} and {{unique}} in text that people read.
      show?: (text: string) => string;
    },
  ): RunStore {
    // The date stays first, so ids sort by time. Other environments add their name.
    const env = input.environment?.name;
    const envPart = env && env !== 'development' ? `-${env}` : '';
    const id = `${stamp()}-${slug(input.name, 40, 'run')}${envPart}-${randomBytes(2).toString('hex')}`;
    const show = input.show ?? ((text: string) => text);
    const dir = join(ensureWalkthroughDir(projectDir), 'runs', id);
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    const settings = input.plan?.accessibility;
    const lhSettings = input.plan?.lighthouse;
    // Plan checks, like { keyboard: false }, change the defaults one by one.
    const planChecks = settings?.checks
      ? CHECKS.filter((c) => settings.checks?.[c] ?? input.a11yChecks?.includes(c))
      : undefined;
    // Keeps the token form of text that changed when the values went in.
    const template = (step: PlanStep) => {
      const out: NonNullable<RunStep['template']> = {};
      for (const [key, text] of [
        ['title', step.do],
        ['expect', step.expect],
        ['caption', step.caption],
      ] as const) {
        if (text !== undefined && show(text) !== text) out[key] = text;
      }
      return Object.keys(out).length ? { template: out } : {};
    };
    const steps: RunStep[] = (input.plan?.steps ?? []).map((step, i) => ({
      id: step.id ?? `step-${i + 1}`,
      index: i + 1,
      title: show(step.do),
      expect: step.expect === undefined ? undefined : show(step.expect),
      ...template(step),
      confirm: needsConfirm(input.mode, step.checkpoint),
      // A step that is only a slide has nothing to test.
      ...(step.slide && !step.action
        ? { status: 'skip' as const, notes: 'A slide for presentations. Nothing to test.' }
        : { status: 'pending' as const }),
      screenshots: [],
      actions: [],
      ...(step.cookies ? { cookies: step.cookies } : {}),
      ...(step.caption ? { caption: show(step.caption) } : {}),
      ...(step.lighthouse
        ? { lighthouse: { mode: step.lighthouse, url: step.action?.navigate } }
        : {}),
      ...(step.a11y
        ? {
            a11y: {
              selector: step.a11y === true ? undefined : step.a11y.selector,
              checks:
                (step.a11y === true ? undefined : step.a11y.checks) ??
                planChecks ??
                input.a11yChecks ??
                [],
            },
          }
        : {}),
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
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.vars && Object.keys(input.vars).length ? { vars: input.vars } : {}),
      ...(input.planHash ? { planHash: input.planHash } : {}),
      chrome: input.chrome,
      setup: input.setup,
      emulation: input.emulation,
      unique: input.unique,
      ...(input.session ? { session: input.session } : {}),
      ...(input.freshBrowser !== undefined ? { freshBrowser: input.freshBrowser } : {}),
      steps,
      ...(settings || input.plan?.steps.some((s) => s.a11y)
        ? {
            a11yPlan: {
              report: settings?.report ?? false,
              standard: settings?.standard,
              checks: planChecks,
            },
          }
        : {}),
      ...(lhSettings || input.plan?.steps.some((s) => s.lighthouse)
        ? {
            lhPlan: {
              device: lhSettings?.device ?? input.lighthouse?.device ?? 'desktop',
              categories: lhSettings?.categories ??
                input.lighthouse?.categories ?? ['performance', 'best-practices', 'seo'],
              report: lhSettings?.report ?? false,
            },
          }
        : {}),
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
