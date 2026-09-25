import { basename } from 'node:path';
import { standardLabel } from '../audit/audit-page.js';
import type { Comparison, SavedReport } from '../audit/compare.js';
import { customPasses } from '../audit/custom-rules.js';
import type { Finding, Findings, ReviewItem } from '../audit/findings.js';
import { pageKey } from '../audit/findings.js';
import type { FocusStop } from '../audit/keyboard.js';
import type { Scores } from '../audit/score.js';
import { CRITERIA, type Criterion, criteriaForTags } from '../audit/wcag.js';
import type { Run } from '../run/run-store.js';

// The text the agent wrote for one issue.
export interface ReportItem {
  explain: string;
  fix: string;
  code?: string;
  where?: Array<{ file: string; line?: number }>;
  // True when the agent wrote nothing, and the text comes from axe.
  fallback?: boolean;
}

export interface CriterionRow {
  criterion: Criterion;
  status: 'problems' | 'passed' | 'manual';
  ids: string[];
}

// Everything the three report files show. The HTML, Markdown, and JSON use the same data.
export interface A11yReportData {
  runId: string;
  runName: string;
  // The run folder: the full path to read screenshots, and the path from the project.
  runDir: string;
  relativeDir: string;
  createdAt: string;
  baseUrl?: string;
  standard: string;
  engine: string;
  checksRun: string[];
  viewports: string[];
  colorSchemes: string[];
  pages: Array<{ page: string; url: string }>;
  scores: Scores;
  findings: Finding[];
  items: Record<string, ReportItem>;
  status: Record<string, 'new' | 'still'>;
  elementsFixed: Record<string, number>;
  fixed: Comparison['fixed'];
  previous?: { runId: string; at: string };
  review: ReviewItem[];
  keyboard: Array<{ page: string; stops: FocusStop[]; endedBy: string }>;
  framesNotChecked: Array<{ url: string; reason: string }>;
  wcag: CriterionRow[];
  // The screenshot of each rule, from the run folder.
  shots: Record<string, string>;
  summary: string;
  prompt: string;
}

// The prompt the developer can paste into a new session to plan the fixes.
export function suggestedPrompt(
  run: Run,
  runDir: string,
  pages: string[],
  firstId: string | undefined,
): string {
  const target = run.planFile ? basename(run.planFile).replace(/\.ya?ml$/, '') : pages.join(' ');
  const app = run.baseUrl ?? run.name;
  return [
    `Read ${runDir}/accessibility.md. It is an accessibility report for ${app}.`,
    'Write a plan to fix the issues. Fix critical and serious issues first. Group the fixes by',
    `source file, and name the issue ID (like ${firstId ?? 'A11Y-001'}) for each fix. When the fixes are done,`,
    `run /walkthrough:a11y ${target} again. The issue IDs stay the same, so you can check`,
    'each fix.',
  ].join('\n');
}

// For each WCAG criterion: problems found, no problems found, or check it by hand.
function wcagRows(run: Run, findings: Finding[]): CriterionRow[] {
  const passed = new Set<string>();
  for (const check of run.accessibility ?? []) {
    for (const p of [...(check.passes ?? []), ...customPasses(check)]) {
      for (const c of criteriaForTags(p.tags)) passed.add(c.number);
    }
  }
  return CRITERIA.map((criterion) => {
    const ids = findings
      .filter((f) => f.criteria.some((c) => c.number === criterion.number))
      .map((f) => f.id);
    const status = ids.length ? 'problems' : passed.has(criterion.number) ? 'passed' : 'manual';
    return { criterion, status, ids };
  });
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

export function buildReportData(input: {
  run: Run;
  runDir: string;
  relativeDir: string;
  findings: Findings;
  scores: Scores;
  comparison?: Comparison;
  items: Record<string, ReportItem>;
  summary: string;
}): A11yReportData {
  const { run, findings, comparison } = input;
  const checks = run.accessibility ?? [];
  const shots: Record<string, string> = {};
  for (const check of checks) {
    for (const shot of check.shots ?? []) shots[shot.rule] ??= shot.file;
  }
  const keyboard = checks
    .filter((c) => c.checks?.keyboard)
    .map((c) => ({
      page: pageKey(c.url),
      stops: c.checks?.keyboard?.stops ?? [],
      endedBy: c.checks?.keyboard?.endedBy ?? 'limit',
    }));
  const checksRun = unique(
    checks.flatMap((c) => [
      c.checks?.keyboard ? 'keyboard' : undefined,
      c.checks?.darkMode ? 'dark mode' : undefined,
      c.checks?.reflow ? 'reflow' : undefined,
      c.checks?.framesChecked ? 'frames' : undefined,
      c.shots ? 'screenshots' : undefined,
    ]),
  );
  const pages = findings.pages.map((p) => p.page);
  return {
    runId: run.id,
    runName: run.name,
    runDir: input.runDir,
    relativeDir: input.relativeDir,
    createdAt: new Date().toISOString(),
    baseUrl: run.baseUrl,
    standard: standardLabel(checks[0]?.standard) || 'WCAG 2.2 AA',
    engine: checks.find((c) => c.engine)?.engine ?? 'axe-core',
    checksRun,
    viewports: unique(checks.map((c) => c.viewport)),
    colorSchemes: unique(checks.map((c) => c.colorScheme)),
    pages: findings.pages,
    scores: input.scores,
    findings: findings.findings,
    items: input.items,
    status: Object.fromEntries(comparison?.status ?? []),
    elementsFixed: Object.fromEntries(comparison?.elementsFixed ?? []),
    fixed: comparison?.fixed ?? [],
    previous: comparison
      ? { runId: comparison.previousRunId, at: comparison.previousAt }
      : undefined,
    review: findings.review,
    keyboard,
    framesNotChecked: checks.flatMap((c) => c.checks?.framesNotChecked ?? []),
    wcag: wcagRows(run, findings.findings),
    shots,
    summary: input.summary,
    prompt: suggestedPrompt(run, input.relativeDir, pages, findings.findings[0]?.id),
  };
}

// The data for accessibility.json. The next report reads it to compare.
export function jsonReport(data: A11yReportData): SavedReport & Record<string, unknown> {
  return {
    version: 1,
    runId: data.runId,
    createdAt: data.createdAt,
    runName: data.runName,
    baseUrl: data.baseUrl,
    standard: data.standard,
    engine: data.engine,
    checksRun: data.checksRun,
    pages: data.pages,
    scores: data.scores,
    summary: data.summary,
    previous: data.previous,
    findings: data.findings.map((f) => ({
      id: f.id,
      rule: f.rule,
      impact: f.impact,
      help: f.help,
      helpUrl: f.helpUrl,
      criteria: f.criteria.map((c) => `${c.number} (${c.level})`),
      area: f.area,
      bestPractice: f.bestPractice,
      status: data.status[f.rule] ?? 'new',
      pages: f.pages,
      elementCount: f.elementCount,
      ...data.items[f.id],
      elements: f.elements.map((e) => ({
        page: e.page,
        url: e.url,
        target: e.target,
        frame: e.frame,
        html: e.html,
        failureSummary: e.failureSummary,
        contrast: e.contrast,
      })),
    })),
    fixed: data.fixed,
    review: data.review.map((r) => ({
      rule: r.rule,
      help: r.help,
      helpUrl: r.helpUrl,
      pages: r.pages,
      elementCount: r.elementCount,
    })),
    wcag: data.wcag.map((w) => ({
      criterion: w.criterion.number,
      level: w.criterion.level,
      status: w.status,
      ids: w.ids,
    })),
  };
}
