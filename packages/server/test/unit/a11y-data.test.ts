import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { standardTags } from '../../src/audit/standards.js';
import { areaForTags, CRITERIA, criteriaForTags, criteriaLabel } from '../../src/audit/wcag.js';

describe('standards', () => {
  it('maps a standard to axe-core tags', () => {
    expect(standardTags('wcag22aa', true)).toEqual([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
      'best-practice',
    ]);
    expect(standardTags('wcag2a', false)).toEqual(['wcag2a']);
  });
});

describe('WCAG criteria', () => {
  it('has the WCAG 2.2 A and AA criteria', () => {
    expect(CRITERIA).toHaveLength(55);
    expect(CRITERIA.find((c) => c.number === '1.4.3')?.url).toBe(
      'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
    );
    expect(CRITERIA.find((c) => c.number === '3.3.4')?.url).toBe(
      'https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html',
    );
  });

  it('reads axe-core tags, and skips AAA and unknown tags', () => {
    expect(criteriaForTags(['wcag1410', 'wcag141']).map((c) => c.number)).toEqual([
      '1.4.10',
      '1.4.1',
    ]);
    // 2.4.9 is AAA. 4.1.1 is not in WCAG 2.2.
    expect(criteriaForTags(['wcag249', 'wcag411', 'cat.color'])).toEqual([]);
    expect(criteriaLabel(['cat.forms', 'wcag2a', 'wcag412'])).toBe('WCAG 4.1.2 (A)');
    expect(criteriaLabel(['best-practice'])).toBe('best practice');
  });

  it('puts each rule in an area', () => {
    expect(areaForTags(['cat.color', 'wcag2aa'])).toBe('Color and layout');
    expect(areaForTags(['cat.forms'])).toBe('Forms and labels');
    expect(areaForTags([])).toBe('Structure and navigation');
  });
});

// Walkthrough reads each rule's impact from axe's own rule list. It is not a public API,
// so this test fails if a new axe-core version changes it.
describe('axe-core rule data', () => {
  it('still has an impact on its rules', () => {
    const source = readFileSync(
      createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
      'utf8',
    );
    expect(source).toContain('{id:"button-name",impact:"critical"');
    expect(source).toContain('_audit');
    expect(source).toContain('pageLevel');
  });
});
