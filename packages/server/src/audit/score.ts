import type { A11yCheck } from '../run/run-store.js';
import type { Impact } from './axe.js';
import { customPasses, customViolations } from './custom-rules.js';
import type { Findings } from './findings.js';
import { pageKey } from './findings.js';
import { AREAS, type Area, areaForTags, criteriaForTags, type Principle } from './wcag.js';

// How much each rule counts, from its impact. Like Lighthouse.
export const WEIGHTS: Record<Impact, number> = { critical: 10, serious: 7, moderate: 3, minor: 1 };

export type Band = 'Good' | 'Needs work' | 'Poor';

export interface Scores {
  // False for older runs that did not save the rules that passed.
  available: boolean;
  overall: number | null;
  band: Band | null;
  bestPractices: number | null;
  pages: Array<{ page: string; url: string; score: number | null; problems: number }>;
  areas: Array<{ area: Area; score: number | null; failed: number; total: number }>;
  principles: Array<{ principle: Principle; score: number | null }>;
  counts: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    elements: number;
    levelA: number;
    levelAA: number;
    bestPractice: number;
    rulesPassed: number;
    rulesFailed: number;
    review: number;
  };
}

interface Outcome {
  passed: boolean;
  impact: Impact;
  tags: string[];
}

export function band(score: number): Band {
  return score >= 90 ? 'Good' : score >= 50 ? 'Needs work' : 'Poor';
}

// Which rules passed and failed on one page. A full-page check wins over a check of
// one part. A rule fails if it failed in any check, even if it also passed.
function pageOutcomes(checks: A11yCheck[]): Map<string, Outcome> {
  const full = checks.filter((c) => !c.scope);
  const use = full.length ? full : checks;
  const out = new Map<string, Outcome>();
  for (const check of use) {
    const failed = [...check.violations, ...customViolations(check)];
    for (const v of failed) {
      out.set(v.id, { passed: false, impact: v.ruleImpact ?? v.impact, tags: v.tags ?? [] });
    }
    for (const p of [...(check.passes ?? []), ...customPasses(check)]) {
      if (!out.has(p.id)) out.set(p.id, { passed: true, impact: p.ruleImpact, tags: p.tags });
    }
  }
  return out;
}

function isWcag(tags: string[]): boolean {
  return criteriaForTags(tags).length > 0;
}

function percent(passed: number, total: number): number | null {
  return total ? Math.round((100 * passed) / total) : null;
}

// Works out every score, the same way every time. It uses only the saved data.
export function computeScores(checks: A11yCheck[], findings: Findings): Scores {
  const available = checks.length > 0 && checks.every((c) => c.passes !== undefined);
  const byPage = new Map<string, A11yCheck[]>();
  for (const check of checks) {
    const key = pageKey(check.url);
    byPage.set(key, [...(byPage.get(key) ?? []), check]);
  }

  const total = { wcag: [0, 0], best: [0, 0] };
  const areas = new Map<Area, [number, number, number, number]>(); // passed, all, failed, rules
  const principles = new Map<Principle, [number, number]>();
  const pages: Scores['pages'] = [];
  let rulesPassed = 0;
  let rulesFailed = 0;

  for (const [page, pageChecks] of byPage) {
    let passed = 0;
    let all = 0;
    let problems = 0;
    for (const outcome of pageOutcomes(pageChecks).values()) {
      const weight = WEIGHTS[outcome.impact];
      const got = outcome.passed ? weight : 0;
      if (outcome.passed) rulesPassed += 1;
      else {
        rulesFailed += 1;
        problems += 1;
      }
      if (isWcag(outcome.tags)) {
        passed += got;
        all += weight;
        total.wcag = [(total.wcag[0] ?? 0) + got, (total.wcag[1] ?? 0) + weight];
        // Count each principle once for a rule.
        const seen = new Set(criteriaForTags(outcome.tags).map((c) => c.principle));
        for (const principle of seen) {
          const [p, a] = principles.get(principle) ?? [0, 0];
          principles.set(principle, [p + got, a + weight]);
        }
      } else if (outcome.tags.includes('best-practice')) {
        total.best = [(total.best[0] ?? 0) + got, (total.best[1] ?? 0) + weight];
      }
      const area = areaForTags(outcome.tags);
      const [p, a, f, r] = areas.get(area) ?? [0, 0, 0, 0];
      areas.set(area, [p + got, a + weight, f + (outcome.passed ? 0 : 1), r + 1]);
    }
    pages.push({
      page,
      url: pageChecks[0]?.url ?? page,
      score: available ? percent(passed, all) : null,
      problems,
    });
  }

  const overall = available ? percent(total.wcag[0] ?? 0, total.wcag[1] ?? 0) : null;
  const counts: Scores['counts'] = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
    elements: 0,
    levelA: 0,
    levelAA: 0,
    bestPractice: 0,
    rulesPassed,
    rulesFailed,
    review: findings.review.length,
  };
  for (const f of findings.findings) {
    counts[f.impact] += 1;
    counts.elements += f.elementCount;
    if (f.criteria.some((c) => c.level === 'A')) counts.levelA += 1;
    else if (f.criteria.some((c) => c.level === 'AA')) counts.levelAA += 1;
    else counts.bestPractice += 1;
  }

  return {
    available,
    overall,
    band: overall === null ? null : band(overall),
    bestPractices: available ? percent(total.best[0] ?? 0, total.best[1] ?? 0) : null,
    pages,
    areas: AREAS.map((area) => {
      const [p, a, f, r] = areas.get(area) ?? [0, 0, 0, 0];
      return { area, score: available ? percent(p, a) : null, failed: f, total: r };
    }),
    principles: (['Perceivable', 'Operable', 'Understandable', 'Robust'] as Principle[]).map(
      (principle) => {
        const [p, a] = principles.get(principle) ?? [0, 0];
        return { principle, score: available ? percent(p, a) : null };
      },
    ),
    counts,
  };
}
