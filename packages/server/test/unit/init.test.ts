import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { initProject } from '../../src/init.js';
import { validatePlanText } from '../../src/run/plans.js';
import { tempDir } from '../helpers/temp.js';

describe('initProject', () => {
  it('makes a working .walkthrough folder', () => {
    const dir = tempDir('init');
    const result = initProject(dir, 'http://localhost:5173/app');
    expect(result.created).toEqual([
      '.walkthrough/config.yaml',
      '.walkthrough/plans/smoke.yaml',
      '.walkthrough/plan.schema.json',
      '.walkthrough/.env.example',
      '.walkthrough/.gitignore',
    ]);
    const config = loadConfig(dir);
    expect(config.baseUrl).toBe('http://localhost:5173/app');
    expect(config.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(config.warnings).toEqual([]);
    const plan = validatePlanText(readFileSync(join(dir, '.walkthrough/plans/smoke.yaml'), 'utf8'));
    expect(plan.ok).toBe(true);
    expect(readFileSync(join(dir, '.walkthrough/.gitignore'), 'utf8')).toContain('.env');
  });

  it('keeps files that exist, but updates the schema', () => {
    const dir = tempDir('init');
    initProject(dir);
    writeFileSync(join(dir, '.walkthrough/config.yaml'), 'baseUrl: http://localhost:1/\n');
    writeFileSync(join(dir, '.walkthrough/plan.schema.json'), '{}');
    const result = initProject(dir);
    expect(result.created).toEqual(['.walkthrough/plan.schema.json']);
    expect(result.kept).toContain('.walkthrough/config.yaml');
    expect(readFileSync(join(dir, '.walkthrough/config.yaml'), 'utf8')).toBe(
      'baseUrl: http://localhost:1/\n',
    );
    expect(readFileSync(join(dir, '.walkthrough/plan.schema.json'), 'utf8')).toContain(
      'Walkthrough test plan',
    );
  });

  it('rejects a start page that is not a web address', () => {
    const dir = tempDir('init');
    expect(() => initProject(dir, 'localhost:3000')).toThrow(/not a web address/);
    expect(existsSync(join(dir, '.walkthrough'))).toBe(false);
  });
});
