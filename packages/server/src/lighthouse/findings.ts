import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageKey } from '../audit/findings.js';
import { checkRunId } from '../run/run-store.js';
import type { LhMetric, LighthouseCheck } from './audit.js';
import { LH_CATEGORIES } from './categories.js';

// One audit that did not pass, on one or more pages.
export interface LhFinding {
  id: string;
  audit: string;
  title: string;
  description: string;
  categories: string[];
  // The lowest score on any page, 0 to 1.
  worst: number;
  mode: string;
  pages: Array<{ page: string; score: number; display?: string; items: string[] }>;
}

export interface LhPage {
  page: string;
  url: string;
  device: string;
  scores: Record<string, number | null>;
  metrics: LhMetric[];
  files?: LighthouseCheck['files'];
}

export interface LhFindings {
  findings: LhFinding[];
  pages: LhPage[];
  categories: string[];
  version: string;
  digest: string;
}

const ORDER = new Map<string, number>(LH_CATEGORIES.map((c, i) => [c, i]));

// The newest check of each page. A later check of the same page replaces the earlier one.
function latest(checks: LighthouseCheck[]): LighthouseCheck[] {
  const byPage = new Map<string, LighthouseCheck>();
  for (const check of checks) byPage.set(`${pageKey(check.url)}|${check.mode}`, check);
  return [...byPage.values()];
}

// Groups the audits of all pages. IDs from an earlier report stay the same.
export function buildLhFindings(
  checks: LighthouseCheck[],
  options: { keepIds?: Map<string, string>; startAfter?: number } = {},
): LhFindings {
  const current = latest(checks);
  const byAudit = new Map<string, LhFinding>();
  for (const check of current) {
    const page = pageKey(check.url);
    for (const audit of check.audits) {
      let finding = byAudit.get(audit.id);
      if (!finding) {
        finding = {
          id: '',
          audit: audit.id,
          title: audit.title,
          description: audit.description,
          categories: [...audit.categories],
          worst: audit.score,
          mode: audit.mode,
          pages: [],
        };
        byAudit.set(audit.id, finding);
      }
      for (const c of audit.categories)
        if (!finding.categories.includes(c)) finding.categories.push(c);
      finding.worst = Math.min(finding.worst, audit.score);
      finding.pages.push({ page, score: audit.score, display: audit.display, items: audit.items });
    }
  }
  const rank = (f: LhFinding) => Math.min(...f.categories.map((c) => ORDER.get(c) ?? 99));
  const findings = [...byAudit.values()].sort(
    (a, b) => rank(a) - rank(b) || a.worst - b.worst || a.audit.localeCompare(b.audit),
  );
  let next = options.startAfter ?? 0;
  for (const f of findings) {
    const kept = options.keepIds?.get(f.audit);
    if (kept) f.id = kept;
  }
  const used = new Set(findings.map((f) => f.id).filter(Boolean));
  for (const f of findings) {
    if (f.id) continue;
    do next += 1;
    while (used.has(lhId(next)));
    f.id = lhId(next);
    used.add(f.id);
  }
  const pages = current.map((c) => ({
    page: pageKey(c.url),
    url: c.url,
    device: c.device,
    scores: c.scores,
    metrics: c.metrics,
    files: c.files,
  }));
  const categories = [...new Set(current.flatMap((c) => Object.keys(c.scores)))].sort(
    (a, b) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99),
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify(findings.map((f) => [f.id, f.audit, f.pages.map((p) => [p.page, p.score])])),
    )
    .digest('hex')
    .slice(0, 12);
  return { findings, pages, categories, version: current[0]?.version ?? '', digest };
}

export function lhId(n: number): string {
  return `LH-${String(n).padStart(3, '0')}`;
}

// What lighthouse.json keeps, so the next report can compare.
export interface SavedLhReport {
  version: 1;
  runId: string;
  createdAt: string;
  pages: Array<{ page: string; scores: Record<string, number | null> }>;
  findings: Array<{ id: string; audit: string; title: string; pages: string[] }>;
}

export interface LhComparison {
  previousRunId: string;
  keepIds: Map<string, string>;
  startAfter: number;
  fixed: Array<{ id: string; audit: string; title: string }>;
  changes: Array<{ page: string; category: string; before: number | null; after: number | null }>;
}

// The newest earlier report of at least one of the same pages, or the one asked for.
export function findPreviousLh(
  projectDir: string,
  runId: string,
  pages: string[],
  compareTo?: string,
): SavedLhReport | undefined {
  const runs = join(projectDir, '.walkthrough', 'runs');
  const read = (id: string): SavedLhReport | undefined => {
    const file = join(runs, id, 'lighthouse.json');
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SavedLhReport;
    } catch {
      return undefined;
    }
  };
  if (compareTo) {
    checkRunId(projectDir, compareTo);
    return read(compareTo);
  }
  if (!existsSync(runs)) return undefined;
  for (const id of readdirSync(runs).sort().reverse()) {
    if (id >= runId) continue;
    const saved = read(id);
    if (saved?.pages.some((p) => pages.includes(p.page))) return saved;
  }
  return undefined;
}

export function compareLh(current: LhFindings, previous: SavedLhReport): LhComparison {
  const keepIds = new Map(previous.findings.map((f) => [f.audit, f.id]));
  const startAfter = Math.max(0, ...previous.findings.map((f) => Number(f.id.slice(3)) || 0));
  const now = new Set(current.findings.map((f) => f.audit));
  const pages = new Set(current.pages.map((p) => p.page));
  const fixed = previous.findings
    .filter((f) => !now.has(f.audit) && f.pages.some((p) => pages.has(p)))
    .map(({ id, audit, title }) => ({ id, audit, title }));
  const changes: LhComparison['changes'] = [];
  for (const page of current.pages) {
    const before = previous.pages.find((p) => p.page === page.page);
    if (!before) continue;
    for (const [category, after] of Object.entries(page.scores)) {
      const was = before.scores[category] ?? null;
      if (was !== after) changes.push({ page: page.page, category, before: was, after });
    }
  }
  return { previousRunId: previous.runId, keepIds, startAfter, fixed, changes };
}
