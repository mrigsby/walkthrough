import { describe, expect, it } from 'vitest';
import type { A11yViolation } from '../../src/audit/axe.js';
import { buildFindings, pageKey } from '../../src/audit/findings.js';
import { computeScores } from '../../src/audit/score.js';
import type { A11yCheck } from '../../src/run/run-store.js';

const imageAlt = (targets: string[], nodeCount?: number): A11yViolation => ({
  id: 'image-alt',
  impact: 'critical',
  ruleImpact: 'critical',
  help: 'Images must have alternative text',
  helpUrl: 'https://example.com/image-alt',
  tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
  nodes: targets.map((target) => ({ target, html: `<img class="${target}">` })),
  nodeCount,
});

const region: A11yViolation = {
  id: 'region',
  impact: 'moderate',
  ruleImpact: 'moderate',
  help: 'All page content should be contained by landmarks',
  helpUrl: 'https://example.com/region',
  tags: ['cat.keyboard', 'best-practice'],
  nodes: [{ target: 'p', html: '<p>' }],
};

const pass = (id: string, ruleImpact: 'critical' | 'serious', tags: string[]) => ({
  id,
  ruleImpact,
  tags,
});
const TITLE = pass('document-title', 'serious', ['cat.text-alternatives', 'wcag2a', 'wcag242']);
const CONTRAST = pass('color-contrast', 'serious', ['cat.color', 'wcag2aa', 'wcag143']);
const LABEL = pass('label', 'critical', ['cat.forms', 'wcag2a', 'wcag412']);

// Two checks of the shop (the same image twice), a full check of the login page,
// and a scoped check of the login page that the full check wins over.
const checks: A11yCheck[] = [
  {
    at: '1',
    url: 'http://localhost:4321/',
    violations: [imageAlt(['.cap']), region],
    passes: [TITLE, CONTRAST, pass('image-alt', 'critical', ['wcag2a', 'wcag111'])],
  },
  {
    at: '2',
    url: 'http://localhost:4321/?utm=x',
    violations: [imageAlt(['.cap'])],
    passes: [TITLE, CONTRAST],
  },
  { at: '3', url: 'http://localhost:4321/login', violations: [], passes: [TITLE, LABEL] },
  {
    at: '4',
    url: 'http://localhost:4321/login',
    scope: '#x',
    violations: [{ ...imageAlt(['#x']), id: 'label', tags: LABEL.tags }],
    passes: [],
  },
];

describe('findings', () => {
  it('names pages by path, and keeps hash routes', () => {
    expect(pageKey('http://a.test/cart?x=1')).toBe('/cart');
    expect(pageKey('http://a.test/#/cart')).toBe('/#/cart');
    expect(pageKey('http://a.test/help#top')).toBe('/help');
  });

  it('merges a rule across checks and removes duplicate elements', () => {
    const { findings, pages } = buildFindings(checks.slice(0, 3));
    expect(pages.map((p) => p.page)).toEqual(['/', '/login']);
    expect(findings.map((f) => [f.id, f.rule, f.elementCount, f.bestPractice])).toEqual([
      ['A11Y-001', 'image-alt', 1, false],
      ['A11Y-002', 'region', 1, true],
    ]);
    expect(findings[0]?.criteria.map((c) => c.number)).toEqual(['1.1.1']);
    expect(findings[0]?.area).toBe('Images and media');
  });

  it('counts elements that axe found but did not keep', () => {
    const many = buildFindings([
      { at: '1', url: 'http://a.test/', violations: [imageAlt(['.a', '.b'], 60)] },
    ]);
    expect(many.findings[0]?.elementCount).toBe(60);
  });

  it('keeps IDs from an earlier report, and numbers new issues after them', () => {
    const { findings } = buildFindings(checks, { keepIds: new Map([['region', 'A11Y-007']]) });
    expect(findings.map((f) => [f.rule, f.id])).toEqual([
      ['image-alt', 'A11Y-008'],
      ['label', 'A11Y-009'],
      ['region', 'A11Y-007'],
    ]);
  });

  it('changes the digest when the findings change', () => {
    const a = buildFindings(checks.slice(0, 1)).digest;
    expect(buildFindings(checks.slice(0, 1)).digest).toBe(a);
    expect(buildFindings(checks.slice(0, 3)).digest).toBe(a);
    const more = [{ ...checks[0], violations: [imageAlt(['.cap', '.mug'])] } as A11yCheck];
    expect(buildFindings(more).digest).not.toBe(a);
  });
});

describe('scores', () => {
  it('scores like Lighthouse, with weights from the rule impact', () => {
    const findings = buildFindings(checks);
    const scores = computeScores(checks, findings);
    // Shop: image-alt fails (10), title (7) and contrast (7) pass: 14 of 24.
    // Login: title (7) and label (10) pass. The scoped check does not count.
    expect(scores.pages).toEqual([
      { page: '/', url: 'http://localhost:4321/', score: 58, problems: 2 },
      { page: '/login', url: 'http://localhost:4321/login', score: 100, problems: 0 },
    ]);
    // All pages: 31 of 41.
    expect(scores.overall).toBe(76);
    expect(scores.band).toBe('Needs work');
    expect(scores.bestPractices).toBe(0);
    expect(scores.principles).toEqual([
      { principle: 'Perceivable', score: 41 },
      { principle: 'Operable', score: 100 },
      { principle: 'Understandable', score: null },
      { principle: 'Robust', score: 100 },
    ]);
    const area = (name: string) => scores.areas.find((a) => a.area === name);
    expect(area('Images and media')).toEqual({
      area: 'Images and media',
      score: 58,
      failed: 1,
      total: 3,
    });
    expect(area('Keyboard and focus')?.score).toBe(0);
    expect(area('Language')?.score).toBeNull();
    expect(scores.counts).toMatchObject({ critical: 2, moderate: 1, levelA: 2, bestPractice: 1 });
  });

  it('says the score is not available for older runs', () => {
    const old = [{ at: '1', url: 'http://a.test/', violations: [imageAlt(['.a'])] }];
    const scores = computeScores(old, buildFindings(old));
    expect(scores.available).toBe(false);
    expect(scores.overall).toBeNull();
    expect(scores.band).toBeNull();
  });

  it('leaves out rules that only need review', () => {
    const review: A11yCheck[] = [
      {
        at: '1',
        url: 'http://a.test/',
        violations: [],
        incomplete: [{ ...imageAlt(['.a']), id: 'color-contrast', tags: CONTRAST.tags }],
        passes: [TITLE],
      },
    ];
    const findings = buildFindings(review);
    expect(findings.review.map((r) => r.rule)).toEqual(['color-contrast']);
    expect(computeScores(review, findings).overall).toBe(100);
  });
});
