import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, resolveProjectDir } from '../../src/config.js';
import { tempDir } from '../helpers/temp.js';

function project(shared?: string, local?: string): string {
  const dir = tempDir('config');
  mkdirSync(join(dir, '.walkthrough'));
  if (shared) writeFileSync(join(dir, '.walkthrough', 'config.yaml'), shared);
  if (local) writeFileSync(join(dir, '.walkthrough', 'config.local.yaml'), local);
  return dir;
}

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const config = loadConfig(project());
    expect(config.allowedOrigins).toContain('http://localhost:*');
    expect(config.allowEvaluate).toBe(false);
    expect(config.dialogs).toBe('ask');
  });

  it('merges the local file over the shared file', () => {
    const config = loadConfig(
      project('browser:\n  slowMo: 100\n  headless: false\n', 'browser:\n  slowMo: 250\n'),
    );
    expect(config.browser.slowMo).toBe(250);
  });

  it('ignores risky settings in the shared file', () => {
    const dir = project('allowEvaluate: true\nuploadsRoot: /\n');
    const config = loadConfig(dir);
    expect(config.allowEvaluate).toBe(false);
    expect(config.uploadsRoot).toBe(dir);
    expect(config.warnings.join(' ')).toMatch(/allowEvaluate.*config\.local\.yaml/);
  });

  it('accepts risky settings from the local file', () => {
    expect(loadConfig(project(undefined, 'allowEvaluate: true\n')).allowEvaluate).toBe(true);
  });

  it('explains bad settings', () => {
    expect(() => loadConfig(project('dialogs: maybe\n'))).toThrow(/not valid.*dialogs/);
  });
});

describe('resolveProjectDir', () => {
  it('uses the first source that is set', () => {
    expect(resolveProjectDir({ argument: '/a', env: { UIWALK_PROJECT_DIR: '/b' } }).dir).toBe('/a');
    expect(
      resolveProjectDir({ env: { UIWALK_PROJECT_DIR: '/b', CLAUDE_PROJECT_DIR: '/c' } }).dir,
    ).toBe('/b');
    expect(resolveProjectDir({ env: { CLAUDE_PROJECT_DIR: '/c' }, roots: ['/d'] }).dir).toBe('/c');
    expect(resolveProjectDir({ env: {}, roots: ['file:///d'] })).toEqual({
      dir: '/d',
      source: 'MCP roots',
    });
    expect(resolveProjectDir({ env: {}, cwd: '/e' }).dir).toBe('/e');
  });

  it('skips a variable that was not filled in', () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an unfilled variable is the test.
      resolveProjectDir({ env: { UIWALK_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}' }, cwd: '/e' }).dir,
    ).toBe('/e');
  });
});
