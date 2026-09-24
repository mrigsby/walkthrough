import { reproSteps } from '../report/common.js';
import type { Run, RunStep } from '../run/run-store.js';
import { VERSION } from '../version.js';

// gh opens the browser with the title and body in the address. GitHub refuses
// addresses of 8192 bytes or more, so the encoded body must stay well under that.
export const MAX_ENCODED_BODY = 6000;

export interface IssueDraft {
  title: string;
  body: string;
  shortened: boolean;
  screenshots: string[];
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, '', ...lines, ''].join('\n');
}

function encodedLength(text: string): number {
  return encodeURIComponent(text).length;
}

// Builds an issue title and body from a bug or a failed step.
export function draftIssue(
  run: Run,
  step: RunStep,
  options: { reportPath: string; screenshots: string[] },
): IssueDraft {
  const what = step.actual ?? step.notes ?? '';
  const title = oneLine(`${step.title}: ${what || 'does not work as expected'}`, 90);

  const repro = reproSteps(run, step).map((line, i) => `${i + 1}. ${line}`);
  const environment = [
    `- Page: ${step.actions.at(-1)?.url ?? run.baseUrl ?? 'unknown'}`,
    ...(run.chrome ? [`- Browser: ${run.chrome}`] : []),
    ...(run.setup ? [`- Setup: ${run.setup}`] : []),
    `- Found by: Walkthrough ${VERSION}, run \`${run.id}\`, step ${step.index}`,
  ];
  const evidence = options.screenshots.length
    ? options.screenshots.map((s) => `- \`${s}\` (drag the file into this issue)`)
    : ['- No screenshot.'];

  const parts = {
    summary: section('What happened', [what || 'See the steps below.']),
    repro: section('Steps to reproduce', repro),
    expected: section('Expected', [step.expect ?? 'See the steps above.']),
    actual: section('Actual', [
      what || 'The step did not pass.',
      ...(step.notes && step.actual ? ['', `Developer notes: ${step.notes}`] : []),
    ]),
    logs:
      step.logs && step.logs !== '(none)'
        ? section('Errors and failed requests', ['```text', step.logs, '```'])
        : '',
    evidence: section('Screenshots', evidence),
    environment: section('Environment', environment),
    report: `The full report is in \`${options.reportPath}\`.\n`,
  };

  const build = (logs: string) =>
    [
      parts.summary,
      parts.repro,
      parts.expected,
      parts.actual,
      logs,
      parts.evidence,
      parts.environment,
      parts.report,
    ]
      .filter(Boolean)
      .join('\n');

  let body = build(parts.logs);
  let shortened = false;
  // Make it short enough for the address: first cut the logs, then drop them.
  if (encodedLength(body) > MAX_ENCODED_BODY && parts.logs) {
    shortened = true;
    const lines = (step.logs ?? '').split('\n');
    while (
      lines.length > 1 &&
      encodedLength(build(section('Errors and failed requests', ['```text', ...lines, '```']))) >
        MAX_ENCODED_BODY
    ) {
      lines.pop();
    }
    const cut = section('Errors and failed requests', [
      '```text',
      ...lines,
      '```',
      '',
      'This list leaves out some errors. See the full report.',
    ]);
    body = encodedLength(build(cut)) <= MAX_ENCODED_BODY ? build(cut) : build('');
  }
  if (encodedLength(body) > MAX_ENCODED_BODY) {
    shortened = true;
    let text = body;
    while (encodedLength(`${text}\n\n(Shortened. See the full report.)`) > MAX_ENCODED_BODY) {
      text = text.slice(0, Math.floor(text.length * 0.9));
    }
    body = `${text}\n\n(Shortened. See the full report.)\n`;
  }
  return { title, body, shortened, screenshots: options.screenshots };
}
