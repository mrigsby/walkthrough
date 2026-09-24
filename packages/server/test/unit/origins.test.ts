import { describe, expect, it } from 'vitest';
import { DEFAULT_ORIGINS, OriginGuard } from '../../src/guards/origins.js';

describe('OriginGuard', () => {
  const guard = new OriginGuard([
    'http://localhost:*',
    'https://*.staging.example.com',
    'http://127.0.0.1:4321',
  ]);

  it('allows matching sites', () => {
    expect(guard.isAllowed('http://localhost:3000/cart')).toBe(true);
    expect(guard.isAllowed('http://localhost/')).toBe(true);
    expect(guard.isAllowed('https://app.staging.example.com/login')).toBe(true);
    expect(guard.isAllowed('http://127.0.0.1:4321/')).toBe(true);
  });

  it('blocks other sites', () => {
    expect(guard.isAllowed('https://example.com')).toBe(false);
    expect(guard.isAllowed('https://staging.example.com')).toBe(false);
    expect(guard.isAllowed('https://evil.com/?q=localhost')).toBe(false);
    expect(guard.isAllowed('http://127.0.0.1:9999/')).toBe(false);
    expect(guard.isAllowed('https://localhost:3000')).toBe(false);
    expect(guard.isAllowed('file:///etc/passwd')).toBe(false);
    expect(guard.isAllowed('not a url')).toBe(false);
  });

  it('always allows blank and error pages', () => {
    expect(guard.isAllowed('about:blank')).toBe(true);
    expect(guard.isAllowed('chrome-error://chromewebdata/')).toBe(true);
  });

  it('gives a helpful message', () => {
    expect(() => guard.check('https://example.com/x')).toThrow(
      /not in the allowed list[\s\S]*allowedOrigins/,
    );
  });

  it('rejects bad patterns', () => {
    expect(() => new OriginGuard(['localhost:3000'])).toThrow(/not valid/);
  });

  it('allows only this computer by default', () => {
    const defaults = new OriginGuard(DEFAULT_ORIGINS);
    expect(defaults.isAllowed('http://localhost:8080')).toBe(true);
    expect(defaults.isAllowed('https://google.com')).toBe(false);
  });
});
