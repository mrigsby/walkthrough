import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { deniedOrigins, environmentGuard, startUrl } from '../../src/environments.js';
import { tempDir } from '../helpers/temp.js';

function config(env?: string) {
  const dir = tempDir('envs');
  mkdirSync(join(dir, '.walkthrough'));
  writeFileSync(
    join(dir, '.walkthrough', 'config.yaml'),
    `baseUrl: http://localhost:4321
allowedOrigins: [http://localhost:4321, "https://*.example.com"]
environments:
  staging:
    baseUrl: https://staging.example.com
  preview:
    baseUrl: https://staging.example.com/preview/
  production:
    baseUrl: https://www.example.com
`,
  );
  return loadConfig(dir, 'test', env);
}

describe('environment guard', () => {
  it('blocks production on development, even when a wildcard allows it', () => {
    const guard = environmentGuard(config());
    expect(guard.isAllowed('http://localhost:4321/cart')).toBe(true);
    expect(guard.isAllowed('https://cdn.example.com/a.js')).toBe(true);
    expect(guard.isAllowed('https://www.example.com/')).toBe(false);
    expect(guard.isAllowed('https://staging.example.com/')).toBe(false);
    expect(() => guard.check('https://www.example.com/')).toThrow(
      /site of the "production" environment.*uses "development"/,
    );
  });

  it('allows a protected environment only after it is confirmed', () => {
    const production = config('production');
    expect(environmentGuard(production).isAllowed('https://www.example.com/')).toBe(false);
    expect(() => environmentGuard(production).check('https://www.example.com/')).toThrow(
      /protected environment.*not confirmed/,
    );
    const confirmed = environmentGuard(production, new Set(['production']));
    expect(confirmed.isAllowed('https://www.example.com/')).toBe(true);
    // The other environments stay blocked.
    expect(confirmed.isAllowed('http://localhost:4321/')).toBe(false);
    expect(confirmed.isAllowed('https://staging.example.com/')).toBe(false);
  });

  it('does not block an environment that shares the active site', () => {
    const denied = deniedOrigins(config('staging')).map((d) => d.origin);
    expect(denied).toContain('https://www.example.com');
    expect(denied).not.toContain('https://staging.example.com');
    expect(denied).toContain('http://localhost:4321');
  });
});

describe('startUrl', () => {
  it('uses a full URL, a path from the base URL, or the base URL', () => {
    expect(startUrl('https://a.example.com/x', 'https://b.example.com')).toBe(
      'https://a.example.com/x',
    );
    expect(startUrl('/admin?tab=1', 'https://b.example.com/app/')).toBe(
      'https://b.example.com/admin?tab=1',
    );
    expect(startUrl(undefined, 'https://b.example.com')).toBe('https://b.example.com');
    expect(() => startUrl('/admin', undefined)).toThrow(/no baseUrl/);
  });
});
