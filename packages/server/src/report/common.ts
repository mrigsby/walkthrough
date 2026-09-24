import { IMPACT_ORDER } from '../audit/axe.js';
import type { Run, RunStep, StepStatus } from '../run/run-store.js';

export const STATUS_LABELS: Record<StepStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  bug: 'Bug',
  skip: 'Skipped',
  stop: 'Stopped',
  blocked: 'Blocked',
  pending: 'Not run',
};

export function isProblem(step: RunStep): boolean {
  return step.status === 'bug' || step.status === 'fail' || step.status === 'blocked';
}

const ACTION_WORDS: Record<string, string> = {
  click: 'Click',
  dblclick: 'Double-click',
  hover: 'Point at',
  fill: 'Type into',
  select: 'Choose in',
  check: 'Check',
  uncheck: 'Uncheck',
  press: 'Press a key in',
  scroll: 'Scroll to',
  upload: 'Upload to',
  navigate: 'Go to',
};

// Steps to reproduce a problem: the steps before it, then its own actions.
export function reproSteps(run: Run, step: RunStep): string[] {
  const before = run.steps
    .filter((s) => s.index < step.index && s.status !== 'pending')
    .map((s) => s.title);
  const own = step.actions.length
    ? step.actions.map((a) => {
        const value =
          a.value && a.action !== 'press'
            ? ` "${a.value}"`
            : a.action === 'press'
              ? ` (${a.value})`
              : '';
        if (a.action === 'navigate') return `Go to ${a.value ?? a.label}`;
        return `${ACTION_WORDS[a.action] ?? a.action} ${a.label}${a.action === 'fill' ? ` the text${value}` : value}`;
      })
    : [step.title];
  return [...(run.baseUrl ? [`Open ${run.baseUrl}`] : []), ...before, ...own];
}

export function duration(run: Run): string {
  if (!run.endedAt) return 'still running';
  const seconds = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

export function resultLine(run: Run): string {
  const counts: Partial<Record<StepStatus, number>> = {};
  for (const step of run.steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
  const order: StepStatus[] = ['pass', 'bug', 'fail', 'blocked', 'skip', 'stop', 'pending'];
  return order
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${STATUS_LABELS[s].toLowerCase()}`)
    .join(', ');
}

export interface A11ySummaryRow {
  where: string;
  impact: string;
  rule: string;
  help: string;
  count: number;
  helpUrl: string;
}

// One row per problem type, for each check in the run.
export function accessibilityRows(run: Run): A11ySummaryRow[] {
  const rows: A11ySummaryRow[] = [];
  for (const check of run.accessibility ?? []) {
    const where = `${check.stepId ? `Step ${check.stepId}, ` : ''}${check.url}${check.scope ? ` (${check.scope})` : ''}`;
    const sorted = [...check.violations].sort(
      (a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact),
    );
    for (const v of sorted) {
      rows.push({
        where,
        impact: v.impact,
        rule: v.id,
        help: v.help,
        count: v.nodes.length,
        helpUrl: v.helpUrl,
      });
    }
  }
  return rows;
}

export const RUN_STATUS_LABELS: Record<Run['status'], string> = {
  running: 'Running',
  finished: 'Finished',
  stopped: 'Stopped by the developer',
  incomplete: 'Incomplete (the run ended early)',
};
