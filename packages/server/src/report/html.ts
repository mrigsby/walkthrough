import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageType } from '../evidence/screenshot.js';
import type { Run, RunStep } from '../run/run-store.js';
import {
  accessibilityRows,
  duration,
  esc,
  isProblem,
  RUN_STATUS_LABELS,
  reproSteps,
  resultLine,
  STATUS_LABELS,
  safeHref,
  stepAccessibility,
} from './common.js';

// Puts the image inside the file, so the report works on its own.
function image(runDir: string, path: string, alt: string): string {
  try {
    const data = readFileSync(join(runDir, path)).toString('base64');
    return `<a href="${esc(path)}"><img src="data:image/${imageType(path)};base64,${data}" alt="${esc(alt)}"></a>`;
  } catch {
    return `<p class="muted">Screenshot missing: ${esc(path)}</p>`;
  }
}

function stepCard(run: Run, runDir: string, step: RunStep, open: boolean): string {
  const parts = [
    `<details class="step ${step.status}"${open ? ' open' : ''}>`,
    `<summary><span class="badge ${step.status}">${esc(STATUS_LABELS[step.status])}</span> Step ${step.index}: ${esc(step.title)}</summary>`,
    '<dl>',
  ];
  if (step.expect) parts.push(`<dt>Expected</dt><dd>${esc(step.expect)}</dd>`);
  if (step.actual) parts.push(`<dt>Actual</dt><dd>${esc(step.actual)}</dd>`);
  if (step.checkedBy)
    parts.push(
      `<dt>Checked by</dt><dd>${step.checkedBy === 'developer' ? 'The developer' : 'The agent'}</dd>`,
    );
  if (step.notes) parts.push(`<dt>Notes</dt><dd>${esc(step.notes)}</dd>`);
  const a11y = stepAccessibility(run, step);
  if (a11y) parts.push(`<dt>Accessibility</dt><dd>${esc(a11y)}</dd>`);
  parts.push('</dl>');
  if (isProblem(step)) {
    parts.push(
      '<h3>Steps to reproduce</h3><ol>',
      ...reproSteps(run, step).map((s) => `<li>${esc(s)}</li>`),
      '</ol>',
    );
  }
  for (const shot of step.screenshots)
    parts.push(image(runDir, shot, `Screenshot of step ${step.index}: ${step.title}`));
  if (step.logs && step.logs !== '(none)') {
    parts.push('<h3>Errors and failed requests</h3>', `<pre tabindex="0">${esc(step.logs)}</pre>`);
  }
  parts.push('</details>');
  return parts.join('\n');
}

const CSS = `
:root { color-scheme: light dark; --bg: #f8fafc; --card: #ffffff; --fg: #0f172a; --muted: #475569; --line: #e2e8f0; --link: #1d4ed8;
  --pass: #15803d; --bug: #b91c1c; --fail: #b91c1c; --skip: #64748b; --stop: #a16207; --pending: #475569; --blocked: #c2410c;
  --critical: #7f1d1d; --serious: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --card: #111827; --fg: #e5e7eb; --muted: #94a3b8; --line: #1f2937; --link: #93c5fd; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 24px; }
.muted { color: var(--muted); }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 16px; margin: 16px 0;
  padding: 12px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.meta div span { display: block; font-size: 12px; color: var(--muted); }
.counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 24px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; color: #ffffff; font-size: 12px; font-weight: 600; }
.badge.pass { background: var(--pass); } .badge.bug, .badge.fail { background: var(--bug); } .badge.skip { background: var(--skip); }
.badge.stop { background: var(--stop); }
.badge.impact-critical { background: var(--critical); } .badge.impact-serious { background: var(--serious); } .badge.impact-moderate { background: var(--stop); } .badge.impact-minor { background: var(--skip); } .badge.pending { background: var(--pending); } .badge.blocked { background: var(--blocked); }
h2 { margin-top: 28px; font-size: 18px; }
h3 { margin: 12px 0 4px; font-size: 15px; }
a { color: var(--link); text-decoration: underline; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.step { margin: 8px 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
.step.bug, .step.fail, .step.blocked { border-left: 4px solid var(--bug); }
summary { cursor: pointer; font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 12px 0; }
dt { color: var(--muted); } dd { margin: 0; white-space: pre-wrap; }
img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; }
pre { overflow-x: auto; padding: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; font-size: 12px; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; background: var(--card); }
caption { text-align: left; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
`;

function accessibilitySection(run: Run): string {
  if (!run.accessibility?.length) return '';
  const rows = accessibilityRows(run);
  if (rows.length === 0) return '<h2>Accessibility</h2><p>No accessibility problems found.</p>';
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.where)}</td><td><span class="badge impact-${esc(r.impact)}">${esc(r.impact)}</span></td><td><a href="${safeHref(r.helpUrl)}">${esc(r.rule)}</a>: ${esc(r.help)}</td><td>${r.count}</td></tr>`,
    )
    .join('\n');
  return `<h2>Accessibility</h2>
<table>
<caption class="sr-only">Accessibility problems</caption>
<thead><tr><th scope="col">Where</th><th scope="col">Impact</th><th scope="col">Problem</th><th scope="col">Elements</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

// A single HTML file with the screenshots inside. It opens without a server.
export function htmlReport(run: Run, runDir: string): string {
  const problems = run.steps.filter(isProblem);
  const counts = new Map<string, number>();
  for (const step of run.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  const meta: Array<[string, string]> = [
    ['Status', RUN_STATUS_LABELS[run.status]],
    ['Mode', run.mode],
    ['Started', new Date(run.startedAt).toLocaleString('en-US')],
    ['Time', duration(run)],
  ];
  if (run.planFile) meta.push(['Plan', run.planFile]);
  if (run.baseUrl) meta.push(['Start page', run.baseUrl]);
  if (run.chrome) meta.push(['Browser', run.chrome]);
  if (run.setup) meta.push(['Setup', run.setup]);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Walkthrough report: ${esc(run.name)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(run.name)}</h1>
<p class="muted">Walkthrough report. Result: ${esc(resultLine(run) || 'no steps')}.${existsSync(join(runDir, 'accessibility.html')) ? ' <a href="accessibility.html">Accessibility report</a>' : ''}</p>
<div class="meta">${meta.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('')}</div>
<div class="counts">${[...counts].map(([status, n]) => `<span class="badge ${status}">${n} ${esc(STATUS_LABELS[status as RunStep['status']])}</span>`).join('')}</div>
${run.summary ? `<h2>Summary</h2><p>${esc(run.summary)}</p>` : ''}
${problems.length ? `<h2>Bugs and failures</h2>\n${problems.map((s) => stepCard(run, runDir, s, true)).join('\n')}` : ''}
<h2>All steps</h2>
<table>
<caption class="sr-only">All steps</caption>
<thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Result</th><th scope="col">Checked by</th><th scope="col">Notes</th></tr></thead>
<tbody>
${run.steps
  .map(
    (s) =>
      `<tr><td>${s.index}</td><td>${esc(s.title)}</td><td><span class="badge ${s.status}">${esc(STATUS_LABELS[s.status])}</span></td><td>${s.checkedBy === 'developer' ? 'Developer' : s.checkedBy === 'agent' ? 'Agent' : ''}</td><td>${esc(s.notes ?? '')}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>
${accessibilitySection(run)}
<h2>Step details</h2>
${
  run.steps
    .filter((s) => !isProblem(s) && s.status !== 'pending')
    .map((s) => stepCard(run, runDir, s, false))
    .join('\n') || '<p class="muted">No other steps.</p>'
}
</main>
</body>
</html>
`;
}
