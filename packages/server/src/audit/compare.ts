import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRunId } from '../run/run-store.js';
import type { Finding, Findings } from './findings.js';

// What an earlier accessibility.json keeps about each issue, for comparing.
export interface SavedFinding {
  id: string;
  rule: string;
  help: string;
  impact: string;
  pages: string[];
  elementCount: number;
  elements: Array<{ page: string; target: string; frame?: { selector: string }; html: string }>;
}

export interface SavedReport {
  version: 1;
  runId: string;
  createdAt: string;
  pages: Array<{ page: string; url: string }>;
  findings: SavedFinding[];
}

export interface Comparison {
  previousRunId: string;
  previousAt: string;
  // The ID each rule had before. Issues that are still there keep it.
  keepIds: Map<string, string>;
  // New IDs start after the highest ID used before.
  startAfter: number;
  status: Map<string, 'new' | 'still'>;
  // How many elements of an issue are fixed, on the pages checked both times.
  elementsFixed: Map<string, number>;
  fixed: Array<{ id: string; rule: string; help: string; impact: string; pages: string[] }>;
}

function readReport(dir: string): SavedReport | undefined {
  try {
    const data = JSON.parse(readFileSync(join(dir, 'accessibility.json'), 'utf8')) as SavedReport;
    return data.version === 1 && Array.isArray(data.findings) ? data : undefined;
  } catch {
    return undefined;
  }
}

// The newest earlier report that checked at least one of the same pages.
// With compareTo, that run's report is used instead.
export function findPrevious(
  projectDir: string,
  currentRunId: string,
  pages: string[],
  compareTo?: string,
): SavedReport | undefined {
  if (compareTo) {
    const report = readReport(checkRunId(projectDir, compareTo));
    return report?.runId === currentRunId ? undefined : report;
  }
  const root = join(projectDir, '.walkthrough', 'runs');
  if (!existsSync(root)) return undefined;
  for (const id of readdirSync(root).sort().reverse()) {
    // Run folder names start with the date and time, so older runs sort first.
    if (id >= currentRunId) continue;
    const report = readReport(join(root, id));
    if (report?.pages.some((p) => pages.includes(p.page))) return report;
  }
  return undefined;
}

// Makes HTML easy to compare: one space between words, all lowercase.
function normal(html: string): string {
  return html.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Compares the findings of this run with an earlier report.
export function compareFindings(current: Findings, previous: SavedReport): Comparison {
  const pagesNow = new Set(current.pages.map((p) => p.page));
  const pagesBoth = new Set(previous.pages.map((p) => p.page).filter((p) => pagesNow.has(p)));
  const keepIds = new Map<string, string>();
  const status = new Map<string, 'new' | 'still'>();
  const elementsFixed = new Map<string, number>();
  const byRule = new Map(previous.findings.map((f) => [f.rule, f]));

  for (const finding of current.findings) {
    const before = byRule.get(finding.rule);
    const shared = before?.pages.some((p) => pagesBoth.has(p));
    if (!before || !shared) {
      status.set(finding.rule, 'new');
      continue;
    }
    keepIds.set(finding.rule, before.id);
    status.set(finding.rule, 'still');
    elementsFixed.set(finding.rule, fixedElements(before, finding, pagesBoth));
  }

  // Issues that were on a page checked again, and are gone now.
  const fixed = previous.findings
    .filter((f) => !status.has(f.rule) && f.pages.some((p) => pagesBoth.has(p)))
    .map((f) => ({ id: f.id, rule: f.rule, help: f.help, impact: f.impact, pages: f.pages }));

  const startAfter = Math.max(0, ...previous.findings.map((f) => Number(f.id.slice(5)) || 0));
  return {
    previousRunId: previous.runId,
    previousAt: previous.createdAt,
    keepIds,
    startAfter,
    status,
    elementsFixed,
    fixed,
  };
}

// Elements from before that are gone now. Matches by selector, then by the HTML,
// because selectors can change when other parts of the page change.
function fixedElements(before: SavedFinding, now: Finding, pagesBoth: Set<string>): number {
  const targets = new Set(
    now.elements.map((e) => `${e.page}|${e.frame?.selector ?? ''}|${e.target}`),
  );
  const snippets = new Set(now.elements.map((e) => `${e.page}|${normal(e.html)}`));
  let gone = 0;
  for (const el of before.elements) {
    if (!pagesBoth.has(el.page)) continue;
    const byTarget = `${el.page}|${el.frame?.selector ?? ''}|${el.target}`;
    const bySnippet = `${el.page}|${normal(el.html)}`;
    if (!targets.has(byTarget) && !snippets.has(bySnippet)) gone += 1;
  }
  return gone;
}
