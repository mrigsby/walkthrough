import { describe, expect, it } from 'vitest';
import { type LighthouseCheck, summarizeLhr } from '../../src/lighthouse/audit.js';
import { buildLhFindings, compareLh, type SavedLhReport } from '../../src/lighthouse/findings.js';
import { buildLhReportData, lhHtml, lhJson, lhMarkdown } from '../../src/report/lh-report.js';
import type { Run } from '../../src/run/run-store.js';

// A small Lighthouse result, shaped like the real one.
const LHR = {
  lighthouseVersion: '13.5.0',
  finalDisplayedUrl: 'http://localhost:4321/',
  gatherMode: 'navigation',
  configSettings: { formFactor: 'desktop' },
  categories: {
    performance: {
      title: 'Performance',
      score: 0.72,
      auditRefs: [
        { id: 'largest-contentful-paint', group: 'metrics' },
        { id: 'render-blocking-insight', group: 'insights' },
        { id: 'fast-audit', group: 'diagnostics' },
      ],
    },
    accessibility: { title: 'Accessibility', score: 0.85, auditRefs: [{ id: 'image-alt' }] },
    seo: { title: 'SEO', score: 0.9, auditRefs: [{ id: 'image-alt' }, { id: 'robots-txt' }] },
  },
  audits: {
    'largest-contentful-paint': {
      id: 'largest-contentful-paint',
      title: 'Largest Contentful Paint',
      score: 0.6,
      scoreDisplayMode: 'numeric',
      displayValue: '2.9 s',
      numericValue: 2900,
    },
    'render-blocking-insight': {
      id: 'render-blocking-insight',
      title: 'Render-blocking requests',
      description: 'Requests block the render. [Learn more](https://developer.chrome.com/x)',
      score: 0,
      scoreDisplayMode: 'metricSavings',
      details: {
        type: 'table',
        items: [{ url: 'http://localhost:4321/styles.css', totalBytes: 4634 }],
      },
    },
    'fast-audit': { id: 'fast-audit', title: 'Fine', score: 1, scoreDisplayMode: 'binary' },
    'image-alt': {
      id: 'image-alt',
      title: 'Image elements do not have `[alt]` attributes',
      score: 0,
      scoreDisplayMode: 'binary',
      details: {
        type: 'table',
        items: [
          { node: { type: 'node', selector: 'main > img', snippet: '<img src="/cap.svg">' } },
        ],
      },
    },
    'robots-txt': {
      id: 'robots-txt',
      title: 'robots.txt',
      score: null,
      scoreDisplayMode: 'notApplicable',
    },
  },
};

function check(url: string, audits = summarizeLhr(LHR, (t) => t).audits): LighthouseCheck {
  return { ...summarizeLhr(LHR, (t) => t), url, audits, at: '2026-09-28T10:00:00.000Z' };
}

describe('summarizeLhr', () => {
  it('keeps scores, metrics, and the audits that did not pass', () => {
    const s = summarizeLhr(LHR, (t) => t);
    expect(s.scores).toEqual({ performance: 72, accessibility: 85, seo: 90 });
    expect(s.metrics).toEqual([
      {
        id: 'largest-contentful-paint',
        title: 'Largest Contentful Paint',
        value: 2900,
        display: '2.9 s',
        score: 0.6,
      },
    ]);
    expect(s.audits.map((a) => [a.id, a.categories])).toEqual([
      ['render-blocking-insight', ['performance']],
      ['image-alt', ['accessibility', 'seo']],
    ]);
    expect(s.audits[0]?.items).toEqual(['http://localhost:4321/styles.css (4.5 KB)']);
    expect(s.audits[1]?.items).toEqual(['main > img: <img src="/cap.svg">']);
  });
});

describe('Lighthouse findings', () => {
  it('groups audits across pages, orders them, and keeps earlier IDs', () => {
    const findings = buildLhFindings([
      check('http://localhost:4321/'),
      check('http://localhost:4321/help'),
    ]);
    expect(findings.findings.map((f) => [f.id, f.audit, f.pages.length])).toEqual([
      ['LH-001', 'render-blocking-insight', 2],
      ['LH-002', 'image-alt', 2],
    ]);
    expect(findings.categories).toEqual(['performance', 'accessibility', 'seo']);
    const again = buildLhFindings([check('http://localhost:4321/')], {
      keepIds: new Map([['image-alt', 'LH-007']]),
      startAfter: 7,
    });
    expect(again.findings.map((f) => f.id)).toEqual(['LH-008', 'LH-007']);
    expect(buildLhFindings([check('http://localhost:4321/')]).digest).toBe(
      buildLhFindings([check('http://localhost:4321/')]).digest,
    );
  });

  it('compares with the last report: kept IDs, fixed issues, and score changes', () => {
    const now = buildLhFindings([check('http://localhost:4321/')]);
    const previous: SavedLhReport = {
      version: 1,
      runId: 'old-run',
      createdAt: '2026-09-27T10:00:00.000Z',
      pages: [{ page: '/', scores: { performance: 60, accessibility: 85, seo: 90 } }],
      findings: [
        { id: 'LH-004', audit: 'image-alt', title: 'Alt', pages: ['/'] },
        { id: 'LH-005', audit: 'uses-long-cache', title: 'Cache', pages: ['/'] },
      ],
    };
    const c = compareLh(now, previous);
    expect(c.keepIds.get('image-alt')).toBe('LH-004');
    expect(c.startAfter).toBe(5);
    expect(c.fixed).toEqual([{ id: 'LH-005', audit: 'uses-long-cache', title: 'Cache' }]);
    expect(c.changes).toEqual([{ page: '/', category: 'performance', before: 60, after: 72 }]);
  });
});

describe('Lighthouse report files', () => {
  const run = {
    id: 'run-1',
    name: 'Lighthouse check',
    baseUrl: 'http://localhost:4321',
  } as Run;

  it('escapes page text and hostile agent text', () => {
    const hostile = '<script>alert(1)</script> ``` <page-content x>';
    const bad = check('http://localhost:4321/', [
      {
        id: 'image-alt',
        title: 'Alt',
        description: 'x [bad](javascript:alert(1))',
        categories: ['accessibility'],
        score: 0,
        mode: 'binary',
        items: [hostile],
      },
    ]);
    const findings = buildLhFindings([bad]);
    const data = buildLhReportData({
      run,
      relativeDir: '.walkthrough/runs/run-1',
      findings,
      items: { 'LH-001': { explain: hostile, fix: 'Add alt text.', code: '```\n<img alt="x">' } },
      summary: hostile,
    });
    const html = lhHtml(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy"/);
    const md = lhMarkdown(data);
    expect(md).toContain('````page-data');
    expect(md).not.toMatch(/<page-content x>/);
    expect(lhJson(data).findings[0]).toMatchObject({
      id: 'LH-001',
      audit: 'image-alt',
      fix: 'Add alt text.',
    });
    expect(data.prompt).toContain('/walkthrough:lighthouse /');
  });
});
