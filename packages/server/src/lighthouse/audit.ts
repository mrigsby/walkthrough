// What Walkthrough keeps from one Lighthouse result. Lighthouse's own files have everything.

export interface LhAudit {
  id: string;
  title: string;
  description: string;
  categories: string[];
  // 0 to 1. Lower is worse.
  score: number;
  mode: string;
  display?: string;
  // Short lines about what the audit found, like a URL or an element.
  items: string[];
}

export interface LhMetric {
  id: string;
  title: string;
  value?: number;
  display?: string;
  score: number | null;
}

export interface LighthouseCheck {
  at: string;
  stepId?: string;
  url: string;
  requestedUrl?: string;
  mode: 'navigation' | 'timespan' | 'snapshot';
  device: 'desktop' | 'mobile';
  version: string;
  // 0 to 100 for each category, or null when Lighthouse could not score it.
  scores: Record<string, number | null>;
  metrics: LhMetric[];
  audits: LhAudit[];
  // Lighthouse's own report files, from the run folder.
  files?: { html?: string; json?: string };
  warnings?: string[];
  // True for a step of a user flow in a run. "name" is the step title.
  flow?: boolean;
  name?: string;
  // Timespan and snapshot checks run few audits, so Lighthouse counts passed audits
  // instead of giving a score.
  fractions?: Record<string, { passed: number; total: number }>;
}

// The parts of a Lighthouse result (LHR) that Walkthrough reads.
interface Lhr {
  lighthouseVersion: string;
  finalDisplayedUrl?: string;
  requestedUrl?: string;
  gatherMode?: string;
  runWarnings?: string[];
  runtimeError?: { code: string; message: string };
  configSettings?: { formFactor?: string };
  categories: Record<
    string,
    {
      title: string;
      score: number | null;
      auditRefs: Array<{ id: string; group?: string; weight?: number }>;
    }
  >;
  audits: Record<
    string,
    {
      id: string;
      title: string;
      description?: string;
      score: number | null;
      scoreDisplayMode: string;
      displayValue?: string;
      numericValue?: number;
      details?: unknown;
    }
  >;
}

// Modes that do not give a real pass or fail.
const NO_SCORE = new Set(['notApplicable', 'manual', 'informative', 'error']);
const MAX_ITEMS = 5;

// Short lines from the details of an audit: URLs, elements, source places, and checklist items.
function detailLines(details: unknown, clean: (t: string) => string): string[] {
  const lines: string[] = [];
  const bytes = (n: unknown) => (typeof n === 'number' ? `${Math.round(n / 102.4) / 10} KB` : '');
  const visit = (value: unknown, depth: number) => {
    if (lines.length >= MAX_ITEMS || depth > 12 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const o = value as Record<string, unknown>;
    const node = o.node as { selector?: string; snippet?: string } | undefined;
    if (o.type === 'node' && typeof o.selector === 'string') {
      lines.push(clean(`${o.selector}: ${String(o.snippet ?? '').slice(0, 160)}`));
      return;
    }
    if (node?.selector) {
      const what = typeof o.description === 'string' ? `${o.description}: ` : '';
      lines.push(clean(`${what}${node.selector}: ${String(node.snippet ?? '').slice(0, 160)}`));
      return;
    }
    if (typeof o.url === 'string' && o.type !== 'network-tree') {
      const extra = [
        o.wastedBytes ? `can save ${bytes(o.wastedBytes)}` : '',
        typeof o.wastedMs === 'number' && o.wastedMs > 0
          ? `can save ${Math.round(o.wastedMs)} ms`
          : '',
        !o.wastedBytes && o.totalBytes ? bytes(o.totalBytes) : '',
      ].filter(Boolean);
      lines.push(clean(`${o.url}${extra.length ? ` (${extra.join(', ')})` : ''}`));
      // A request in a network tree: the requests that it started come next.
      if (o.children && typeof o.children === 'object') visit(Object.values(o.children), depth + 1);
      return;
    }
    const place = o.sourceLocation as { url?: string; line?: number } | undefined;
    if (typeof o.description === 'string' && place?.url) {
      lines.push(clean(`${o.description} (${place.url}:${(place.line ?? 0) + 1})`));
      return;
    }
    if (o.type === 'checklist' && o.items && typeof o.items === 'object') {
      for (const item of Object.values(
        o.items as Record<string, { label?: string; value?: boolean }>,
      )) {
        if (item.value === false && item.label) lines.push(clean(`Not done: ${item.label}`));
      }
      return;
    }
    for (const key of ['items', 'value']) visit(o[key], depth + 1);
    // Network trees keep their requests in maps keyed by id.
    for (const key of ['chains', 'children']) {
      const map = o[key];
      if (map && typeof map === 'object') visit(Object.values(map), depth + 1);
    }
  };
  visit(details, 0);
  return lines.slice(0, MAX_ITEMS);
}

// Passed and total audits in a category, counted like the Lighthouse flow report does.
function fraction(lhr: Lhr, category: Lhr['categories'][string]) {
  let passed = 0;
  let total = 0;
  for (const ref of category.auditRefs) {
    const a = lhr.audits[ref.id];
    if (!a || ref.group === 'hidden') continue;
    if (['notApplicable', 'manual', 'informative'].includes(a.scoreDisplayMode)) continue;
    total += 1;
    if (a.scoreDisplayMode !== 'error' && Number(a.score) >= 0.9) passed += 1;
  }
  return { passed, total };
}

// Scores, metrics, and the audits that did not pass.
export function summarizeLhr(
  lhr: Lhr,
  clean: (t: string) => string,
): Omit<LighthouseCheck, 'at' | 'stepId' | 'files' | 'requestedUrl'> {
  const scores: Record<string, number | null> = {};
  const fractions: Record<string, { passed: number; total: number }> = {};
  const audits = new Map<string, LhAudit>();
  const mode = (lhr.gatherMode as LighthouseCheck['mode']) ?? 'navigation';
  for (const [categoryId, category] of Object.entries(lhr.categories)) {
    scores[categoryId] = category.score === null ? null : Math.round(category.score * 100);
    if (mode !== 'navigation') fractions[categoryId] = fraction(lhr, category);
    for (const ref of category.auditRefs) {
      if (ref.group === 'metrics' || ref.group === 'hidden') continue;
      const a = lhr.audits[ref.id];
      if (!a || a.score === null || NO_SCORE.has(a.scoreDisplayMode) || a.score >= 0.9) continue;
      const known = audits.get(a.id);
      if (known) {
        if (!known.categories.includes(categoryId)) known.categories.push(categoryId);
        continue;
      }
      audits.set(a.id, {
        id: a.id,
        title: clean(a.title),
        description: clean(a.description ?? ''),
        categories: [categoryId],
        score: a.score,
        mode: a.scoreDisplayMode,
        display: a.displayValue ? clean(a.displayValue) : undefined,
        items: detailLines(a.details, clean),
      });
    }
  }
  const metrics: LhMetric[] = (lhr.categories.performance?.auditRefs ?? [])
    .filter((r) => r.group === 'metrics')
    .map((r) => lhr.audits[r.id])
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => ({
      id: a.id,
      title: a.title,
      value: a.numericValue,
      display: a.displayValue,
      score: a.score,
    }));
  return {
    url: clean(lhr.finalDisplayedUrl ?? lhr.requestedUrl ?? ''),
    mode,
    device: lhr.configSettings?.formFactor === 'mobile' ? 'mobile' : 'desktop',
    version: lhr.lighthouseVersion,
    scores,
    metrics,
    audits: [...audits.values()],
    warnings: lhr.runWarnings?.length ? lhr.runWarnings.map(clean) : undefined,
    ...(mode === 'navigation' ? {} : { fractions }),
  };
}
