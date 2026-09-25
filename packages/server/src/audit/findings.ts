import { createHash } from 'node:crypto';
import type { A11yCheck } from '../run/run-store.js';
import { type A11yNode, type A11yViolation, IMPACT_ORDER, type Impact } from './axe.js';
import { customViolations } from './custom-rules.js';
import { type Area, areaForTags, type Criterion, criteriaForTags } from './wcag.js';

export interface FindingElement extends A11yNode {
  page: string;
  url: string;
}

// One problem type (one rule), merged across all pages.
export interface Finding {
  id: string;
  rule: string;
  impact: Impact;
  ruleImpact: Impact;
  help: string;
  description?: string;
  helpUrl: string;
  tags: string[];
  criteria: Criterion[];
  bestPractice: boolean;
  area: Area;
  custom: boolean;
  pages: string[];
  elementCount: number;
  elements: FindingElement[];
}

// Something axe could not decide. A person should look at it.
export interface ReviewItem {
  rule: string;
  help: string;
  helpUrl: string;
  pages: string[];
  elementCount: number;
  elements: FindingElement[];
}

export interface Findings {
  findings: Finding[];
  review: ReviewItem[];
  pages: Array<{ page: string; url: string }>;
  digest: string;
}

const MAX_ELEMENTS = 50;

// A short name for a page: its path, plus the hash when the app uses it for pages.
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    const route = /^#!?\//.test(u.hash) ? u.hash : '';
    return `${u.pathname}${route}`;
  } catch {
    return url;
  }
}

function worse(a: Impact, b: Impact): Impact {
  return IMPACT_ORDER.indexOf(a) <= IMPACT_ORDER.indexOf(b) ? a : b;
}

interface Group {
  rule: A11yViolation;
  custom: boolean;
  impact: Impact;
  pages: string[];
  count: number;
  elements: FindingElement[];
  seen: Set<string>;
}

// Adds one rule result from one page to its group. Skips elements already seen.
function add(
  groups: Map<string, Group>,
  v: A11yViolation,
  check: A11yCheck,
  custom: boolean,
): void {
  const page = pageKey(check.url);
  let group = groups.get(v.id);
  if (!group) {
    group = {
      rule: v,
      custom,
      impact: v.impact,
      pages: [],
      count: 0,
      elements: [],
      seen: new Set(),
    };
    groups.set(v.id, group);
  }
  group.impact = worse(group.impact, v.impact);
  if (!group.pages.includes(page)) group.pages.push(page);
  const extra = Math.max(0, (v.nodeCount ?? v.nodes.length) - v.nodes.length);
  for (const node of v.nodes) {
    const key = `${page}|${node.frame?.selector ?? ''}|${node.target}`;
    if (group.seen.has(key)) continue;
    group.seen.add(key);
    group.count += 1;
    if (group.elements.length < MAX_ELEMENTS)
      group.elements.push({ ...node, page, url: check.url });
  }
  // Elements axe found but did not keep.
  group.count += extra;
}

// Groups every check in a run by rule, across pages, with IDs like A11Y-001.
// "keepIds" gives an issue the ID it had in an earlier report.
export function buildFindings(
  checks: A11yCheck[],
  options: { keepIds?: Map<string, string> } = {},
): Findings {
  const groups = new Map<string, Group>();
  const review = new Map<string, Group>();
  const pages: Findings['pages'] = [];
  for (const check of checks) {
    const page = pageKey(check.url);
    if (!pages.some((p) => p.page === page)) pages.push({ page, url: check.url });
    for (const v of check.violations) add(groups, v, check, false);
    for (const v of customViolations(check)) add(groups, v, check, true);
    for (const v of check.incomplete ?? []) add(review, v, check, false);
  }

  const sorted = [...groups.values()].sort(
    (a, b) =>
      IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) ||
      a.rule.id.localeCompare(b.rule.id),
  );
  // Issues from an earlier report keep their ID. New issues get the next numbers.
  const keep = options.keepIds ?? new Map<string, string>();
  let next = Math.max(0, ...[...keep.values()].map((id) => Number(id.slice(5)) || 0)) + 1;
  const findings: Finding[] = sorted.map((g) => {
    const tags = g.rule.tags ?? [];
    const criteria = criteriaForTags(tags);
    let id = keep.get(g.rule.id);
    if (!id) id = `A11Y-${String(next++).padStart(3, '0')}`;
    return {
      id,
      rule: g.rule.id,
      impact: g.impact,
      ruleImpact: g.rule.ruleImpact ?? g.impact,
      help: g.rule.help,
      description: g.rule.description,
      helpUrl: g.rule.helpUrl,
      tags,
      criteria,
      bestPractice: criteria.length === 0,
      area: areaForTags(tags),
      custom: g.custom,
      pages: g.pages,
      elementCount: g.count,
      elements: g.elements,
    };
  });

  const reviewItems: ReviewItem[] = [...review.values()].map((g) => ({
    rule: g.rule.id,
    help: g.rule.help,
    helpUrl: g.rule.helpUrl,
    pages: g.pages,
    elementCount: g.count,
    elements: g.elements,
  }));

  // A short fingerprint. It changes when the findings change.
  const digest = createHash('sha256')
    .update(JSON.stringify(findings.map((f) => [f.id, f.rule, f.elementCount, f.pages])))
    .digest('hex')
    .slice(0, 12);
  return { findings, review: reviewItems, pages, digest };
}
