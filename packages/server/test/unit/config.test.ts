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

  it('has accessibility defaults, and merges checks key by key', () => {
    expect(loadConfig(project()).accessibility).toEqual({
      standard: 'wcag22aa',
      bestPractices: true,
      checks: { keyboard: true, darkMode: true, reflow: true, frames: true, screenshots: true },
      maxScreenshots: 25,
    });
    const config = loadConfig(
      project(
        'accessibility:\n  standard: wcag21aa\n  checks:\n    keyboard: false\n',
        'accessibility:\n  checks:\n    reflow: false\n',
      ),
    );
    expect(config.accessibility.standard).toBe('wcag21aa');
    expect(config.accessibility.checks.keyboard).toBe(false);
    expect(config.accessibility.checks.reflow).toBe(false);
    expect(config.accessibility.checks.darkMode).toBe(true);
  });

  it('refuses an unknown accessibility check', () => {
    expect(() => loadConfig(project('accessibility:\n  checks:\n    sparkle: true\n'))).toThrow(
      /accessibility/,
    );
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

  it('reads screenshot folders only from the local file', () => {
    const shared = loadConfig(project('screenshotRoots:\n  - /tmp/shots\n'));
    expect(shared.screenshotRoots).toEqual([]);
    expect(shared.warnings.join(' ')).toMatch(/screenshotRoots.*config\.local\.yaml/);
    const dir = project(undefined, 'screenshotRoots:\n  - /tmp/shots\n  - ../site/images\n');
    expect(loadConfig(dir).screenshotRoots).toEqual([
      '/tmp/shots',
      join(dir, '..', 'site', 'images'),
    ]);
  });

  it('has video and lighthouse defaults, and merges them key by key', () => {
    const plain = loadConfig(project());
    expect(plain.video).toEqual({
      runFormat: 'mp4',
      bugFormat: 'gif',
      width: 1280,
      gifWidth: 800,
      gifFps: 10,
      maxGifSeconds: 60,
      idleSeconds: 1,
      replaySeconds: 15,
      showPanel: false,
      pointer: true,
      captions: true,
    });
    expect(plain.lighthouse).toEqual({
      device: 'desktop',
      categories: ['performance', 'best-practices', 'seo'],
    });
    const config = loadConfig(
      project(
        'video:\n  runFormat: webm\n  gifWidth: 640\nlighthouse:\n  device: mobile\n',
        'video:\n  gifWidth: 500\nlighthouse:\n  categories: [performance, agentic-browsing]\n',
      ),
    );
    expect(config.video.runFormat).toBe('webm');
    expect(config.video.gifWidth).toBe(500);
    expect(config.lighthouse).toEqual({
      device: 'mobile',
      categories: ['performance', 'agentic-browsing'],
    });
  });

  it('refuses unknown video and lighthouse values', () => {
    expect(() => loadConfig(project('video:\n  runFormat: avi\n'))).toThrow(/video/);
    expect(() => loadConfig(project('lighthouse:\n  categories: [speed]\n'))).toThrow(/lighthouse/);
  });

  it('reads allowSecretValues and ffmpegPath only from the local file', () => {
    const shared = loadConfig(project('allowSecretValues: true\nffmpegPath: /bin/sh\n'));
    expect(shared.allowSecretValues).toBe(false);
    expect(shared.ffmpegPath).toBeUndefined();
    expect(shared.warnings.join(' ')).toMatch(/allowSecretValues/);
    expect(shared.warnings.join(' ')).toMatch(/ffmpegPath/);
    const dir = project(undefined, 'allowSecretValues: true\nffmpegPath: tools/ffmpeg\n');
    const local = loadConfig(dir);
    expect(local.allowSecretValues).toBe(true);
    expect(local.ffmpegPath).toBe(join(dir, 'tools', 'ffmpeg'));
  });

  it('explains bad settings', () => {
    expect(() => loadConfig(project('dialogs: maybe\n'))).toThrow(/not valid.*dialogs/);
  });
});

describe('environments', () => {
  const shared = `baseUrl: http://localhost:4321
allowedOrigins: [http://localhost:4321]
vars:
  shopper: Demo Shopper
  store: Demo Shop
environments:
  staging:
    baseUrl: https://staging.example.com/app/
    allowedOrigins: [https://cdn.staging.example.com]
    vars: { shopper: Staging Shopper }
    secrets: { APP_PASSWORD: STAGING_APP_PASSWORD }
    headers: { x-preview-token: "{{secret:PREVIEW_TOKEN}}" }
    actionTimeoutMs: 20000
  production:
    baseUrl: https://www.example.com
`;

  it('has development by default, from the top-level settings', () => {
    const config = loadConfig(project(shared));
    expect(config.defaultEnvironment).toBe('development');
    expect(config.environment).toMatchObject({
      name: 'development',
      label: 'Development',
      baseUrl: 'http://localhost:4321',
      protected: false,
      source: 'baseUrl in config.yaml',
    });
    expect(config.baseUrl).toBe('http://localhost:4321');
    expect(config.allowedOrigins).toEqual(['http://localhost:4321']);
    expect(config.actionTimeoutMs).toBe(10_000);
    expect(config.vars).toEqual({ shopper: 'Demo Shopper', store: 'Demo Shop' });
    expect(Object.keys(config.environments)).toEqual(['development', 'staging', 'production']);
  });

  it('makes the settings of another environment', () => {
    const config = loadConfig(project(shared), 'test', 'staging');
    expect(config.baseUrl).toBe('https://staging.example.com/app/');
    // Shared sites, the environment's own sites, and the site of its base URL.
    expect(config.allowedOrigins).toEqual([
      'http://localhost:4321',
      'https://cdn.staging.example.com',
      'https://staging.example.com',
    ]);
    expect(config.actionTimeoutMs).toBe(20_000);
    expect(config.environment).toMatchObject({
      label: 'Staging',
      color: '#b45309',
      vars: { shopper: 'Staging Shopper' },
      secrets: { APP_PASSWORD: 'STAGING_APP_PASSWORD' },
      headers: { 'x-preview-token': '{{secret:PREVIEW_TOKEN}}' },
      protected: false,
    });
    expect(config.warnings).toEqual([]);
  });

  it('protects production by default', () => {
    const config = loadConfig(project(shared), 'test', 'production');
    expect(config.environment.protected).toBe(true);
    expect(config.environment.color).toBe('#b91c1c');
  });

  it('merges the local file per environment and key', () => {
    const local = `environment: staging
environments:
  staging:
    vars: { store: Local Shop }
    headers: { x-extra: "{{secret:EXTRA}}" }
  mine:
    baseUrl: http://10.0.0.5:3000
`;
    const config = loadConfig(project(shared, local));
    expect(config.defaultEnvironment).toBe('staging');
    expect(config.environment.name).toBe('staging');
    expect(config.environment.source).toBe('config.yaml and config.local.yaml');
    expect(config.environment.vars).toEqual({ shopper: 'Staging Shopper', store: 'Local Shop' });
    expect(Object.keys(config.environment.headers)).toEqual(['x-preview-token', 'x-extra']);
    expect(config.environments.mine?.source).toBe('config.local.yaml');
  });

  it('lets environments.development change the top-level base URL', () => {
    const config = loadConfig(
      project(`${shared}  development:\n    baseUrl: http://localhost:5000\n    label: Local\n`),
    );
    expect(config.baseUrl).toBe('http://localhost:5000');
    expect(config.environment.label).toBe('Local');
  });

  it('explains an unknown environment, a missing base URL, and a bad default', () => {
    expect(() => loadConfig(project(shared), 'test', 'qa')).toThrow(
      /no environment "qa".*development, staging, production/,
    );
    expect(() => loadConfig(project('environments:\n  qa:\n    label: QA\n'))).toThrow(
      /"qa" needs a baseUrl/,
    );
    expect(() => loadConfig(project(`${shared}environment: qa\n`))).toThrow(
      /default environment "qa"/,
    );
  });

  it('refuses bad names, colors, and reserved vars', () => {
    expect(() =>
      loadConfig(project('environments:\n  Staging:\n    baseUrl: https://s.example.com\n')),
    ).toThrow(/environments/);
    expect(() =>
      loadConfig(
        project('environments:\n  s:\n    baseUrl: https://s.example.com\n    color: red\n'),
      ),
    ).toThrow(/hex color/);
    expect(() => loadConfig(project('vars:\n  baseUrl: x\n'))).toThrow(/reserved/);
  });

  it('warns about plain secrets and turned-off protection', () => {
    const shared2 = `environments:
  staging:
    baseUrl: https://s.example.com
    headers: { x-token: abc123 }
    httpCredentials: { username: team, password: hunter22 }
  production:
    baseUrl: https://www.example.com
`;
    const config = loadConfig(
      project(shared2, 'environments:\n  production:\n    protected: false\n'),
    );
    const text = config.warnings.join('\n');
    expect(text).toMatch(/header "x-token".*plain value.*\.env\.staging/);
    expect(text).toMatch(/httpCredentials password.*plain value/);
    expect(text).toMatch(/turns off the protection of the "production"/);
    expect(config.environments.production?.protected).toBe(false);
  });

  it('ignores ignoreHttpsErrors on a protected environment', () => {
    const config = loadConfig(
      project(
        'environments:\n  production:\n    baseUrl: https://www.example.com\n    ignoreHttpsErrors: true\n',
      ),
    );
    expect(config.environments.production?.ignoreHttpsErrors).toBe(false);
    expect(config.warnings.join(' ')).toMatch(/ignores "ignoreHttpsErrors"/);
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
