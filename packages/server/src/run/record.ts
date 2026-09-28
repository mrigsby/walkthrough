import { isAbsolute, join, relative } from 'node:path';
import type { Context } from '../context.js';
import type { LogEntry } from '../evidence/logs.js';
import { formatLogs } from '../evidence/logs.js';
import type { RunStep, StepStatus } from './run-store.js';

export interface StepRef {
  id?: string;
  index?: number;
  title?: string;
  expect?: string;
}

export interface StepResult {
  status: StepStatus;
  checkedBy: 'developer' | 'agent';
  notes?: string;
  actual?: string;
  // Screenshot path, from the project folder.
  screenshot?: string;
  // Other evidence files, like a HAR file, from the project folder.
  files?: string[];
  // What mock rules did during the step.
  mocked?: string[];
  logs?: LogEntry[];
}

// Saves a step result in the active run, with the actions since the last result.
export function recordResult(ctx: Context, ref: StepRef, result: StepResult): RunStep | undefined {
  const store = ctx.run;
  if (store?.run.status !== 'running') return undefined;
  const step = store.step(ref);
  step.status = result.status;
  step.checkedBy = result.checkedBy;
  if (result.notes !== undefined) step.notes = result.notes || undefined;
  if (result.actual !== undefined) step.actual = result.actual || undefined;
  if (result.screenshot) {
    const full = isAbsolute(result.screenshot)
      ? result.screenshot
      : join(store.projectDir, result.screenshot);
    step.screenshots.push(relative(store.dir, full));
  }
  if (result.mocked?.length) step.mocked = [...new Set([...(step.mocked ?? []), ...result.mocked])];
  for (const file of result.files ?? []) {
    const full = isAbsolute(file) ? file : join(store.projectDir, file);
    step.files = [...(step.files ?? []), relative(store.dir, full)];
  }
  if (result.logs) {
    step.logs = formatLogs(result.logs);
    step.errorCount = result.logs.filter((e) => e.level === 'error').length;
  }
  const actions = ctx.actionLog
    .slice(ctx.actionCursor)
    .map(({ tab, action, label, selector, value, files, frameUrl, url }) => ({
      tab,
      action,
      label,
      selector,
      value,
      files,
      frameUrl,
      url,
    }));
  step.actions.push(...actions);
  ctx.actionCursor = ctx.actionLog.length;
  step.at = new Date().toISOString();
  store.save();
  return step;
}

// A short hint about what to do next in the run.
export function nextStepHint(ctx: Context): string {
  const next = ctx.run?.nextPending();
  if (!ctx.run) return '';
  if (!next) return 'All steps have a result. Call run_finish to write the report.';
  return `Next: step ${next.index} [${next.id}]${next.confirm ? ' (confirm with the developer)' : ''}: ${next.title}`;
}
