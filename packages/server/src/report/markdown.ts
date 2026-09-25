import type { Run, RunStep } from '../run/run-store.js';
import {
  accessibilityRows,
  cell,
  duration,
  isProblem,
  RUN_STATUS_LABELS,
  reproSteps,
  resultLine,
  STATUS_LABELS,
  stepAccessibility,
} from './common.js';

function stepDetails(run: Run, step: RunStep, withRepro: boolean): string[] {
  const out = [`### Step ${step.index}: ${step.title} (${STATUS_LABELS[step.status]})`, ''];
  if (step.expect) out.push(`- **Expected:** ${step.expect}`);
  if (step.actual) out.push(`- **Actual:** ${step.actual}`);
  if (step.checkedBy)
    out.push(`- **Checked by:** ${step.checkedBy === 'developer' ? 'the developer' : 'the agent'}`);
  if (step.notes) out.push(`- **Notes:** ${step.notes}`);
  const a11y = stepAccessibility(run, step);
  if (a11y) out.push(`- **Accessibility:** ${a11y}`);
  out.push('');
  if (withRepro) {
    out.push('**Steps to reproduce:**', '');
    for (const [i, line] of reproSteps(run, step).entries()) out.push(`${i + 1}. ${line}`);
    out.push('');
  }
  for (const shot of step.screenshots) out.push(`![Step ${step.index} screenshot](${shot})`, '');
  if (step.logs && step.logs !== '(none)') {
    out.push('**Errors and failed requests:**', '', '```text', step.logs, '```', '');
  }
  return out;
}

// A report that reads well in a code editor, a pull request, or an issue.
export function markdownReport(run: Run, options: { a11yReport?: boolean } = {}): string {
  const problems = run.steps.filter(isProblem);
  const lines = [
    `# Walkthrough report: ${run.name}`,
    '',
    `- **Result:** ${resultLine(run) || 'no steps'}`,
    `- **Status:** ${RUN_STATUS_LABELS[run.status]}`,
    `- **Mode:** ${run.mode}`,
    ...(run.planFile ? [`- **Plan:** \`${run.planFile}\``] : []),
    ...(run.baseUrl ? [`- **Start page:** ${run.baseUrl}`] : []),
    ...(run.chrome ? [`- **Browser:** ${run.chrome}`] : []),
    ...(run.setup ? [`- **Setup:** ${run.setup}`] : []),
    `- **Started:** ${run.startedAt}`,
    `- **Time:** ${duration(run)}`,
    ...(options.a11yReport
      ? ['- **Accessibility report:** accessibility.html and accessibility.md']
      : []),
    '',
  ];
  if (run.summary) lines.push('## Summary', '', run.summary, '');

  if (problems.length > 0) {
    lines.push('## Bugs and failures', '');
    for (const step of problems) lines.push(...stepDetails(run, step, true));
  }

  lines.push(
    '## All steps',
    '',
    '| # | Step | Result | Checked by | Notes |',
    '|---|---|---|---|---|',
  );
  for (const step of run.steps) {
    const who =
      step.checkedBy === 'developer' ? 'Developer' : step.checkedBy === 'agent' ? 'Agent' : '';
    lines.push(
      `| ${step.index} | ${cell(step.title)} | ${STATUS_LABELS[step.status]} | ${who} | ${cell(step.notes)} |`,
    );
  }
  lines.push('');

  if (run.accessibility?.length) {
    const rows = accessibilityRows(run);
    lines.push('## Accessibility', '');
    if (rows.length === 0) lines.push('No accessibility problems found.', '');
    else {
      lines.push('| Where | Impact | Problem | Elements |', '|---|---|---|---|');
      for (const r of rows) {
        lines.push(
          `| ${cell(r.where)} | ${r.impact} | [${cell(r.rule)}](${r.helpUrl.replace(/[()\s|]/g, encodeURIComponent)}): ${cell(r.help)} | ${r.count} |`,
        );
      }
      lines.push('');
    }
  }

  const others = run.steps.filter((s) => !isProblem(s) && s.status !== 'pending');
  if (others.length > 0) {
    lines.push('## Step details', '');
    for (const step of others) lines.push(...stepDetails(run, step, false));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
